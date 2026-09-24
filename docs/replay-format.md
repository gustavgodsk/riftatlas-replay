# Replay file format (`.ratlas.json`)

A replay is a single JSON document. Design goals, in priority order:

1. **Faithful** — reduces to exactly the state the server had.
2. **Honest** — records what the capture could not see, rather than hiding it.
3. **Self-contained** — replayable with no network access and no RiftAtlas account.
4. **Safe to share** — contains no credentials and no more identity than the
   match itself displayed.

## Why store commits, not snapshots

The obvious design records periodic snapshots. Measured against the reference
capture, that is the wrong choice: six snapshots cost 232 KiB while the 369
commits encoding the entire match cost 522 KiB — and the commits also carry the
*cause* of each transition, which snapshots discard.

So a replay stores **the sequence-0 snapshot plus every commit**, and re-derives
intermediate states on load. Later snapshots are kept only where the commit chain
is broken and a snapshot is the sole way to continue (see `gaps`). A 20-minute
match lands at roughly 550 KiB uncompressed, well under 150 KiB gzipped.

## Structure

```jsonc
{
  "format": "riftatlas-replay",
  "version": 1,

  "match": {
    "roomCode": "3NKJ3",
    "capturedAt": "2026-09-16T04:00:29.759Z",
    "durationMs": 1161974,
    "gameVariant": "duel",
    "playMode": "constructed",
    "matchFormat": "bo1",
    "deckRulesMode": "standard",
    "roomOrigin": "matchmaking",
    "setupOrderVersion": 2,
    "outcome": { "winnerPlayerId": "plr_135347f2", "reason": "concession" }
  },

  // What this recording could and could not see. Never omit.
  "viewer": {
    "role": "player",              // "player" | "spectator"
    "playerId": "plr_135347f2",
    "fogOfWar": true,              // opposing hidden zones were masked
    "maskedZonesByPlayer": { "plr_72272ae6": ["deck", "hand", "runeDeck"] }
  },

  "players": [
    {
      "id": "plr_72272ae6", "seat": 0, "name": "BertoC",
      "decklistRaw": null,         // null when the capture did not expose it
      "finalScore": 8,
      "thinkTimeMs": 383609
    },
    {
      "id": "plr_135347f2", "seat": 1, "name": "EagleV",
      "decklistRaw": "Legend:\n1 Zed, Master of Shadows [VEN-191]\n…",
      "finalScore": 7,
      "thinkTimeMs": 741606
    }
  ],

  // The room shell document as the server sent it, credentials stripped. Not
  // needed to render a replay ourselves, but it is what puts RiftAtlas' own
  // client into the game view, so a replay can be handed to their UI.
  "shell": { "roomCode": "3NKJ3", "viewer": { }, "selfPlayer": { }, "publicPlayers": [] },

  // Base state. Exactly an `authoritative_snapshot` payload.
  "origin": {
    "sequence": 0,
    "snapshot": { /* … */ },
    "gameplayLog": [],
    "actionClock": { /* … */ }
  },

  // Ordered commits. `t` is ms since the first captured frame; everything else
  // is the wire payload with transport fields stripped.
  "commits": [
    {
      "t": 5646,
      "baseSequence": 0,
      "sequence": 1,
      "action": { "type": "select_battlefield", "battlefield": "Abandoned Hall" },
      "operations": [ /* … */ ],
      "actionClock": { /* … */ }
    }
  ],

  // Breaks in the commit chain. A player MUST surface these in the UI.
  "gaps": [
    {
      "fromSequence": 368,
      "toSequence": 369,
      "missingCommits": 1,
      "reason": "resync_required",
      "recovery": "snapshot",
      "snapshot": { /* authoritative_snapshot payload at 369 */ }
    }
  ],

  "chat": [
    { "at": 1789532387166, "authorPlayerId": "plr_135347f2", "text": "ggg" }
  ],

  "notes": [
    { "id": "3f1c…", "at": 1789532101000, "t": 412000, "sequence": 187, "text": "should have held the gear", "pinned": false }
  ]
}
```

## Field rules

