import { humanizeDuration, formatDate } from '../duration.js';
import { bold, dim, red, yellow, green, cyan, pad, truncate, displayWidth } from './style.js';

const DAY = 24 * 60 * 60 * 1000;

/** Colour the waiting time by how stale it is. */
function waitingCell(ms) {
  const text = humanizeDuration(ms);
  if (ms >= 7 * DAY) return red(text);
  if (ms >= 2 * DAY) return yellow(text);
  return text;
}

function directionCell(direction) {
  return direction === 'awaiting_them' ? cyan('them') : yellow('you');
}

/**
 * Column definitions. `drop` is the order columns are sacrificed when the
 * terminal is too narrow (higher number goes first).
 */
function columnsFor(threads, opts) {
  const mixedDirection = new Set(threads.map((t) => t.direction)).size > 1;
  const anyGroup = threads.some((t) => t.isGroup);

  return [
    { key: 'index', label: '#', align: 'right', drop: 0,
      width: String(threads.length).length,
      value: (_t, i) => dim(String(i + 1)) },

    { key: 'name', label: 'Contact', align: 'left', drop: 0, min: 12, max: 28, flex: 2,
      value: (t) => (t.isGroup ? `${t.name}` : t.name) },

    { key: 'number', label: 'Number', align: 'left', drop: 3, width: 15,
      value: (t) => dim(t.number ?? '—') },

    ...(mixedDirection
      ? [{ key: 'owed', label: 'Owed by', align: 'left', drop: 1, width: 7,
           value: (t) => directionCell(t.direction) }]
      : []),

    { key: 'last', label: 'Last', align: 'right', drop: 0, width: 11,
      value: (t) => formatDate(t.lastMessageAt, opts.now) },

    { key: 'waiting', label: 'Waiting', align: 'right', drop: 0, width: 9,
      value: (t) => waitingCell(t.waitingMs) },

    { key: 'msgs', label: 'Msgs', align: 'right', drop: 4, width: 4,
      value: (t) => String(t.unansweredCount) },

    { key: 'saved', label: 'Saved', align: 'left', drop: 2, width: 5,
      value: (t) => (t.isGroup ? dim('—') : t.isSaved ? green('yes') : dim('no')) },

    ...(anyGroup
      ? [{ key: 'type', label: 'Type', align: 'left', drop: 2, width: 6,
           value: (t) => dim(t.isGroup ? 'group' : 'direct') }]
      : []),

    { key: 'preview', label: 'Last message', align: 'left', drop: 5, min: 16, max: 60, flex: 3,
      value: (t) => dim(t.lastMessagePreview || '—') },
  ];
}

/** Fit columns into the available width, dropping and flexing as needed. */
function layout(columns, available) {
  const gap = 2; // spaces between columns
  let cols = [...columns];

  const fixedWidth = (c) => c.width ?? c.min ?? displayWidth(c.label);
  const total = (list) =>
    list.reduce((sum, c) => sum + fixedWidth(c), 0) + gap * Math.max(0, list.length - 1);

  const dropOrder = [...new Set(cols.map((c) => c.drop))].sort((a, b) => b - a);
  for (const level of dropOrder) {
    if (level === 0 || total(cols) <= available) break;
    cols = cols.filter((c) => c.drop !== level);
  }

  // Hand leftover space to the flexible columns, proportional to their weight.
  const sized = cols.map((c) => ({ ...c, size: fixedWidth(c) }));
  let slack = available - total(sized);
  const flexible = sized.filter((c) => c.flex);
  if (slack > 0 && flexible.length) {
    const weight = flexible.reduce((sum, c) => sum + c.flex, 0);
    for (const c of flexible) {
      const room = (c.max ?? Infinity) - c.size;
      const share = Math.min(room, Math.floor((slack * c.flex) / weight));
      c.size += Math.max(0, share);
    }
    // Distribute any rounding remainder one cell at a time.
    slack = available - sized.reduce((s, c) => s + c.size, 0) - gap * (sized.length - 1);
    for (const c of flexible) {
      if (slack <= 0) break;
      if (c.size < (c.max ?? Infinity)) {
        c.size += 1;
        slack -= 1;
      }
    }
  }
  return sized;
}

/** Terminal width, falling back to $COLUMNS when output is piped. */
function terminalWidth() {
  if (process.stdout.columns) return process.stdout.columns;
  const fromEnv = Number(process.env.COLUMNS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100;
}

export function renderTable(threads, opts = {}) {
  const now = opts.now ?? Date.now();
  const width = opts.width ?? terminalWidth();

  if (threads.length === 0) {
    return dim('No unanswered conversations match those filters.');
  }

  const cols = layout(columnsFor(threads, { now }), Math.max(40, width - 1));
  const gap = '  ';

  const header = cols.map((c) => bold(pad(truncate(c.label, c.size), c.size, c.align))).join(gap);
  const rule = dim(cols.map((c) => '-'.repeat(c.size)).join(gap));

  const rows = threads.map((t, i) => {
    const cells = cols.map((c) => {
      const raw = c.value(t, i);
      return pad(truncate(raw, c.size), c.size, c.align);
    });
    return cells.join(gap);
  });

  return [header, rule, ...rows].join('\n');
}

/** Headline block printed above the table. */
export function renderSummary(summary, opts = {}) {
  const scanned = opts.scanned ?? summary.total;
  const lines = [
    bold(`${summary.total} unanswered conversation${summary.total === 1 ? '' : 's'}`) +
      dim(` (of ${scanned} analysed)`),
    `  ${cyan('awaiting them')} ${summary.awaitingThem}` +
      dim('  ·  ') +
      `${yellow('awaiting you')} ${summary.awaitingYou}`,
    `  ${dim('saved')} ${summary.saved}` +
      dim('  ·  ') +
      `${dim('unsaved')} ${summary.unsaved}` +
      dim('  ·  ') +
      `${dim('groups')} ${summary.groups}` +
      dim('  ·  ') +
      `${dim('longest wait')} ${humanizeDuration(summary.longestWaitMs)}`,
  ];
  return lines.join('\n');
}
