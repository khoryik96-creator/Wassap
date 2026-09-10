/** The triage UI served by `wassap ui`. One self-contained page. */

const STYLE = `
:root {
  color-scheme: light;
  --bg:#f6f6f4; --panel:#fff; --ink:#1b1b19; --muted:#6d6c66; --line:#e2e1dc;
  --accent:#2f6f4f; --warn:#9a6413; --alert:#a33321; --chip:#efeee9; --mine:#dcf3e4; --theirs:#f0efeb;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg:#16161a; --panel:#1e1e23; --ink:#ececea; --muted:#9b9a94; --line:#32323a;
    --accent:#7fc9a1; --warn:#e0b062; --alert:#eb8b78; --chip:#2a2a31; --mine:#264534; --theirs:#26262d;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg:#16161a; --panel:#1e1e23; --ink:#ececea; --muted:#9b9a94; --line:#32323a;
  --accent:#7fc9a1; --warn:#e0b062; --alert:#eb8b78; --chip:#2a2a31; --mine:#264534; --theirs:#26262d;
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--ink); height:100vh; overflow:hidden;
  font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header { padding:12px 18px; border-bottom:1px solid var(--line); background:var(--panel); }
h1 { margin:0 0 2px; font-size:16px; letter-spacing:-0.01em; }
.counts { color:var(--muted); font-size:12.5px; }
.filters { display:flex; flex-wrap:wrap; gap:8px 12px; padding:10px 18px; border-bottom:1px solid var(--line); background:var(--panel); align-items:center; }
input, select, textarea, button { font:inherit; }
input, select, textarea {
  background:var(--bg); color:var(--ink); border:1px solid var(--line);
  border-radius:7px; padding:6px 8px; font-size:13px;
}
input[type=search] { min-width:190px; }
button {
  background:var(--chip); color:var(--ink); border:1px solid var(--line);
  border-radius:7px; padding:6px 11px; font-size:13px; cursor:pointer;
}
button:hover { border-color:var(--muted); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.primary:hover { opacity:.9; }
main { display:grid; grid-template-columns:minmax(340px,1fr) minmax(380px,1.2fr); height:calc(100vh - var(--chrome, 160px)); overflow:hidden; }
.list { overflow-y:auto; border-right:1px solid var(--line); }
.row { padding:11px 18px; border-bottom:1px solid var(--line); cursor:pointer; display:grid; gap:3px; }
.row:hover { background:var(--panel); }
.row[aria-selected=true] { background:var(--panel); box-shadow:inset 3px 0 0 var(--accent); }
.row .top { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
.row .who { font-weight:600; }
.row .meta, .row .snippet { color:var(--muted); font-size:12.5px; }
.row .snippet { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wait { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
.ok { color:var(--accent); } .warn { color:var(--warn); } .alert { color:var(--alert); }
.tag { display:inline-block; padding:1px 7px; border-radius:999px; background:var(--chip); font-size:11px; color:var(--muted); }
.detail { overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:14px; }
.detail h2 { margin:0; font-size:15px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; }
.thread { display:flex; flex-direction:column; gap:7px; }
.bubble { max-width:78%; padding:8px 11px; border-radius:11px; font-size:13.5px; white-space:pre-wrap; overflow-wrap:anywhere; }
.bubble.me { align-self:flex-end; background:var(--mine); }
.bubble.them { align-self:flex-start; background:var(--theirs); }
.bubble .when { display:block; margin-top:4px; font-size:11px; color:var(--muted); }
.empty { color:var(--muted); padding:36px 18px; text-align:center; }
.setup { padding:10px 18px; border-bottom:1px solid var(--line); background:var(--panel); display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; }
.setup .state { color:var(--muted); font-size:12.5px; flex:1 1 260px; }
.job { padding:10px 18px; border-bottom:1px solid var(--line); background:var(--bg); display:none; gap:14px; align-items:flex-start; }
.job.on { display:flex; }
.job .log { flex:1 1 auto; max-height:150px; overflow-y:auto; font:12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color:var(--muted); white-space:pre-wrap; }
.job img { width:190px; height:190px; border-radius:8px; background:#fff; padding:6px; display:none; }
.job img.on { display:block; }
.err { color:var(--alert); }
textarea { width:100%; min-height:70px; resize:vertical; }
.saved { color:var(--accent); font-size:12px; }
`;

