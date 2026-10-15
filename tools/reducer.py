#!/usr/bin/env python3
"""Reference implementation of the RiftAtlas authoritative-state reducer.

The realtime protocol is event-sourced: an `authoritative_snapshot` establishes
state at a sequence number, and each `authoritative_patch_commit` advances
`baseSequence` -> `sequence` by applying an ordered list of domain-level patch
operations. Replaying a snapshot plus its following commits reproduces the
server's state exactly.

This module is the normative spec for the JavaScript reducer in the extension.
Both must stay behaviourally identical; `verify.py` checks this one against the
snapshots embedded in a capture.
"""
import copy

#: Every patch operation verb observed in the protocol.
OPS = (
    "set_room_fields", "unset_room_fields",
    "set_player_fields", "set_board_fields", "unset_board_fields",
    "zone_insert", "zone_remove", "zone_reorder", "zone_move", "zone_replace",
    "patch_card_fields", "unset_card_fields",
    "log_insert", "log_remove",
    "chain_insert", "chain_remove", "chain_replace",
)

#: Fields the server injects into snapshots but never sends as patches, so a
#: reduced state legitimately lacks them. Cosmetic only; not game state.
SNAPSHOT_ONLY_PLAYER_FIELDS = ("identity",)


class UnknownOperation(Exception):
    """Raised when the server introduces a patch verb this reducer predates."""


def _player(state, player_id):
    for player in state["players"]:
        if player["id"] == player_id:
            return player
    raise KeyError(player_id)


def _zone(state, player_id, zone):
    return _player(state, player_id)["board"].setdefault(zone, [])


def apply_operation(state, log, op):
    """Apply one patch operation in place to `state` and `log`."""
    verb = op["op"]

    if verb == "set_room_fields":
        state.update(op["fields"])
    elif verb == "unset_room_fields":
        for field in op["fields"]:
            state.pop(field, None)

    elif verb == "set_player_fields":
        _player(state, op["playerId"]).update(op["fields"])
    elif verb == "set_board_fields":
        _player(state, op["playerId"])["board"].update(op["fields"])
    elif verb == "unset_board_fields":
        # Seen first on 2026-10-15. Assumed to carry a list of names like the
        # other unset verbs; anything else must fail loudly, not delete nothing.
        if not isinstance(op["fields"], list):
            raise ValueError("unset_board_fields without a list of fields")
        board = _player(state, op["playerId"])["board"]
        for field in op["fields"]:
            board.pop(field, None)

    elif verb == "zone_insert":
        zone = _zone(state, op["playerId"], op["zone"])
        index = op["index"]
        zone[index:index] = copy.deepcopy(op["cards"])
    elif verb == "zone_remove":
        board = _player(state, op["playerId"])["board"]
        dropped = set(op["cardIds"])
        board[op["zone"]] = [c for c in board.get(op["zone"], []) if c["id"] not in dropped]
    elif verb == "zone_replace":
        # The whole zone, as it now stands. Seen first on 2026-09-17; the server
        # uses it where a move rewrites several cards at once.
        _player(state, op["playerId"])["board"][op["zone"]] = copy.deepcopy(op["cards"])
    elif verb == "zone_reorder":
        board = _player(state, op["playerId"])["board"]
        by_id = {c["id"]: c for c in board.get(op["zone"], [])}
        board[op["zone"]] = [by_id[i] for i in op["cardIds"] if i in by_id]
    elif verb == "zone_move":
        src, dst = op["from"], op["to"]
        src_board = _player(state, src["playerId"])["board"]
        existing = next((c for c in src_board.get(src["zone"], []) if c["id"] == op["cardId"]), None)
        src_board[src["zone"]] = [c for c in src_board.get(src["zone"], []) if c["id"] != op["cardId"]]
        # The commit carries the post-move card, which may have been revealed or
        # otherwise rewritten in transit; prefer it over the card we held.
        card = copy.deepcopy(op.get("card") or existing)
        dst_zone = _zone(state, dst["playerId"], dst["zone"])
        index = dst.get("index", len(dst_zone))
        dst_zone[index:index] = [card]

    elif verb == "patch_card_fields":
        for card in _zone(state, op["playerId"], op["zone"]):
            if card["id"] == op["cardId"]:
                card.update(op["fields"])
    elif verb == "unset_card_fields":
        for card in _zone(state, op["playerId"], op["zone"]):
            if card["id"] == op["cardId"]:
                for field in op["fields"]:
                    card.pop(field, None)

    elif verb == "log_insert":
        index = op["index"]
        log[index:index] = copy.deepcopy(op["entries"])
    elif verb == "log_remove":
        dropped = set(op["entryIds"])
        log[:] = [e for e in log if e["id"] not in dropped]

    elif verb == "chain_insert":
        chain = state.setdefault("chainEntries", [])
        index = op["index"]
        chain[index:index] = copy.deepcopy(op["entries"])
    elif verb == "chain_remove":
        dropped = set(op["entryIds"])
        state["chainEntries"] = [e for e in state.get("chainEntries", []) if e["id"] not in dropped]
    elif verb == "chain_replace":
        replacements = {e["id"]: e for e in op["entries"]}
        state["chainEntries"] = [
            copy.deepcopy(replacements.get(e["id"], e)) for e in state.get("chainEntries", [])
        ]

    else:
        raise UnknownOperation(verb)


