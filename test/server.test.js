import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertChat, upsertMessages, setThreadState, threadState, setMeta } from '../src/db.js';
import { review } from '../src/review.js';
import { filtersFromQuery, threadDetail, startServer } from '../src/server.js';

const NOW = Date.now();
const DAY = 86400000;
const JID = '447700900123@c.us';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-srv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  const db = openDb(file);
  upsertChat(db, { id: JID, name: 'Priya M.', is_my_contact: 1, contact_name: 'Priya M.', number: '447700900123' });
  upsertMessages(db, [
    { id: 'm1', chat_id: JID, timestamp: NOW - 20 * DAY, from_me: 0, type: 'chat', body: 'hello' },
    { id: 'm2', chat_id: JID, timestamp: NOW - 12 * DAY, from_me: 1, type: 'chat', body: 'still on?' },
  ]);
  return { db, file };
}

test('query parameters map onto the same filters the CLI uses', () => {
  const params = new URLSearchParams({
    direction: 'them', saved: 'unsaved', chatType: 'group', minWait: String(3 * DAY),
    search: 'priya', sort: 'date', limit: '5', unreadOnly: 'true', statuses: 'handled,open',
  });
  const opts = filtersFromQuery(params);
  assert.equal(opts.direction, 'them');
  assert.equal(opts.saved, false);
  assert.equal(opts.chatType, 'group');
  assert.equal(opts.minWait, 3 * DAY);
  assert.equal(opts.search, 'priya');
  assert.equal(opts.sort, 'date');
  assert.equal(opts.limit, 5);
  assert.equal(opts.unreadOnly, true);
  assert.deepEqual(opts.statuses, ['handled', 'open']);
});

test('empty query parameters fall back to sane defaults', () => {
  const opts = filtersFromQuery(new URLSearchParams());
  assert.equal(opts.direction, 'both');
  assert.equal(opts.saved, undefined);
  assert.equal(opts.minWait, null);
  assert.deepEqual(opts.statuses, ['open'], 'triaged threads stay hidden by default');
});

test('statuses=all disables the status filter', () => {
  assert.equal(filtersFromQuery(new URLSearchParams({ statuses: 'all' })).statuses, 'all');
});

test('triage state survives a resync and is not overwritten by it', (t) => {
  const { db } = tempDb(t);

  setThreadState(db, JID, { status: 'handled', note: 'chased on LinkedIn' });
  upsertChat(db, { id: JID, name: 'Priya M.', is_my_contact: 1, number: '447700900123' });
  upsertMessages(db, [
    { id: 'm3', chat_id: JID, timestamp: NOW - 1 * DAY, from_me: 1, type: 'chat', body: 'ping' },
  ]);

  const state = threadState(db, JID);
  assert.equal(state.status, 'handled');
  assert.equal(state.note, 'chased on LinkedIn');
});

test('a handled thread drops out of the open list but is still findable', (t) => {
  const { db } = tempDb(t);
  assert.equal(review(db, { chatType: 'all' }).threads.length, 1);

  setThreadState(db, JID, { status: 'handled' });
  assert.equal(review(db, { chatType: 'all' }).threads.length, 0, 'hidden from open');
  assert.equal(review(db, { chatType: 'all', statuses: 'all' }).threads.length, 1, 'still there');
  assert.equal(review(db, { chatType: 'all', statuses: ['handled'] }).threads.length, 1);
});

test('a snooze hides a thread until it lapses, then it returns', (t) => {
  const { db } = tempDb(t);

  setThreadState(db, JID, { status: 'snoozed', snoozed_until: NOW + 7 * DAY });
  assert.equal(review(db, { chatType: 'all' }, NOW).threads.length, 0, 'hidden while snoozed');

  const afterwards = review(db, { chatType: 'all' }, NOW + 8 * DAY).threads;
  assert.equal(afterwards.length, 1, 'back once the snooze lapses');
  assert.equal(afterwards[0].status, 'open');
});

