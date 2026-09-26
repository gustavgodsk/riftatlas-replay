#!/usr/bin/env node
/**
 * Send-to-site (#29): the parts with no chrome or DOM dependency.
 *
 *   node tests/upload.mjs
 *
 * uploadSession() itself - the fetch, chrome.storage and chrome.alarms glue
 * in service-worker.js - is not covered here; it cannot run outside Chrome.
 * See upload-core.js for what is pure and why.
 */
import { exportJson, uploadFilename, nextUploadState, RETRY_DELAYS_MS, shouldAutoSend } from '../extension/background/upload-core.js';

const cases = [
  // exportJson: the same string both the download and the upload send.
  ['{"a":1,"b":[1,2,3]}', exportJson({ a: 1, b: [1, 2, 3] }), 'exportJson matches JSON.stringify'],
  [true, JSON.parse(exportJson({ nested: { x: 'y' } })).nested.x === 'y',
    'exportJson round trips through JSON.parse'],

  // uploadFilename: the session's human room code, falling back to the
  // recording id's own room code when the session carries none.
  ['ABCDE.ratlas.json', uploadFilename({ room: 'ABCDE' }, 'ABCDE@123'),
    'uploadFilename prefers the session room code'],
  ['ABCDE.ratlas.json', uploadFilename(null, 'ABCDE@123'),
    'uploadFilename falls back to the recording id when there is no session'],
  ['ABCDE.ratlas.json', uploadFilename({}, 'ABCDE'),
    'uploadFilename handles a legacy bare room-code id'],

  // nextUploadState: the retry/backoff state machine.
  [3, RETRY_DELAYS_MS.length, 'three backoff delays are configured'],
  ['sent', nextUploadState(0, true).status, 'a success on the first attempt is sent'],
  ['sent', nextUploadState(3, true).status, 'a success is sent whatever attempt it lands on'],
  [null, nextUploadState(0, true).retryDelayMs, 'a success schedules no retry'],

  ['failed', nextUploadState(0, false).status, 'a failure is failed'],
  [1, nextUploadState(0, false).attempts, 'first failure: attempts 1'],
  [RETRY_DELAYS_MS[0], nextUploadState(0, false).retryDelayMs, 'first failure retries after the first delay'],
  [2, nextUploadState(1, false).attempts, 'second failure: attempts 2'],
  [RETRY_DELAYS_MS[1], nextUploadState(1, false).retryDelayMs, 'second failure retries after the second delay'],
  [3, nextUploadState(2, false).attempts, 'third failure: attempts 3'],
  [RETRY_DELAYS_MS[2], nextUploadState(2, false).retryDelayMs, 'third failure retries after the third delay'],
  [4, nextUploadState(3, false).attempts, 'fourth failure: attempts 4'],
  [null, nextUploadState(3, false).retryDelayMs,
    'fourth failure gives up automatic retries - a person must retry by hand'],
  [null, nextUploadState(10, false).retryDelayMs, 'never schedules a retry once attempts are exhausted'],

  ['boom', nextUploadState(0, false, { error: 'boom' }).error, 'carries the error through on failure'],
  ['m1', nextUploadState(0, true, { matchId: 'm1' }).matchId, 'carries the match id through on success'],

  // A manual retry always passes attempt 0, so it gets the full sequence back.
  [RETRY_DELAYS_MS[0], nextUploadState(0, false).retryDelayMs,
    'a manual retry (attempt 0) gets the first delay again, not wherever it left off'],

  // shouldAutoSend (#54): a ghost, no-play recording must never reach the site.
  [false, shouldAutoSend({ finished: false }, 5, { autoSend: true }),
    'never auto-sends a recording still in progress'],
  [false, shouldAutoSend({ finished: true, upload: { status: 'sent' } }, 5, { autoSend: true }),
    'never auto-sends a recording already sent (or sending, or mid-retry)'],
  [false, shouldAutoSend({ finished: true, origin: {} }, 0, { autoSend: true }),
    'never auto-sends an empty recording - zero commits, nothing was played'],
  [true, shouldAutoSend({ finished: true, origin: {} }, 1, { autoSend: true }),
    'auto-sends a recording with even a single real commit'],
  [false, shouldAutoSend({ finished: true, origin: {} }, 5, { autoSend: false }),
    'never auto-sends when "send automatically" is off'],
  [false, shouldAutoSend({ finished: true, origin: {} }, 5, null),
    'never auto-sends when send-to-site is not configured at all'],
  [true, shouldAutoSend({ finished: true, origin: {} }, 5, { autoSend: true }),
    'auto-sends a finished, non-empty, unsent recording when configured'],
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
