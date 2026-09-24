/**
 * IndexedDB persistence for in-progress and finished recordings.
 *
 * Everything the recorder learns is written here immediately. MV3 terminates an
 * idle service worker after about thirty seconds and a match has long quiet
 * stretches, so worker memory is not a place a match can live: a re-awakened
 * worker must be able to resume a session it does not remember starting.
 *
 * ── Recording ids ────────────────────────────────────────────────────────────
 *
 * The key is a **recording id**, not a room code. RiftAtlas room codes are five
 * characters, so they are certainly reused over time, and keying by room code
 * meant a recycled code silently merged two different matches - the new match's
 * sequence 1 overwriting the old one's.
 *
 * A recording id is `<roomCode>@<startedAt>`, which stays unique across reuse
 * and still sorts and reads sensibly. The key path is unchanged, so no
 * migration is needed and nothing already recorded is lost: existing rows keep
 * a bare room code as their id, which `roomOf` handles.
 */
import { pickNoteTarget } from './notes-core.js';

const DB = 'riftatlas-replay';
const VERSION = 1;

export const SESSIONS = 'sessions';   // id -> session metadata + origin snapshot
export const COMMITS = 'commits';     // [id, sequence] -> commit
export const EXTRAS = 'extras';       // [id, kind, key] -> chat / gap snapshot / error / note
export const REPLAYS = 'replays';     // id -> finished .ratlas.json

/** A recording's identity: the room, plus when this recording began. */
export function recordingId(roomCode, startedAt) {
  return `${roomCode}@${startedAt}`;
}

/** The room code a recording id refers to; also accepts a bare room code. */
export function roomOf(id) {
  return String(id).split('@')[0];
}

let opening = null;

export function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // `roomCode` is the key path for historical reasons; the value stored in
      // it is a recording id. Renaming it would mean a migration that could
      // lose recordings, which is not worth the tidiness.
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'roomCode' });
      if (!db.objectStoreNames.contains(COMMITS)) db.createObjectStore(COMMITS, { keyPath: ['roomCode', 'sequence'] });
      if (!db.objectStoreNames.contains(EXTRAS)) db.createObjectStore(EXTRAS, { keyPath: ['roomCode', 'kind', 'id'] });
      if (!db.objectStoreNames.contains(REPLAYS)) db.createObjectStore(REPLAYS, { keyPath: 'roomCode' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    // `request.result` is undefined for a key that is absent, which is a
    // meaningful answer. Unwrap explicitly rather than with `??`, or a miss
    // resolves to the IDBRequest itself and gets mistaken for a record.
    tx.oncomplete = () => resolve(request instanceof IDBRequest ? request.result : request);
    tx.onerror = () => reject(tx.error);
  }));
}

export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const all = (store, range) => run(store, 'readonly', (s) => s.getAll(range));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

/** Every commit for one recording, in sequence order. */
export function commitsFor(id) {
  return all(COMMITS, IDBKeyRange.bound([id, -Infinity], [id, Infinity]))
    .then((rows) => rows.sort((a, b) => a.sequence - b.sequence));
}

/** Extras of one kind for one recording. */
export function extrasFor(id, kind) {
  return all(EXTRAS, IDBKeyRange.bound([id, kind, ''], [id, kind, '￿']));
}

/**
 * The recording a frame for this room belongs to, if any.
 *
 * An open recording, or one closed within the last couple of minutes. The grace
 * period matters because a match's last word can arrive after it has been
 * declared over: in a best-of-three the next game's room opens immediately, the
 * previous recording is closed on the spot, and the concession that ended it
 * turns up a moment later. Without the grace that frame has nowhere to go and is
 * dropped - which is how a real game two ended with no result at all.
 *
 * Reusing a room code is safe here: a rematch gets a new code, confirmed across
 * a best-of-three where all three games had different ones. A code returning
 * after two minutes is a different match and starts its own recording.
 */
const REOPEN_GRACE_MS = 2 * 60 * 1000;

/** Can a frame arriving now still belong to this recording? */
export function stillAccepting(session, now) {
  if (session.finished !== true) return true;
  return (now - (session.lastAt ?? 0)) < REOPEN_GRACE_MS;
}

export async function activeRecordingFor(roomCode, now = Date.now()) {
  const sessions = await all(SESSIONS);
  const candidates = sessions
    .filter((s) => roomOf(s.roomCode) === roomCode)
    .filter((s) => stillAccepting(s, now))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return candidates[0] ?? null;
}

/**
 * The recording a note for this room belongs to: the newest for the room, open
 * or finished, ignoring the grace window. See notes-core.js.
 */
export async function noteTargetFor(roomCode) {
  return pickNoteTarget(await all(SESSIONS), roomCode);
}

/**
 * Is this a recording, or just the residue of being in a room?
 *
 * Leaving a finished match is the usual way residue appears: the recording is
 * closed, and the client's parting frames then start a fresh one that never
 * catches a thing. It ends up listed above the real match wearing the same room
 * code.
 *
 * A recording is only real once it holds a commit. Before that it is either
 * residue, or a match in the act of starting - told apart by whether it is
 * still open. A match that has closed without a single commit recorded nothing
 * worth keeping, whether or not it managed to catch an opening snapshot.
 */
export function isEmptyRecording(session, commitCount) {
  if (commitCount) return false;
  return !session?.origin || session.finished === true;
}

/** Delete every trace of one recording. */
export async function dropRecording(id) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([SESSIONS, COMMITS, EXTRAS, REPLAYS], 'readwrite');
    tx.objectStore(SESSIONS).delete(id);
    tx.objectStore(REPLAYS).delete(id);
    tx.objectStore(COMMITS).delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
    tx.objectStore(EXTRAS).delete(IDBKeyRange.bound([id, '', ''], [id, '￿', '￿']));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
