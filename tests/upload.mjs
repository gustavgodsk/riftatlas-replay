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
import {
  exportJson, uploadFilename, nextUploadState, RETRY_DELAYS_MS, shouldAutoSend, AUTO_SEND_COUNTDOWN_MS,
  getShownUpload, getCountdownResult, isUnsent, STUCK_AFTER_MS, ABANDONED_AFTER_MS,
} from '../extension/background/upload-core.js';
import { getRecordedFields } from '../extension/background/recorder.js';

const now = 1_700_000_000_000;
const done = (upload) => ({ finished: true, lastAt: now - 1000, origin: {}, upload });

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

  // Auto-send countdown toast: armed once (this still gates the arming, not
  // an instant send - see service-worker.js armCountdown/resolveCountdown),
  // and never re-armed while one is already counting down.
  [10_000, AUTO_SEND_COUNTDOWN_MS, 'the auto-send countdown is ten seconds'],
  [false, shouldAutoSend({ finished: true, upload: { status: 'countdown', sendAt: Date.now() + 5000 } }, 5, { autoSend: true }),
    'never re-arms a recording already counting down'],

  // getShownUpload: a 'sending' or 'countdown' nothing will come back to
  // finish must read as failed, or the Send button is hidden for good.
  ['sending', getShownUpload({ status: 'sending', at: now - 5000 }, now).status,
    'a send in progress is shown as sending'],
  ['failed', getShownUpload({ status: 'sending', at: now - STUCK_AFTER_MS - 1 }, now).status,
    'a send stuck past the limit is shown as failed, so it can be retried'],
  ['countdown', getShownUpload({ status: 'countdown', sendAt: now + 5000 }, now).status,
    'a running countdown is shown as counting down'],
  ['failed', getShownUpload({ status: 'countdown', sendAt: now - STUCK_AFTER_MS - 1 }, now).status,
    'a countdown long overdue is shown as failed'],
  [null, getShownUpload(undefined, now), 'no upload is no upload'],

  // getCountdownResult: what the toast shows once it stops waiting.
  ['discarded', getCountdownResult(undefined, now).outcome, 'a recording that is gone was discarded'],
  ['sent', getCountdownResult(done({ status: 'sent' }), now).outcome, 'a sent recording reads as sent'],
  ['boom', getCountdownResult(done({ status: 'failed', error: 'boom' }), now).error,
    'a failed send carries its error to the toast'],
  ['failed', getCountdownResult(done(undefined), now).outcome,
    'a countdown that vanished reads as not sent, never as waiting forever'],
  [null, getCountdownResult(done({ status: 'countdown', sendAt: now + 1000 }), now),
    'still counting down: keep waiting'],
  [null, getCountdownResult(done({ status: 'sending', at: now }), now), 'still sending: keep waiting'],

  // isUnsent: what "Send unsent" picks up.
  [true, isUnsent(done(undefined), 5, now), 'a finished game never sent is unsent'],
  [true, isUnsent(done({ status: 'failed' }), 5, now), 'a failed send is unsent'],
  [true, isUnsent(done({ status: 'sending', at: now - STUCK_AFTER_MS - 1 }), 5, now),
    'a send stuck at sending is unsent'],
  [false, isUnsent(done({ status: 'sent' }), 5, now), 'a sent game is not'],
  [false, isUnsent(done({ status: 'sending', at: now }), 5, now), 'a game being sent right now is not'],
  [false, isUnsent(done({ status: 'countdown', sendAt: now + 5000 }), 5, now),
    'a game counting down is left to its countdown'],
  [false, isUnsent(done(undefined), 0, now), 'an empty recording is never sent'],
  [false, isUnsent({ ...done(undefined), origin: null }, 5, now),
    'a recording with no anchoring snapshot cannot build, so is not sent'],
  [false, isUnsent({ ...done(undefined), buildError: 'unknown patch operation' }, 5, now),
    'a recording whose build failed waits until it builds'],
  [false, isUnsent({ finished: false, lastAt: now - 60_000, origin: {} }, 5, now), 'a match still being played is not'],
  [true, isUnsent({ finished: false, lastAt: now - ABANDONED_AFTER_MS - 1, origin: {} }, 5, now),
    'an open recording silent for half an hour ended unnoticed, and is unsent'],

  // getRecordedFields: a frame writes back only what it found, never the
  // upload or the closed flag that other writers own.
  [false, 'upload' in getRecordedFields({ lastAt: 1, upload: { status: 'sending' } }),
    'a frame never writes back the upload it read'],
  [false, 'finished' in getRecordedFields({ lastAt: 1, finished: false }),
    'a frame never writes back the closed flag it read'],
  [false, 'buildError' in getRecordedFields({ lastAt: 1, buildError: 'x' }),
    'a frame never writes back a build verdict'],
  [7, getRecordedFields({ lastAt: 7, upload: {} }).lastAt, 'a frame does write what it found'],
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
