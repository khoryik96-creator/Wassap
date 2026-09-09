import { dbPath } from './config.js';
// Imported for its side effect: silences the node:sqlite experimental warning
// before the module below triggers it.
import './warnings.js';

const { DatabaseSync } = await import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  is_group       INTEGER NOT NULL DEFAULT 0,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  is_muted       INTEGER NOT NULL DEFAULT 0,
  is_read_only   INTEGER NOT NULL DEFAULT 0,
  unread_count   INTEGER NOT NULL DEFAULT 0,
  number         TEXT,
  is_my_contact  INTEGER NOT NULL DEFAULT 0,
  contact_name   TEXT,
  push_name      TEXT,
  is_business    INTEGER NOT NULL DEFAULT 0,
  is_blocked     INTEGER NOT NULL DEFAULT 0,
  participants   INTEGER NOT NULL DEFAULT 0,
  synced_at      INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  chat_id   TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  from_me   INTEGER NOT NULL,
  author    TEXT,
  type      TEXT,
  body      TEXT,
  has_media INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);

-- Triage state a person sets in the UI. Kept apart from synced data so a
-- resync never overwrites it.
CREATE TABLE IF NOT EXISTS thread_state (
  chat_id       TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'open',
  note          TEXT,
  snoozed_until INTEGER,
  updated_at    INTEGER NOT NULL
);
`;

export function openDb(file = dbPath()) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Columns declared NOT NULL need a value even when the source object omits them. */
const CHAT_DEFAULTS = {
  is_group: 0, is_archived: 0, is_muted: 0, is_read_only: 0,
  unread_count: 0, is_my_contact: 0, is_business: 0, is_blocked: 0,
  participants: 0,
};

const CHAT_COLUMNS = [
  'id', 'name', 'is_group', 'is_archived', 'is_muted', 'is_read_only',
  'unread_count', 'number', 'is_my_contact', 'contact_name', 'push_name',
  'is_business', 'is_blocked', 'participants', 'synced_at',
];

export function upsertChat(db, chat) {
  const placeholders = CHAT_COLUMNS.map(() => '?').join(', ');
  const updates = CHAT_COLUMNS.filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  db.prepare(
    `INSERT INTO chats (${CHAT_COLUMNS.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`
  ).run(...CHAT_COLUMNS.map((c) => normalize(chat[c], CHAT_DEFAULTS[c])));
}

export function upsertMessages(db, rows) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO messages (id, chat_id, timestamp, from_me, author, type, body, has_media)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       timestamp = excluded.timestamp,
       from_me   = excluded.from_me,
       author    = excluded.author,
       type      = excluded.type,
       body      = excluded.body,
       has_media = excluded.has_media`
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        normalize(r.id), normalize(r.chat_id), normalize(r.timestamp, 0),
        normalize(r.from_me, 0), normalize(r.author), normalize(r.type),
        normalize(r.body), normalize(r.has_media, 0)
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function allChats(db) {
  return db.prepare('SELECT * FROM chats').all();
}

export function messagesForChat(db, chatId) {
  return db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC, id ASC')
    .all(chatId);
}

export function counts(db) {
  const chats = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  return { chats, messages };
}

/** SQLite bindings reject booleans/undefined; coerce to storable primitives. */
function normalize(v, fallback = null) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export const THREAD_STATUSES = ['open', 'handled', 'ignored', 'snoozed'];

/** Every triage record, keyed by chat id. */
export function threadStates(db) {
  const rows = db.prepare('SELECT * FROM thread_state').all();
  return new Map(rows.map((r) => [r.chat_id, r]));
}

export function threadState(db, chatId) {
  return db.prepare('SELECT * FROM thread_state WHERE chat_id = ?').get(chatId) ?? null;
}

/**
 * Merge a change into a thread's triage record. Only the fields present in
 * `patch` are touched, so setting a note does not clear a snooze.
 */
export function setThreadState(db, chatId, patch = {}) {
  const current = threadState(db, chatId);
  const next = {
    status: patch.status ?? current?.status ?? 'open',
    note: patch.note !== undefined ? patch.note : current?.note ?? null,
    snoozed_until:
      patch.snoozed_until !== undefined ? patch.snoozed_until : current?.snoozed_until ?? null,
  };

  if (!THREAD_STATUSES.includes(next.status)) {
    throw new Error(`Unknown status "${next.status}". Use one of: ${THREAD_STATUSES.join(', ')}.`);
  }
  // A snooze without an end date is just "open".
  if (next.status === 'snoozed' && !next.snoozed_until) next.status = 'open';

  db.prepare(
    `INSERT INTO thread_state (chat_id, status, note, snoozed_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       status = excluded.status,
       note = excluded.note,
       snoozed_until = excluded.snoozed_until,
       updated_at = excluded.updated_at`
  ).run(chatId, next.status, next.note, next.snoozed_until, Date.now());

  return threadState(db, chatId);
}
