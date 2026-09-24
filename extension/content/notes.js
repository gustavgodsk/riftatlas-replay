/**
 * In-game notes overlay (fork build).
 *
 * Alt+H, or the small pill bottom-left, toggles a one-line note box. The note is
 * stamped with the game sequence at the moment the note was started and handed to
 * the bridge (content/bridge.js, same isolated world), which queues it behind
 * the frames already on their way to the worker.
 *
 * Alt+P while the box is open (or the pin toggle in the box) marks the note as
 * pinned.
 *
 * Hiding the box (Alt+H or the pill again) keeps the draft: text, pin state and
 * sequence stamp. Reopening a non-empty draft keeps its original sequence; an
 * empty draft takes a fresh one. Only a successful save resets the draft (see
 * content/notes-draft.js).
 *
 * Everything lives in a closed shadow root, and every key pressed inside it
 * stops there, so typing a note never reaches the game - except Escape, which
 * the overlay ignores and leaves to the game (it exits fullscreen).
 */
(() => {
  if (window !== window.top) return;
  const api = () => window.__riftatlasNotes;
  const { openDraft, hideDraft, resetDraft } = globalThis.__riftatlasNoteDraft;
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
    .row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .meta { font-size: 11px; color: #aaa; }
    .pin { margin-left: auto; font-size: 11px; color: #888; cursor: pointer; user-select: none;
      padding: 0 6px; border-radius: 8px; border: 1px solid rgba(255,255,255,.15); }
    .pin.on { color: #ffd54f; border-color: rgba(255,213,79,.6); background: rgba(255,213,79,.12); }
    .err { color: #ff8a80; }
    .toast { position: fixed; left: 12px; bottom: 44px; z-index: 2147483647; padding: 4px 10px;
      border-radius: 12px; background: rgba(20,60,30,.9); color: #dfd; font: 12px/1.4 system-ui, sans-serif; }
  `;

  let host, pill, box, input, meta, pinEl, toast, draft = resetDraft(), pinned = false, saving = false, toastTimer = 0;

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
      <div class="box" hidden><textarea rows="1" maxlength="${MAX}" placeholder="note (Enter saves, Alt+H hides, Alt+P pins)"></textarea><div class="row"><div class="meta"></div><div class="pin" title="pin this note (Alt+P)">&#128204; pin</div></div></div>
      <div class="toast" hidden></div>`;
    pill = root.querySelector('.pill');
    box = root.querySelector('.box');
    input = root.querySelector('textarea');
    meta = root.querySelector('.meta');
    pinEl = root.querySelector('.pin');
    toast = root.querySelector('.toast');

    pill.addEventListener('click', (e) => { e.stopPropagation(); if (box.hidden) { if (ready()) openBox(); } else hideBox(); });
    pinEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the textarea
    pinEl.addEventListener('click', (e) => { e.stopPropagation(); setPinned(!pinned); input.focus(); });
    // Nothing typed in the overlay may reach the game, except Escape (fullscreen exit).
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    }
    input.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP') { e.preventDefault(); setPinned(!pinned); }
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

  function setPinned(on) {
    pinned = on;
    pinEl.classList.toggle('on', on);
    pinEl.innerHTML = on ? '&#128204; pinned' : '&#128204; pin';
  }

  function openBox() {
    if (!host) mount();
    draft = openDraft(draft, api()?.getState().lastSequence);
    input.value = draft.text;
    meta.className = 'meta';
    meta.textContent = Number.isInteger(draft.sequence) ? `seq ${draft.sequence}` : 'no sequence yet';
    setPinned(draft.pinned);
    toast.hidden = true;
    box.hidden = false;
    input.focus();
  }

  // Hide without losing anything: text, pin and sequence come back on reopen.
  function hideBox() {
    draft = hideDraft({ ...draft, pinned }, input.value);
    box.hidden = true;
    input.blur();
  }

  // After a successful save only.
  function clearBox() {
    draft = resetDraft();
    input.value = '';
    setPinned(false);
    box.hidden = true;
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
      const wasPinned = pinned;
      const ack = await notes.enqueueNote(text, draft.sequence, { pinned: wasPinned });
      if (ack?.ok) {
        clearBox();
        showToast(`saved · seq ${ack.sequence ?? '?'}${wasPinned ? ' · pinned' : ''}`);
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
    if (box.hidden) openBox(); else hideBox();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
