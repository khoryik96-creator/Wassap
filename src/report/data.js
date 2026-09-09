import { formatIso, humanizeDuration } from '../duration.js';

/** Flat, stable shape for machine consumers. */
export function toRecords(threads) {
  return threads.map((t) => ({
    contact: t.name,
    number: t.number,
    push_name: t.pushName,
    chat_id: t.chatId,
    direction: t.direction,
    owed_by: t.direction === 'awaiting_them' ? 'them' : 'you',
    saved_contact: t.isSaved,
    is_group: t.isGroup,
    is_archived: t.isArchived,
    is_muted: t.isMuted,
    is_business: t.isBusiness,
    unread_count: t.unreadCount,
    last_message_at: formatIso(t.lastMessageAt),
    last_message_from_me: t.lastMessageFromMe,
    last_message_preview: t.lastMessagePreview,
    unanswered_since: formatIso(t.unansweredSince),
    unanswered_count: t.unansweredCount,
    waiting_ms: t.waitingMs,
    waiting_human: humanizeDuration(t.waitingMs),
    silence_ms: t.silenceMs,
    message_count: t.messageCount,
    outgoing_count: t.outgoingCount,
    incoming_count: t.incomingCount,
    first_message_at: formatIso(t.firstMessageAt),
  }));
}

export function toJson(threads, summary) {
  return JSON.stringify(
    { generated_at: new Date().toISOString(), summary, threads: toRecords(threads) },
    null,
    2
  );
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(threads) {
  const records = toRecords(threads);
  if (!records.length) return '';
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(headers.map((h) => csvCell(r[h])).join(','));
  }
  return lines.join('\n') + '\n';
}
