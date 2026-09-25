const list = document.getElementById('list');
const search = document.getElementById('search');
const count = document.getElementById('count');
const send = (msg) => chrome.runtime.sendMessage(msg);

/** Everything the list last received, so filtering never needs a round trip. */
let allRows = [];

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

document.getElementById('open-player').onclick = () => send({ type: 'openPlayer' });

document.getElementById('unstick').onclick = async (e) => {
  const button = e.currentTarget;
  const was = button.textContent;
  button.textContent = 'Clearing…';
  const res = await send({ type: 'clearRoomState' });
  button.textContent = res?.ok ? 'Done' : (res?.error ?? 'failed');
  setTimeout(() => { button.textContent = was; }, 2500);
};

document.getElementById('dump').onclick = async (e) => {
  const button = e.currentTarget;
  const was = button.textContent;
  button.textContent = 'Dumping…';
  const res = await send({ type: 'dump' });
  button.textContent = res?.ok ? 'Saved' : (res?.error ?? 'failed');
  setTimeout(() => { button.textContent = was; }, 2500);
};

// --- Send to site (#29) -----------------------------------------------------
//
// Settings live in chrome.storage.local (via the background, which is the
// only place that reads them), keyed under `siteUpload`. The origin
// permission is requested here, in this click handler, because
// chrome.permissions.request needs a user gesture still on the call stack.

const siteUrlInput = document.getElementById('site-url');
const tokenInput = document.getElementById('site-token');
const autoSendInput = document.getElementById('auto-send');
const settingsStatus = document.getElementById('upload-settings-status');
const settingsDetails = document.getElementById('upload-settings');

/** The configured site, used to build the "sent" link on each row. */
let currentSiteUrl = '';

async function loadUploadSettings() {
  const cfg = await send({ type: 'get_upload_settings' });
  currentSiteUrl = cfg?.siteUrl ?? '';
  siteUrlInput.value = currentSiteUrl;
  tokenInput.value = cfg?.token ?? '';
  autoSendInput.checked = cfg?.autoSend === true;
}

document.getElementById('save-upload-settings').onclick = async () => {
  const siteUrl = siteUrlInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  const autoSend = autoSendInput.checked;
  settingsStatus.textContent = '';

  if (siteUrl) {
    let origin;
    try { origin = new URL(siteUrl).origin; }
    catch { settingsStatus.textContent = 'not a valid URL'; return; }
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) { settingsStatus.textContent = 'permission not granted'; return; }
  }

  await send({ type: 'set_upload_settings', siteUpload: { siteUrl, token, autoSend } });
  currentSiteUrl = siteUrl;
  settingsStatus.textContent = 'saved';
  setTimeout(() => { settingsStatus.textContent = ''; }, 2000);
  render();
};

/**
 * How that recording's send-to-site status is shown: a "Send to site" button
 * (which opens the settings if none are saved yet), a "Retry" button with the
 * error on hover, or a "sent" badge linking to the match.
 */
