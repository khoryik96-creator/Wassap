import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, sortThreads } from '../src/filters.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const daysAgo = (n) => NOW - n * DAY;

function thread(over = {}) {
  return {
    chatId: 'c1', name: 'Priya', number: '+447700900123', pushName: null, contactName: 'Priya',
    isGroup: false, isSaved: true, isArchived: false, isMuted: false, isBusiness: false,
    isBlocked: false, participants: 0, unreadCount: 0,
    direction: 'awaiting_them', lastMessageAt: daysAgo(5), lastMessageFromMe: true,
    lastMessagePreview: 'ping', unansweredSince: daysAgo(5), unansweredCount: 1,
    waitingMs: 5 * DAY, silenceMs: 5 * DAY, messageCount: 4,
    outgoingCount: 2, incomingCount: 2, firstMessageAt: daysAgo(40),
    ...over,
  };
}

const names = (list) => list.map((t) => t.name);

test('direct chats only by default; groups opt in', () => {
  const threads = [thread({ name: 'Priya' }), thread({ name: 'Team', isGroup: true })];
  assert.deepEqual(names(applyFilters(threads, {})), ['Priya']);
  assert.deepEqual(names(applyFilters(threads, { chatType: 'all' })), ['Priya', 'Team']);
  assert.deepEqual(names(applyFilters(threads, { chatType: 'group' })), ['Team']);
});

test('direction selects a bucket', () => {
  const threads = [
    thread({ name: 'Owed by them', direction: 'awaiting_them' }),
    thread({ name: 'Owed by me', direction: 'awaiting_you' }),
  ];
  assert.deepEqual(names(applyFilters(threads, { direction: 'them' })), ['Owed by them']);
  assert.deepEqual(names(applyFilters(threads, { direction: 'you' })), ['Owed by me']);
  assert.equal(applyFilters(threads, { direction: 'both' }).length, 2);
});

test('saved and unsaved narrow by address book', () => {
  const threads = [
    thread({ name: 'Saved', isSaved: true }),
    thread({ name: 'Unsaved', isSaved: false }),
  ];
  assert.deepEqual(names(applyFilters(threads, { saved: true })), ['Saved']);
  assert.deepEqual(names(applyFilters(threads, { saved: false })), ['Unsaved']);
  assert.equal(applyFilters(threads, { saved: undefined }).length, 2);
});

test('since and until bound the last message date', () => {
  const threads = [
    thread({ name: 'Recent', lastMessageAt: daysAgo(2) }),
    thread({ name: 'Old', lastMessageAt: daysAgo(60) }),
  ];
  assert.deepEqual(names(applyFilters(threads, { since: daysAgo(30) })), ['Recent']);
  assert.deepEqual(names(applyFilters(threads, { until: daysAgo(30) })), ['Old']);
});

test('minWait and maxWait bound how long it has been pending', () => {
  const threads = [
    thread({ name: 'Fresh', waitingMs: 1 * DAY }),
    thread({ name: 'Stale', waitingMs: 30 * DAY }),
  ];
  assert.deepEqual(names(applyFilters(threads, { minWait: 3 * DAY })), ['Stale']);
  assert.deepEqual(names(applyFilters(threads, { maxWait: 3 * DAY })), ['Fresh']);
});

test('archived, muted and blocked chats follow their flags', () => {
  const archived = [thread({ name: 'Archived', isArchived: true })];
  assert.equal(applyFilters(archived, {}).length, 0);
  assert.equal(applyFilters(archived, { archived: true }).length, 1);

  const muted = [thread({ name: 'Muted', isMuted: true })];
  assert.equal(applyFilters(muted, {}).length, 1, 'muted chats are included by default');
  assert.equal(applyFilters(muted, { muted: false }).length, 0);

  const blocked = [thread({ name: 'Blocked', isBlocked: true })];
  assert.equal(applyFilters(blocked, {}).length, 0);
  assert.equal(applyFilters(blocked, { blocked: true }).length, 1);
});

test('search matches name, number and push name', () => {
  const threads = [
    thread({ name: 'Priya', number: '+447700900123', pushName: null }),
    thread({ name: '+19998887777', number: '+19998887777', pushName: 'Sam', contactName: null }),
  ];
  assert.deepEqual(names(applyFilters(threads, { search: 'priy' })), ['Priya']);
  assert.deepEqual(names(applyFilters(threads, { search: '9998' })), ['+19998887777']);
  assert.deepEqual(names(applyFilters(threads, { search: 'sam' })), ['+19998887777']);
  assert.equal(applyFilters(threads, { search: 'nobody' }).length, 0);
});

test('minMessages and unreadOnly trim thin or read chats', () => {
  const threads = [
    thread({ name: 'Thin', messageCount: 1, unreadCount: 0 }),
    thread({ name: 'Rich', messageCount: 20, unreadCount: 3 }),
  ];
  assert.deepEqual(names(applyFilters(threads, { minMessages: 5 })), ['Rich']);
  assert.deepEqual(names(applyFilters(threads, { unreadOnly: true })), ['Rich']);
});

test('filters combine', () => {
  const threads = [
    thread({ name: 'Match', isSaved: false, waitingMs: 10 * DAY, direction: 'awaiting_them' }),
    thread({ name: 'Saved too recent', isSaved: true, waitingMs: 10 * DAY }),
    thread({ name: 'Unsaved but fresh', isSaved: false, waitingMs: 1 * DAY }),
  ];
  const got = applyFilters(threads, { saved: false, minWait: 3 * DAY, direction: 'them' });
  assert.deepEqual(names(got), ['Match']);
});

test('sortThreads orders by the requested key', () => {
  const threads = [
    thread({ name: 'B', waitingMs: 1 * DAY, lastMessageAt: daysAgo(1), unansweredCount: 5 }),
    thread({ name: 'A', waitingMs: 9 * DAY, lastMessageAt: daysAgo(9), unansweredCount: 1 }),
  ];
  assert.deepEqual(names(sortThreads(threads, 'waiting')), ['A', 'B']);
  assert.deepEqual(names(sortThreads(threads, 'date')), ['B', 'A']);
  assert.deepEqual(names(sortThreads(threads, 'oldest')), ['A', 'B']);
  assert.deepEqual(names(sortThreads(threads, 'name')), ['A', 'B']);
  assert.deepEqual(names(sortThreads(threads, 'count')), ['B', 'A']);
});

test('sortThreads rejects an unknown key', () => {
  assert.throws(() => sortThreads([], 'nope'), /Unknown sort/);
});

test('sortThreads does not mutate its input', () => {
  const threads = [thread({ name: 'B', waitingMs: 1 }), thread({ name: 'A', waitingMs: 9 })];
  sortThreads(threads, 'waiting');
  assert.deepEqual(names(threads), ['B', 'A']);
});

test('asking for saved or unsaved numbers excludes groups', () => {
  const threads = [
    thread({ name: 'Saved', isSaved: true }),
    thread({ name: 'Unsaved', isSaved: false }),
    thread({ name: 'Group', isGroup: true, isSaved: false }),
  ];
  const opts = { chatType: 'all' };
  assert.deepEqual(names(applyFilters(threads, { ...opts, saved: false })), ['Unsaved']);
  assert.deepEqual(names(applyFilters(threads, { ...opts, saved: true })), ['Saved']);
  assert.equal(applyFilters(threads, opts).length, 3, 'without the filter groups stay');
});
