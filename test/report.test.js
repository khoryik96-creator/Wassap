import test from 'node:test';
import assert from 'node:assert/strict';
import { toRecords, toCsv, toJson } from '../src/report/data.js';
import { renderHtml } from '../src/report/html.js';
import { renderTable, renderSummary } from '../src/report/table.js';
import { displayWidth, truncate, pad, stripAnsi } from '../src/report/style.js';
import { summarize } from '../src/analyze.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const QUOTE = String.fromCharCode(34);

function thread(over = {}) {
  return {
    chatId: 'c1@c.us', name: 'Priya M.', number: '+447700900123', pushName: null,
    contactName: 'Priya M.', isGroup: false, isSaved: true, isArchived: false,
    isMuted: false, isBusiness: false, isBlocked: false, participants: 0, unreadCount: 0,
    direction: 'awaiting_them', lastMessageAt: NOW - 5 * DAY, lastMessageFromMe: true,
    lastMessagePreview: 'are we still on for Friday?', unansweredSince: NOW - 5 * DAY,
    unansweredCount: 1, waitingMs: 5 * DAY, silenceMs: 5 * DAY, messageCount: 4,
    outgoingCount: 2, incomingCount: 2, firstMessageAt: NOW - 40 * DAY,
    ...over,
  };
}

test('records carry both machine and human forms of the wait', () => {
  const [r] = toRecords([thread()]);
  assert.equal(r.owed_by, 'them');
  assert.equal(r.waiting_ms, 5 * DAY);
  assert.equal(r.waiting_human, '5d');
  assert.equal(r.saved_contact, true);
  assert.equal(r.last_message_at, new Date(NOW - 5 * DAY).toISOString());
});

test('CSV quotes commas, quotes and newlines', () => {
  const csv = toCsv([
    thread({ lastMessagePreview: 'hi, ' + QUOTE + 'you' + QUOTE }),
    thread({ chatId: 'c2', lastMessagePreview: 'line one\nline two' }),
  ]);
  const [header, ...rows] = csv.trim().split('\n');
  assert.match(header, /^contact,number/);
  const doubled = QUOTE + 'hi, ' + QUOTE + QUOTE + 'you' + QUOTE + QUOTE + QUOTE;
  assert.ok(csv.includes(doubled), 'embedded quotes are doubled');
  assert.ok(csv.includes(QUOTE + 'line one\nline two' + QUOTE), 'newlines stay in a quoted cell');
  assert.ok(rows.length >= 2);
});

test('CSV of nothing is empty rather than a stray header', () => {
  assert.equal(toCsv([]), '');
});

test('JSON output is parseable and carries the summary', () => {
  const threads = [thread(), thread({ chatId: 'c2', direction: 'awaiting_you', isSaved: false })];
  const parsed = JSON.parse(toJson(threads, summarize(threads)));
  assert.equal(parsed.threads.length, 2);
  assert.equal(parsed.summary.awaitingThem, 1);
  assert.equal(parsed.summary.awaitingYou, 1);
  assert.ok(parsed.generated_at);
});

test('HTML embeds the data and neutralises script-closing text', () => {
  const evil = 'evil </script><script>alert(1)</script>';
  const threads = [thread({ lastMessagePreview: evil })];
  const html = renderHtml(threads, summarize(threads), { filterNote: 'unsaved numbers only' });

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Unanswered conversations'));
  assert.ok(html.includes('unsaved numbers only'));
  assert.ok(html.includes('const DATA = ['));
  assert.ok(
    !html.includes('</script><script>alert(1)'),
    'a raw closing script tag must not survive into the page'
  );
  assert.ok(html.includes('\\u003c/script\\u003e'), 'angle brackets are escaped in the payload');
});

test('HTML escapes markup in contact names', () => {
  const threads = [thread({ name: '<img onerror=x>' })];
  const html = renderHtml(threads, summarize(threads));
  assert.ok(!html.includes('<img onerror=x>'));
});

test('the table renders a header, a rule and one row per thread', () => {
  const threads = [thread(), thread({ chatId: 'c2', name: 'Sam', direction: 'awaiting_you' })];
  const out = stripAnsi(renderTable(threads, { now: NOW, width: 120 }));
  const lines = out.split('\n');
  assert.match(lines[0], /Contact/);
  assert.match(lines[0], /Waiting/);
  assert.match(lines[0], /Owed by/, 'the bucket column appears when both directions are present');
  assert.match(lines[1], /^-+/);
  assert.equal(lines.length, 4);
  assert.match(out, /Priya M\./);
  assert.match(out, /5d/);
});

test('the table drops optional columns rather than overflowing a narrow terminal', () => {
  const out = stripAnsi(renderTable([thread()], { now: NOW, width: 52 }));
  for (const line of out.split('\n')) {
    assert.ok(displayWidth(line) <= 52, 'line too wide: ' + displayWidth(line));
  }
  assert.match(out, /Contact/);
  assert.match(out, /Waiting/);
});

test('the table keeps its columns aligned with wide characters', () => {
  const threads = [thread({ name: 'Priya' }), thread({ chatId: 'c2', name: 'Yuki 日本語' })];
  const lines = stripAnsi(renderTable(threads, { now: NOW, width: 120 })).split('\n');
  const widths = lines.map((l) => displayWidth(l.trimEnd()));
  assert.ok(Math.max(...widths) - Math.min(...widths) < 40, 'rows stay roughly rectangular');
});

test('an empty result says so instead of drawing an empty table', () => {
  assert.match(stripAnsi(renderTable([], { now: NOW })), /No unanswered conversations/);
});

test('the summary block reports both buckets', () => {
  const threads = [thread(), thread({ chatId: 'c2', direction: 'awaiting_you', isSaved: false })];
  const out = stripAnsi(renderSummary(summarize(threads), { scanned: 10 }));
  assert.match(out, /2 unanswered conversations/);
  assert.match(out, /of 10 analysed/);
  assert.match(out, /awaiting them 1/);
  assert.match(out, /awaiting you 1/);
});

test('width helpers account for wide glyphs and ANSI', () => {
  const esc = String.fromCharCode(27);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth(esc + '[1mabc' + esc + '[22m'), 3);
  assert.equal(displayWidth(truncate('abcdefghij', 5)), 5);
  assert.equal(displayWidth(pad('ab', 6)), 6);
});

test('the table shows a placeholder rather than a saved flag for groups', () => {
  const out = stripAnsi(renderTable([thread({ isGroup: true, number: null, name: 'Five-a-side' })], { now: NOW, width: 120 }));
  const row = out.split('\n')[2];
  assert.match(row, /Five-a-side/);
  assert.ok(!/\byes\b|\bno\b/.test(row), 'no saved/unsaved verdict for a group');
});
