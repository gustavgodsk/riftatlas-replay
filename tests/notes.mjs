#!/usr/bin/env node
/**
 * In-game notes: which recording a note lands in, how it is stamped, and the
 * order it is exported in.
 *
 * A note typed a few minutes after the match ended still belongs to that match,
 * so unlike frames there is no grace window - but it must never land in a
 * different room's recording.
 *
 *   node tests/notes.mjs
 */
import { pickNoteTarget, stampNote, sortNotes, nextLastSequence } from '../extension/background/notes-core.js';

const MINUTE = 60 * 1000;
const now = 1_700_000_000_000;

const open = { roomCode: `ABCDE@${now - 10 * MINUTE}`, room: 'ABCDE', startedAt: now - 10 * MINUTE, finished: false };
const older = { roomCode: `ABCDE@${now - 90 * MINUTE}`, room: 'ABCDE', startedAt: now - 90 * MINUTE, finished: true, lastAt: now - 60 * MINUTE };
const finished = { roomCode: `ABCDE@${now - 30 * MINUTE}`, room: 'ABCDE', startedAt: now - 30 * MINUTE, finished: true, lastAt: now - 20 * MINUTE };
const other = { roomCode: `ZZZZZ@${now - MINUTE}`, room: 'ZZZZZ', startedAt: now - MINUTE, finished: false };
const bare = { roomCode: 'QQQQQ', startedAt: now - 5 * MINUTE, finished: true };

const session = { startedAt: now - 10 * MINUTE, lastSequence: 42, origin: { sequence: 0 } };
const note = (over) => ({ id: 'n1', at: now, text: ' held the gear ', sequence: 17, ...over });

const cases = [
  [open.roomCode, pickNoteTarget([older, open, other], 'ABCDE')?.roomCode,
    'picks the open recording for the room'],
  [finished.roomCode, pickNoteTarget([older, finished, other], 'ABCDE')?.roomCode,
    'falls back to the newest finished recording, 20 minutes after it ended'],
  [null, pickNoteTarget([other], 'ABCDE'),
    "never picks another room's recording"],
  [null, pickNoteTarget([], 'ABCDE'), 'no recordings at all: null'],
  [null, pickNoteTarget([open], null), 'no room: null'],
  ['QQQQQ', pickNoteTarget([bare], 'QQQQQ')?.roomCode, 'a legacy bare room-code id still matches'],

  [17, stampNote(note(), session).sequence, 'keeps the sequence captured when the box opened'],
  [42, stampNote(note({ sequence: null }), session).sequence, 'falls back to the last sequence seen'],
  [0, stampNote(note({ sequence: undefined }), { ...session, lastSequence: undefined }).sequence,
    'then to the origin snapshot sequence'],
  [null, stampNote(note({ sequence: null }), { startedAt: now }).sequence, 'then to null'],
  ['held the gear', stampNote(note(), session).text, 'trims the text'],
  [10 * MINUTE, stampNote(note(), session).t, 't is relative to the recording start'],
  ['n1', stampNote(note(), session).id, 'keeps the note id'],
  [true, !!stampNote(note({ text: '   ' }), session).error, 'rejects empty text'],
  [true, !!stampNote(note({ text: 'x'.repeat(1001) }), session).error, 'rejects text over 1000 characters'],
  [false, !!stampNote(note({ text: 'x'.repeat(1000) }), session).error, 'accepts exactly 1000 characters'],

  ['a,b,c,d,e', sortNotes([
    { id: 'e', sequence: null, at: 1 },
    { id: 'c', sequence: 9, at: 5 },
    { id: 'a', sequence: 3, at: 9 },
    { id: 'd', sequence: 9, at: 6 },
    { id: 'b', sequence: 9, at: 2 },
  ]).map((n) => n.id).join(','), 'orders by sequence, then time, nulls last'],
  [0, sortNotes([]).length, 'no notes: empty array'],

  [5, nextLastSequence(null, 5), 'first sequence seen'],
  [9, nextLastSequence(9, 4), 'never goes backwards'],
  [12, nextLastSequence(9, 12), 'moves forward'],
  [9, nextLastSequence(9, undefined), 'a frame without a sequence changes nothing'],
  [9, nextLastSequence(9, '12'), 'a non-integer sequence is ignored'],
  [null, nextLastSequence(undefined, undefined), 'nothing seen yet: null'],
];

let failed = 0;
for (const [expected, actual, why] of cases) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${why}`);
  if (!ok) console.log(`       got ${actual}, wanted ${expected}`);
}
console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
