/**
 * Assemble a .ratlas.json from persisted recording state.
 *
 * Behaviourally identical to tools/har_to_replay.py, which is the reference.
 * Finalisation is a pure function of what is already in IndexedDB, so a worker
 * that was killed mid-match can still produce a correct replay on wake.
 */
import { SESSIONS, all, get, commitsFor, extrasFor, roomOf } from './store.js';
import { isTerminalLogEntry } from './recorder.js';
import { sortNotes } from './notes-core.js';
import { Timeline } from '../shared/reducer.js';

const FORMAT = 'riftatlas-replay';
const VERSION = 1;

/**
 * Points needed to win, by game variant, as the client defines them.
 *
 * The threshold is not in the match state - the client derives it from the
 * variant - so it is mirrored here. The real rule adds a small bonus for
 * certain battlefield brushes, which is not reproduced: this is only used to
 * recognise a player who has clearly reached a winning score, so erring low
 * would misread a match and erring high would simply defer to RiftAtlas.
 */
const VICTORY_SCORE = {
  duel: 8,
  free_for_all_3: 8,
  free_for_all_4: 8,
  teams_2v2: 11,
};
const BASE_VICTORY_SCORE = 8;

/** Zones holding placeholder stubs, per player. Empty means full information. */
function maskedZones(state) {
  const out = {};
  for (const player of state.players ?? []) {
    const zones = Object.entries(player.board ?? {})
      .filter(([, cards]) => Array.isArray(cards)
        && cards.some((c) => c && typeof c === 'object' && c.isPlaceholder))
      .map(([zone]) => zone).sort();
    if (zones.length) out[player.id] = zones;
  }
  return out;
}

/**
 * Who a later game in the series says won this one.
 *
 * A best-of-three game does not always end inside the game. Pressing "Next
 * game" asks both players to name the winner of the one just played, and the
 * series moves on once they agree - so a game settled that way ends with no
 * victory line, no concession, and no winning score. One real game two finished
 * 4-4 with "EagleV2 ended their turn." as its last word.
 *
 * The result is not lost, it is just written somewhere else: each room's shell
 * carries the running `winsByPlayerId` for the series as it stood when that
 * game began. Game N's winner is therefore whoever gained a win between game
 * N's shell and game N+1's. Confirmed against a real series - game one's 8-4
 * shows up as a win in game two's shell, and the agreed game two shows up in
 * game three's, which is the only place it appears at all.
 *
 * A room's shell never gains its own result, so the final game of a series has
 * no successor to be judged by. That game has to end inside the game, which is
 * how a series ends anyway.
 *
 * This has no counterpart in tools/har_to_replay.py: a capture holds one game,
 * and this reads across recordings.
 */
export function seriesWinner(before, after) {
  const b = before?.winsByPlayerId ?? {};
  const a = after?.winsByPlayerId ?? {};
  // Exactly one player, up by exactly one. Anything else means the ledger is
  // not describing a single game, and RiftAtlas' own ruling is the better bet.
  const ids = new Set([...Object.keys(b), ...Object.keys(a)]);
  const moved = [...ids].filter((id) => (a[id] ?? 0) !== (b[id] ?? 0));
  const gained = moved.filter((id) => (a[id] ?? 0) - (b[id] ?? 0) === 1);
  return moved.length === 1 && gained.length === 1 ? gained[0] : null;
}

async function seriesVerdict(session) {
  const { seriesId, gameNumber } = session.shell ?? {};
  if (!seriesId || !gameNumber) return null;

  const sessions = await all(SESSIONS);
  const next = sessions.find((s) => s.shell?.seriesId === seriesId
    && s.shell?.gameNumber === gameNumber + 1);
  if (!next) return null;

  return seriesWinner(session.shell, next.shell);
}

/**
 * The commits that arrived before the only anchor this recording ever got.
 *
 * Null unless *every* commit is below the anchor, which is the case worth
 * naming: nothing can be replayed at all. A recording with some commits above
 * its anchor plays from the anchor onwards, and the gap machinery already
 * describes what it lost.
 */
export function unanchoredSpan(originSequence, commits) {
  if (!commits.length) return null;
  if (!commits.every((c) => c.sequence <= originSequence)) return null;
  return {
    commits: commits.length,
    from: commits[0].sequence,
    to: commits.at(-1).sequence,
    anchor: originSequence,
  };
}

