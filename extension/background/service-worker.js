/**
 * Service worker: routes observed frames into the recorder and serves the popup.
 *
 * Holds no match state. MV3 will terminate this worker repeatedly during a
 * match; everything it learns is already in IndexedDB by the time the message
 * handler returns, so a restart is invisible.
 */
import { onFrame, onNote, looksFinished, everyoneLeft, endsWithSocket } from './recorder.js';
import { buildReplay } from './finalise.js';
import { SESSIONS, COMMITS, EXTRAS, REPLAYS, all, get, put, dropRecording, commitsFor, roomOf, isEmptyRecording } from './store.js';
import { exportJson, uploadFilename, nextUploadState } from './upload-core.js';

/**
 * Build a data: URL for a download from raw JSON text. Chunked, because
 * spreading a large array into String.fromCharCode overflows the call stack -
 * which is exactly how the first export silently did nothing at all.
 */
function toDataUrl(jsonText) {
  const bytes = new TextEncoder().encode(jsonText);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:application/json;base64,' + btoa(binary);
}

/** Same, for an arbitrary JSON-able value (the debug dump, which is not a replay). */
function jsonDataUrl(value) {
  return toDataUrl(JSON.stringify(value));
}

/** Rooms whose socket closed or whose log announced a result, awaiting finalise. */
const pendingFinalise = new Set();

const ARMING_SCRIPTS = [
  {
    id: 'riftatlas-replay-arm',
    matches: ['https://play.riftatlas.com/*'],
    js: ['replay-mode/arm.js'],
    runAt: 'document_start',
    world: 'ISOLATED',
  },
  {
    id: 'riftatlas-replay-inject',
    matches: ['https://play.riftatlas.com/*'],
    js: ['replay-mode/inject.js'],
    runAt: 'document_start',
    world: 'MAIN',
  },
];

async function registerArmingScripts() {
  await unregisterArmingScripts();
  // Session storage is closed to content scripts by default, so arm.js would
  // read nothing. Widen it for the pending replay handover.
  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  }).catch(() => {});
  await chrome.scripting.registerContentScripts(ARMING_SCRIPTS);
}

async function unregisterArmingScripts() {
  const ids = ARMING_SCRIPTS.map((s) => s.id);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
  } catch { /* nothing registered */ }
}

// Never carry an arming registration across a browser restart.
chrome.runtime.onStartup.addListener(() => {
  unregisterArmingScripts();
  chrome.storage.session.remove('pendingReplay').catch(() => {});
});

/**
 * Does this failure need a newer version, or is it worth trying again now?
 *
 * A patch verb the reducer has never seen can only be handled by code that
 * knows it, so retrying changes nothing until a new version arrives. Every
 * other failure - a storage hiccup, a worker stopped mid-build - may well
 * succeed on a second attempt, and there is no reason to make anyone wait for a
 * release for those.
 */
function needsNewVersion(problem) {
  return /unknown patch operation/i.test(String(problem));
}

/**
 * Rebuild whatever failed to build, whenever the extension changes.
 *
 * A build fails when the reducer meets something RiftAtlas has added since -
 * and the fix for that arrives as a new version. Asking someone to press
 * Rebuild would be asking them to run the same code twice; retrying on update
 * is the moment it can actually succeed. The recordings were never damaged, so
 * this repairs replays that have been broken for as long as the gap lasted.
 */
async function rebuildFailed(why, { onlyRetryable = false } = {}) {
  const sessions = await all(SESSIONS);
  const broken = sessions.filter((s) => {
    const problem = s.buildError || s.coverageStoppedEarly;
    if (!problem) return false;
    return onlyRetryable ? !needsNewVersion(problem) : true;
  });
  if (!broken.length) return;
  console.info(`[riftatlas-replay] ${why}: rebuilding ${broken.length} replay(s) that failed before`);
  for (const session of broken) await finalise(session.roomCode, { close: false });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'update' || reason === 'install') {
    rebuildFailed(`extension ${reason}`).catch(() => {});
  }
});

