/**
 * Pure helpers for in-game notes. No chrome, no IndexedDB, so tests can import
 * them from node directly.
 *
 * A note is a line of text written during a match, stamped with the sequence
 * the game was at when the note box was opened. It is stored beside the
 * recording (EXTRAS, kind 'note') and exported as `notes[]`.
 */

export const MAX_NOTE_LENGTH = 1000;

/** The room code a recording id refers to (mirrors store.js roomOf). */
const roomOf = (id) => String(id).split('@')[0];

/**
 * Which recording a note for this room belongs to: the newest one for the
 * room, open or finished, with no grace window. A note typed a few minutes
 * after the match ended still belongs to that match.
 */
export function pickNoteTarget(sessions, room) {
  if (!room) return null;
  const candidates = (sessions ?? [])
    .filter((s) => (s.room ?? roomOf(s.roomCode)) === room)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return candidates[0] ?? null;
}

/**
 * Turn a note from the page into what is stored. Returns `{error}` when the
 * text is unusable.
 */
export function stampNote(note, session) {
  const text = typeof note?.text === 'string' ? note.text.trim() : '';
  if (!text) return { error: 'empty note' };
  if (text.length > MAX_NOTE_LENGTH) return { error: `note is over ${MAX_NOTE_LENGTH} characters` };
  const sequence = Number.isInteger(note.sequence)
    ? note.sequence
    : (session?.lastSequence ?? session?.origin?.sequence ?? null);
  const at = Number.isFinite(note.at) ? note.at : Date.now();
  return {
    id: String(note.id),
    at,
    t: at - (session?.startedAt ?? at),
    sequence: Number.isInteger(sequence) ? sequence : null,
    text,
  };
}

/** Notes in game order: by sequence, then time; notes without a sequence last. */
export function sortNotes(notes) {
  return [...(notes ?? [])].sort((a, b) => {
    const sa = Number.isInteger(a.sequence), sb = Number.isInteger(b.sequence);
    if (sa !== sb) return sa ? -1 : 1;
    if (sa && a.sequence !== b.sequence) return a.sequence - b.sequence;
    return (a.at ?? 0) - (b.at ?? 0);
  });
}

/** The highest sequence seen so far; frames without one change nothing. */
export function nextLastSequence(prev, seq) {
  if (!Number.isInteger(seq)) return prev ?? null;
  if (!Number.isInteger(prev)) return seq;
  return Math.max(prev, seq);
}