def apply_commit(state, log, commit):
    for op in commit["patch"]["operations"]:
        apply_operation(state, log, op)
    return commit["sequence"]


class Timeline:
    """Materialises every sequence of a match from snapshots and commits.

    Feed frames in wire order. A commit whose `baseSequence` does not match the
    current sequence signals a hole in the capture (the client missed frames, or
    the server forced a resync); the timeline repairs it from a snapshot at that
    sequence if one was captured, and records the hole either way.
    """

    def __init__(self):
        self.snapshots = {}      # sequence -> (state, log)
        self.states = {}         # sequence -> (state, log), fully materialised
        self.commits = {}        # sequence -> commit that produced it
        self.holes = []          # (from_sequence, to_sequence, repaired)
        self.resyncs = []        # (from_sequence, to_sequence) jumps taken via snapshot
        self._state = None
        self._log = None
        self._sequence = None

    def ingest(self, msg):
        kind = msg.get("type")
        if kind == "authoritative_snapshot":
            seq = msg["sequence"]
            entry = (copy.deepcopy(msg["snapshot"]), copy.deepcopy(msg.get("gameplayLog", [])))
            self.snapshots.setdefault(seq, entry)
            self.states.setdefault(seq, entry)
            if self._sequence is None or seq >= self._sequence:
                if self._sequence is not None and seq != self._sequence:
                    # The server re-anchored us forward: the commits between the
                    # two sequences never reached this client and are lost.
                    self.resyncs.append((self._sequence, seq))
                self._state, self._log = copy.deepcopy(entry[0]), copy.deepcopy(entry[1])
                self._sequence = seq
            return

        if kind != "authoritative_patch_commit":
            return
        if self._sequence is None:
            return  # commits before the first snapshot cannot be anchored

        base = msg["baseSequence"]
        if base != self._sequence:
            # Any snapshot between where we stand and the commit's base lets the
            # chain continue. Insisting on one exactly at the break threw away
            # every later commit: one real match could walk 8 of its 396.
            usable = [s for s in self.snapshots if self._sequence <= s <= base]
            if not usable:
                self.holes.append((self._sequence, base, False))
                return
            at = max(usable)
            state, log = self.snapshots[at]
            self._state, self._log = copy.deepcopy(state), copy.deepcopy(log)
            self.holes.append((self._sequence, at, True))
            self._sequence = at
            if base != self._sequence:
                self.holes.append((self._sequence, base, False))
                return

        self._sequence = apply_commit(self._state, self._log, msg)
        self.commits[self._sequence] = msg
        self.states[self._sequence] = (copy.deepcopy(self._state), copy.deepcopy(self._log))

    def at(self, sequence):
        """Return (state, log) at `sequence`, or None if it was never reached."""
        return self.states.get(sequence)

    @property
    def sequences(self):
        return sorted(self.states)