function uploadStatusEl(row) {
  const el = document.createElement('div');
  el.className = 'upload';
  // A 'sending' the background never overwrote (MV3 killed the worker mid-fetch)
  // would otherwise hide the button for good; after two minutes, offer a retry.
  const upload = row.upload?.status === 'sending' && Date.now() - (row.upload.at ?? 0) > 120_000
    ? { status: 'failed', error: 'Upload interrupted - click to retry' }
    : row.upload;

  if (upload?.status === 'sent') {
    const badge = tag('sent', 'sent');
    if (currentSiteUrl && upload.matchId) {
      const link = document.createElement('a');
      link.href = `${currentSiteUrl}/matches/${upload.matchId}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = badge.className;
      link.textContent = 'sent';
      el.append(link);
    } else {
      el.append(badge);
    }
    return el;
  }

  if (upload?.status === 'sending') {
    // Set synchronously by the background before its fetch goes out (see
    // inFlight in service-worker.js) - shown as a plain badge, with no button
    // underneath it, so a second click here can never race the same upload.
    el.append(tag('sending…', 'sending'));
    return el;
  }

  if (upload?.status === 'failed') {
    const badge = tag('failed', 'upload-failed');
    badge.title = upload.error ?? 'upload failed';
    el.append(badge);
  }

  el.append(small(upload?.status === 'failed' ? 'Retry' : 'Send to site',
    upload?.status === 'failed' ? (upload.error ?? 'Upload failed - click to retry')
      : 'Upload this replay to your configured site', async (e) => {
      if (!currentSiteUrl) { settingsDetails.open = true; settingsDetails.scrollIntoView(); return; }
      const b = e.currentTarget;
      b.textContent = 'Sending…';
      await send({ type: 'upload_session', roomCode: row.roomCode });
      refresh();
    }));
  return el;
}

/**
 * How the match ended, in words. 'series' is the odd one: a best-of-three game
 * can be settled by both players naming the winner when the next game starts,
 * which is a result the game's own log never mentions.
 */
const HOW_IT_ENDED = {
  victory: 'victory',
  concession: 'concession',
  score: 'on score',
  series: 'agreed between games',
};

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function tag(text, cls) {
  const el = document.createElement('span');
  el.className = `tag ${cls}`;
  el.textContent = text;
  return el;
}

/** One side of a scoreline: the player, with their legend beneath. */
function seatEl(player, side, won) {
  const el = document.createElement('div');
  el.className = `seat ${side}${won ? ' winner' : ''}`;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = player.name ?? player.id;
  name.title = name.textContent;
  el.append(name);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.textContent = player.legend?.name ?? '';
  legend.title = legend.textContent;
  el.append(legend);
  return el;
}

/**
 * The score between them, left untinted on purpose.
 *
 * The winner is not always the higher score: a concession can end a match at
 * 5-8 in the loser's favour on points, and highlighting the winning half made
 * the smaller number look like the bigger one. The result is carried by the
 * card's edge and the winner's name; the score is just the score.
 */
function scoreEl(left, right) {
  const el = document.createElement('div');
  el.className = 'tally';
  const a = document.createElement('span');
  a.textContent = left?.finalScore ?? '–';
  const dash = document.createElement('span');
  dash.className = 'dash';
  dash.textContent = '–';
  const b = document.createElement('span');
  b.textContent = right?.finalScore ?? '–';
  el.append(a, dash, b);
  return el;
}

/** A small secondary action. */
function small(label, title, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = `small ${cls}`.trim();
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}

/**
 * The words a recording can be found by: room code, both players, both legends,
 * the format, and the date written a few ways so "sep", "16" and "2026" all
 * work.
 */
function haystack(row) {
  const started = row.startedAt ? new Date(row.startedAt) : null;
  return [
    row.room ?? row.roomCode,
    row.match?.matchFormat,
    ...(row.players ?? []).flatMap((p) => [p.name, p.legend?.name, p.legend?.cardCode]),
    started && when(row.startedAt),
    started && started.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    started && started.toISOString().slice(0, 10),
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Every term must match, so "zed berto" narrows rather than widens. */
function matches(row, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(row);
  return terms.every((t) => hay.includes(t));
}

async function refresh() {
  allRows = (await send({ type: 'list' })) ?? [];
  render();
}

function render() {
  const query = search.value;
  const rows = allRows.filter((r) => matches(r, query));

  search.hidden = allRows.length < 6;   // pointless chrome on a short list
  count.hidden = !query;
  count.textContent = `${rows.length} of ${allRows.length} recordings`;

  list.replaceChildren();
  if (!allRows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No recordings yet. Open a RiftAtlas match to start one.';
    list.append(li);
    return;
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Nothing matches “${query.trim()}”.`;
    list.append(li);
    return;
  }

  for (const row of rows) {
    const id = row.roomCode;                       // recording id, for actions
    const code = row.room ?? row.roomCode;         // room code, for people
    const li = document.createElement('li');

    // Row 1: which match, and the thing most visits are for.
    const top = document.createElement('div');
    top.className = 'top';

    const head = document.createElement('div');
    head.className = 'head';
    const room = document.createElement('span');
    room.className = 'room';
    room.textContent = code;
    head.append(room, small('Copy', 'Copy the room code', async (e) => {
      const b = e.currentTarget;
      try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; }
      catch { b.textContent = 'failed'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    }));
    if (!row.finished) head.append(tag('recording', 'live'));
    if (row.partial) head.append(tag('partial', 'partial'));
    if (row.stale) {
      const t = tag(`rebuild — ${row.builtCommits}/${row.recordedCommits}`, 'partial');
      t.title = `The replay covers ${row.builtCommits} of ${row.recordedCommits} recorded actions. `
        + 'Press Rebuild to bring it up to date.';
      head.append(t);
    }
    top.append(head);

    const watch = document.createElement('button');
    watch.className = 'watch';
    watch.textContent = 'Watch replay';
    watch.title = 'Play this match back in RiftAtlas\u2019 own board, with card art '
      + 'and their match log.';
    top.append(watch);

    // Row 2: the scoreline. You on the left, opponent on the right, score
    // between them, with each legend under its player.
    const seats = [...(row.players ?? [])];
    const mine = seats.findIndex((p) => p.id === row.viewerPlayerId);
    if (mine > 0) seats.unshift(seats.splice(mine, 1)[0]);
    const [left, right] = seats;
    const winner = row.match?.outcome?.winnerPlayerId ?? null;

    const score = document.createElement('div');
    score.className = 'score';
    if (left) {
      const won = winner && left.id === winner;
      if (winner) li.classList.add(won ? 'won' : 'lost');
      score.append(
        seatEl(left, 'left', won),
        scoreEl(left, right),
        right ? seatEl(right, 'right', winner && right.id === winner) : document.createElement('div'),
      );
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [when(row.startedAt), row.match?.matchFormat,
      HOW_IT_ENDED[row.match?.outcome?.reason] ?? row.match?.outcome?.reason]
      .filter(Boolean).join('  ·  ');


    watch.onclick = async () => {
      watch.textContent = 'Opening…';
      const res = await send({ type: 'replayMode', roomCode: id });
      watch.textContent = 'Watch replay';
      if (!res?.ok) meta.textContent = res?.error ?? 'could not start the replay';
    };

    // Row 3: the rest.
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      small('Export', 'Save this match as a .ratlas.json file. Rebuilds first, '
        + 'so an export is always up to date.', async (e) => {
        const b = e.currentTarget;
        b.textContent = 'Exporting…';
        const res = await send({ type: 'export', roomCode: id });
        b.textContent = res?.ok ? 'Saved' : 'failed';
        if (!res?.ok) meta.textContent = res?.error ?? 'export failed';
        setTimeout(() => { b.textContent = 'Export'; }, 1800);
      }),
      small('Rebuild', 'Re-assemble the replay from what was recorded. Not normally '
        + 'needed — recording is continuous, and Export rebuilds anyway.', async (e) => {
        e.currentTarget.textContent = 'Rebuilding…';
        await send({ type: 'finalise', roomCode: id });
        refresh();
      }),
      small('Delete', 'Delete this recording', () => askDelete(li, code, id), 'danger'),
    );
    actions.append(uploadStatusEl(row));

    li.append(top);
    if (left) li.append(score);
    li.append(meta);
    const trouble = row.unanchored
      ? `Only the final position was captured — the ${row.unanchored.commits} actions `
        + 'recorded here all came before it, and cannot be replayed'
      : row.buildError
      ? `Could not build: ${row.buildError}`
      : row.stoppedEarly
        ? `Plays ${row.stoppedEarly.sequence ? `up to action ${row.stoppedEarly.sequence}` : 'partially'}`
          + ` — ${row.stoppedEarly.reason}`
        : null;
    if (trouble) {
      const problem = document.createElement('div');
      problem.className = 'problem';
      problem.textContent = row.unanchored
        ? `${trouble}. This happens when recording starts partway through a match. `
          + 'Rebuilding will not change it.'
        : row.needsNewVersion
        ? `${trouble}. RiftAtlas has added something this version does not know yet — `
          + 'send a Debug dump. Your recording is safe, and the replay will rebuild '
          + 'itself once that is fixed.'
        : `${trouble}. Your recording is safe; press Rebuild to try again.`;
      li.append(problem);
    }
    li.append(actions);
    list.append(li);
  }
}

/**
 * Deleting a recording destroys it, so it asks first — inline rather than with
 * confirm(), which can dismiss the whole popup on some platforms.
 */
function askDelete(li, code, id) {
  if (li.querySelector('.confirm')) return;
  const bar = document.createElement('div');
  bar.className = 'confirm';
  const text = document.createElement('span');
  text.textContent = `Delete the ${code} recording? This cannot be undone.`;
  const yes = document.createElement('button');
  yes.className = 'danger-solid';
  yes.textContent = 'Delete';
  yes.onclick = async () => { await send({ type: 'delete', roomCode: id }); refresh(); };
  const no = document.createElement('button');
  no.textContent = 'Cancel';
  no.onclick = () => bar.remove();
  bar.append(text, yes, no);
  li.append(bar);
  no.focus();
}

search.addEventListener('input', render);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; render(); }
});

loadUploadSettings();
refresh();
