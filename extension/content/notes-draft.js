/**
 * Note-box draft state (fork build), kept pure so tests/notes.mjs can check it.
 *
 * A draft is { text, pinned, sequence }. Hiding the box keeps all three; only a
 * successful save resets them. When the box opens on a non-empty draft, the
 * draft keeps the sequence it was started at (the game moment the note is
 * about); an empty draft takes the current sequence instead.
 *
 * Classic script: loaded before content/notes.js and exposed on globalThis.
 */
(() => {
  const resetDraft = () => ({ text: '', pinned: false, sequence: null });

  function openDraft(state, lastSequence) {
    const draft = state ?? resetDraft();
    const current = Number.isInteger(lastSequence) ? lastSequence : null;
    const keep = draft.text.trim() !== '' && Number.isInteger(draft.sequence);
    return { ...draft, sequence: keep ? draft.sequence : current };
  }

  const hideDraft = (state, text) => ({ ...(state ?? resetDraft()), text: String(text ?? '') });

  globalThis.__riftatlasNoteDraft = { openDraft, hideDraft, resetDraft };
})();
