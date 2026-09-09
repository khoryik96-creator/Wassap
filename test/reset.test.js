import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertChat, upsertMessages, setMeta } from '../src/db.js';
import { describeStore, resetStore } from '../src/reset.js';
import { dbPath, sessionDir } from '../src/config.js';

function scratchHome(t) {
  const previous = process.env.WASSAP_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-reset-'));
  process.env.WASSAP_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.WASSAP_HOME;
    else process.env.WASSAP_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function seedSomething() {
  const db = openDb();
  upsertChat(db, { id: 'c@c.us', name: 'A', is_my_contact: 1 });
  upsertMessages(db, [
    { id: 'm1', chat_id: 'c@c.us', timestamp: Date.now(), from_me: 1, type: 'chat', body: 'x' },
  ]);
  setMeta(db, 'demo', '1');
  db.close();
}

test('describeStore reports counts without holding the file open', (t) => {
  scratchHome(t);
  seedSomething();

  const store = describeStore();
  assert.equal(store.exists, true);
  assert.equal(store.chats, 1);
  assert.equal(store.messages, 1);
  assert.equal(store.isDemo, true);

  // The regression this guards: reset used to leave a handle open, which made
  // the delete below fail with EPERM on Windows.
  assert.doesNotThrow(() => fs.rmSync(store.file, { force: true }));
});

test('describeStore copes with no database at all', (t) => {
  scratchHome(t);
  const store = describeStore();
  assert.equal(store.exists, false);
  assert.equal(store.chats, 0);
  assert.equal(store.isDemo, false);
});

test('resetStore removes the database and its WAL sidecars', (t) => {
  scratchHome(t);
  seedSomething();

  const file = dbPath();
  fs.writeFileSync(`${file}-wal`, '');
  fs.writeFileSync(`${file}-shm`, '');

  const removed = resetStore();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(fs.existsSync(`${file}-shm`), false);
  assert.equal(removed.length, 3);
});

test('resetStore leaves the session alone unless asked', (t) => {
  scratchHome(t);
  seedSomething();
  fs.mkdirSync(sessionDir(), { recursive: true });

  resetStore();
  assert.equal(fs.existsSync(sessionDir()), true, 'session survives a plain reset');

  seedSomething();
  resetStore({ all: true });
  assert.equal(fs.existsSync(sessionDir()), false, '--all removes it');
});

test('resetStore is safe to run twice', (t) => {
  scratchHome(t);
  seedSomething();

  assert.ok(resetStore().length > 0);
  assert.deepEqual(resetStore(), [], 'a second run removes nothing and does not throw');
});
