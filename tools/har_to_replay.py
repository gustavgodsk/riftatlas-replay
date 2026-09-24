#!/usr/bin/env python3
"""Build a .ratlas.json replay from a captured HAR.

This is the recorder's finalisation logic, runnable offline. Keeping it here
means the replay format and the player can be developed and tested against a
real match without the extension existing yet, and it doubles as the reference
for what the extension's finaliser must produce.

    python3 har_to_replay.py capture.har out.ratlas.json
"""
import argparse
import json
import re

from har_to_jsonl import redact
from reducer import Timeline

FORMAT = "riftatlas-replay"
VERSION = 1

#: Frame types that carry authoritative state or match context. Everything else
#: (presence, auth, rewind prompts) is dropped before anything is written.
KEEP = {
    "authoritative_snapshot", "authoritative_patch_commit",
    "room_shell_sync", "chat_sync", "chat_append", "error",
}


CONCESSION_ID = re.compile(r"^log_concession")
VICTORY_TEXT = re.compile(r"\bwins\.\s*$|\bwins the (?:game|match)\b", re.I)


def is_terminal_log_entry(entry):
    """Does this log line end the match?

    Mirrors isTerminalLogEntry in extension/background/recorder.js. The
    initiative roll is the trap: "EagleV wins initiative (15 vs 1)" reads as a
    victory to anything looking for " wins", and crediting the match to whoever
    won the dice is worse than naming no winner at all.
    """
    if not entry:
        return False
    if CONCESSION_ID.match(entry.get("id") or ""):
        return True
    text = entry.get("text") or ""
    if re.search(r"initiative", text, re.I):
        return False
    return bool(VICTORY_TEXT.search(text))


def extract_frames(har_path, url_contains="/parties/match/"):
    with open(har_path) as fh:
        entries = json.load(fh)["log"]["entries"]
    frames = []
    for entry in entries:
        if url_contains not in entry["request"]["url"]:
            continue
        frames.extend(entry.get("_webSocketMessages", []))
    frames.sort(key=lambda m: m["time"])
    if not frames:
        raise SystemExit("no WebSocket frames matched %r" % url_contains)
    t0 = frames[0]["time"]
    out = []
    for frame in frames:
        try:
            msg = redact(json.loads(frame["data"]))
        except ValueError:
            continue
        out.append((round((frame["time"] - t0) * 1000), frame["type"], msg))
    return out


def masked_zones(state):
    """Zones holding placeholder stubs, per player. Empty means full information."""
    out = {}
    for player in state.get("players", []):
        zones = sorted(
            zone for zone, cards in player.get("board", {}).items()
            if isinstance(cards, list)
            and any(isinstance(c, dict) and c.get("isPlaceholder") for c in cards)
        )
        if zones:
            out[player["id"]] = zones
    return out


