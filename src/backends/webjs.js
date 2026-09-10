import { withClient } from '../whatsapp.js';
import { isExcludedChatId } from '../analyze.js';

/** whatsapp-web.js reports seconds; the database stores milliseconds. */
const toMs = (seconds) => (seconds ? Number(seconds) * 1000 : 0);

async function contactFacts(chat) {
  if (chat.isGroup) return { participants: chat.participants?.length ?? 0 };
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

/** Pull chats and their recent messages by driving WhatsApp Web in a browser. */
export async function harvest({ limit = 50, includeGroups = true, onStatus = () => {}, onQr = undefined } = {}) {
  return withClient(
    async (client) => {
      const account = client.info?.wid?._serialized ?? null;
      const all = await client.getChats();
      const wanted = all.filter(
        (c) => !isExcludedChatId(c.id?._serialized) && (includeGroups || !c.isGroup)
      );

      onStatus(`Found ${wanted.length} chats. Fetching up to ${limit} messages each...`);

      const chats = [];
      const messages = [];
      let done = 0;

      for (const chat of wanted) {
        const id = chat.id?._serialized ?? String(chat.id);
        try {
          chats.push({
            id,
            name: chat.name ?? null,
            is_group: chat.isGroup ? 1 : 0,
            is_archived: chat.archived ? 1 : 0,
            is_muted: chat.isMuted ? 1 : 0,
            is_read_only: chat.isReadOnly ? 1 : 0,
            unread_count: chat.unreadCount ?? 0,
            synced_at: Date.now(),
            ...(await contactFacts(chat)),
          });

          for (const m of await chat.fetchMessages({ limit })) {
            messages.push({
              id: m.id?._serialized ?? `${id}:${m.timestamp}:${m.fromMe ? 1 : 0}`,
              chat_id: id,
              timestamp: toMs(m.timestamp),
              from_me: m.fromMe ? 1 : 0,
              author: m.author ?? null,
              type: m.type ?? null,
              body: m.body ?? null,
              has_media: m.hasMedia ? 1 : 0,
            });
          }
        } catch (err) {
          onStatus(`  skipped ${id}: ${err.message}`);
        }
        done += 1;
        if (done % 10 === 0 || done === wanted.length) onStatus(`  ${done}/${wanted.length} chats`);
      }

      return { account, chats, messages };
    },
    { onStatus, onQr }
  );
}

export async function login({ onStatus = () => {}, onQr = undefined } = {}) {
  return withClient(
    async (client) => ({
      account: client.info?.wid?._serialized ?? null,
      name: client.info?.pushname ?? client.info?.wid?.user ?? 'your account',
    }),
    { onStatus, onQr }
  );
}
