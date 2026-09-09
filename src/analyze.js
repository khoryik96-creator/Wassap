/**
 * Turns raw chats + messages into "unanswered thread" records.
 *
 * A thread is unanswered when the newest conversational message in it has not
 * been followed by anything from the other side. Which side is waiting decides
 * the bucket:
 *
 *   awaiting_them — you sent last, nobody replied   (they owe you)
 *   awaiting_you  — they sent last, you never replied (you owe them)
 *
 * Two durations are reported because they answer different questions:
 *   waitingMs — since the ball moved to the other side (start of the trailing
 *               run of same-side messages). "How long has this been pending."
 *   silenceMs — since the very last message. "How quiet has it been."
 * They differ when you send several messages in a row without a reply.
 */

/** Message types that are system noise, not conversation. */
export const NON_CONVERSATIONAL_TYPES = new Set([
  'e2e_notification',
  'notification',
  'notification_template',
  'gp2',
  'group_notification',
  'broadcast_notification',
  'protocol',
  'ciphertext',
  'revoked',
  'call_log',
  // A thumbs-up acknowledges a message; it does not answer it.
  'reaction',
]);

/** Chat ids that are not real conversations (status feed, channels). */
export function isExcludedChatId(id) {
  if (!id) return true;
  return id.endsWith('@broadcast') || id.endsWith('@newsletter');
}

export function isConversational(msg) {
  if (!msg) return false;
  if (NON_CONVERSATIONAL_TYPES.has(msg.type)) return false;
  return true;
}

/**
 * "447700900123@c.us" -> "+447700900123".
 * Returns null for anything that is not plausibly a phone number, so group ids
 * like "120363@g.us" or "group0@g.us" do not turn into bogus numbers.
 */
export function formatNumber(raw) {
  if (!raw) return null;
  const local = String(raw).split('@')[0];
  const digits = local.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

/** The label a human recognises the other party by. */
export function displayName(chat) {
  const number = formatNumber(chat.number ?? chat.id);
  if (chat.is_group) return chat.name || 'Unnamed group';
  if (chat.is_my_contact) return chat.contact_name || chat.name || number || chat.id;
  // Unsaved: their self-set push name is a hint, but the number is the identity.
  return chat.push_name ? `~${chat.push_name}` : number || chat.id;
}

/** One-line preview of a message for the report tables. */
export function previewBody(msg, max = 60) {
  if (!msg) return '';
  let text = (msg.body || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (msg.has_media) return `[${msg.type || 'media'}]`;
    return msg.type && msg.type !== 'chat' ? `[${msg.type}]` : '';
  }
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/**
 * Analyse a single chat. Returns null when the chat holds no conversational
 * messages (so there is nothing that could be unanswered).
 */
export function analyzeChat(chat, messages, now = Date.now()) {
  if (isExcludedChatId(chat.id)) return null;

  const conv = messages
    .filter(isConversational)
    .sort((a, b) => a.timestamp - b.timestamp || String(a.id).localeCompare(String(b.id)));

  if (conv.length === 0) return null;

  const last = conv[conv.length - 1];
  const lastFromMe = Boolean(last.from_me);

  // Walk back over the trailing run of messages from the same side.
  let start = conv.length - 1;
  while (start > 0 && Boolean(conv[start - 1].from_me) === lastFromMe) start -= 1;
  const runStart = conv[start];

  const outgoing = conv.reduce((n, m) => n + (m.from_me ? 1 : 0), 0);

  return {
    chatId: chat.id,
    name: displayName(chat),
    // Groups have no phone number of their own.
    number: chat.is_group ? null : formatNumber(chat.number ?? chat.id),
    pushName: chat.push_name || null,
    contactName: chat.contact_name || null,

    isGroup: Boolean(chat.is_group),
    isSaved: Boolean(chat.is_my_contact),
    isArchived: Boolean(chat.is_archived),
    isMuted: Boolean(chat.is_muted),
    isBusiness: Boolean(chat.is_business),
    isBlocked: Boolean(chat.is_blocked),
    participants: chat.participants || 0,
    unreadCount: chat.unread_count || 0,

    direction: lastFromMe ? 'awaiting_them' : 'awaiting_you',
    lastMessageAt: last.timestamp,
    lastMessageFromMe: lastFromMe,
    lastMessagePreview: previewBody(last),

    unansweredSince: runStart.timestamp,
    unansweredCount: conv.length - start,
    waitingMs: Math.max(0, now - runStart.timestamp),
    silenceMs: Math.max(0, now - last.timestamp),

    messageCount: conv.length,
    outgoingCount: outgoing,
    incomingCount: conv.length - outgoing,
    firstMessageAt: conv[0].timestamp,
  };
}

/** Analyse every chat, dropping those with nothing to report. */
export function analyzeAll(chats, messagesByChat, now = Date.now()) {
  const out = [];
  for (const chat of chats) {
    const thread = analyzeChat(chat, messagesByChat.get(chat.id) ?? [], now);
    if (thread) out.push(thread);
  }
  return out;
}

/** Headline totals for the report footer/header. */
export function summarize(threads) {
  const s = {
    total: threads.length,
    awaitingThem: 0,
    awaitingYou: 0,
    saved: 0,
    unsaved: 0,
    groups: 0,
    direct: 0,
    longestWaitMs: 0,
  };
  for (const t of threads) {
    if (t.direction === 'awaiting_them') s.awaitingThem += 1;
    else s.awaitingYou += 1;
    // "Saved" only means something for a person, so groups sit outside the split.
    if (!t.isGroup) {
      if (t.isSaved) s.saved += 1;
      else s.unsaved += 1;
    }
    if (t.isGroup) s.groups += 1;
    else s.direct += 1;
    if (t.waitingMs > s.longestWaitMs) s.longestWaitMs = t.waitingMs;
  }
  return s;
}
