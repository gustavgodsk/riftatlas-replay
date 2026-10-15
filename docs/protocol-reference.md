# Protocol reference

Endpoint observed:

```
wss://realtime.riftatlas-workers.com/parties/match/<roomCode>
    ?_pk=<partyKey>&playerId=<playerId>&roomCode=<roomCode>
```

A sibling socket handles matchmaking
(`/parties/matchmaking/<queueId>`) and is not part of a replay.

All frames are opcode 1 (UTF-8 text), one JSON object per frame, with a `type`
discriminator and a `gameInstanceId` equal to the room code.

Everything below is derived from a single capture. Counts are from that capture
and are illustrative, not limits.

## Frame types

### State-bearing — a replay needs all of these

| type | dir | purpose |
|---|---|---|
| `authoritative_snapshot` | recv | Full game state at `sequence`. Fields: `snapshot`, `gameplayLog`, `actionClock`, `sequence`. |
| `authoritative_patch_commit` | recv | Advances `baseSequence` → `sequence`. Fields: `action`, `patch.operations`, `clientActionId`, `actionClock`. |
| `room_shell_sync` | recv | Session document: decklists, format, phase, seats, disconnect state. |
| `chat_sync` / `chat_append` | recv | Match chat entries. |
| `error` | recv | `{code, message, mutationClass, clientActionId, authoritativeSequence}`. `mutationClass: "resync_required"` precedes a re-anchoring snapshot. |

### Ephemeral — discard

| type | dir | notes |
|---|---|---|
| `presence_update` | send | Local hover / typing / emote broadcast. |
| `presence_event` | recv | `hover_state`, `card_ping`, `board_emote`, `chat_typing`, `presence_snapshot`, `player_presence`. |
| `rewind_confirmation_state` | recv | Rewind-prompt state; `null` throughout this capture. |
| `auth_session` / `auth_refresh` | both | Token lifecycle. **Contains credentials — redact.** |
| `gameplay_action_noop_ack` | recv | Acknowledges an action that changed nothing. |
| `judge_call_sync`, `spectator_roster_sync`, `setup_log_sync` | recv | Empty in this capture; re-evaluate if a capture shows them populated. |

### Client-originated

| type | notes |
|---|---|
| `join_shell`, `join_game`, `resume_game` | Handshake. **Carry `authToken`.** |
| `action_intent` | Optimistic intent: `{action, actorPlayerId, clientActionId, clientBaseSequence}`. Correlates to the resulting commit by `clientActionId` — 162 of 369 commits in this capture matched a local intent; the rest originated from the opponent. Useful for measuring client-perceived latency, never authoritative. |
| `chat_send` | Outgoing chat. |

## Patch operations

`patch.operations` is an ordered list applied left to right. These are
domain-level verbs, **not** RFC 6902 JSON Patch — there is no `path` field.

Normative semantics: `tools/reducer.py`.

| op | fields | effect |
|---|---|---|
| `set_room_fields` | `fields` | Merge into root state. |
| `unset_room_fields` | `fields` (list of names) | Delete root keys. |
| `set_player_fields` | `playerId`, `fields` | Merge into the player object. |
| `set_board_fields` | `playerId`, `fields` | Merge into `player.board` (non-zone scalars). |
| `unset_board_fields` | `playerId`, `fields` (list of names, assumed) | Delete `player.board` keys. Seen first on 2026-10-15. |
| `zone_insert` | `playerId`, `zone`, `index`, `cards` | Splice cards in at `index`. |
| `zone_remove` | `playerId`, `zone`, `cardIds` | Remove by id. |
| `zone_reorder` | `playerId`, `zone`, `cardIds` | Reorder to the given id sequence. |
| `zone_replace` | `playerId`, `zone`, `cards` | Replace the zone's contents wholesale. Seen first on 2026-09-17, in a `move_card` that rewrote several cards at once — a reminder that this list grows. |
| `zone_move` | `cardId`, `from{playerId,zone}`, `to{playerId,zone,index}`, `card` | Move across zones/players. **`card` carries the post-move object** and may reveal a previously hidden card — prefer it over the locally held one. |
| `patch_card_fields` | `playerId`, `zone`, `cardId`, `fields` | Merge into one card. |
| `unset_card_fields` | `playerId`, `zone`, `cardId`, `fields` | Delete card keys. |
| `log_insert` | `index`, `entries` | Splice gameplay-log entries (index 0 = newest). |
| `log_remove` | `entryIds` | Remove log entries — used by rewind. |
| `chain_insert` | `index`, `entries` | Splice onto the resolution chain. |
| `chain_remove` | `entryIds` | Remove chain entries. |
| `chain_replace` | `entries` | Replace matching chain entries in place. |

