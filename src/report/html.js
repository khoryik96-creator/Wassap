import { toRecords } from './data.js';
import { humanizeDuration } from '../duration.js';

/** Safe to embed inside a <script> block. */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const STYLE = `
:root {
  color-scheme: light;
  --bg: #f6f6f4;
  --panel: #ffffff;
  --ink: #1b1b19;
  --muted: #6d6c66;
  --line: #e2e1dc;
  --accent: #2f6f4f;
  --warn: #9a6413;
  --alert: #a33321;
  --chip: #efeee9;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #16161a;
    --panel: #1e1e23;
    --ink: #ececea;
    --muted: #9b9a94;
    --line: #32323a;
    --accent: #7fc9a1;
    --warn: #e0b062;
    --alert: #eb8b78;
    --chip: #2a2a31;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #16161a; --panel: #1e1e23; --ink: #ececea; --muted: #9b9a94;
  --line: #32323a; --accent: #7fc9a1; --warn: #e0b062; --alert: #eb8b78; --chip: #2a2a31;
}
* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--ink); margin: 0;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 28px 20px 60px;
}
.wrap { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin-bottom: 22px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.tile .n { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.tile .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
.controls {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 16px; margin-bottom: 18px;
  display: flex; flex-wrap: wrap; gap: 14px 20px; align-items: flex-end;
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
input, select {
  background: var(--bg); color: var(--ink); border: 1px solid var(--line);
  border-radius: 7px; padding: 7px 9px; font: inherit; font-size: 13px; min-width: 130px;
}
input[type="search"] { min-width: 200px; }
.tablewrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th {
  position: sticky; top: 0; background: var(--panel); z-index: 1;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
  cursor: pointer; user-select: none;
}
th:hover { color: var(--ink); }
th .arrow { opacity: 0.45; font-size: 10px; }
tbody tr:last-child td { border-bottom: none; }
td.preview { white-space: normal; color: var(--muted); max-width: 380px; }
td.num { font-variant-numeric: tabular-nums; color: var(--muted); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; background: var(--chip); }
td.wait-ok { color: var(--accent); }
td.wait-warn { color: var(--warn); font-weight: 500; }
td.wait-alert { color: var(--alert); font-weight: 600; }
.dot { font-size: 11px; color: var(--muted); }
.empty { padding: 40px; text-align: center; color: var(--muted); }
footer { color: var(--muted); font-size: 12px; margin-top: 18px; }
`;

const SCRIPT = String.raw`
const state = { sort: 'waiting_ms', dir: -1 };
const $ = (id) => document.getElementById(id);
const DAY = 86400000;

function waitClass(ms) {
  if (ms >= 7 * DAY) return 'wait-alert';
  if (ms >= 2 * DAY) return 'wait-warn';
  return 'wait-ok';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function parseDays(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * DAY : null;
}

function visible() {
  const q = $('q').value.trim().toLowerCase();
  const dir = $('direction').value;
  const saved = $('saved').value;
  const kind = $('kind').value;
  const minWait = parseDays($('minwait').value);
  const since = $('since').value ? Date.parse($('since').value) : null;
  const until = $('until').value ? Date.parse($('until').value) + DAY - 1 : null;

  return DATA.filter((r) => {
    if (dir !== 'both' && r.owed_by !== dir) return false;
    // A group is neither a saved nor an unsaved number.
    if (saved !== 'all' && r.is_group) return false;
    if (saved === 'saved' && !r.saved_contact) return false;
    if (saved === 'unsaved' && r.saved_contact) return false;
    if (kind === 'direct' && r.is_group) return false;
    if (kind === 'group' && !r.is_group) return false;
    if (minWait != null && r.waiting_ms < minWait) return false;
    const last = Date.parse(r.last_message_at);
    if (since != null && last < since) return false;
    if (until != null && last > until) return false;
    if (q) {
      const hay = [r.contact, r.number, r.push_name, r.last_message_preview]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function humanize(ms) {
  if (ms < 60000) return 'just now';
  const units = [['y', 31536000000], ['mo', 2592000000], ['d', 86400000], ['h', 3600000], ['m', 60000]];
  const out = [];
  let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { out.push(n + label); rest -= n * size; }
    if (out.length === 2) break;
  }
  return out.join(' ') || 'just now';
}

function render() {
  const rows = visible().sort((a, b) => {
    const k = state.sort;
    let av = a[k], bv = b[k];
    if (k === 'last_message_at') { av = Date.parse(av); bv = Date.parse(bv); }
    if (typeof av === 'string') return state.dir * av.localeCompare(bv);
    return state.dir * ((av ?? 0) - (bv ?? 0));
  });

  $('count').textContent = rows.length;
  const them = rows.filter((r) => r.owed_by === 'them').length;
  $('them').textContent = them;
  $('you').textContent = rows.length - them;
  $('unsaved').textContent = rows.filter((r) => !r.is_group && !r.saved_contact).length;
  $('longest').textContent = rows.length ? humanize(Math.max(...rows.map((r) => r.waiting_ms))) : '—';

  const body = rows.map((r) => {
    const d = new Date(r.last_message_at);
    const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    return '<tr>' +
      '<td>' + esc(r.contact) + (r.is_group ? ' <span class="dot">group</span>' : '') + '</td>' +
      '<td class="num">' + esc(r.number || '—') + '</td>' +
      '<td><span class="badge">' + (r.owed_by === 'them' ? 'them' : 'you') + '</span></td>' +
      '<td class="num">' + date + '</td>' +
      '<td class="num ' + waitClass(r.waiting_ms) + '">' + humanize(r.waiting_ms) + '</td>' +
      '<td class="num">' + r.unanswered_count + '</td>' +
      '<td>' + (r.is_group ? '<span class="dot">n/a</span>'
        : r.saved_contact ? 'yes' : '<span class="dot">no</span>') + '</td>' +
      '<td class="preview">' + esc(r.last_message_preview || '—') + '</td>' +
      '</tr>';
  }).join('');

  $('rows').innerHTML = body ||
    '<tr><td colspan="8" class="empty">Nothing matches these filters.</td></tr>';

  document.querySelectorAll('th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.key === state.sort ? (state.dir === 1 ? '▲' : '▼') : '';
  });
}

document.querySelectorAll('th[data-key]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sort === key) state.dir *= -1;
    else { state.sort = key; state.dir = key === 'contact' ? 1 : -1; }
    render();
  });
});

['q', 'direction', 'saved', 'kind', 'minwait', 'since', 'until'].forEach((id) => {
  $(id).addEventListener('input', render);
});

render();
`;

