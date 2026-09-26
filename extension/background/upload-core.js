/**
 * Pure logic for sending a finished replay straight to the site (#29): the
 * export string shared with the download path, the default filename, and the
 * retry/backoff state machine. No chrome or DOM dependency, so it is unit
 * tested directly - see tests/upload.mjs.
 *
 * Everything that actually touches the network, chrome.storage or
 * chrome.alarms lives in service-worker.js, the only place in this extension
 * that is allowed to depend on the browser being there.
 */
import { roomOf, isEmptyRecording } from './store.js';

/** The exact JSON text both the download and the upload send, so they can never drift apart. */
export function exportJson(replay) {
  return JSON.stringify(replay);
}

/** `<roomCode>.ratlas.json` - the same default name the download path already used. */
export function uploadFilename(session, recordingId) {
  return `${session?.room ?? roomOf(recordingId)}.ratlas.json`;
}

/** 5s, 30s, 2min: up to three automatic retries after the first failed attempt. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

/**
 * What a session's `upload` field should hold after one attempt, and how long
 * to wait before the next one - or `retryDelayMs: null` once the automatic
 * retries are exhausted, left as `status: 'failed'` for a person to retry by
 * hand.
 *
 * `attempt` is 0 for a fresh call - the auto-send trigger, or a person
 * pressing "Send to site" / "Retry" in the popup - and counts up by one on
 * each automatic retry that follows a failure. A manual retry always passes
 * `attempt: 0`, so it gets the full backoff sequence again rather than
 * picking up wherever the automatic retries left off.
 */
export function nextUploadState(attempt, ok, meta = {}) {
  if (ok) return { status: 'sent', retryDelayMs: null, ...meta };
  const attempts = attempt + 1;
  const retryDelayMs = attempts <= RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempts - 1] : null;
  return { status: 'failed', attempts, retryDelayMs, ...meta };
}

/**
 * Should this just-finished recording be offered to auto-send (#54)?
 *
 * Never for a recording still in progress, or one already sent/sending/retried
 * (`session.upload` set) - the guards `maybeAutoSend` always had. New here:
 * never for an *empty* recording either - `commitCount` 0, the same signal
 * `isEmptyRecording` uses to hide these from the popup. A room can be opened
 * (a `room_shell_sync`, or a stray reconnect) without a single move ever being
 * made in it - most often the residue of a Bo3 "next game" room that opened
 * the instant the previous game ended and was then abandoned - and that used
 * to reach the site as a real "game": 0-0, no result, but a row all the same,
 * quietly wrecking that Bo3's math (a real game 2 read as a decided series
 * closing early, or a Bo3 that was really only ever a Bo1). Finally, "send
 * automatically" itself has to be turned on.
 *
 * A *real* game that ends 0-0 - someone left before either side scored -
 * still has commits (turns were taken) and is not caught by this: that is a
 * genuine loss for the leaver, worth keeping.
 */
export function shouldAutoSend(session, commitCount, siteUpload) {
  if (!session?.finished || session.upload) return false;
  if (isEmptyRecording(session, commitCount)) return false;
  return siteUpload?.autoSend === true;
}
