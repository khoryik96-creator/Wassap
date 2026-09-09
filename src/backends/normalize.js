/**
 * Convert Baileys' protocol objects into the rows the local database stores.
 *
 * Kept free of I/O so the mapping can be tested without a WhatsApp connection,
 * which is where most of the risk in a new backend lives.
 */

/** Baileys timestamps arrive as seconds, sometimes wrapped in a protobuf Long. */
export function toMillis(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 1000);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
  }
  if (typeof value?.toNumber === 'function') return Math.round(value.toNumber() * 1000);
  if (typeof value?.low === 'number') return Math.round(value.low * 1000);
  return 0;
}

export const isGroupJid = (jid) => String(jid ?? '').endsWith('@g.us');

/** Content keys that are protocol machinery rather than something a person sent. */
const SYSTEM_CONTENT = {
  protocolMessage: 'protocol',
  senderKeyDistributionMessage: 'e2e_notification',
  messageContextInfo: 'notification',
  reactionMessage: 'reaction',
  pollUpdateMessage: 'notification',
  keepInChatMessage: 'notification',
};

/** Content keys we present as ordinary message types. */
const CONTENT_TYPES = {
  conversation: 'chat',
  extendedTextMessage: 'chat',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'vcard',
  contactsArrayMessage: 'vcard',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  pollCreationMessage: 'poll',
  pollCreationMessageV3: 'poll',
  viewOnceMessage: 'image',
  viewOnceMessageV2: 'image',
  ephemeralMessage: 'chat',
};

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Unwrap the envelopes WhatsApp puts around disappearing and view-once messages. */
function unwrap(message, depth = 0) {
  if (!message || depth > 4) return message;
  for (const key of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    if (message[key]?.message) return unwrap(message[key].message, depth + 1);
  }
  return message;
}

/** The content key that decides what kind of message this is. */
export function contentKey(message) {
  const inner = unwrap(message);
  if (!inner) return null;
  const keys = Object.keys(inner).filter((k) => inner[k] !== null && inner[k] !== undefined);
  // messageContextInfo rides along with real content; it never defines the message.
  const meaningful = keys.filter((k) => k !== 'messageContextInfo');
  return (meaningful[0] ?? keys[0]) ?? null;
}

export function messageType(message) {
  const key = contentKey(message);
  if (!key) return 'notification';
  return SYSTEM_CONTENT[key] ?? CONTENT_TYPES[key] ?? key;
}

/** Readable text for the report preview, or '' when the message carries none. */
export function messageText(message) {
  const inner = unwrap(message);
  if (!inner) return '';
  if (typeof inner.conversation === 'string') return inner.conversation;
  if (inner.extendedTextMessage?.text) return inner.extendedTextMessage.text;

  for (const key of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']) {
    if (inner[key]?.caption) return inner[key].caption;
  }
  if (inner.documentMessage?.fileName) return inner.documentMessage.fileName;
  if (inner.pollCreationMessage?.name) return inner.pollCreationMessage.name;
  if (inner.locationMessage) return inner.locationMessage.name ?? '';
  return '';
}

/**
 * One stored message row, or null when the object carries nothing usable
 * (a placeholder with no content, or no id to key on).
 */
export function normalizeMessage(waMessage) {
  const key = waMessage?.key;
  if (!key?.id || !key?.remoteJid) return null;

  const type = messageType(waMessage.message);
  const text = messageText(waMessage.message);

  return {
    id: `${key.remoteJid}:${key.id}`,
    chat_id: key.remoteJid,
    timestamp: toMillis(waMessage.messageTimestamp),
    from_me: key.fromMe ? 1 : 0,
    author: key.participant ?? waMessage.participant ?? null,
    type,
    body: text || null,
    has_media: MEDIA_TYPES.has(type) ? 1 : 0,
  };
}

/**
 * One stored chat row. `contact` is the address-book entry when there is one;
 * its presence and a real `name` are what make a number "saved".
 */
export function normalizeChat(chat, contact = null) {
  const id = chat?.id;
  if (!id) return null;

  const group = isGroupJid(id);
  const savedName = contact?.name ?? null;
  const pushName = contact?.notify ?? contact?.verifiedName ?? null;

  return {
    id,
    name: chat.name ?? savedName ?? null,
    is_group: group ? 1 : 0,
    is_archived: chat.archived ? 1 : 0,
    is_muted: toMillis(chat.muteEndTime) > Date.now() ? 1 : 0,
    is_read_only: chat.readOnly ? 1 : 0,
    unread_count: Number(chat.unreadCount ?? 0) || 0,
    number: group ? null : String(id).split('@')[0],
    is_my_contact: !group && savedName ? 1 : 0,
    contact_name: group ? null : savedName,
    push_name: group ? null : pushName,
    is_business: contact?.verifiedName ? 1 : 0,
    is_blocked: 0,
    participants: Number(chat.participants?.length ?? 0) || 0,
    synced_at: Date.now(),
  };
}

/**
 * Chats never announced in the history sync still show up as message senders.
 * Build minimal rows for them so nothing is silently dropped.
 */
export function chatsFromMessages(messageRows, knownIds, contactsById = new Map()) {
  const extra = new Map();
  for (const row of messageRows) {
    const id = row.chat_id;
    if (!id || knownIds.has(id) || extra.has(id)) continue;
    extra.set(id, normalizeChat({ id }, contactsById.get(id) ?? null));
  }
  return [...extra.values()].filter(Boolean);
}
