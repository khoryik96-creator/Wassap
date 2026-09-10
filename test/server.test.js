import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertChat, upsertMessages, setThreadState, threadState, setMeta } from '../src/db.js';
import { review } from '../src/review.js';
import { filtersFromQuery, threadDetail, startServer, isSameOrigin, createJobRunner } from '../src/server.js';

const NOW = Date.now();
const DAY = 86400000;
const JID = '447700900123@c.us';

/**
 * An isolated data directory. Without this the server reads and creates the
 * developer's real ~/.wassap, because dataDir() makes the directory it names.
 */
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-srv-'));
  const previousHome = process.env.WASSAP_HOME;
  process.env.WASSAP_HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.WASSAP_HOME;
    else process.env.WASSAP_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
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
  const { base } = await serve(t, file);

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
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ status: 'handled', note: 'done' }),
  });
  assert.equal(posted.status, 200);

  const after = await (await fetch(`${base}/api/threads?chatType=all`)).json();
  assert.equal(after.threads.length, 0, 'handled thread left the open list');
});

test('the server rejects a bad status and unknown routes', async (t) => {
  const { file } = tempDb(t);
  const { base } = await serve(t, file);

  const bad = await fetch(`${base}/api/threads/${encodeURIComponent(JID)}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
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
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  assert.equal(host, '127.0.0.1', 'your whole message history must not be on the network');
  assert.equal(server.address().address, '127.0.0.1');
});

/**
 * Start a server and tear it down completely. server.close() alone waits for
 * open connections, and the events endpoint holds one open by design.
 */
async function serve(t, dbFile) {
  const { server, port } = await startServer({ port: 0, dbFile });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** Wait for the running job to finish, rather than sleeping and hoping. */
async function waitForJob(base, kind, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${base}/api/state`)).json();
    if (state.job && state.job.kind === kind && !state.job.running) return state.job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${kind} did not finish within ${timeoutMs}ms.`);
}

test('the state endpoint reports what the UI needs to orient itself', async (t) => {
  const { file, db } = tempDb(t);
  setMeta(db, 'account', '60182071315:59@s.whatsapp.net');
  setMeta(db, 'last_sync', NOW);
  setMeta(db, 'backend', 'baileys');

  const { base } = await serve(t, file);

  const state = await (await fetch(`${base}/api/state`)).json();
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
  const { base } = await serve(t, file);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  controller.abort();
});

test('a job failure is reported through the stream rather than crashing the server', async (t) => {
  const { file, db } = tempDb(t);
  setMeta(db, 'demo', '1'); // sync refuses on demo data, so this stays offline
  const { base } = await serve(t, file);

  const started = await fetch(`${base}/api/sync`, { method: 'POST', headers: { origin: base } });
  assert.equal(started.status, 202);

  const job = await waitForJob(base, 'sync');
  assert.equal(job.running, false);
  assert.match(job.error, /demo data/);

  // The server is still answering afterwards.
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('the QR endpoint serves real PNG bytes, not a JSON-encoded buffer', async (t) => {
  const { file } = tempDb(t);
  const { writeQrImage } = await import('../src/qr.js');
  const { dataDir } = await import('../src/config.js');

  const { base } = await serve(t, file);

  assert.equal((await fetch(`${base}/api/qr.png`)).status, 404, 'nothing to serve yet');

  const written = await writeQrImage('2@TESTPAYLOAD==,abc=,def=,1', path.join(dataDir(), 'qr.png'));
  assert.ok(written, 'the image was written');

  const res = await fetch(`${base}/api/qr.png`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic number');
  assert.equal(bytes.length, fs.statSync(path.join(dataDir(), 'qr.png')).size, 'byte-for-byte');
});

test('a foreign Origin cannot start a job', async (t) => {
  const { file } = tempDb(t);
  const { base } = await serve(t, file);

  // A page the user happens to be browsing must not be able to start a sync.
  const foreign = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);

  // Reading is still allowed without an origin.
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('the origin check accepts our own page and refuses everything else', () => {
  // Tested directly: fetch will not let a caller forge a Host header, but a
  // DNS-rebinding attacker's browser sends one, so the check must cover it.
  const ok = (headers) => isSameOrigin({ headers }, 4173);

  assert.equal(ok({ host: '127.0.0.1:4173' }), true, 'no origin header, same host');
  assert.equal(ok({ host: 'localhost:4173' }), true);
  assert.equal(ok({ host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' }), true);
  assert.equal(ok({ host: 'localhost:4173', origin: 'http://localhost:4173' }), true);

  assert.equal(ok({ host: 'attacker.example', origin: 'http://127.0.0.1:4173' }), false, 'DNS rebinding');
  assert.equal(ok({ host: '127.0.0.1:4173', origin: 'https://evil.example' }), false);
  assert.equal(ok({ host: '127.0.0.1:9999' }), false, 'a different port is a different server');
  assert.equal(ok({}), false, 'no host at all');
  assert.equal(ok({ host: '127.0.0.1:4173', origin: 'not a url' }), false);
});

test('only one job runs at a time', async () => {
  const runner = createJobRunner();
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  assert.equal(runner.start('sync', () => held), true, 'the first job takes the slot');
  assert.equal(runner.busy(), true);
  assert.equal(runner.start('login', async () => 'second'), false, 'the second is refused');
  assert.equal(runner.snapshot().kind, 'sync', 'the running job was not replaced');

  release('done');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runner.busy(), false);
  assert.equal(runner.start('login', async () => 'ok'), true, 'the slot frees up afterwards');
});

test('a job that throws is recorded, and does not reject unhandled', async () => {
  const runner = createJobRunner();
  runner.start('sync', async () => { throw new Error('nope'); });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshot = runner.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.error, 'nope');
});

test('a late callback from a finished job cannot write into the next one', async () => {
  const runner = createJobRunner();
  let leaked;

  runner.start('login', async ({ onStatus }) => { leaked = onStatus; });
  await new Promise((resolve) => setTimeout(resolve, 20));

  runner.start('sync', async () => new Promise(() => {}));
  leaked('a late line from the login backend');

  const snapshot = runner.snapshot();
  assert.equal(snapshot.kind, 'sync');
  assert.deepEqual(snapshot.log, [], 'the stray line did not land in the running job');
});
