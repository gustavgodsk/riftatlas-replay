/**
 * Authoritative-state reducer — port of tools/reducer.py.
 *
 * tools/reducer.py is normative. Keep this file structurally parallel to it:
 * same function names, same operation order, same branch order. It is meant to
 * be read side by side with the Python, and tests/reducer-parity asserts the
 * two agree on real captures.
 */

/** Every patch operation verb observed in the protocol. */
export const OPS = [
  'set_room_fields', 'unset_room_fields',
  'set_player_fields', 'set_board_fields', 'unset_board_fields',
  'zone_insert', 'zone_remove', 'zone_reorder', 'zone_move', 'zone_replace',
  'patch_card_fields', 'unset_card_fields',
  'log_insert', 'log_remove',
  'chain_insert', 'chain_remove', 'chain_replace',
];

/**
 * Fields the server injects into snapshots but never sends as patches, so a
 * reduced state legitimately lacks them. Cosmetic only; not game state.
 */
export const SNAPSHOT_ONLY_PLAYER_FIELDS = ['identity'];

/** Raised when the server introduces a patch verb this reducer predates. */
export class UnknownOperation extends Error {
  constructor(verb) {
    super(`unknown patch operation "${verb}"`);
    this.name = 'UnknownOperation';
    this.verb = verb;
  }
}

const clone = (v) => structuredClone(v);

function player(state, playerId) {
  const found = state.players.find((p) => p.id === playerId);
  if (!found) throw new Error(`unknown player ${playerId}`);
  return found;
}

function zone(state, playerId, name) {
  const board = player(state, playerId).board;
  if (!board[name]) board[name] = [];
  return board[name];
}

/** Apply one patch operation in place to `state` and `log`. */
export function applyOperation(state, log, op) {
  switch (op.op) {
    case 'set_room_fields':
      Object.assign(state, op.fields);
      break;
    case 'unset_room_fields':
      for (const field of op.fields) delete state[field];
      break;

    case 'set_player_fields':
      Object.assign(player(state, op.playerId), op.fields);
      break;
    case 'set_board_fields':
      Object.assign(player(state, op.playerId).board, op.fields);
      break;
    case 'unset_board_fields': {
      // Seen first on 2026-10-15. Assumed to carry a list of names like the
      // other unset verbs; anything else must fail loudly, not delete nothing.
      if (!Array.isArray(op.fields)) throw new Error(`unset_board_fields without a list of fields`);
      const board = player(state, op.playerId).board;
      for (const field of op.fields) delete board[field];
      break;
    }

    case 'zone_insert':
      zone(state, op.playerId, op.zone).splice(op.index, 0, ...clone(op.cards));
      break;
    case 'zone_remove': {
      const board = player(state, op.playerId).board;
      const dropped = new Set(op.cardIds);
      board[op.zone] = (board[op.zone] ?? []).filter((c) => !dropped.has(c.id));
      break;
    }
    case 'zone_replace':
      // The whole zone, as it now stands. Seen first on 2026-09-17; the server
      // uses it where a move rewrites several cards at once.
      player(state, op.playerId).board[op.zone] = clone(op.cards);
      break;
    case 'zone_reorder': {
      const board = player(state, op.playerId).board;
      const byId = new Map((board[op.zone] ?? []).map((c) => [c.id, c]));
      board[op.zone] = op.cardIds.filter((id) => byId.has(id)).map((id) => byId.get(id));
      break;
    }
    case 'zone_move': {
      const { from: src, to: dst } = op;
      const srcBoard = player(state, src.playerId).board;
      const existing = (srcBoard[src.zone] ?? []).find((c) => c.id === op.cardId);
      srcBoard[src.zone] = (srcBoard[src.zone] ?? []).filter((c) => c.id !== op.cardId);
      // The commit carries the post-move card, which may have been revealed or
      // otherwise rewritten in transit; prefer it over the card we held.
      const card = clone(op.card ?? existing);
      const dstZone = zone(state, dst.playerId, dst.zone);
      dstZone.splice(dst.index ?? dstZone.length, 0, card);
      break;
    }

    case 'patch_card_fields':
      for (const card of zone(state, op.playerId, op.zone)) {
        if (card.id === op.cardId) Object.assign(card, op.fields);
      }
      break;
    case 'unset_card_fields':
      for (const card of zone(state, op.playerId, op.zone)) {
        if (card.id === op.cardId) for (const f of op.fields) delete card[f];
      }
      break;

    case 'log_insert':
      log.splice(op.index, 0, ...clone(op.entries));
      break;
    case 'log_remove': {
      const dropped = new Set(op.entryIds);
      const kept = log.filter((e) => !dropped.has(e.id));
      log.length = 0;
      log.push(...kept);
      break;
    }

    case 'chain_insert':
      if (!state.chainEntries) state.chainEntries = [];
      state.chainEntries.splice(op.index, 0, ...clone(op.entries));
      break;
    case 'chain_remove': {
      const dropped = new Set(op.entryIds);
      state.chainEntries = (state.chainEntries ?? []).filter((e) => !dropped.has(e.id));
      break;
    }
    case 'chain_replace': {
      const replacements = new Map(op.entries.map((e) => [e.id, e]));
      state.chainEntries = (state.chainEntries ?? []).map(
        (e) => (replacements.has(e.id) ? clone(replacements.get(e.id)) : e));
      break;
    }

    default:
      throw new UnknownOperation(op.op);
  }
}

