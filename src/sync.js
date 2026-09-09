import { upsertChat, upsertMessages, setMeta, counts } from './db.js';
import { withClient } from './whatsapp.js';
import { isExcludedChatId } from './analyze.js';

/** whatsapp-web.js reports seconds; the database stores milliseconds. */
const toMs = (seconds) => (seconds ? Number(seconds) * 1000 : 0);

/** Pull contact facts, tolerating chats where the lookup is not permitted. */
async function contactFacts(chat) {
  if (chat.isGroup) {
    return { participants: chat.participants?.length ?? 0 };
  }
  try {
    const c = await chat.getContact();
    return {
      number: c?.number ?? String(chat.id?._serialized ?? '').split('@')[0],
      is_my_contact: c?.isMyContact ? 1 : 0,
      contact_name: c?.name ?? null,
      push_name: c?.pushname ?? null,
      is_business: c?.isBusiness ? 1 : 0,
      is_blocked: c?.isBlocked ? 1 : 0,
    };
  } catch {
    return { number: String(chat.id?._serialized ?? '').split('@')[0] };
  }
}

function toChatRow(chat, facts) {
  return {
    id: chat.id?._serialized ?? String(chat.id),
    name: chat.name ?? null,
    is_group: chat.isGroup ? 1 : 0,
    is_archived: chat.archived ? 1 : 0,
    is_muted: chat.isMuted ? 1 : 0,
    is_read_only: chat.isReadOnly ? 1 : 0,
    unread_count: chat.unreadCount ?? 0,
    synced_at: Date.now(),
    ...facts,
  };
}

function toMessageRows(chatId, messages) {
  return messages.map((m) => ({
    id: m.id?._serialized ?? `${chatId}:${m.timestamp}:${m.fromMe ? 1 : 0}`,
    chat_id: chatId,
    timestamp: toMs(m.timestamp),
    from_me: m.fromMe ? 1 : 0,
    author: m.author ?? null,
    type: m.type ?? null,
    body: m.body ?? null,
    has_media: m.hasMedia ? 1 : 0,
  }));
}

/**
 * Sync chats and their recent messages into the local database.
 *
 * `limit` caps messages fetched per chat. Because the database is additive,
 * running sync regularly builds up more history than any single fetch returns.
 */
export async function sync(db, { limit = 50, includeGroups = true, onStatus = () => {} } = {}) {
  return withClient(
    async (client) => {
      const me = client.info?.wid?._serialized ?? null;
      if (me) setMeta(db, 'account', me);
      setMeta(db, 'last_sync', Date.now());

      const chats = await client.getChats();
      const wanted = chats.filter(
        (c) => !isExcludedChatId(c.id?._serialized) && (includeGroups || !c.isGroup)
      );

      onStatus(`Found ${wanted.length} chats. Fetching up to ${limit} messages each...`);

      let done = 0;
      let messageTotal = 0;
      for (const chat of wanted) {
        const id = chat.id?._serialized ?? String(chat.id);
        try {
          const facts = await contactFacts(chat);
          upsertChat(db, toChatRow(chat, facts));

          const messages = await chat.fetchMessages({ limit });
          messageTotal += upsertMessages(db, toMessageRows(id, messages));
        } catch (err) {
          onStatus(`  skipped ${id}: ${err.message}`);
        }
        done += 1;
        if (done % 10 === 0 || done === wanted.length) {
          onStatus(`  ${done}/${wanted.length} chats`);
        }
      }

      const totals = counts(db);
      return { chats: wanted.length, messages: messageTotal, stored: totals, account: me };
    },
    { onStatus }
  );
}