const SCRIPT = String.raw`
const DAY = 86400000;
const $ = (id) => document.getElementById(id);
let threads = [];
let selected = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

function humanize(ms) {
  if (ms < 60000) return 'just now';
  const units = [['y',31536000000],['mo',2592000000],['d',86400000],['h',3600000],['m',60000]];
  const out = []; let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { out.push(n + label); rest -= n * size; }
    if (out.length === 2) break;
  }
  return out.join(' ') || 'just now';
}

const waitClass = (ms) => ms >= 7*DAY ? 'alert' : ms >= 2*DAY ? 'warn' : 'ok';

// Join the parts that exist, so a group with no number has no dangling separator.
const meta = (parts) => parts.filter(Boolean).map(esc).join('  ' + String.fromCharCode(183) + '  ');

function query() {
  const p = new URLSearchParams();
  p.set('direction', $('direction').value);
  p.set('saved', $('saved').value);
  p.set('chatType', $('chatType').value);
  p.set('statuses', $('statuses').value);
  p.set('sort', $('sort').value);
  if ($('q').value.trim()) p.set('search', $('q').value.trim());
  if ($('minwait').value) p.set('minWait', String(Number($('minwait').value) * DAY));
  return p.toString();
}

async function load() {
  const res = await fetch('/api/threads?' + query());
  const data = await res.json();
  threads = data.threads || [];
  $('counts').textContent =
    threads.length + ' shown  ' + String.fromCharCode(183) + '  ' +
    data.summary.awaitingThem + ' awaiting them  ' + String.fromCharCode(183) + '  ' +
    data.summary.awaitingYou + ' awaiting you  ' + String.fromCharCode(183) + '  ' +
    data.scanned + ' analysed';
  renderList();
}

function renderList() {
  if (!threads.length) {
    $('list').innerHTML = '<div class="empty">Nothing matches these filters.</div>';
    $('detail').innerHTML = '<div class="empty">No conversation selected.</div>';
    return;
  }
  $('list').innerHTML = threads.map((t, i) =>
    '<div class="row" role="option" data-i="' + i + '" aria-selected="' + (t.chatId === selected) + '">' +
      '<div class="top">' +
        '<span class="who">' + esc(t.name) + (t.isGroup ? ' <span class="tag">group</span>' : '') +
          (t.status && t.status !== 'open' ? ' <span class="tag">' + esc(t.status) + '</span>' : '') +
        '</span>' +
        '<span class="wait ' + waitClass(t.waitingMs) + '">' + humanize(t.waitingMs) + '</span>' +
      '</div>' +
      '<div class="meta">' + meta([
        t.number,
        'owed by ' + (t.direction === 'awaiting_them' ? 'them' : 'you'),
        t.isGroup ? 'group' : (t.isSaved ? 'saved' : 'unsaved'),
        t.unansweredCount > 1 ? t.unansweredCount + ' unanswered' : null,
      ]) + '</div>' +
      '<div class="snippet">' + esc(t.lastMessagePreview || '') + '</div>' +
    '</div>').join('');

  for (const row of document.querySelectorAll('.row')) {
    row.addEventListener('click', () => open(threads[Number(row.dataset.i)]));
  }
}

async function open(thread) {
  selected = thread.chatId;
  renderList();
  $('detail').innerHTML = '<div class="empty">Loading...</div>';

  const res = await fetch('/api/threads/' + encodeURIComponent(thread.chatId) + '/messages');
  const data = await res.json();

  const bubbles = (data.messages || []).map((m) => {
    const when = new Date(m.timestamp).toLocaleString();
    return '<div class="bubble ' + (m.from_me ? 'me' : 'them') + '">' +
      esc(m.preview || '') + '<span class="when">' + when + '</span></div>';
  }).join('');

  $('detail').innerHTML =
    '<h2>' + esc(thread.name) + '</h2>' +
    '<div class="counts">' + meta([
      thread.number,
      'waiting ' + humanize(thread.waitingMs),
      thread.messageCount + ' messages known',
      'status: ' + (thread.status || 'open'),
    ]) + '</div>' +
    '<div class="actions">' +
      '<button data-act="handled">Mark handled</button>' +
      '<button data-act="snooze">Snooze 7 days</button>' +
      '<button data-act="ignored">Ignore</button>' +
      '<button data-act="open">Reopen</button>' +
    '</div>' +
    '<div><textarea id="note" placeholder="Private note, kept locally">' + esc(thread.note || '') + '</textarea>' +
    '<div class="actions" style="margin-top:6px"><button class="primary" data-act="note">Save note</button>' +
    '<span id="notesaved" class="saved"></span></div></div>' +
    '<div class="thread">' + (bubbles || '<div class="empty">No messages stored for this chat.</div>') + '</div>';

  for (const button of $('detail').querySelectorAll('button')) {
    button.addEventListener('click', () => act(thread, button.dataset.act));
  }
}

async function act(thread, what) {
  const payload = {};
  if (what === 'note') payload.note = $('note').value;
  else if (what === 'snooze') { payload.status = 'snoozed'; payload.snoozedUntil = Date.now() + 7*DAY; }
  else payload.status = what;

  await fetch('/api/threads/' + encodeURIComponent(thread.chatId) + '/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (what === 'note') {
    // Hold the element: the detail pane may be re-rendered before this fires.
    const badge = $('notesaved');
    if (badge) {
      badge.textContent = 'saved';
      setTimeout(() => { if (badge.isConnected) badge.textContent = ''; }, 1500);
    }
    thread.note = payload.note;
    return;
  }
  await load();
  const still = threads.find((t) => t.chatId === thread.chatId);
  if (still) open(still); else $('detail').innerHTML = '<div class="empty">Done. Pick another conversation.</div>';
}

function fitMain() {
  const chrome = document.querySelector('header').offsetHeight +
    document.querySelector('.setup').offsetHeight +
    document.querySelector('.filters').offsetHeight +
    ($('job').classList.contains('on') ? $('job').offsetHeight : 0);
  document.documentElement.style.setProperty('--chrome', chrome + 'px');
}

async function refreshState() {
  const s = await (await fetch('/api/state')).json();

  // The linked flag reflects stored credentials; the account only appears once
  // a link or sync has reported one, so fall back to the weaker signal.
  const who = s.account
    ? 'Linked: ' + s.account.split(':')[0].split('@')[0]
    : s.linked ? 'Linked' : 'Not linked yet';

  $('state').textContent = meta([
    who,
    'last sync ' + (s.lastSync ? humanize(Date.now() - s.lastSync) + ' ago' : 'never'),
    s.chats + ' chats, ' + s.messages + ' messages',
    s.isDemo ? 'DEMO DATA' : null,
  ]);

  setBusy(Boolean(s.job && s.job.running));
  fitMain();
}

function setBusy(busy) {
  $('link').disabled = busy;
  $('syncnow').disabled = busy;
}

function logLine(text, isError) {
  const div = document.createElement('div');
  if (isError) div.className = 'err';
  div.textContent = text;
  $('joblog').appendChild(div);
  $('joblog').scrollTop = $('joblog').scrollHeight;
}

function showJob(on) {
  $('job').classList.toggle('on', on);
  fitMain();
}

function hideQr() {
  $('qr').classList.remove('on');
  $('qr').removeAttribute('src');
}

function connectEvents() {
  const source = new EventSource('/api/events');

  source.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'replay') {
      // A reconnecting EventSource is re-sent the log so far. Rebuild from it
      // rather than appending, or every reconnect duplicates the whole log.
      $('joblog').textContent = '';
      for (const message of data.log) logLine(message);
      if (data.error) logLine(data.error, true);
      if (data.qrAt && data.running) {
        $('qr').src = '/api/qr.png?at=' + data.qrAt;
        $('qr').classList.add('on');
      } else {
        hideQr();
      }
      setBusy(data.running);
      showJob(true);
      return;
    }

    if (data.type === 'started') {
      $('joblog').textContent = '';
      hideQr();
      showJob(true);
      setBusy(true);
    } else if (data.type === 'status') {
      logLine(data.message);
      showJob(true);
    } else if (data.type === 'qr') {
      $('qr').src = '/api/qr.png?at=' + data.at;
      $('qr').classList.add('on');
      showJob(true);
      fitMain();
    } else if (data.type === 'done') {
      logLine('Finished.');
      hideQr();
      setBusy(false);
      refreshState();
      load();
    } else if (data.type === 'error') {
      logLine(data.message, true);
      // A failed link must not leave an expired QR on screen to be scanned.
      hideQr();
      setBusy(false);
      refreshState();
    }
  };
}

async function startJob(what) {
  const res = await fetch('/api/' + what, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showJob(true);
    logLine(body.error || ('Could not start ' + what + ' (HTTP ' + res.status + ').'), true);
  }
}

for (const id of ['q','direction','saved','chatType','statuses','sort','minwait']) {
  $(id).addEventListener('input', load);
}
$('refresh').addEventListener('click', () => { load(); refreshState(); });
$('link').addEventListener('click', () => startJob('login'));
$('syncnow').addEventListener('click', () => startJob('sync'));
window.addEventListener('resize', fitMain);

connectEvents();
refreshState();
load();
`;

