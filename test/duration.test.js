import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, resolveInstant, humanizeDuration, formatDate } from '../src/duration.js';

test('parseDuration handles single units', () => {
  assert.equal(parseDuration('30d'), 30 * 86400000);
  assert.equal(parseDuration('12h'), 12 * 3600000);
  assert.equal(parseDuration('2w'), 14 * 86400000);
  assert.equal(parseDuration('90m'), 90 * 60000);
  assert.equal(parseDuration('3mo'), 90 * 86400000);
  assert.equal(parseDuration('1y'), 365 * 86400000);
});

test('parseDuration handles compound and spaced forms', () => {
  assert.equal(parseDuration('1d12h'), 36 * 3600000);
  assert.equal(parseDuration('2w 3d'), 17 * 86400000);
  assert.equal(parseDuration('1D12H'), 36 * 3600000);
});

test('parseDuration treats a bare number as days', () => {
  assert.equal(parseDuration('7'), 7 * 86400000);
});

test('parseDuration rejects non-durations', () => {
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('2026-01-15'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(null), null);
});

test('resolveInstant accepts durations and absolute dates', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  assert.equal(resolveInstant('30d', now), now - 30 * 86400000);
  assert.equal(resolveInstant('2026-01-15', now), Date.parse('2026-01-15'));
  assert.equal(resolveInstant('now', now), now);
  assert.equal(resolveInstant(null, now), null);
});

test('resolveInstant reports unusable input', () => {
  assert.throws(() => resolveInstant('last tuesday'), /Cannot read/);
});

test('humanizeDuration shows at most two units', () => {
  assert.equal(humanizeDuration(12 * 86400000 + 4 * 3600000), '12d 4h');
  assert.equal(humanizeDuration(45 * 60000), '45m');
  assert.equal(humanizeDuration(30 * 1000), 'just now');
  assert.equal(humanizeDuration(0), 'just now');
  assert.equal(humanizeDuration(-5), 'just now');
  assert.equal(humanizeDuration(null), '-'.replace('-', String.fromCharCode(8212)));
});

test('formatDate includes the year only when it differs', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  assert.match(formatDate(Date.parse('2026-09-02T10:00:00Z'), now), /Sep 0[12]/);
  assert.match(formatDate(Date.parse('2025-09-02T10:00:00Z'), now), /2025/);
});
