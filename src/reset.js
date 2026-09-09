import fs from 'node:fs';
import { openDb, counts, getMeta } from './db.js';
import { dbPath, sessionDir } from './config.js';
import { UserError } from './errors.js';

/** WAL mode leaves sidecar files beside the database; a reset must take all three. */
const DB_SUFFIXES = ['', '-wal', '-shm'];

/** What a reset would remove, without removing anything. */
export function describeStore() {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    return { file, session: sessionDir(), exists: false, chats: 0, messages: 0, isDemo: false };
  }

  // Read what we need, then let go of the file. Windows refuses to delete a
  // database that still has an open handle, so closing here is not optional.
  const db = openDb();
  try {
    const totals = counts(db);
    return {
      file,
      session: sessionDir(),
      exists: true,
      chats: totals.chats,
      messages: totals.messages,
      isDemo: getMeta(db, 'demo') === '1',
    };
  } finally {
    db.close();
  }
}

/**
 * Delete the local message database, and optionally the linked session.
 * Assumes no handle is open — call describeStore() first if you need counts.
 */
export function resetStore({ all = false } = {}) {
  const file = dbPath();
  const session = sessionDir();
  const removed = [];

  for (const suffix of DB_SUFFIXES) {
    const target = `${file}${suffix}`;
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removed.push(target);
      }
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') {
        throw new UserError(
          `Could not delete ${target} because another program is holding it open.\n` +
            'Close any other wassap command still running (a sync or login in\n' +
            'another window), then try again.'
        );
      }
      throw err;
    }
  }

  if (all && fs.existsSync(session)) {
    fs.rmSync(session, { recursive: true, force: true });
    removed.push(session);
  }

  return removed;
}
