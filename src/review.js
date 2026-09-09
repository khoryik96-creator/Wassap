import { allChats, threadStates } from './db.js';
import { analyzeAll, summarize } from './analyze.js';
import { applyFilters, sortThreads } from './filters.js';

/** Load every chat with its messages and analyse them in one pass. */
export function buildThreads(db, now = Date.now()) {
  const chats = allChats(db);
  const messagesByChat = new Map();

  const rows = db
    .prepare('SELECT * FROM messages ORDER BY chat_id ASC, timestamp ASC, id ASC')
    .all();
  for (const row of rows) {
    let bucket = messagesByChat.get(row.chat_id);
    if (!bucket) {
      bucket = [];
      messagesByChat.set(row.chat_id, bucket);
    }
    bucket.push(row);
  }

  const threads = analyzeAll(chats, messagesByChat, now);

  // Fold in whatever triage a person has recorded in the UI.
  const states = threadStates(db);
  for (const thread of threads) {
    const state = states.get(thread.chatId);
    const snoozedUntil = state?.snoozed_until ?? null;
    const stillSnoozed = state?.status === 'snoozed' && snoozedUntil && snoozedUntil > now;
    thread.status = stillSnoozed ? 'snoozed' : state?.status === 'snoozed' ? 'open' : state?.status ?? 'open';
    thread.note = state?.note ?? null;
    thread.snoozedUntil = snoozedUntil;
  }
  return threads;
}

/** Analyse, filter, sort and cap — the whole `review` pipeline. */
export function review(db, opts = {}, now = Date.now()) {
  const all = buildThreads(db, now);
  const filtered = applyFilters(all, opts);
  const sorted = sortThreads(filtered, opts.sort ?? 'waiting');
  const limited = opts.limit ? sorted.slice(0, opts.limit) : sorted;
  return { threads: limited, summary: summarize(sorted), scanned: all.length, matched: sorted.length };
}