**`notes[]`** is additive and optional (fork build 0.6.2.1 and later). Each
entry is a note the recording player typed during the match with Alt+H:
`{id, at, t, sequence, text, pinned}`. `at` is wall clock, `t` is relative to the
recording's first frame like `commits[].t`, and `sequence` is the game sequence
when the note box was opened. `sequence` may be `null` when no sequence was
known. Notes are ordered by sequence, then `at`, with `null` sequences last.
Readers must treat a missing `notes` as `[]`.
`pinned` (fork build 0.6.2.2 and later) is a boolean, default `false`, set when
the player toggled the pin (Alt+P) before saving. Every exported note carries
it, but it is optional for readers: a missing `pinned` means `false`.

**`viewer.fogOfWar`** is the most important field in the document. It is `true`
whenever any zone in the capture contained `__hidden_zone__` placeholders. A
player that renders a fog-of-war replay without saying so is lying to the user
about what they are looking at.

**`players[].decklistRaw`** is `null` for any player whose decklist the capture
did not carry. In a player-seat capture that is always the opponent. Do not
reconstruct a decklist from observed cards and present it as the decklist — a
list of "cards we saw" is a different and much weaker claim, and belongs in
derived analysis, not here.

**`commits[].t`** is relative to the first captured frame, not wall clock, so a
replay's timeline is stable regardless of when it is played back. Absolute
timestamps remain available on gameplay-log entries.

**The narration is derivable, and must be derived.** The server trims its own
gameplay log as a match runs, so `origin.gameplayLog` plus the final state holds
only a fraction of what was narrated — 99 of 291 events on the reference capture.
The `log_insert` operations inside `commits[]` carry all of them, so no extra
field is needed; a reader builds the full event list by accumulating across
sequences. See [`replay-navigation.md`](replay-navigation.md).

**`match.outcome.reason`** says what settled the match, and the four values are
not equally direct:

| `reason` | Decided by |
|---|---|
| `victory` | a victory line in the game's own log |
| `concession` | a concession line in the game's own log |
| `score` | one player alone at or above the victory score, when the log named someone else |
| `series` | the winner both players agreed on when the next game of a series began |

`score` exists because RiftAtlas logs leaving a room as a concession, and a
winner usually leaves as soon as they have won — so the log routinely credits
the win to the player who stayed. It decides *who* won, never *that* a match is
over; scores are manual in a simulator and a mistaken 8 gets corrected long
before a recording closes.

`series` exists because a best-of-three game need not end inside the game at
all. Pressing "Next game" asks both players to name the winner of the one just
played, and the series moves on once they agree — leaving that game with no
victory line, no concession, and no winning score. Each room's shell carries the
running `winsByPlayerId` for the series as it stood when that game began, so
game N's winner is whoever gained a win between game N's shell and game N+1's.
A room's shell never gains its own result, so the last game of a series has no
successor to be judged by and must end inside the game — which is how a series
ends anyway. Being a cross-recording lookup, it has no counterpart in
`tools/har_to_replay.py`, where one capture is one game.

`winnerPlayerId` is `null` when nothing settled it, which is honest rather than
broken: a match abandoned mid-play has no winner to name.

**`gaps[]`** must be non-lossy: if the chain broke and no snapshot was captured
at the far side, emit the gap with `"recovery": "none"` and accept that the
replay ends there. Do not interpolate.

**Credentials** — `authToken`, `_pk`, and the handshake frames that carry them
are never written. The writer redacts at extraction time
(`tools/har_to_jsonl.py`), not at export time, so a credential never reaches a
file in the first place.

## Merging two captures

Both players recording the same match yields complementary fog: each sees their
own hidden zones. A merge is viable because `sequence` is a shared authoritative
clock — commits align exactly across captures.

The merged document sets `viewer.role: "merged"`, `fogOfWar: false` when every
zone resolved, and fills `decklistRaw` for both seats. Conflict rule: a resolved
card always beats a `__hidden_zone__` placeholder; two *different* resolved
values at the same sequence is a bug and must fail loudly rather than pick one.

This is deliberately deferred past v1 — it needs a second capture to design
against, and we have one capture.

## Versioning

`version` is an integer that increments on any breaking change. A reader must
refuse a `version` it does not know rather than attempting a best-effort parse;
a subtly misread replay is worse than a refused one. `match.setupOrderVersion`
and the server's `rewindProtocolVersion` are recorded separately so a future
reader can detect replays produced against an older RiftAtlas protocol.