Treat an unrecognised verb as fatal for that replay segment rather than skipping
it — a silently ignored op yields a plausible-looking but wrong board.

## State shape

```
snapshot
├── roomCode, phase, roomMode, gameVariant, playMode
├── setupOrderVersion, rewindProtocolVersion
├── rewindablePlayerIds[], forwardablePlayerIds[]
├── chainEntries[], chainResolveVotes[]
└── players[]
    ├── id, seat, name, joinedAt, sealedFormatId
    ├── identity        ← snapshot-only cosmetics, never patched
    └── board
        ├── score, floatingEnergy, floatingPower, legendXp
        ├── handRevealToOpponent, recycledDeckBottomCount
        ├── deckPeek { cardIds[], revealedCardIds[] }
        └── zones: deck, hand, base, trash, banished,
                   battlefieldA, battlefieldB, battlefieldC,
                   battlefieldToken, champion, legend,
                   runeDeck, runeArea
```

Phases seen: `battlefield_pick` → `initiative_roll` → `first_player_choice` →
`mulligan` → `sideboarding` → `in_game`.

### Card object

```json
{
  "id": "card_679829df-…", "name": "Irelia, Fervent", "cardCode": "SFD-057",
  "type": "unit", "source": "champion", "ownerPlayerId": "plr_…",
  "exhausted": false, "createdAt": 1789531254187,
  "hasWhenYouPlayMe": false, "isPlaceholder": false,
  "keywords": ["Deflect"],
  "whiteCounter": 2, "attachedToCardId": "card_…", "customLabels": ["…"]
}
```

The last three are optional.

A masked card is a **stub object in the same position**, not a bare string:

```json
{
  "id": "__hidden_zone__:plr_72272ae6:deck:0", "name": "",
  "source": "mainDeck", "exhausted": false,
  "createdAt": 0, "isPlaceholder": true
}
```

Detect masking with `isPlaceholder === true`, not by string-matching the id.
Stubs have no `cardCode`, `type`, `keywords` or `ownerPlayerId`, so any code
reading those fields must tolerate their absence.

Masking applies to the viewer's **own** `deck` and `runeDeck` as well as the
opponent's — only the viewer's `hand` is revealed to them.

### Gameplay log entry

```json
{
  "id": "pk-log_b28c96a7-…", "at": 1789532395210,
  "text": "EagleV drew 1 card.", "authorPlayerId": "plr_…",
  "actionType": "draw_cards", "actionKind": "draw",
  "turnNumber": 13, "turnPlayerId": "plr_…"
}
```

Newest first. `actionType`/`actionKind`/`turnNumber` are absent on some
system-generated entries (e.g. concessions).

### Action clock

```json
{
  "scopeKey": "3NKJ3:1",
  "totals": { "plr_72272ae6": 383609, "plr_135347f2": 741606 },
  "activeTargets": [{ "playerId": "plr_…", "reason": "turn" }],
  "runningSince": 1789532395582, "serverNow": 1789532396034
}
```

Cumulative milliseconds per player. Rides along on snapshots and commits.

## Action types

Carried on `authoritative_patch_commit.action.type`. Observed in one match:

`rune_batch`, `adjust_card_counter`, `move_card`, `battlefield_conquer_pass_focus`,
`move_cards_to_trash_batch`, `draw_cards`, `chain_resolve`,
`battlefield_conquer_pass_response`, `battlefield_conquer_confirm`, `end_turn`,
`chain_set_resolve_vote`, `payment_batch`, `chain_add`, `toggle_exhausted`,
`target_arrow_add`, `create_token`, `set_card_hidden`, `set_card_label`,
`equip_card`, `select_battlefield`, `submit_sideboard`, `submit_mulligan`,
`set_hand_reveal`, `roll_initiative`, `choose_first_player`,
`request_sideboard_skip`, `respond_sideboard_skip`, `adjust_card_might`,
`rewind_last_action`.

This list is not exhaustive and will grow with more captures. `rewind_last_action`
is worth noting: rewind is committed **forward** as an ordinary patch that undoes
prior effects, so a replay needs no special handling — it simply shows the rewind
happening, which is what actually occurred.
