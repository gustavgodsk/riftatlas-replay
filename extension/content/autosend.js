/**
 * Auto-send countdown toast.
 *
 * "Send automatically" no longer sends the instant a match finishes: the
 * background arms a ten-second countdown instead (background/upload-core.js
 * AUTO_SEND_COUNTDOWN_MS, background/service-worker.js armCountdown /
 * resolveCountdown) and this shows it, bottom-right, with two ways out -
 * "Send now" (send immediately) and "Discard" (drop the recording; the game
 * is never uploaded, and no local copy of it is kept either - the same as
 * pressing Delete in the popup). Doing nothing sends when the countdown
 * reaches zero, exactly what auto-send always did.
 *
 * The deadline itself lives in the background, against a chrome.alarm, not a
 * timer in this page: a closed or navigated tab must not stop the send this
 * toast stands in for, and only the background outlives the tab. This is
 * purely the view onto that - it ticks down from an absolute deadline
 * (`sendAt`) rather than counting seconds itself, so a late-arriving message
 * or a page reloaded mid-countdown still shows the right number, and
 * `get_active_countdowns` on mount recovers a countdown that was already
 * running before this page (or this content script) existed.
 *
 * Only one toast at a time: a game that finishes while one is already
 * showing queues behind it. A queued game's own ten seconds is not paused
 * for that - it is armed in the background the moment it is queued - so it
 * can resolve (send, by default) before its toast ever gets a turn; that
 * shows up as a brief result instead of a live countdown once it does.
 */
(() => {
  if (window !== window.top) return;

  const CSS = `
    :host { all: initial; }
    .toast { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: 230px;
      padding: 10px 12px; border-radius: 10px; box-sizing: border-box;
      background: rgba(20,20,24,.92); border: 1px solid rgba(255,255,255,.2);
      color: #eee; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    .toast[hidden] { display: none; }
    .msg { margin-bottom: 8px; }
    .msg.result.ok { color: #b7f5b0; font-weight: 600; }
    .msg.result.err { color: #ff8a80; font-weight: 600; }
    .count { font-weight: 600; color: #ffd54f; }
    .row[hidden] { display: none; }
    .row { display: flex; gap: 8px; }
    button { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.08); color: #eee; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: rgba(255,255,255,.16); }
    button.discard { border-color: rgba(255,138,128,.4); color: #ff8a80; }
    button:disabled { opacity: .5; cursor: default; }
  `;

  let host, toast, msg, row, sendBtn, discardBtn;
  /** The countdown currently on screen: `{ recordingId, room, sendAt }`, or null. */
  let current = null;
  /** Countdowns waiting for their turn, oldest first. */
  const queue = [];
  /** Results that arrived for a countdown before it ever became `current`. */
  const resolvedWhileQueued = new Map();
  let tickTimer = 0;
  let settleTimer = 0;

  function mount() {
    if (host) return;
    host = document.createElement('riftatlas-autosend');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="toast" hidden>
        <div class="msg"></div>
        <div class="row">
          <button class="send">Send now</button>
          <button class="discard">Discard</button>
        </div>
      </div>`;
    toast = root.querySelector('.toast');
    msg = root.querySelector('.msg');
    row = root.querySelector('.row');
    sendBtn = root.querySelector('.send');
    discardBtn = root.querySelector('.discard');
    sendBtn.addEventListener('click', () => act('autosend_send_now'));
    discardBtn.addEventListener('click', () => act('autosend_discard'));
    document.documentElement.appendChild(host);
  }

  function tick() {
    if (!current) return;
    const remainingMs = current.sendAt - Date.now();
    if (remainingMs <= 0) {
      // The deadline is here; the background is the one actually sending.
      // Reflect the wait for its result rather than counting past zero.
      showBusy('Sending…');
      return;
    }
    const remaining = Math.ceil(remainingMs / 1000);
    msg.className = 'msg';
    msg.textContent = '';
    msg.append('Sending game in ', Object.assign(document.createElement('span'),
      { className: 'count', textContent: String(remaining) }), '…');
  }

  function showBusy(text) {
    clearInterval(tickTimer);
    msg.className = 'msg';
    msg.textContent = text;
    sendBtn.disabled = true;
    discardBtn.disabled = true;
  }

  function showResult(outcome, error) {
    clearInterval(tickTimer);
    const text = outcome === 'discarded' ? 'Discarded'
      : outcome === 'sent' ? 'Sent'
      : `Not sent — ${error ?? 'failed'}`;
    msg.className = `msg result ${outcome === 'failed' ? 'err' : 'ok'}`;
    msg.textContent = text;
    row.hidden = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      row.hidden = false;
      current = null;
      showNext();
    }, 1500);
  }

  function showCurrent() {
    mount();
    clearInterval(tickTimer);
    clearTimeout(settleTimer);
    sendBtn.disabled = false;
    discardBtn.disabled = false;
    row.hidden = false;
    toast.hidden = false;

    const already = resolvedWhileQueued.get(current.recordingId);
    if (already) {
      resolvedWhileQueued.delete(current.recordingId);
      showResult(already.outcome, already.error);
      return;
    }
    tick();
    tickTimer = setInterval(tick, 250);
  }

  function showNext() {
    current = queue.shift() ?? null;
    if (current) showCurrent();
    else if (toast) toast.hidden = true;
  }

  async function act(type) {
    if (!current) return;
    showBusy(type === 'autosend_discard' ? 'Discarding…' : 'Sending…');
    try {
      await chrome.runtime.sendMessage({ type, recordingId: current.recordingId });
      // The result lands as its own 'autosend_resolved' message; nothing more
      // to do here even on success.
    } catch {
      // Extension reloaded or the worker could not be reached. The
      // background is still the source of truth for whether this actually
      // got sent - it holds the alarm regardless of this page.
      msg.textContent = 'Could not reach the extension — it will still send on its own.';
    }
  }

  function enqueue(entry) {
    if (current?.recordingId === entry.recordingId) return;
    if (queue.some((q) => q.recordingId === entry.recordingId)) return;
    if (!current) { current = entry; showCurrent(); }
    else queue.push(entry);
  }

  function resolved(recordingId, outcome, error) {
    if (current?.recordingId === recordingId) {
      showResult(outcome, error);
      return;
    }
    const at = queue.findIndex((q) => q.recordingId === recordingId);
    if (at >= 0) {
      // Never shown yet - remember the result so it flashes briefly once its
      // turn comes up, instead of showing a countdown for a game that is
      // already gone.
      queue.splice(at, 1);
      resolvedWhileQueued.set(recordingId, { outcome, error });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'autosend_countdown') {
      enqueue({ recordingId: message.recordingId, room: message.room, sendAt: message.sendAt });
    } else if (message?.type === 'autosend_resolved') {
      resolved(message.recordingId, message.outcome, message.error);
    }
  });

  // Recover a countdown already in flight: this page (or this content
  // script) did not exist yet when it was armed, so no 'autosend_countdown'
  // message was ever sent for it.
  function recover() {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'get_active_countdowns' })
      .then((rows) => { for (const active of rows ?? []) enqueue(active); })
      .catch(() => { /* extension reloaded; nothing to recover from here */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', recover, { once: true });
  else recover();
})();