export function renderHtml(threads, summary, meta = {}) {
  const records = toRecords(threads);
  const generated = new Date().toLocaleString();
  const filterNote =
    meta.filterNote && meta.filterNote !== 'none'
      ? `<div class="sub">Filters applied at generation: ${escapeHtml(meta.filterNote)}</div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unanswered WhatsApp conversations</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>Unanswered conversations</h1>
  <div class="sub">Generated ${escapeHtml(generated)} &middot; ${records.length} thread${records.length === 1 ? '' : 's'} in this export &middot; longest wait ${escapeHtml(humanizeDuration(summary.longestWaitMs))}</div>
  ${filterNote}

  <div class="tiles">
    <div class="tile"><div class="n" id="count">0</div><div class="l">Shown</div></div>
    <div class="tile"><div class="n" id="them">0</div><div class="l">Awaiting them</div></div>
    <div class="tile"><div class="n" id="you">0</div><div class="l">Awaiting you</div></div>
    <div class="tile"><div class="n" id="unsaved">0</div><div class="l">Unsaved numbers</div></div>
    <div class="tile"><div class="n" id="longest">&mdash;</div><div class="l">Longest wait</div></div>
  </div>

  <div class="controls">
    <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="name, number or text"></div>
    <div class="field"><label for="direction">Owed by</label>
      <select id="direction">
        <option value="both">Either side</option>
        <option value="them">Them (no reply to me)</option>
        <option value="you">Me (I never replied)</option>
      </select></div>
    <div class="field"><label for="saved">Contact</label>
      <select id="saved">
        <option value="all">Saved and unsaved</option>
        <option value="saved">Saved only</option>
        <option value="unsaved">Unsaved only</option>
      </select></div>
    <div class="field"><label for="kind">Chat type</label>
      <select id="kind">
        <option value="all">Direct and groups</option>
        <option value="direct">Direct only</option>
        <option value="group">Groups only</option>
      </select></div>
    <div class="field"><label for="minwait">Waiting at least (days)</label><input type="number" id="minwait" min="0" step="1" placeholder="0"></div>
    <div class="field"><label for="since">Last message from</label><input type="date" id="since"></div>
    <div class="field"><label for="until">Last message until</label><input type="date" id="until"></div>
  </div>

  <div class="tablewrap">
    <table>
      <thead><tr>
        <th data-key="contact">Contact <span class="arrow"></span></th>
        <th data-key="number">Number <span class="arrow"></span></th>
        <th data-key="owed_by">Owed by <span class="arrow"></span></th>
        <th data-key="last_message_at">Last message <span class="arrow"></span></th>
        <th data-key="waiting_ms">Waiting <span class="arrow"></span></th>
        <th data-key="unanswered_count">Msgs <span class="arrow"></span></th>
        <th data-key="saved_contact">Saved <span class="arrow"></span></th>
        <th>Last message text</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <footer>Generated locally by wassap. This file contains your message previews &mdash; treat it as private.</footer>
</div>
<script>const DATA = ${embedJson(records)};</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