export async function buildReplay(recordingId) {
  const session = await get(SESSIONS, recordingId);
  if (!session?.origin) throw new Error(`no anchoring snapshot for ${recordingId}`);
  const roomCode = session.room ?? roomOf(recordingId);

  const commits = await commitsFor(recordingId);
  const snapshots = await extrasFor(recordingId, 'snapshot');
  const chat = (await extrasFor(recordingId, 'chat')).map((r) => r.entry)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // In-game notes, in game order. Always present, empty when there are none.
  const notes = sortNotes((await extrasFor(recordingId, 'note'))
    .map((r) => ({ ...r.note, pinned: r.note?.pinned === true })));
  const errors = new Map((await extrasFor(recordingId, 'error')).map((r) => [r.sequence, r.code]));

  const timeline = new Timeline();
  timeline.ingest({ type: 'authoritative_snapshot', ...session.origin });

  // Repair holes with any snapshot that lets the chain continue, not only one
  // sitting exactly on the break. A hole is fatal to everything after it - the
  // reducer cannot apply a commit whose base state it never saw - so a match
  // that lost a handful of frames replayed as nine moves out of 396 while the
  // other 388 sat unused. Resuming from the nearest usable snapshot recovers
  // the rest of the match, minus the stretch that was actually lost.
  const bySequence = [...snapshots].sort((a, b) => a.sequence - b.sequence);
  const unrepaired = [];
  let sequence = session.origin.sequence;
  let stoppedAt = null;

  // Commits recorded before the only snapshot that ever arrived.
  //
  // A recording started mid-match has no anchor until the server sends one, and
  // it may not send one until the match ends. Everything caught in between then
  // sits below the anchor, and a patch cannot be applied to a state that comes
  // after it - so the replay holds the final board and nothing that led to it,
  // which in the player is a scrubber that will not move.
  //
  // Nothing here can fix that; the states those commits describe were never
  // captured. Saying so is the whole remedy, because the alternative reads as a
  // replay that merely needs rebuilding.
  const unanchored = unanchoredSpan(session.origin.sequence, commits);

  for (const commit of commits) {
    if (commit.baseSequence !== sequence) {
      const repair = bySequence.find((s) => s.sequence >= sequence && s.sequence <= commit.baseSequence);
      if (repair) {
        timeline.ingest({ type: 'authoritative_snapshot', ...repair });
        sequence = repair.sequence;
      }
    }
    if (stoppedAt) break;
    // Commits below where we now stand belong to the lost stretch; skip them
    // rather than feeding the reducer a base it never reached.
    if (commit.baseSequence !== sequence) {
      // One gap per contiguous run of skipped commits, not one per commit.
      const open = unrepaired.at(-1);
      if (open && open.from === sequence) open.to = commit.baseSequence;
      else if (commit.baseSequence > sequence) {
        unrepaired.push({ from: sequence, to: commit.baseSequence });
      }
      continue;
    }
    try {
      timeline.ingest({ type: 'authoritative_patch_commit', ...commit });
      sequence = commit.sequence;
    } catch (error) {
      // Something the reducer does not know - a patch verb RiftAtlas has added
      // since. Keep everything up to here rather than losing the match: a new
      // verb should cost the rest of a replay, not the whole of it. The
      // recording is untouched, so the same match builds in full once the
      // reducer catches up.
      stoppedAt = { sequence: commit.sequence, reason: String(error?.message ?? error) };
      break;
    }
  }

  // Snapshots beyond everything we could walk still tell us how the match
  // ended. When a hole has cost the middle of a game, the final board is the
  // most that can be salvaged, and it is worth more than stopping at the hole.
  //
  // Skipped when the reducer stopped early: stitching the ending onto a replay
  // that cannot reach it would present a gap as if it were merely a resync.
  for (const later of stoppedAt ? [] : bySequence) {
    if (later.sequence <= sequence) continue;
    timeline.ingest({ type: 'authoritative_snapshot', ...later });
    const open = unrepaired.at(-1);
    if (open && open.from === sequence) open.to = later.sequence;
    else if (later.sequence > sequence) unrepaired.push({ from: sequence, to: later.sequence });
    sequence = later.sequence;
  }

  const lastSeq = timeline.sequences.at(-1);
  const [finalState, finalLog] = timeline.states.get(lastSeq);

  const gaps = timeline.resyncs.map(({ from, to }) => {
    const repair = snapshots.find((s) => s.sequence === to);
    return {
      fromSequence: from, toSequence: to, missingCommits: to - from,
      reason: errors.get(to) ?? 'unknown',
      recovery: repair ? 'snapshot' : 'none',
      snapshot: repair?.snapshot ?? null,
      gameplayLog: repair?.gameplayLog ?? null,
    };
  });

  // Holes nothing could bridge. Recorded but unusable, and the replay has to
  // say so - reporting no gaps made a truncated match look like a short one.
  const seen = new Set(gaps.map((g) => `${g.fromSequence}:${g.toSequence}`));
  for (const { from, to } of unrepaired) {
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      fromSequence: from, toSequence: to, missingCommits: to - from,
      reason: errors.get(to) ?? 'frames_not_captured',
      recovery: 'none', snapshot: null, gameplayLog: null,
    });
  }
  gaps.sort((a, b) => a.fromSequence - b.fromSequence);

  const shell = session.shell ?? {};
  const viewer = session.viewer ?? shell.viewer ?? {};
  const masked = maskedZones(finalState);
  const clock = commits.at(-1)?.actionClock ?? session.origin.actionClock ?? {};
  const totals = clock.totals ?? {};
  const selfPlayer = shell.selfPlayer ?? {};

  const legendOf = (player) => {
    // The legend can leave its own zone during play, so fall back to the
    // opening board, which always has it.
    const here = player.board?.legend?.[0];
    if (here?.name) return { name: here.name, cardCode: here.cardCode ?? null };
    const atStart = session.origin.snapshot.players
      ?.find((x) => x.id === player.id)?.board?.legend?.[0];
    return atStart?.name ? { name: atStart.name, cardCode: atStart.cardCode ?? null } : null;
  };

  const players = (finalState.players ?? []).map((p) => ({
    id: p.id, seat: p.seat, name: p.name, legend: legendOf(p),
    decklistRaw: p.id === selfPlayer.id ? (selfPlayer.decklistRaw ?? null) : null,
    finalScore: p.board?.score ?? null,
    thinkTimeMs: totals[p.id] ?? null,
  }));

  let winnerPlayerId = null;
  let reason = null;
  // The same rule the recorder uses to decide a match has ended, rather than a
  // second, looser one. This scanner had its own ` wins\b` test, which the
  // initiative roll satisfies - "EagleV wins initiative (15 vs 1)" - so a match
  // that ended with no result at all was credited to whoever won the dice, at
  // 1-2 on points. The recorder stopped falling for that; this had not.
  for (const entry of finalLog) {
    if (!isTerminalLogEntry(entry)) continue;
    const text = entry.text ?? '';
    reason = /conceded/.test(text) ? 'concession' : 'victory';
    winnerPlayerId = players.find((p) => p.name && text.includes(`${p.name} wins`))?.id ?? null;
    break;
  }

  // Reaching the victory score settles a finished match, whatever the log says.
  //
  // RiftAtlas records a player leaving the room as a concession, and a winner
  // usually leaves as soon as they have won - so the log credits the win to the
  // player who stayed. Both captures of a finished match showed exactly that:
  // the player on 8 points was logged as the conceder.
  //
  // This decides who won. It never decides *that* a match is over: scores are
  // manual in a simulator and a player can put themselves on 8 by mistake and
  // correct it. Nothing in the recorder watches the score, and the finalisation
  // triggers are a new room, everyone leaving, a terminal log line, or the
  // socket closing - never a number on the track. Reading the score only once a
  // recording has closed means a mistaken 8 mid-match is simply corrected
  // before anyone asks who won.
  //
  // Only an unambiguous case overrides: exactly one player at or above the
  // threshold. Anything else keeps RiftAtlas' own ruling.
  const victoryScore = VICTORY_SCORE[finalState.gameVariant] ?? BASE_VICTORY_SCORE;
  if (session.finished === true) {
    const reached = players.filter((p) => (p.finalScore ?? 0) >= victoryScore);
    if (reached.length === 1 && reached[0].id !== winnerPlayerId) {
      winnerPlayerId = reached[0].id;
      reason = 'score';
    }
  }

  // What both players agreed on afterwards settles it over anything read from
  // the board, because it is the result the series itself was scored on.
  const agreed = await seriesVerdict(session);
  if (agreed && agreed !== winnerPlayerId) {
    winnerPlayerId = agreed;
    reason = 'series';
  }

  return {
    format: FORMAT,
    version: VERSION,
    match: {
      roomCode: finalState.roomCode ?? roomCode,
      capturedAt: shell.createdAt ?? session.startedAt,
      durationMs: commits.at(-1)?.t ?? 0,
      gameVariant: finalState.gameVariant ?? null,
      playMode: finalState.playMode ?? null,
      matchFormat: shell.matchFormat ?? null,
      deckRulesMode: shell.deckRulesMode ?? null,
      roomOrigin: shell.roomOrigin ?? null,
      roomMode: finalState.roomMode ?? null,
      setupOrderVersion: finalState.setupOrderVersion ?? null,
      outcome: { winnerPlayerId, reason, victoryScore },
    },
    viewer: {
      role: viewer.role ?? 'player',
      playerId: viewer.playerId ?? null,
      fogOfWar: Object.keys(masked).length > 0,
      maskedZonesByPlayer: masked,
    },
    partial: session.partial === true,
    // What the reducer could actually walk, against what was recorded. A
    // replay that stops early must be visibly short, not quietly short.
    coverage: {
      recordedCommits: commits.length,
      appliedCommits: timeline.commits.size,
      lastSequence: lastSeq,
      // Set when the reducer met something it did not understand. The recording
      // is complete; this replay is not.
      stoppedAt,
      // Set when every recorded commit predates the only anchor there is, so
      // none of them can be replayed. Rebuilding cannot help.
      unanchored,
    },
    players,
    shell: session.shell ?? null,
    origin: session.origin,
    recordingId,
    commits: commits.map(({ roomCode: _ignored, ...c }) => c),
    gaps,
    chat,
    notes,
  };
}
