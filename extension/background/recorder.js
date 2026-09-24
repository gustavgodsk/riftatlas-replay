/**
 * Turns observed frames into persisted recording state.
 *
 * Every frame is redacted and written to IndexedDB as it arrives. Nothing
 * accumulates in worker memory, so an MV3 worker termination mid-match costs
 * nothing.
 */
import { SESSIONS, COMMITS, EXTRAS, put, get, recordingId, activeRecordingFor, noteTargetFor } from './store.js';
import { stampNote, nextLastSequence } from './notes-core.js';

/** Frame types that carry authoritative state or match context. */
const KEEP = new Set([
  'authoritative_snapshot', 'authoritative_patch_commit',
  'room_shell_sync', 'chat_sync', 'chat_append', 'error',
]);

/** Keys scrubbed before anything is written. Mirrors tools/har_to_jsonl.py. */
const SECRETS = new Set(['authToken', 'token', 'jwt', '_pk']);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRETS.has(k) && typeof v === 'string' ? '<redacted>' : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Frames arrive faster than a read-modify-write of the session record can
 * complete, and several types mutate it. Serialise them: without this, a
 * `room_shell_sync` write is silently clobbered by a snapshot write that read
 * the session before it landed, and the replay loses its decklist and format.
 */
let queue = Promise.resolve();

export function onFrame(frame) {
  const next = queue.then(() => handleFrame(frame), () => handleFrame(frame));
  queue = next.catch(() => {});
  return next;
}

/**
 * Store an in-game note. Chained on the same queue as frames so a note never
 * races the session write of the frame before it.
 *
 * Resolves `{ok, sequence, rebuild?}`; `rebuild` names a finished recording
 * whose replay should be rebuilt so the note is in it.
 */
export function onNote(note) {
  const next = queue.then(() => handleNote(note), () => handleNote(note));
  queue = next.catch(() => {});
  return next;
}

async function handleNote(note) {
  const session = await noteTargetFor(note?.roomCode);
  if (!session) return { ok: false, error: 'no recording for this room yet' };
  const stamped = stampNote(note, session);
  if (stamped.error) return { ok: false, error: stamped.error };
  await put(EXTRAS, { roomCode: session.roomCode, kind: 'note', id: stamped.id, note: stamped });
  // Never reopen or close anything: the session record is left untouched.
  return {
    ok: true,
    sequence: stamped.sequence,
    rebuild: session.finished === true ? session.roomCode : null,
  };
}

