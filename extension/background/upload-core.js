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
 * How long the auto-send countdown toast waits before sending by default.
 * Ten seconds is enough to notice the toast and hit Discard for a game that
 * should not be kept - an opponent who left before it really started, say -
 * without turning "send automatically" into something that has to be
 * babysat every game.
 */
export const AUTO_SEND_COUNTDOWN_MS = 10_000;

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
 * Should this just-finished recording be armed for auto-send (#54)?
 *
 * "Armed" rather than sent outright: a positive answer starts the countdown
 * toast (service-worker.js `armCountdown`), not the upload itself - see
 * AUTO_SEND_COUNTDOWN_MS. The countdown sets `session.upload.status` to
 * `'countdown'` as soon as it starts, so this still only ever answers yes
 * once per recording.
 *
 * Never for a recording still in progress, or one already
 * sent/sending/counting-down/retried (`session.upload` set) - the guards
 * `maybeAutoSend` always had. New here:
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

/**
 * How long a 'sending' or an overdue countdown may stand before it counts as
 * stuck. Either one hides the Send button, and the worker that would have
 * finished it can be gone - MV3 stops it freely, mid-fetch included.
 */
export const STUCK_AFTER_MS = 120_000;

/** An open recording this long without a frame is a match that ended unnoticed. */
export const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * The upload state as the popup, the toast and backfill should treat it: a
 * 'sending' or 'countdown' nothing is coming back to finish reads as 'failed',
 * so it can be sent again.
 */
export function getShownUpload(upload, now) {
  if (upload?.status === 'sending' && now - (upload.at ?? 0) > STUCK_AFTER_MS) {
    return { status: 'failed', error: 'Upload interrupted - click to retry' };
  }
  if (upload?.status === 'countdown' && now - (upload.sendAt ?? 0) > STUCK_AFTER_MS) {
    return { status: 'failed', error: 'Auto-send never finished - click to retry' };
  }
  return upload ?? null;
}

/**
 * How an auto-send countdown ended, for the toast: `{outcome, error?}`, or null
 * while it is still counting down or sending. A recording that is gone was
 * discarded.
 */
export function getCountdownResult(session, now) {
  if (!session) return { outcome: 'discarded' };
  const upload = getShownUpload(session.upload, now);
  if (upload?.status === 'sent') return { outcome: 'sent' };
  if (upload?.status === 'failed') return { outcome: 'failed', error: upload.error ?? null };
  if (!upload) return { outcome: 'failed', error: 'not sent - use Send to site in the popup' };
  return null;
}

/**
 * Should "Send unsent" send this recording?
 *
 * Every recording that holds a game and has not reached the site: closed, or
 * open but silent long enough to be a match that ended without the extension
 * noticing. Never one being sent or counted down right now, and never one
 * that cannot build - no anchoring snapshot, or a build that failed - since
 * there is nothing to send until it does. The site dedupes
 * on room and capture time, so a recording that did arrive but lost its 'sent'
 * mark only comes back as a duplicate.
 */
export function isUnsent(session, commitCount, now) {
  if (!commitCount || !session.origin || session.buildError) return false;
  if (!isClosed(session, now)) return false;
  const status = getShownUpload(session.upload, now)?.status;
  return status !== 'sent' && status !== 'sending' && status !== 'countdown';
}

/** Has this recording ended, whether or not anything closed it? */
function isClosed(session, now) {
  return session.finished === true || now - (session.lastAt ?? 0) > ABANDONED_AFTER_MS;
}

/** Stop "Send unsent" after this many failures in a row: the site or the token is down, not one game. */
export const BACKFILL_MAX_FAILURES_IN_A_ROW = 3;