// A browser restart is another free moment to retry, and covers an update that
// happened while the browser was closed.
chrome.runtime.onStartup.addListener(() => { rebuildFailed('browser start').catch(() => {}); });

/**
 * Close a recording: mark it done, then build its replay.
 *
 * Closing and building are separate on purpose. Building can fail - a recording
 * that never caught an anchoring snapshot has nothing to build from - and an
 * earlier version left such a recording open forever, so the next match in the
 * same room code was appended to it and the two merged. A recording that has
 * ended is ended whether or not a replay came out of it.
 */
async function finalise(recordingId, { close = true } = {}) {
  if (close) {
    try {
      const session = await get(SESSIONS, recordingId);
      if (session && !session.finished) {
        session.finished = true;
        await put(SESSIONS, session);
      }
    } catch (err) {
      console.warn('[riftatlas-replay] could not close', recordingId, err.message);
    }
  }
  try {
    const replay = await buildReplay(recordingId);
    await put(REPLAYS, { roomCode: recordingId, builtAt: Date.now(), replay });
    const session = await get(SESSIONS, recordingId);
    if (session) {
      const stopped = replay.coverage?.stoppedAt ?? null;
      const had = session.buildError || session.coverageStoppedEarly;
      delete session.buildError;
      // A replay that stopped early is still worth retrying later, for the same
      // reason a failed one is: the missing piece arrives with a new version.
      if (stopped) session.coverageStoppedEarly = stopped.reason;
      else delete session.coverageStoppedEarly;
      if (had || stopped) await put(SESSIONS, session);
    }
    pendingFinalise.delete(recordingId);
    // The recording just closed for good (not an in-progress rebuild): offer
    // it to auto-send, if it is set up and this is the first time (#29).
    if (close) maybeAutoSend(recordingId, session).catch(() => {});
  } catch (err) {
    // Record why, and show it. A build can fail for a reason worth acting on -
    // a patch verb the reducer predates, say - and a console warning nobody
    // reads made that look like a button that simply does nothing.
    console.warn('[riftatlas-replay] could not build', recordingId, err.message);
    try {
      const session = await get(SESSIONS, recordingId);
      if (session) { session.buildError = String(err?.message ?? err); await put(SESSIONS, session); }
    } catch { /* the session is gone */ }
  }
}

// ---- Send to site (#29) --------------------------------------------------
//
// Opt-in, fork-only: off unless someone pastes a site URL and token into the
// popup's settings. See upload-core.js for the pure export/filename/backoff
// logic; everything here is the browser-only glue around it.

const RETRY_ALARM_PREFIX = 'riftatlas-replay-upload-retry:';
const retryAlarmName = (recordingId) => RETRY_ALARM_PREFIX + recordingId;

async function setUpload(recordingId, upload) {
  const session = await get(SESSIONS, recordingId);
  if (!session) return;
  session.upload = upload;
  await put(SESSIONS, session);
}

/**
 * Auto-send fires once, right after a recording closes for good - never for a
 * live match (`close: false` rebuilds do not reach here) and never twice for
 * the same recording (an `upload` already on the session means it has already
 * been sent, or is already mid-retry).
 */
async function maybeAutoSend(recordingId, session) {
  if (!session?.finished || session.upload) return;
  const { siteUpload } = await chrome.storage.local.get('siteUpload');
  if (!siteUpload?.autoSend) return;
  uploadSession(recordingId).catch(() => {});
}

/**
 * POST one recording's export to the configured site. `attempt` is 0 for a
 * fresh call - auto-send, or a person pressing "Send to site" / "Retry" in
 * the popup - and counts up for the automatic backoff retries scheduled
 * below; see `nextUploadState` for the state machine.
 */