def build(frames):
    timeline = Timeline()
    commits, chat, shell, origin, error_codes = [], {}, None, None, {}

    for t_ms, direction, msg in frames:
        kind = msg.get("type")
        if kind not in KEEP:
            continue
        timeline.ingest(msg)

        if kind == "room_shell_sync" and shell is None:
            shell = msg["sessionDoc"]
        elif kind == "authoritative_snapshot" and origin is None:
            origin = {
                "sequence": msg["sequence"],
                "snapshot": msg["snapshot"],
                "gameplayLog": msg.get("gameplayLog", []),
                "actionClock": msg.get("actionClock"),
            }
        elif kind == "authoritative_patch_commit":
            commits.append({
                "t": t_ms,
                "baseSequence": msg["baseSequence"],
                "sequence": msg["sequence"],
                "action": msg["action"],
                "operations": msg["patch"]["operations"],
                "actionClock": msg.get("actionClock"),
            })
        elif kind in ("chat_sync", "chat_append"):
            for entry in msg.get("chatEntries", []) or msg.get("entries", []) or []:
                chat[entry["id"]] = entry
        elif kind == "error":
            error_codes[msg.get("authoritativeSequence")] = msg.get("code")

    if origin is None:
        raise SystemExit("capture contains no snapshot to anchor on")

    last_seq = timeline.sequences[-1]
    final_state, final_log = timeline.states[last_seq]

    # Gaps: sequences the server re-anchored us across. The commits in between
    # never reached this client and cannot be recovered from this capture.
    gaps = []
    for src, dst in timeline.resyncs:
        snapshot = timeline.snapshots.get(dst)
        gaps.append({
            "fromSequence": src,
            "toSequence": dst,
            "missingCommits": dst - src,
            "reason": error_codes.get(dst, "unknown"),
            "recovery": "snapshot" if snapshot else "none",
            "snapshot": snapshot[0] if snapshot else None,
            "gameplayLog": snapshot[1] if snapshot else None,
        })

    viewer = (shell or {}).get("viewer") or {}
    viewer_id = viewer.get("playerId")
    masked = masked_zones(final_state)
    # The viewer's own hand is never masked from them, so a capture is
    # full-information only if no zone anywhere held a placeholder.
    fog = bool(masked)

    decklists = {}
    self_player = (shell or {}).get("selfPlayer") or {}
    if self_player.get("id"):
        decklists[self_player["id"]] = self_player.get("decklistRaw")

    clock = (commits[-1]["actionClock"] if commits else origin.get("actionClock")) or {}
    totals = clock.get("totals", {})

    players = []
    for p in final_state.get("players", []):
        players.append({
            "id": p["id"],
            "seat": p.get("seat"),
            "name": p.get("name"),
            "decklistRaw": decklists.get(p["id"]),
            "finalScore": p.get("board", {}).get("score"),
            "thinkTimeMs": totals.get(p["id"]),
        })

    winner, reason = None, None
    for entry in final_log:
        if not is_terminal_log_entry(entry):
            continue
        text = entry.get("text", "")
        reason = "concession" if "conceded" in text else "victory"
        for p in players:
            if p["name"] and p["name"] + " wins" in text:
                winner = p["id"]
        break

    started = (shell or {}).get("createdAt")
    return {
        "format": FORMAT,
        "version": VERSION,
        "match": {
            "roomCode": final_state.get("roomCode"),
            "capturedAt": started,
            "durationMs": commits[-1]["t"] if commits else 0,
            "gameVariant": final_state.get("gameVariant"),
            "playMode": final_state.get("playMode"),
            "matchFormat": (shell or {}).get("matchFormat"),
            "deckRulesMode": (shell or {}).get("deckRulesMode"),
            "roomOrigin": (shell or {}).get("roomOrigin"),
            "roomMode": final_state.get("roomMode"),
            "setupOrderVersion": final_state.get("setupOrderVersion"),
            "outcome": {"winnerPlayerId": winner, "reason": reason},
        },
        "viewer": {
            "role": viewer.get("role", "player"),
            "playerId": viewer_id,
            "fogOfWar": fog,
            "maskedZonesByPlayer": masked,
        },
        "players": players,
        "shell": shell,
        "origin": origin,
        "commits": commits,
        "gaps": gaps,
        "chat": sorted(chat.values(), key=lambda e: e.get("at", 0)),
        # In-game notes are written in the extension; a HAR carries none.
        "notes": [],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("har")
    ap.add_argument("out")
    args = ap.parse_args()
    replay = build(extract_frames(args.har))
    with open(args.out, "w") as fh:
        json.dump(replay, fh, separators=(",", ":"))
    import os
    print("wrote %s (%.0f KiB)" % (args.out, os.path.getsize(args.out) / 1024))
    print("  match      %s  %s %s  %s" % (
        replay["match"]["roomCode"], replay["match"]["playMode"],
        replay["match"]["matchFormat"], replay["match"]["outcome"]))
    print("  viewer     %s %s  fogOfWar=%s" % (
        replay["viewer"]["role"], replay["viewer"]["playerId"], replay["viewer"]["fogOfWar"]))
    print("  players    %s" % [(p["name"], p["finalScore"], p["thinkTimeMs"]) for p in replay["players"]])
    print("  commits    %d   gaps %d   chat %d" % (
        len(replay["commits"]), len(replay["gaps"]), len(replay["chat"])))


if __name__ == "__main__":
    main()
