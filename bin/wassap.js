#!/usr/bin/env node
import '../src/warnings.js';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getMeta, counts } from '../src/db.js';
import { dataDir, sessionDir, dbPath } from '../src/config.js';
import { review } from '../src/review.js';
import { resolveInstant, parseDuration, humanizeDuration } from '../src/duration.js';
import { renderTable, renderSummary } from '../src/report/table.js';
import { toJson, toCsv } from '../src/report/data.js';
import { renderHtml } from '../src/report/html.js';
import { SORT_KEYS } from '../src/filters.js';
import { describeStore, resetStore } from '../src/reset.js';
import { invocation, command, setInvocation } from '../src/invocation.js';

// How this user actually invokes the tool, so every suggestion is copy-pasteable.
const CMD = invocation(import.meta.url);
setInvocation(CMD);
import { bold, dim, cyan, yellow } from '../src/report/style.js';

const HELP = `
${bold('wassap')} - review WhatsApp conversations that went unanswered.

${bold('USAGE')}
  ${CMD} <command> [options]

${bold('COMMANDS')}
  login                 Link this tool to your WhatsApp account (shows a QR code).
  sync                  Pull chats and recent messages into the local database.
  review                Report unanswered conversations (default command).
  status                Show what is stored locally and when it was last synced.
  reset                 Delete the local message database (needs --yes).
  logout                Unlink the device and delete the stored session.

${bold('REVIEW FILTERS')}
  --direction <both|them|you>   Who is being waited on. them = they never replied
                                to you; you = you never replied to them. (both)
  --since <date|duration>       Only chats whose last message is newer than this,
                                e.g. --since 30d, --since 2026-01-15.
  --until <date|duration>       Only chats whose last message is older than this.
  --min-wait <duration>         Only threads pending at least this long, e.g. 3d.
  --max-wait <duration>         Only threads pending at most this long.
  --saved                       Only numbers saved in your contacts.
  --unsaved                     Only numbers not in your contacts.
  --chat-type <direct|group|all>  Which chats to include. (direct)
  --groups                      Shorthand for --chat-type all.
  --only-groups                 Shorthand for --chat-type group.
  --archived                    Include archived chats.
  --exclude-muted               Skip muted chats.
  --blocked                     Include blocked contacts.
  --search <text>               Match a name, number or push name.
  --min-messages <n>            Ignore threads with fewer than n messages.
  --unread                      Only chats with unread messages.
  --sort <key>                  ${Object.keys(SORT_KEYS).join(', ')}. (waiting)
  --limit <n>                   Show at most n rows.

${bold('OUTPUT')}
  --json                        Write JSON (stdout unless --out is given).
  --csv                         Write CSV (stdout unless --out is given).
  --html                        Write an interactive HTML dashboard (report.html).
  --out <path>                  Destination file for the chosen format.

${bold('RESET OPTIONS')}
  --yes                         Confirm the deletion. Without it, reset only reports.
  --all                         Also remove the linked session, as logout does.

${bold('SYNC OPTIONS')}
  --messages <n>                Messages to fetch per chat. (50)
  --no-groups                   Skip group chats while syncing.

${bold('EXAMPLES')}
  ${CMD} login
  ${CMD} sync --messages 100
  ${CMD} review --min-wait 3d --unsaved
  ${CMD} review --direction them --since 30d --sort waiting
  ${CMD} review --groups --html --out ~/Desktop/unanswered.html
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  direction: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  'min-wait': { type: 'string' },
  'max-wait': { type: 'string' },
  saved: { type: 'boolean' },
  unsaved: { type: 'boolean' },
  'chat-type': { type: 'string' },
  groups: { type: 'boolean' },
  'only-groups': { type: 'boolean' },
  archived: { type: 'boolean' },
  'exclude-muted': { type: 'boolean' },
  blocked: { type: 'boolean' },
  search: { type: 'string' },
  'min-messages': { type: 'string' },
  unread: { type: 'boolean' },
  sort: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  csv: { type: 'boolean' },
  html: { type: 'boolean' },
  out: { type: 'string' },
  messages: { type: 'string' },
  'no-groups': { type: 'boolean' },
  yes: { type: 'boolean' },
  all: { type: 'boolean' },
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function integer(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} expects a whole number, got "${value}".`);
  return n;
}

function duration(value, flag) {
  if (value === undefined) return null;
  const ms = parseDuration(value);
  if (ms === null) fail(`${flag} expects a duration like 3d, 12h or 2w, got "${value}".`);
  return ms;
}

