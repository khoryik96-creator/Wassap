/** Filtering and sorting of analysed threads. */

export const SORT_KEYS = {
  waiting: (a, b) => b.waitingMs - a.waitingMs,
  silence: (a, b) => b.silenceMs - a.silenceMs,
  date: (a, b) => b.lastMessageAt - a.lastMessageAt,
  oldest: (a, b) => a.lastMessageAt - b.lastMessageAt,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  count: (a, b) => b.unansweredCount - a.unansweredCount,
  messages: (a, b) => b.messageCount - a.messageCount,
  unread: (a, b) => b.unreadCount - a.unreadCount,
};

const DIRECTION_MAP = {
  them: 'awaiting_them',
  you: 'awaiting_you',
};

/**
 * `opts` mirrors the CLI flags:
 *   direction  'them' | 'you' | 'both'
 *   since, until      epoch ms bounds on the last message
 *   minWait, maxWait  ms bounds on how long the thread has been pending
 *   saved             true = saved only, false = unsaved only, undefined = both
 *   chatType   'direct' | 'group' | 'all'
 *   archived, muted   include archived / muted chats
 *   search            substring match on name, number or push name
 *   minMessages       ignore threads thinner than this
 *   unreadOnly        only chats with unread messages
 */
export function applyFilters(threads, opts = {}) {
  const {
    direction = 'both',
    since = null,
    until = null,
    minWait = null,
    maxWait = null,
    saved,
    chatType = 'direct',
    archived = false,
    muted = true,
    blocked = false,
    search = null,
    minMessages = 1,
    unreadOnly = false,
  } = opts;

  const wantDirection = DIRECTION_MAP[direction] ?? null;
  const needle = search ? String(search).toLowerCase() : null;

  return threads.filter((t) => {
    if (wantDirection && t.direction !== wantDirection) return false;

    if (chatType === 'direct' && t.isGroup) return false;
    if (chatType === 'group' && !t.isGroup) return false;

    if (!archived && t.isArchived) return false;
    if (!muted && t.isMuted) return false;
    if (!blocked && t.isBlocked) return false;

    // Saved/unsaved describes a person's number, so asking for either excludes
    // groups entirely rather than lumping them in with unsaved contacts.
    if (saved !== undefined) {
      if (t.isGroup) return false;
      if (saved === true && !t.isSaved) return false;
      if (saved === false && t.isSaved) return false;
    }

    if (since != null && t.lastMessageAt < since) return false;
    if (until != null && t.lastMessageAt > until) return false;

    if (minWait != null && t.waitingMs < minWait) return false;
    if (maxWait != null && t.waitingMs > maxWait) return false;

    if (minMessages > 1 && t.messageCount < minMessages) return false;
    if (unreadOnly && t.unreadCount <= 0) return false;

    if (needle) {
      const haystack = [t.name, t.number, t.pushName, t.contactName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

export function sortThreads(threads, key = 'waiting') {
  const cmp = SORT_KEYS[key];
  if (!cmp) {
    throw new Error(`Unknown sort "${key}". Options: ${Object.keys(SORT_KEYS).join(', ')}`);
  }
  return [...threads].sort(cmp);
}