export function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wassap</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Unanswered conversations</h1>
  <div class="counts" id="counts">Loading...</div>
</header>

<div class="setup">
  <div class="state" id="state">Checking...</div>
  <button id="link">Link device</button>
  <button class="primary" id="syncnow">Sync now</button>
</div>

<div class="job" id="job">
  <div class="log" id="joblog"></div>
  <img id="qr" alt="WhatsApp QR code">
</div>

<div class="filters">
  <input type="search" id="q" placeholder="Search name, number or text">
  <select id="direction">
    <option value="both">Either side</option>
    <option value="them">Owed by them</option>
    <option value="you">Owed by me</option>
  </select>
  <select id="saved">
    <option value="all">Saved and unsaved</option>
    <option value="saved">Saved only</option>
    <option value="unsaved">Unsaved only</option>
  </select>
  <select id="chatType">
    <option value="all">Direct and groups</option>
    <option value="direct">Direct only</option>
    <option value="group">Groups only</option>
  </select>
  <select id="statuses">
    <option value="open">Open</option>
    <option value="all">All, including handled</option>
    <option value="handled">Handled</option>
    <option value="snoozed">Snoozed</option>
    <option value="ignored">Ignored</option>
  </select>
  <select id="sort">
    <option value="waiting">Longest waiting</option>
    <option value="date">Most recent</option>
    <option value="oldest">Oldest</option>
    <option value="count">Most unanswered</option>
    <option value="name">Name</option>
  </select>
  <input type="number" id="minwait" min="0" step="1" placeholder="min days">
  <button id="refresh">Refresh</button>
</div>

<main>
  <div class="list" id="list" role="listbox"></div>
  <div class="detail" id="detail"><div class="empty">Pick a conversation on the left.</div></div>
</main>

<script>${SCRIPT}</script>
</body>
</html>
`;
}