function filtersFrom(values, now) {
  if (values.saved && values.unsaved) {
    fail('--saved and --unsaved contradict each other; pass neither to see both.');
  }

  let chatType = values['chat-type'] ?? (values['only-groups'] ? 'group' : values.groups ? 'all' : 'direct');
  if (!['direct', 'group', 'all'].includes(chatType)) {
    fail(`--chat-type expects direct, group or all, got "${chatType}".`);
  }

  const direction = values.direction ?? 'both';
  if (!['both', 'them', 'you'].includes(direction)) {
    fail(`--direction expects both, them or you, got "${direction}".`);
  }

  const sort = values.sort ?? 'waiting';
  if (!(sort in SORT_KEYS)) {
    fail(`--sort expects one of: ${Object.keys(SORT_KEYS).join(', ')}. Got "${sort}".`);
  }

  let since = null;
  let until = null;
  try {
    since = values.since ? resolveInstant(values.since, now) : null;
    until = values.until ? resolveInstant(values.until, now) : null;
  } catch (err) {
    fail(err.message);
  }

  return {
    direction,
    since,
    until,
    minWait: duration(values['min-wait'], '--min-wait'),
    maxWait: duration(values['max-wait'], '--max-wait'),
    saved: values.saved ? true : values.unsaved ? false : undefined,
    chatType,
    archived: Boolean(values.archived),
    muted: !values['exclude-muted'],
    blocked: Boolean(values.blocked),
    search: values.search ?? null,
    minMessages: integer(values['min-messages'], '--min-messages') ?? 1,
    unreadOnly: Boolean(values.unread),
    sort,
    limit: integer(values.limit, '--limit') ?? 0,
  };
}

/** A short human description of the active filters, for the HTML header. */
function describeFilters(opts) {
  const parts = [];
  if (opts.direction !== 'both') parts.push(`owed by ${opts.direction}`);
  if (opts.saved === true) parts.push('saved contacts only');
  if (opts.saved === false) parts.push('unsaved numbers only');
  if (opts.chatType !== 'all') parts.push(`${opts.chatType} chats`);
  if (opts.minWait) parts.push(`waiting at least ${humanizeDuration(opts.minWait)}`);
  if (opts.maxWait) parts.push(`waiting at most ${humanizeDuration(opts.maxWait)}`);
  if (opts.since) parts.push(`last message after ${new Date(opts.since).toLocaleDateString()}`);
  if (opts.until) parts.push(`last message before ${new Date(opts.until).toLocaleDateString()}`);
  if (opts.search) parts.push(`matching "${opts.search}"`);
  if (opts.unreadOnly) parts.push('unread only');
  if (opts.archived) parts.push('including archived');
  return parts.join(', ') || 'none';
}

function writeOut(content, target, kindLabel) {
  if (!target) {
    process.stdout.write(content);
    return;
  }
  const file = path.resolve(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  process.stderr.write(`${kindLabel} written to ${file}\n`);
}

async function cmdReview(values) {
  const now = Date.now();
  const opts = filtersFrom(values, now);
  const db = openDb();

  if (counts(db).chats === 0) {
    process.stderr.write(
      dim(`No data yet. Run \`${command('login', CMD)}\` to link your account, then \`${command('sync', CMD)}\`.\n`)
    );
    process.exit(1);
  }

  const { threads, summary, scanned, matched } = review(db, opts, now);

  if (values.json) {
    writeOut(toJson(threads, summary), values.out, 'JSON');
    return;
  }
  if (values.csv) {
    writeOut(toCsv(threads), values.out, 'CSV');
    return;
  }
  if (values.html) {
    const html = renderHtml(threads, summary, { filterNote: describeFilters(opts) });
    writeOut(html, values.out ?? 'report.html', 'Dashboard');
    return;
  }

  process.stdout.write(renderSummary(summary, { scanned }) + '\n\n');
  process.stdout.write(renderTable(threads, { now }) + '\n');
  if (opts.limit && matched > threads.length) {
    process.stdout.write(dim(`\nShowing ${threads.length} of ${matched} matches (--limit).\n`));
  }
}

async function cmdSync(values) {
  const { sync } = await import('../src/sync.js');
  const db = openDb();
  const onStatus = (m) => process.stderr.write(`${m}\n`);
  const result = await sync(db, {
    limit: integer(values.messages, '--messages') ?? 50,
    includeGroups: !values['no-groups'],
    onStatus,
  });
  process.stderr.write(
    `\nSynced ${result.chats} chats. Local store now holds ` +
      `${result.stored.chats} chats and ${result.stored.messages} messages.\n` +
      dim(`Run \`${command('review', CMD)}\` to see what is unanswered.\n`)
  );
}

async function cmdLogin() {
  const { withClient } = await import('../src/whatsapp.js');
  const onStatus = (m) => process.stderr.write(`${m}\n`);
  await withClient(
    async (client) => {
      const me = client.info?.pushname ?? client.info?.wid?.user ?? 'your account';
      process.stderr.write(`\nLinked as ${bold(String(me))}.\n`);
      process.stderr.write(dim(`Next: run \`${command('sync', CMD)}\` to pull your chats.\n`));
    },
    { onStatus }
  );
}

function cmdStatus() {
  const db = openDb();
  const totals = counts(db);
  const account = getMeta(db, 'account');
  const lastSync = getMeta(db, 'last_sync');
  const linked = fs.existsSync(sessionDir());

  process.stdout.write(`${bold(command('status', CMD))}\n`);
  process.stdout.write(`  data directory  ${dataDir()}\n`);
  process.stdout.write(`  linked session  ${linked ? cyan('yes') : dim(`no - run \`${command('login', CMD)}\``)}\n`);
  process.stdout.write(`  account         ${account ?? dim('unknown')}\n`);
  process.stdout.write(
    `  last sync       ${lastSync ? `${new Date(Number(lastSync)).toLocaleString()} ` + dim(`(${humanizeDuration(Date.now() - Number(lastSync))} ago)`) : dim('never')}\n`
  );
  process.stdout.write(`  stored          ${totals.chats} chats, ${totals.messages} messages\n`);
  if (getMeta(db, 'demo') === '1') {
    process.stdout.write(
      `  ${yellow('note')}            this is demo data from scripts/seed-demo.js; ` +
        `run \`${command('reset --yes', CMD)}\` before syncing your real account\n`
    );
  }
}