async function handleFrame({ data, at, socketId }) {
  let msg;
  try { msg = JSON.parse(data); } catch { return null; }
  if (!KEEP.has(msg.type)) return null;

  const room = msg.gameInstanceId;
  if (!room) return null;
  msg = redact(msg);

  // Find the recording in progress for this room, or begin one. Room codes are
  // five characters and get reused, so a returning code must not be appended to
  // a finished recording - that would merge two unrelated matches, the new
  // one's early sequences overwriting the old one's.
  let session = await activeRecordingFor(room, at);
  // A frame landing on a recording that has just closed reopens it, and the
  // caller rebuilds so the late arrival is not stranded in a replay built
  // without it.
  const wasClosed = session?.finished === true;
  if (wasClosed) session.finished = false;
  if (!session) {
    // Only a frame that carries game state may start a recording. Looking at a
    // room sends a shell sync and nothing else, and a finished room can be
    // looked at long after the match - which used to create an empty recording
    // above the real one, with the same code and nothing in it.
    if (msg.type !== 'authoritative_snapshot' && msg.type !== 'room_shell_sync') return null;
    session = {
      roomCode: recordingId(room, at),   // the store's key: a recording id
      room,                              // the human-facing room code
      startedAt: at, lastAt: at,
      origin: null, shell: null, viewer: null,
      // A recorder attached mid-match has no sequence-0 snapshot and cannot
      // anchor; the replay is marked partial rather than looking complete.
      partial: true,
      finished: false,
    };
  }
  const roomCode = session.roomCode;   // every store write is keyed by this
  session.lastAt = at;
  // The newest game sequence seen, so a note without one can still be placed.
  session.lastSequence = nextLastSequence(session.lastSequence, msg.sequence);
  // Which socket is feeding this recording. A closing socket ends the match it
  // was carrying and nothing else: RiftAtlas keeps several party sockets open
  // at once, and a lobby socket closing used to end a match in progress.
  // Stored rather than held in worker memory, which MV3 discards at will.
  if (socketId) session.socketId = socketId;

  switch (msg.type) {
    case 'authoritative_snapshot':
      if (!session.origin) {
        session.origin = {
          sequence: msg.sequence,
          snapshot: msg.snapshot,
          gameplayLog: msg.gameplayLog ?? [],
          actionClock: msg.actionClock ?? null,
        };
        session.partial = msg.sequence !== 0;
      } else if (msg.sequence !== session.origin.sequence) {
        // A later snapshot is only kept when it may be needed to repair a gap.
        await put(EXTRAS, {
          roomCode, kind: 'snapshot', id: String(msg.sequence),
          sequence: msg.sequence, snapshot: msg.snapshot,
          gameplayLog: msg.gameplayLog ?? [],
        });
      }
      break;

    case 'authoritative_patch_commit':
      await put(COMMITS, {
        roomCode, sequence: msg.sequence,
        t: at - session.startedAt,
        baseSequence: msg.baseSequence,
        action: msg.action,
        operations: msg.patch.operations,
        actionClock: msg.actionClock ?? null,
      });
      break;

    case 'room_shell_sync': {
      if (!session.shell) session.shell = msg.sessionDoc;
      session.viewer = msg.sessionDoc?.viewer ?? session.viewer;
      // Who the room currently considers gone. A match is over for our purposes
      // when nobody is left in it - a far steadier signal than reading the log.
      const doc = msg.sessionDoc ?? {};
      const seats = [doc.selfPlayer?.id, ...(doc.publicPlayers ?? []).map((p) => p.id)]
        .filter(Boolean);
      const gone = Object.keys(doc.disconnectedAtByPlayerId ?? {});
      session.seatCount = seats.length || session.seatCount;
      session.everyoneLeft = seats.length > 0 && seats.every((id) => gone.includes(id));
      break;
    }

    case 'chat_sync':
    case 'chat_append':
      for (const entry of msg.chatEntries ?? msg.entries ?? []) {
        await put(EXTRAS, { roomCode, kind: 'chat', id: entry.id, entry });
      }
      break;

    case 'error':
      await put(EXTRAS, {
        roomCode, kind: 'error', id: String(msg.authoritativeSequence ?? at),
        sequence: msg.authoritativeSequence ?? null, code: msg.code ?? null,
      });
      break;
  }

  await put(SESSIONS, session);
  return { id: roomCode, reopened: wasClosed };
}

/**
 * Has the match ended?
 *
 * Text matching here is delicate. A first pass looked for " wins", which the
 * initiative roll trips on sequence 3 of every game - "BertoC wins initiative
 * (16 vs 2) and decides who plays first." That froze the built replay at the
 * dice roll. So: concessions are identified by the server's own log id, and a
 * victory line must end with "wins." rather than merely contain the word.
 *
 * A normal victory is still unverified (open question 5), which is why
 * finalisation never relies on this alone - the socket closing rebuilds
 * regardless.
 */
const CONCESSION_ID = /^log_concession/;
const VICTORY_TEXT = /\bwins\.\s*$|\bwins the (?:game|match)\b/i;

export function isTerminalLogEntry(entry) {
  if (!entry) return false;
  if (CONCESSION_ID.test(entry.id ?? '')) return true;
  const text = entry.text ?? '';
  if (/initiative/i.test(text)) return false;   // the dice roll is not an ending
  return VICTORY_TEXT.test(text);
}

/**
 * Does this socket closing end this recording?
 *
 * Only for the recording that socket was feeding. The observer watches every
 * `/parties/` socket and RiftAtlas keeps several open at once, so treating any
 * close as the end of every match cut two live games in half in one evening.
 *
 * An unidentified socket ends nothing: leaving a recording open costs far less
 * than ending one that is still being played, and the other end triggers -
 * everyone leaving, a new room, a victory line - still apply.
 */
export function endsWithSocket(session, socketId) {
  if (!socketId || !session?.socketId) return false;
  return session.socketId === socketId;
}

/** Has everyone left the room? Set from the room document as it arrives. */
export function everyoneLeft(session) {
  return session?.everyoneLeft === true;
}

/**
 * A match can end without any commit saying so. In the reference capture the
 * concession arrived only inside the snapshot the server pushed to re-anchor
 * the client after a resync - there was no log_insert carrying it anywhere. So
 * check snapshots too, or the ending is invisible on exactly the matches where
 * something went wrong.
 */
export function looksFinished(msg) {
  if (msg.type === 'authoritative_patch_commit') {
    return (msg.patch?.operations ?? [])
      .filter((op) => op.op === 'log_insert')
      .flatMap((op) => op.entries ?? [])
      .some(isTerminalLogEntry);
  }
  if (msg.type === 'authoritative_snapshot') {
    return (msg.gameplayLog ?? []).some(isTerminalLogEntry);
  }
  return false;
}
