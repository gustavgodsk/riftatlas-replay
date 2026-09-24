#!/usr/bin/env node
/**
 * Replay-agnostic structural check: does this file load, reduce, and index?
 *
 * Unlike index-shape.mjs, this asserts nothing about which match it is, so it
 * works on a freshly recorded replay as well as the reference capture.
 *
 *   node tests/replay-smoke.mjs <replay.ratlas.json>
 */
import fs from 'node:fs';
import { timelineFromReplay, buildIndex, Cursor } from '../extension/shared/timeline-index.js';

const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
const replay = JSON.parse(raw);

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};

check('format', replay.format === 'riftatlas-replay', replay.format);
check('version is known', replay.version === 1, String(replay.version));
check('has origin snapshot', !!replay.origin?.snapshot);
check('viewer declared', !!replay.viewer && typeof replay.viewer.fogOfWar === 'boolean');
check('players present', Array.isArray(replay.players) && replay.players.length > 0,
  `${replay.players?.length} player(s)`);

// Credentials must never reach a replay file.
check('no JWT-shaped strings', !/eyJ[A-Za-z0-9_-]{20,}/.test(raw));
check('no authToken key', !raw.includes('"authToken"'));
check('no party key', !raw.includes('"_pk"'));

// In-game notes are optional; when present each is {sequence:int|null, text:string, pinned?:boolean}.
if (replay.notes !== undefined) {
  check('notes is an array', Array.isArray(replay.notes));
  check('notes are well formed', Array.isArray(replay.notes) && replay.notes.every((n) =>
    (n.sequence === null || Number.isInteger(n.sequence)) && typeof n.text === 'string'
    && (n.pinned === undefined || typeof n.pinned === 'boolean')),
  `${replay.notes?.length} note(s)`);
}

const timeline = timelineFromReplay(replay);
const index = buildIndex(timeline);
check('sequences materialised', index.sequences.length > 0, String(index.sequences.length));
check('every commit reached a state',
  replay.commits.every((c) => timeline.states.has(c.sequence)));
check('chapters cover every sequence',
  index.sequences.every((s) => !!index.chapterBySequence.get(s)));
check('events carry text', index.events.every((e) => typeof e.text === 'string'),
  `${index.events.length} event(s)`);

// A hole in the commit chain makes everything after it unreplayable. The file
// may still carry those commits, so "recorded" and "playable" can differ
// wildly - one real match recorded 396 commits and could walk 8 of them. That
// is allowed to happen, but never silently.
const applied = index.sequences.length - 1;
const recorded = replay.coverage?.recordedCommits ?? replay.commits.length;
const declared = (replay.gaps ?? []).length > 0;
check('commit coverage', applied === recorded || declared,
  `${applied} of ${recorded} applied${declared ? ', gaps declared' : ', NO gaps declared'}`);

// Navigation must be reversible and land back exactly where it started.
const cursor = new Cursor(index);
cursor.toEnd();
const end = cursor.sequence;
cursor.toStart();
const start = cursor.sequence;
while (cursor.sequence < end) cursor.stepSequence(1);
check('walk forward reaches the end', cursor.sequence === end, `${start} -> ${end}`);
while (cursor.sequence > start) cursor.stepSequence(-1);
check('walk back reaches the start', cursor.sequence === start);

// Stepping back past any reveal must restore the earlier state byte for byte.
const fingerprint = (seq) => JSON.stringify(timeline.states.get(seq)[0]);
const mid = index.sequences[Math.floor(index.sequences.length / 2)];
const before = fingerprint(mid);
cursor.toEnd();
cursor.sequence = mid;
check('state at a sequence is stable across navigation', fingerprint(mid) === before);

console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
