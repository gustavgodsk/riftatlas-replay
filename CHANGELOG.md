# Changelog

What changed in each released version, in the words a player would use. The
Chrome Web Store has no changelog field, so this is the record, and the source
for the "What's new" block in the listing description.

## 0.6.3.2 (fork build)

- **Fixed: a finished match could be sent to the site twice.** Several
  things can decide a match just ended at almost the same moment, and each
  one used to start its own send before the first had a chance to say it was
  already sending - so the site sometimes got two identical uploads a
  millisecond apart. Only the first now goes through; the popup shows
  "sending…" while it is in flight, and turns it back into a Retry button if
  a send is still "sending" two minutes later (Chrome stopped it mid-way).

## 0.6.3.0 (fork build)

- **Send finished matches straight to the site.** Opt-in: paste your site's
  URL and a token (created on its Settings page) into the popup's "Send to
  site" section, then press **Send to site** on any recording, or turn on
  "Send automatically" to have it happen the moment a match finishes. Never
  sends anything unless you set this up - this is a fork-only feature and does
  not change what the extension does otherwise. A failed send retries a few
  times on its own (5s, 30s, 2min) and can always be retried by hand
  afterwards; the popup shows sent / failed / not-sent for each recording.
- **Fixed: the popup no longer shows two scrollbars.** Only the recordings
  list scrolls now; the popup itself never does.

## 0.6.2.3 (fork build)

- **Alt+H toggles the note box.** Press Alt+H (or click the pill) again to hide
  it. Hiding keeps what you typed, the pin, and the game moment the note was
  started; reopening shows them unchanged. The draft is cleared only when Enter
  saves it.
- **Escape belongs to the game again.** The note box no longer uses Esc, so Esc
  exits fullscreen as usual even while the box is open.

## 0.6.2.2 (fork build)

- **Pinned notes.** While the note box is open, press Alt+P (or click the
  "pin" toggle in the box) to pin the note. Every note starts unpinned. Pinned
  notes show "pinned" in the saved toast and are exported with
  `pinned: true`; every note in `notes[]` now carries `pinned`.

## 0.6.2.1 (fork build)

- **In-game notes.** Press Alt+H during a match (or click the small "note" pill
  bottom-left), type a line, press Enter. The note is stamped with the game
  moment the box opened, kept with the recording, and exported as `notes[]`
  in the replay file. Esc cancels; Shift+Enter adds a line.

## 0.6.2

- Removed the `tabs` permission. Nothing needed it, and it read as access to
  every tab you have open. The extension asks for three permissions now instead
  of four, and only ever touches the RiftAtlas tab its host permission covers.

## 0.6.1

- **Matches are no longer cut in half.** RiftAtlas keeps several connections
  open at once, and any of them closing — the lobby, not your game — ended
  whatever match was being recorded. The half that followed had nothing to
  anchor on, so it built into a replay stuck on its final position. Only the
  connection carrying your match can end its recording now.
- A replay holding nothing but the final position says so, instead of offering
  a Rebuild that cannot help.
- **The dice roll is no longer read as a win.** "EagleV wins initiative (15 vs
  1)" was being taken as the result, so a match that ended with nothing recorded
  was credited to whoever won the roll. A match with no ending now honestly
  shows none.

## 0.6.0

- **Best-of-three results are recorded properly.** A game settled by the winner
  prompt that appears when you press "Next game" ends with nothing in its own
  log — no victory line, no concession, no winning score. The result is read
  from the series instead. The last game of a series still has to end in the
  game.
- A match's final action arriving just after the next game's room opens now
  lands in the match it belongs to, rather than being dropped.

## 0.5.0 and earlier

Development before the first store submission: the recorder, the standalone
player, replay mode inside RiftAtlas' own board, the popup, and the packaging
and publishing tooling.