test('a snooze with no end date is just open', (t) => {
  const { db } = tempDb(t);
  const state = setThreadState(db, JID, { status: 'snoozed' });
  assert.equal(state.status, 'open');
});

test('setting a note does not disturb the status', (t) => {
  const { db } = tempDb(t);
  setThreadState(db, JID, { status: 'handled' });
  setThreadState(db, JID, { note: 'called instead' });

  const state = threadState(db, JID);
  assert.equal(state.status, 'handled', 'status survived a note-only update');
  assert.equal(state.note, 'called instead');
});

test('an unknown status is refused', (t) => {
  const { db } = tempDb(t);
  assert.throws(() => setThreadState(db, JID, { status: 'banana' }), /Unknown status/);
});

test('thread detail returns the whole conversation, oldest first', (t) => {
  const { db } = tempDb(t);
  const detail = threadDetail(db, JID);
  assert.equal(detail.chatId, JID);
  assert.equal(detail.messages.length, 2);
  assert.ok(detail.messages[0].timestamp < detail.messages[1].timestamp);
  assert.equal(detail.messages[1].from_me, true);
  assert.equal(detail.messages[1].preview, 'still on?');
});

test('the server answers over HTTP and records triage', async (t) => {
  const { file } = tempDb(t);
  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());

  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const list = await (await fetch(`${base}/api/threads?chatType=all`)).json();
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].name, 'Priya M.');

  const detail = await (await fetch(`${base}/api/threads/${encodeURIComponent(JID)}/messages`)).json();
  assert.equal(detail.messages.length, 2);

  const posted = await fetch(`${base}/api/threads/${encodeURIComponent(JID)}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'handled', note: 'done' }),
  });
  assert.equal(posted.status, 200);

  const after = await (await fetch(`${base}/api/threads?chatType=all`)).json();
  assert.equal(after.threads.length, 0, 'handled thread left the open list');
});

test('the server rejects a bad status and unknown routes', async (t) => {
  const { file } = tempDb(t);
  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${base}/api/threads/${encodeURIComponent(JID)}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'banana' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown status/);

  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 204);
});

test('the server binds to loopback only', async (t) => {
  const { file } = tempDb(t);
  const { server, host } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());
  assert.equal(host, '127.0.0.1', 'your whole message history must not be on the network');
  assert.equal(server.address().address, '127.0.0.1');
});

test('the state endpoint reports what the UI needs to orient itself', async (t) => {
  const { file, db } = tempDb(t);
  setMeta(db, 'account', '60182071315:59@s.whatsapp.net');
  setMeta(db, 'last_sync', NOW);
  setMeta(db, 'backend', 'baileys');

  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());

  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.account, '60182071315:59@s.whatsapp.net');
  assert.equal(state.backend, 'baileys');
  assert.equal(state.lastSync, NOW);
  assert.equal(state.chats, 1);
  assert.equal(state.messages, 2);
  assert.equal(state.isDemo, false);
  assert.equal(state.job, null, 'nothing running yet');
});

test('the events endpoint is a server-sent event stream', async (t) => {
  const { file } = tempDb(t);
  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  controller.abort();
});

test('a job failure is reported through the stream rather than crashing the server', async (t) => {
  const { file, db } = tempDb(t);
  setMeta(db, 'demo', '1'); // sync refuses on demo data, so this stays offline
  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;

  const started = await fetch(`${base}/api/sync`, { method: 'POST' });
  assert.equal(started.status, 202);

  // Give the job a moment to fail, then check it was recorded, not thrown away.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.job.kind, 'sync');
  assert.equal(state.job.running, false);
  assert.match(state.job.error, /demo data/);

  // The server is still answering afterwards.
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('there is no QR image until something asks for one', async (t) => {
  const { file } = tempDb(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-home-'));
  const previous = process.env.WASSAP_HOME;
  process.env.WASSAP_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.WASSAP_HOME;
    else process.env.WASSAP_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { server, port } = await startServer({ port: 0, dbFile: file });
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/qr.png`)).status, 404);
});