async function uploadSession(recordingId, attempt = 0) {
  await chrome.alarms.clear(retryAlarmName(recordingId));

  const { siteUpload } = await chrome.storage.local.get('siteUpload');
  if (!siteUpload?.siteUrl || !siteUpload?.token) return { ok: false, error: 'not configured' };

  // Rebuild first, always - the same rule the download path follows, so an
  // upload is never a replay that fell behind the recording.
  await finalise(recordingId, { close: false });
  const [row, session] = await Promise.all([get(REPLAYS, recordingId), get(SESSIONS, recordingId)]);
  if (!row) return { ok: false, error: 'nothing recorded for this room' };

  const body = exportJson(row.replay);
  const filename = uploadFilename(session, recordingId);

  let ok = false;
  let meta = {};
  try {
    const res = await fetch(`${siteUpload.siteUrl.replace(/\/+$/, '')}/api/replays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${siteUpload.token}`,
        'Content-Type': 'application/json',
        'X-Replay-Filename': filename,
      },
      body,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.outcome?.message || `HTTP ${res.status}`);
    ok = true;
    meta = { matchId: data?.outcome?.matchId ?? null, outcome: data?.outcome ?? null };
  } catch (err) {
    meta = { error: String(err?.message ?? err) };
  }

  const upload = { ...nextUploadState(attempt, ok, meta), at: Date.now() };
  await setUpload(recordingId, upload);
  if (!ok && upload.retryDelayMs != null) {
    chrome.alarms.create(retryAlarmName(recordingId), { when: Date.now() + upload.retryDelayMs });
  }
  return ok ? { ok: true, upload } : { ok: false, error: upload.error, upload };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RETRY_ALARM_PREFIX)) return;
  const recordingId = alarm.name.slice(RETRY_ALARM_PREFIX.length);
  get(SESSIONS, recordingId).then((session) => {
    uploadSession(recordingId, session?.upload?.attempts ?? 0).catch(() => {});
  });
});

/**
 * The room whose frames we saw last. A different one means the previous match
 * is over, whatever its log did or did not say.
 */
