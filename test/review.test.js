import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertChat, upsertMessages, setMeta, getMeta, counts } from '../src/db.js';
import { review, buildThreads } from '../src/review.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const daysAgo = (n) => NOW - n * DAY;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function seed(db) {
  // Saved contact, I pinged twice with no reply.
  upsertChat(db, {
    id: 'saved@c.us', name: 'Priya M.', number: '447700900123',
    is_my_contact: 1, contact_name: 'Priya M.',
  });
  upsertMessages(db, [
    { id: 's1', chat_id: 'saved@c.us', timestamp: daysAgo(30), from_me: 0, type: 'chat', body: 'hey' },
    { id: 's2', chat_id: 'saved@c.us', timestamp: daysAgo(12), from_me: 1, type: 'chat', body: 'still on?' },
    { id: 's3', chat_id: 'saved@c.us', timestamp: daysAgo(9), from_me: 1, type: 'chat', body: 'bump' },
  ]);

  // Unsaved number waiting on me.
  upsertChat(db, {
    id: 'unsaved@c.us', name: null, number: '19998887777',
    is_my_contact: 0, push_name: 'Sam',
  });
  upsertMessages(db, [
    { id: 'u1', chat_id: 'unsaved@c.us', timestamp: daysAgo(4), from_me: 0, type: 'chat', body: 'quote attached' },
  ]);

  // Group chat, unanswered by me.
  upsertChat(db, { id: 'grp@g.us', name: 'Five-a-side', is_group: 1, participants: 8 });
  upsertMessages(db, [
    { id: 'g1', chat_id: 'grp@g.us', timestamp: daysAgo(2), from_me: 0, type: 'chat', body: 'who is in?' },
  ]);

  // Archived, and fully answered - neither should surface by default.
  upsertChat(db, { id: 'arch@c.us', name: 'Old thing', is_archived: 1, is_my_contact: 1 });
  upsertMessages(db, [
    { id: 'a1', chat_id: 'arch@c.us', timestamp: daysAgo(200), from_me: 1, type: 'chat', body: 'x' },
  ]);

  // Status broadcast must never appear.
  upsertChat(db, { id: 'status@broadcast', name: 'Status' });
  upsertMessages(db, [
    { id: 'b1', chat_id: 'status@broadcast', timestamp: daysAgo(1), from_me: 0, type: 'chat', body: 'x' },
  ]);
}

test('buildThreads reads chats and messages back out of SQLite', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed(db);

  const threads = buildThreads(db, NOW);
  const ids = threads.map((x) => x.chatId).sort();
  assert.deepEqual(ids, ['arch@c.us', 'grp@g.us', 'saved@c.us', 'unsaved@c.us']);
  assert.ok(!ids.includes('status@broadcast'), 'status feed is excluded');
});

test('the default review shows direct, unarchived threads sorted by wait', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed(db);

  const { threads, summary, scanned, matched } = review(db, {}, NOW);
  assert.deepEqual(threads.map((x) => x.chatId), ['saved@c.us', 'unsaved@c.us']);
  assert.equal(scanned, 4);
  assert.equal(matched, 2);
  assert.equal(summary.awaitingThem, 1);
  assert.equal(summary.awaitingYou, 1);

  const [priya] = threads;
  assert.equal(priya.unansweredCount, 2, 'two unreplied messages in a row');
  assert.equal(priya.waitingMs, 12 * DAY, 'pending since the first of those');
  assert.equal(priya.silenceMs, 9 * DAY);
});

test('filters flow through the review pipeline', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed(db);

  assert.deepEqual(
    review(db, { saved: false }, NOW).threads.map((x) => x.chatId),
    ['unsaved@c.us']
  );
  assert.deepEqual(
    review(db, { direction: 'them' }, NOW).threads.map((x) => x.chatId),
    ['saved@c.us']
  );
  assert.deepEqual(
    review(db, { minWait: 10 * DAY }, NOW).threads.map((x) => x.chatId),
    ['saved@c.us']
  );
  assert.deepEqual(
    review(db, { chatType: 'group' }, NOW).threads.map((x) => x.chatId),
    ['grp@g.us']
  );
  assert.equal(review(db, { archived: true }, NOW).threads.length, 3);
  assert.equal(review(db, { since: daysAgo(5) }, NOW).threads.length, 1);
  assert.equal(review(db, { limit: 1 }, NOW).threads.length, 1);
  assert.equal(review(db, { limit: 1 }, NOW).matched, 2, 'limit caps rows, not the match count');
});

test('re-syncing the same message updates rather than duplicates it', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  upsertChat(db, { id: 'c@c.us', name: 'A', is_my_contact: 1 });
  upsertMessages(db, [{ id: 'm1', chat_id: 'c@c.us', timestamp: daysAgo(3), from_me: 1, type: 'chat', body: 'v1' }]);
  upsertMessages(db, [{ id: 'm1', chat_id: 'c@c.us', timestamp: daysAgo(3), from_me: 1, type: 'chat', body: 'v2' }]);

  assert.equal(counts(db).messages, 1);
  assert.equal(review(db, {}, NOW).threads[0].lastMessagePreview, 'v2');
});

test('chat rows are updated in place across syncs', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  upsertChat(db, { id: 'c@c.us', name: 'Unknown', is_my_contact: 0, number: '447700900123' });
  upsertMessages(db, [{ id: 'm1', chat_id: 'c@c.us', timestamp: daysAgo(3), from_me: 1, type: 'chat', body: 'x' }]);
  assert.equal(review(db, {}, NOW).threads[0].isSaved, false);

  upsertChat(db, { id: 'c@c.us', name: 'Priya', is_my_contact: 1, contact_name: 'Priya', number: '447700900123' });
  assert.equal(counts(db).chats, 1);
  const after = review(db, {}, NOW).threads[0];
  assert.equal(after.isSaved, true);
  assert.equal(after.name, 'Priya');
});

test('meta round-trips sync bookkeeping', (t) => {
  const { db, dir } = tempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(getMeta(db, 'account'), null);
  setMeta(db, 'account', '44770@c.us');
  setMeta(db, 'account', '44771@c.us');
  assert.equal(getMeta(db, 'account'), '44771@c.us');
});