export function applyCommit(state, log, commit) {
  // A commit from the wire nests its operations under `patch`; a commit stored
  // in a replay file carries them directly. Accept both.
  for (const op of commit.operations ?? commit.patch.operations) applyOperation(state, log, op);
  return commit.sequence;
}

/**
 * Materialises every sequence of a match from snapshots and commits.
 *
 * Feed frames in wire order. A commit whose `baseSequence` does not match the
 * current sequence signals a hole in the capture (the client missed frames, or
 * the server forced a resync); the timeline repairs it from a snapshot at that
 * sequence if one was captured, and records the hole either way.
 */
export class Timeline {
  constructor() {
    this.snapshots = new Map();   // sequence -> [state, log]
    this.states = new Map();      // sequence -> [state, log], fully materialised
    this.commits = new Map();     // sequence -> commit that produced it
    this.holes = [];              // {from, to, repaired}
    this.resyncs = [];            // {from, to} jumps taken via snapshot
    this._state = null;
    this._log = null;
    this._sequence = null;
  }

  ingest(msg) {
    const kind = msg.type;
    if (kind === 'authoritative_snapshot') {
      const seq = msg.sequence;
      const entry = [clone(msg.snapshot), clone(msg.gameplayLog ?? [])];
      if (!this.snapshots.has(seq)) this.snapshots.set(seq, entry);
      if (!this.states.has(seq)) this.states.set(seq, entry);
      if (this._sequence === null || seq >= this._sequence) {
        if (this._sequence !== null && seq !== this._sequence) {
          // The server re-anchored us forward: the commits between the two
          // sequences never reached this client and are lost.
          this.resyncs.push({ from: this._sequence, to: seq });
        }
        this._state = clone(entry[0]);
        this._log = clone(entry[1]);
        this._sequence = seq;
      }
      return;
    }

    if (kind !== 'authoritative_patch_commit') return;
    if (this._sequence === null) return;  // commits before the first snapshot cannot be anchored

    const base = msg.baseSequence;
    if (base !== this._sequence) {
      // Any snapshot between where we stand and the commit's base lets the
      // chain continue. Insisting on one exactly at the break threw away every
      // later commit: one real match could walk 8 of its 396.
      const usable = [...this.snapshots.keys()]
        .filter((s) => s >= this._sequence && s <= base);
      if (!usable.length) {
        this.holes.push({ from: this._sequence, to: base, repaired: false });
        return;
      }
      const at = Math.max(...usable);
      const [state, log] = this.snapshots.get(at);
      this._state = clone(state);
      this._log = clone(log);
      this.holes.push({ from: this._sequence, to: at, repaired: true });
      this._sequence = at;
      if (base !== this._sequence) {
        this.holes.push({ from: this._sequence, to: base, repaired: false });
        return;
      }
    }

    this._sequence = applyCommit(this._state, this._log, msg);
    this.commits.set(this._sequence, msg);
    this.states.set(this._sequence, [clone(this._state), clone(this._log)]);
  }

  /** Return [state, log] at `sequence`, or undefined if it was never reached. */
  at(sequence) {
    return this.states.get(sequence);
  }

  get sequences() {
    return [...this.states.keys()].sort((a, b) => a - b);
  }
}
