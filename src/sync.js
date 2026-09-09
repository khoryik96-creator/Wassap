import { upsertChat, upsertMessages, setMeta, getMeta, counts } from './db.js';
import { isExcludedChatId } from './analyze.js';
import { UserError } from './errors.js';
import { command } from './invocation.js';
import { loadBackend } from './backends/index.js';

/**
 * Pull chats and messages into the local database.
 *
 * Backends differ in how they reach WhatsApp but hand back the same rows, so
 * everything below this point is shared.
 */
export async function sync(db, { limit = 50, includeGroups = true, backend, onStatus = () => {}, onQr = null } = {}) {
  if (getMeta(db, 'demo') === '1') {
    throw new UserError(
      'This database holds demo data from scripts/seed-demo.js.\n' +
        `Clear it before syncing your real account:  ${command('reset --yes')}`
    );
  }

  const { name, harvest } = await loadBackend(backend);
  onStatus(`Connecting to WhatsApp (${name})...`);

  const result = await harvest({ limit, includeGroups, onStatus, onQr });

  const chats = (result.chats ?? []).filter((c) => c && !isExcludedChatId(c.id));
  const keep = new Set(chats.map((c) => c.id));
  const messages = (result.messages ?? []).filter((m) => m && keep.has(m.chat_id));

  for (const chat of chats) upsertChat(db, chat);
  upsertMessages(db, messages);

  if (result.account) setMeta(db, 'account', result.account);
  setMeta(db, 'last_sync', Date.now());
  setMeta(db, 'backend', name);

  const totals = counts(db);
  return {
    backend: name,
    chats: chats.length,
    messages: messages.length,
    stored: totals,
    account: result.account ?? null,
  };
}
