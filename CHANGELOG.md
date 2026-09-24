# Changelog

What changed in each released version, in the words a player would use. The
Chrome Web Store has no changelog field, so this is the record, and the source
for the "What's new" block in the listing description.

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
