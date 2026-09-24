/**
 * In-game notes overlay (fork build).
 *
 * Alt+H, or the small pill bottom-left, opens a one-line note box. The note is
 * stamped with the game sequence at the moment the box opened and handed to
 * the bridge (content/bridge.js, same isolated world), which queues it behind
 * the frames already on their way to the worker.
 *
 * Everything lives in a closed shadow root, and every key pressed inside it
 * stops there, so typing a note never reaches the game.
 */
(() => {
  if (window !== window.top) return;
  const api = () => window.__riftatlasNotes;
  const MAX = 1000;

  const CSS = `
    :host { all: initial; }
    .pill { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647;
      height: 24px; padding: 0 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.25);
      background: rgba(20,20,24,.72); color: #eee; font: 12px/22px system-ui, sans-serif;
      cursor: pointer; user-select: none; opacity: .75; }
    .pill:hover { opacity: 1; }
    .pill.off { opacity: .35; cursor: default; }
    .box { position: fixed; left: 12px; bottom: 44px; z-index: 2147483647; width: 360px;
      max-width: calc(100vw - 24px); padding: 8px; border-radius: 8px;
      background: rgba(20,20,24,.9); border: 1px solid rgba(255,255,255,.2);
      color: #eee; font: 13px/1.35 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    .box[hidden], .toast[hidden] { display: none; }
    textarea { box-sizing: border-box; width: 100%; min-height: 28px; max-height: 120px; resize: vertical;
      background: rgba(0,0,0,.35); color: #fff; border: 1px solid rgba(255,255,255,.2);
      border-radius: 4px; padding: 4px 6px; font: inherit; outline: none; }
    .meta { margin-top: 4px; font-size: 11px; color: #aaa; }
    .err { color: #ff8a80; }
    .toast { position: fixed; left: 12px; bottom: 44px; z-index: 2147483647; padding: 4px 10px;
      border-radius: 12px; background: rgba(20,60,30,.9); color: #dfd; font: 12px/1.4 system-ui, sans-serif; }
  `;

  let host, pill, box, input, meta, toast, seqAtOpen = null, saving = false, toastTimer = 0;

  const ready = () => {
    const s = api()?.getState();
    return !!s?.hasMatch && Number.isInteger(s.lastSequence);
  };

  function mount() {
    if (host) return;
    host = document.createElement('riftatlas-notes');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="pill off" title="no match yet">&#9998; note</div>
      <div class="box" hidden><textarea rows="1" maxlength="${MAX}" placeholder="note (Enter saves, Esc cancels)"></textarea><div class="meta"></div></div>
      <div class="toast" hidden></div>`;
    pill = root.querySelector('.pill');
    box = root.querySelector('.box');
    input = root.querySelector('textarea');
    meta = root.querySelector('.meta');
    toast = root.querySelector('.toast');

    pill.addEventListener('click', (e) => { e.stopPropagation(); if (ready()) openBox(); });
    // Nothing typed in the overlay may reach the game.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeBox(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
    });
    document.documentElement.appendChild(host);
    setInterval(refreshPill, 1000);
    refreshPill();
  }

  function refreshPill() {
    const on = ready();
    pill.classList.toggle('off', !on);
    pill.title = on ? 'add a note (Alt+H)' : 'no match yet';
  }

  function openBox() {
    if (!host) mount();
    seqAtOpen = api()?.getState().lastSequence ?? null;
    meta.className = 'meta';
    meta.textContent = Number.isInteger(seqAtOpen) ? `seq ${seqAtOpen}` : 'no sequence yet';
    toast.hidden = true;
    box.hidden = false;
    input.focus();
  }

  function closeBox() {
    box.hidden = true;
    input.value = '';
    input.blur();
  }

  async function save() {
    if (saving) return;
    const text = input.value.trim();
    if (!text) { showError('empty note'); return; }
    if (text.length > MAX) { showError(`over ${MAX} characters`); return; }
    const notes = api();
    if (!notes) { showError('recorder not loaded, reload the page'); return; }
    saving = true;
    meta.className = 'meta';
    meta.textContent = 'saving...';
    try {
      const ack = await notes.enqueueNote(text, seqAtOpen);
      if (ack?.ok) {
        closeBox();
        showToast(`saved · seq ${ack.sequence ?? '?'}`);
      } else {
        showError(ack?.error ?? 'not saved');
      }
    } catch (err) {
      showError(String(err?.message ?? err));
    } finally {
      saving = false;
    }
  }

  function showError(message) {
    meta.className = 'meta err';
    meta.textContent = message;
    input.focus();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 1500);
  }

  function typingElsewhere(target) {
    if (!target || target === host) return false;
    return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '');
  }

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyH') return;
    if (typingElsewhere(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!host) mount();
    if (box.hidden) openBox(); else input.focus();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