let currentRoom = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'observer') {
    if (msg.kind === 'frame') {
      // Acknowledge only once the frame is persisted, and keep the port open
      // until then by returning true.
      //
      // This is the frame-loss bug. Handling the frame without an
      // acknowledgement and returning false told Chrome the listener was done,
      // so sendMessage resolved before anything reached IndexedDB. The bridge
      // counted the frame delivered and moved on, and if the worker was then
      // stopped mid-write - which MV3 does freely - the frame was gone with
      // nothing to retry. One real match lost 28 commits that way and replayed
      // as nine moves out of 396.
      onFrame(msg).then(async (result) => {
        sendResponse({ ok: true });
        if (!result) return;
        const { id: roomCode, reopened } = result;

        // A frame arriving on a closed recording reopens it, and the room it
        // belongs to is not the room being played now - so leave `currentRoom`
        // alone. Whether it is over is decided below, on the evidence, rather
        // than assumed from the fact that it was closed once already: the
        // close may have been the mistake.
        if (!reopened) {
          // A new room started: whatever came before it is finished.
          if (currentRoom && currentRoom !== roomCode) {
            const previous = currentRoom;
            currentRoom = roomCode;
            await finalise(previous);
          } else {
            currentRoom = roomCode;
          }
        }

        // Everyone has left the room. Steadier than reading the log, and the
        // reason finalisation no longer hangs on spotting a victory line.
        const session = await get(SESSIONS, roomCode);
        if (everyoneLeft(session)) { await finalise(roomCode); return; }

        // Last and least: the log looks like an ending. Only a hint - it has
        // been wrong before, and a closing socket rebuilds regardless.
        try {
          if (looksFinished(JSON.parse(msg.data))) { await finalise(roomCode); return; }
        } catch { /* already filtered by onFrame */ }

        // Nothing says it has ended. If this frame reopened it, rebuild so the
        // arrival is not stranded in a replay built without it, and let it run.
        if (reopened) await finalise(roomCode, { close: false });
      }).catch((error) => {
        // Nothing was stored. Say so, so the bridge sends it again.
        sendResponse({ ok: false, error: String(error?.message ?? error) });
      });
      return true;
    }

    if (msg.kind === 'note') {
      // An in-game note. Acknowledged only once stored, like a frame. A note on
      // a finished recording rebuilds its replay in the background so the note
      // is in it; the recording stays finished.
      onNote(msg).then((result) => {
        const { rebuild, ...response } = result;
        sendResponse(response);
        if (rebuild) finalise(rebuild, { close: false }).catch(() => {});
      }).catch((error) => {
        sendResponse({ ok: false, error: String(error?.message ?? error) });
      });
      return true;
    }

    if (msg.kind === 'close') {
      // Only the recording this socket was feeding has ended.
      //
      // The observer watches every `/parties/` socket, and RiftAtlas keeps
      // several open at once - lobby, queue, the match itself. This used to
      // close *every* recording on any of them closing, which ended live
      // matches from across the room: two in one evening were cut in half
      // mid-play, and the half that followed had no snapshot to anchor on, so
      // it built into a replay that could not move off its final state.
      //
      // Everything else is still rebuilt, because an early finalise - the
      // initiative roll once read as a victory - must never be the last word,
      // or the replay stays frozen wherever the detector misfired. An unknown
      // socket closes nothing: the other end triggers will finish the match,
      // and leaving a recording open costs far less than ending a live one.
      all(SESSIONS).then((sessions) => {
        for (const s of sessions) {
          finalise(s.roomCode, { close: endsWithSocket(s, msg.socketId) });
        }
      });
    }
    return false;
  }

  if (msg?.type === 'list') {
    // Retry anything that could succeed without a new version, and finish
    // before listing, so a recording that just repaired itself is not still
    // shown as broken. Costs nothing when there is nothing to retry, which is
    // the usual case.
    rebuildFailed('popup opened', { onlyRetryable: true })
      .catch(() => {})
      .then(() => all(SESSIONS))
      .then(async (sessions) => {
      const replays = await all(REPLAYS);
      const built = new Map(replays.map((r) => [r.roomCode, r]));
      // One pass over the commits rather than a range query per recording:
      // with a long history that difference is the popup feeling instant or not.
      const counts = new Map();
      for (const c of await all(COMMITS)) {
        counts.set(c.roomCode, (counts.get(c.roomCode) ?? 0) + 1);
      }
      // A session that has caught nothing is not a recording, and is never
      // listed. Ending a match is the usual way one appears: finalise closes
      // the recording, then the trailing frames - a shell sync as the client
      // returns to the room - find no open recording and start an empty one,
      // which then sits above the real match wearing the same room code.
      //
      // They are hidden immediately and deleted once they cannot still be a
      // match in the act of starting: a shell sync does arrive a beat before
      // the opening snapshot, and in that beat the two look identical.
      const SETTLE_MS = 2 * 60 * 1000;
      const now = Date.now();
      const live = [];
      for (const s of sessions) {
        if (!isEmptyRecording(s, counts.get(s.roomCode))) { live.push(s); continue; }
        if (now - (s.lastAt ?? 0) > SETTLE_MS) dropRecording(s.roomCode).catch(() => {});
      }

      const rows = await Promise.all(live
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(async (s) => {
          const replay = built.get(s.roomCode)?.replay ?? null;
          const recorded = counts.get(s.roomCode) ?? 0;
          return {
            roomCode: s.roomCode,               // the recording id, used by actions
            room: s.room ?? roomOf(s.roomCode),  // the code a person recognises
            startedAt: s.startedAt,
            lastAt: s.lastAt,
            finished: s.finished === true,
            partial: s.partial === true,
            hasReplay: !!replay,
            builtAt: built.get(s.roomCode)?.builtAt ?? null,
            recordedCommits: recorded,
            builtCommits: replay?.commits?.length ?? 0,
            // A built replay can fall behind its recording - an early finalise
            // once froze one at the dice roll while recording carried on. Say
            // so rather than letting a short replay look like a short match.
            stale: !!replay && replay.commits.length < recorded
              && !replay.coverage?.unanchored,
            unanchored: replay?.coverage?.unanchored ?? null,
            match: replay?.match ?? null,
            players: replay?.players ?? null,
            viewerPlayerId: replay?.viewer?.playerId ?? null,
            buildError: s.buildError ?? null,
            stoppedEarly: replay?.coverage?.stoppedAt ?? null,
            needsNewVersion: needsNewVersion(s.buildError || s.coverageStoppedEarly || ''),
            upload: s.upload ?? null,
          };
        }));
      sendResponse(rows);
    });
    return true;
  }

  if (msg?.type === 'export') {
    (async () => {
      // Rebuild first, always. A replay built earlier in the match can be
      // behind the recording, and exporting a stale one is how a complete
      // recording leaves as a short replay.
      await finalise(msg.roomCode, { close: false });
      const row = await get(REPLAYS, msg.roomCode);
      if (!row) return sendResponse({ ok: false, error: 'nothing recorded for this room' });
      // A data: URL keeps the download entirely local; no blob URL, no fetch.
      const url = toDataUrl(exportJson(row.replay));
      chrome.downloads.download({ url, filename: `${msg.roomCode}.ratlas.json`, saveAs: true },
        () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }));
      return;
    })();
    return true;
  }

  if (msg?.type === 'finalise') {
    // Rebuilding is not the same as ending: a match still in progress must stay
    // open so its later frames keep landing in the same recording.
    finalise(msg.roomCode, { close: false }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'delete') {
    dropRecording(msg.roomCode).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'upload_session') {
    // A person pressing "Send to site" or "Retry" - always attempt 0, so a
    // manual retry gets the full backoff sequence again (#29).
    uploadSession(msg.roomCode).then((result) => sendResponse(result));
    return true;
  }

  if (msg?.type === 'get_upload_settings') {
    chrome.storage.local.get('siteUpload').then(({ siteUpload }) => sendResponse(siteUpload ?? null));
    return true;
  }

  if (msg?.type === 'set_upload_settings') {
    chrome.storage.local.set({ siteUpload: msg.siteUpload }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'replayMode') {
    (async () => {
      const row = await get(REPLAYS, msg.roomCode);
      if (!row) return sendResponse({ ok: false, error: 'build the replay first' });

      const [tab] = await chrome.tabs.query({ url: 'https://play.riftatlas.com/*' });
      if (!tab) {
        return sendResponse({ ok: false, error: 'open play.riftatlas.com first' });
      }

      // Replay mode must install before the page opens its match socket, about
      // two seconds into load. So park the replay, register the arming scripts
      // at document_start, and reload the tab - arming after the fact loses the
      // race and replay mode rightly refuses to displace a real socket.
      await chrome.storage.session.set({ pendingReplay: row.replay });
      await registerArmingScripts();
      await chrome.tabs.update(tab.id, { active: true, url: 'https://play.riftatlas.com/game' });
      sendResponse({ ok: true, roomCode: msg.roomCode });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'replayModeArmed') {
    // Armed exactly once; take the scripts back out so replay mode is not
    // sitting on every future page load.
    unregisterArmingScripts();
    return false;
  }

  if (msg?.type === 'dump') {
    // Everything the recorder holds, for a bug report: raw commits and
    // snapshots included, so a recording that will not finalise can still be
    // diagnosed. Carries decklists and player names, but no credentials -
    // handshake frames are dropped before anything is stored.
    (async () => {
      try {
        const dump = {
          dumpedAt: new Date().toISOString(),
          extensionVersion: chrome.runtime.getManifest().version,
          sessions: await all(SESSIONS),
          commits: await all(COMMITS),
          extras: await all(EXTRAS),
          replays: await all(REPLAYS),
        };
        chrome.downloads.download(
          { url: jsonDataUrl(dump), filename: 'riftatlas-replay-debug.json', saveAs: false },
          () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }));
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'clearRoomState') {
    // Forget whatever room the client thinks it is in. The way out of
    // "Couldn't reconnect to your game" when a replay left its room behind.
    (async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://play.riftatlas.com/*' });
      if (!tab) return sendResponse({ ok: false, error: 'open play.riftatlas.com first' });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          localStorage.removeItem('riftbound_simulator_last_room');
          sessionStorage.removeItem('riftbound_simulator_active_room');
        },
      });
      await chrome.tabs.update(tab.id, { active: true, url: 'https://play.riftatlas.com/' });
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'openPlayer') {
    chrome.tabs.create({ url: chrome.runtime.getURL('player/player.html') });
    return false;
  }

  return false;
});

void pendingFinalise;