function cmdReset(values) {
  const store = describeStore();

  if (!values.yes) {
    process.stdout.write(
      `${bold(command('reset', CMD))} would delete:\n` +
        `  ${store.file}\n` +
        (store.exists
          ? `    ${store.chats} chats, ${store.messages} messages` +
            `${store.isDemo ? dim(' (demo data)') : ''}\n`
          : `    ${dim('nothing stored yet')}\n`) +
        (values.all ? `  ${store.session}\n    the linked device session\n` : '') +
        `\nRe-run with --yes to confirm.\n`
    );
    return;
  }

  const removed = resetStore({ all: Boolean(values.all) });
  if (removed.length === 0) {
    process.stdout.write('Nothing to delete.\n');
    return;
  }
  for (const path of removed) process.stdout.write(`Deleted ${path}\n`);
  if (values.all) {
    process.stdout.write(dim('Also unlink "wassap" under WhatsApp > Linked devices.\n'));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const commands = new Set(['login', 'sync', 'review', 'status', 'reset', 'logout', 'help']);
  const command = commands.has(argv[0]) ? argv.shift() : 'review';

  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (err) {
    fail(`${err.message}\n\nRun \`${command('help', CMD)}\` for available options.`);
  }

  if (command === 'help' || values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  switch (command) {
    case 'login':
      return cmdLogin();
    case 'sync':
      return cmdSync(values);
    case 'status':
      return cmdStatus();
    case 'reset':
      return cmdReset(values);
    case 'logout':
      return cmdLogout();
    default:
      return cmdReview(values);
  }
}

/**
 * Puppeteer and whatsapp-web.js surface low-level failures. Translate the ones
 * users actually hit into something actionable; WASSAP_DEBUG=1 keeps the stack.
 */
function explain(err) {
  const text = String(err?.message ?? err);

  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED/.test(text)) {
    return (
      'Could not reach web.whatsapp.com.\n' +
      'Check your internet connection, and if you are behind a proxy or a restricted\n' +
      'network, note that linking needs direct HTTPS access to web.whatsapp.com.'
    );
  }
  if (/Could not find (expected )?browser|Failed to launch|spawn .*ENOENT/i.test(text)) {
    return (
      'No usable Chromium was found.\n' +
      'Install Chrome or Chromium, then point wassap at it:\n' +
      '  export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome'
    );
  }
  if (/Execution context was destroyed|Session closed|Target closed|Protocol error/i.test(text)) {
    return (
      'The browser session ended unexpectedly. This usually means WhatsApp logged the\n' +
      `device out. Run \`${command('logout', CMD)}\` and then \`${command('login', CMD)}\` to link again.`
    );
  }
  if (/authentication failed/i.test(text)) {
    return `WhatsApp rejected the stored session. Run \`${command('logout', CMD)}\`, then \`${command('login', CMD)}\`.`;
  }
  return null;
}

main().catch((err) => {
  // Errors we raised ourselves already say the right thing.
  if (err?.userFacing) {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(1);
  }

  const hint = explain(err);
  if (hint && !process.env.WASSAP_DEBUG) {
    process.stderr.write(`\n${hint}\n`);
  } else {
    process.stderr.write(`\n${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
