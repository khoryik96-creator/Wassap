import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeChat, analyzeAll, summarize, displayName, previewBody,
  formatNumber, isExcludedChatId, isConversational,
} from '../src/analyze.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const daysAgo = (n) => NOW - n * DAY;

function msg(id, timestamp, fromMe, extra = {}) {
  return {
    id, chat_id: 'c1', timestamp,
    from_me: fromMe ? 1 : 0,
    type: 'chat', body: 'hello', has_media: 0,
    ...extra,
  };
}

const directChat = {
  id: 'c1', name: 'Priya M.', is_group: 0, is_archived: 0, is_muted: 0,
  unread_count: 0, number: '447700900123', is_my_contact: 1,
  contact_name: 'Priya M.', push_name: 'Priya', is_business: 0, is_blocked: 0,
};

test('a thread ending with my message is awaiting them', () => {
  const t = analyzeChat(directChat, [
    msg('m1', daysAgo(20), false),
    msg('m2', daysAgo(12), true),
  ], NOW);
  assert.equal(t.direction, 'awaiting_them');
  assert.equal(t.lastMessageFromMe, true);
  assert.equal(t.waitingMs, 12 * DAY);
  assert.equal(t.unansweredCount, 1);
});

test('a thread ending with their message is awaiting me', () => {
  const t = analyzeChat(directChat, [
    msg('m1', daysAgo(20), true),
    msg('m2', daysAgo(5), false),
  ], NOW);
  assert.equal(t.direction, 'awaiting_you');
  assert.equal(t.waitingMs, 5 * DAY);
});

test('waiting runs from the start of the unanswered streak, silence from the last message', () => {
  const t = analyzeChat(directChat, [
    msg('m1', daysAgo(30), false),
    msg('m2', daysAgo(20), true),
    msg('m3', daysAgo(16), true),
    msg('m4', daysAgo(9), true),
  ], NOW);
  assert.equal(t.unansweredCount, 3, 'three unreplied messages in a row');
  assert.equal(t.waitingMs, 20 * DAY, 'pending since the first of the streak');
  assert.equal(t.silenceMs, 9 * DAY, 'quiet since the most recent message');
});

test('system notifications never decide who spoke last', () => {
  const t = analyzeChat(directChat, [
    msg('m1', daysAgo(10), true),
    msg('m2', daysAgo(1), false, { type: 'e2e_notification' }),
    msg('m3', daysAgo(1), false, { type: 'call_log' }),
  ], NOW);
  assert.equal(t.direction, 'awaiting_them');
  assert.equal(t.waitingMs, 10 * DAY);
  assert.equal(t.messageCount, 1);
});

test('messages out of order are sorted before analysis', () => {
  const t = analyzeChat(directChat, [
    msg('m3', daysAgo(2), true),
    msg('m1', daysAgo(9), false),
    msg('m2', daysAgo(4), true),
  ], NOW);
  assert.equal(t.unansweredCount, 2);
  assert.equal(t.waitingMs, 4 * DAY);
});

test('chats with nothing conversational are dropped', () => {
  assert.equal(analyzeChat(directChat, [], NOW), null);
  assert.equal(
    analyzeChat(directChat, [msg('m1', daysAgo(1), false, { type: 'gp2' })], NOW),
    null
  );
});

test('status broadcasts and channels are excluded', () => {
  assert.equal(isExcludedChatId('status@broadcast'), true);
  assert.equal(isExcludedChatId('123@newsletter'), true);
  assert.equal(isExcludedChatId('447700900123@c.us'), false);
  assert.equal(
    analyzeChat({ ...directChat, id: 'status@broadcast' }, [msg('m1', daysAgo(1), true)], NOW),
    null
  );
});

test('counts split incoming and outgoing', () => {
  const t = analyzeChat(directChat, [
    msg('m1', daysAgo(9), false),
    msg('m2', daysAgo(8), true),
    msg('m3', daysAgo(7), true),
  ], NOW);
  assert.equal(t.messageCount, 3);
  assert.equal(t.outgoingCount, 2);
  assert.equal(t.incomingCount, 1);
  assert.equal(t.firstMessageAt, daysAgo(9));
});

test('saved contacts show their address-book name, unsaved show the number', () => {
  assert.equal(displayName(directChat), 'Priya M.');
  assert.equal(
    displayName({ ...directChat, is_my_contact: 0, contact_name: null, push_name: 'Sam' }),
    '~Sam'
  );
  assert.equal(
    displayName({ ...directChat, is_my_contact: 0, contact_name: null, push_name: null }),
    '+447700900123'
  );
  assert.equal(displayName({ id: 'g@g.us', is_group: 1, name: 'Five-a-side' }), 'Five-a-side');
});

test('formatNumber strips the WhatsApp suffix', () => {
  assert.equal(formatNumber('447700900123@c.us'), '+447700900123');
  assert.equal(formatNumber('44 7700 900123'), '+447700900123');
  assert.equal(formatNumber(null), null);
});

test('previews summarise media and clip long text', () => {
  assert.equal(previewBody({ body: '  hello   there ', type: 'chat' }), 'hello there');
  assert.equal(previewBody({ body: '', type: 'image', has_media: 1 }), '[image]');
  assert.equal(previewBody({ body: 'x'.repeat(100), type: 'chat' }, 20).length, 20);
  assert.equal(previewBody(null), '');
});

test('isConversational rejects only system types', () => {
  assert.equal(isConversational({ type: 'chat' }), true);
  assert.equal(isConversational({ type: 'image' }), true);
  assert.equal(isConversational({ type: 'revoked' }), false);
});

test('analyzeAll and summarize aggregate across chats', () => {
  const chats = [
    directChat,
    { ...directChat, id: 'c2', is_my_contact: 0, contact_name: null, number: '19998887777' },
    { id: 'g1', name: 'Team', is_group: 1 },
  ];
  const byChat = new Map([
    ['c1', [msg('a', daysAgo(10), true)]],
    ['c2', [msg('b', daysAgo(3), false)]],
    ['g1', [msg('c', daysAgo(1), true)]],
  ]);
  const threads = analyzeAll(chats, byChat, NOW);
  assert.equal(threads.length, 3);

  const s = summarize(threads);
  assert.equal(s.total, 3);
  assert.equal(s.awaitingThem, 2);
  assert.equal(s.awaitingYou, 1);
  assert.equal(s.saved, 1);
  assert.equal(s.unsaved, 1, 'the group is not counted as an unsaved contact');
  assert.equal(s.groups, 1);
  assert.equal(s.direct, 2);
  assert.equal(s.longestWaitMs, 10 * DAY);
});

test('groups carry no phone number and sit outside the saved/unsaved split', () => {
  const group = { id: 'group0@g.us', name: 'Five-a-side', is_group: 1, participants: 8 };
  const t = analyzeChat(group, [msg('g1', daysAgo(2), false)], NOW);
  assert.equal(t.number, null, 'a group id must not be scraped into a phone number');
  assert.equal(t.isGroup, true);

  const s = summarize([t]);
  assert.equal(s.groups, 1);
  assert.equal(s.saved, 0);
  assert.equal(s.unsaved, 0, 'a group is neither a saved nor an unsaved contact');
});

test('formatNumber rejects ids that are not plausible phone numbers', () => {
  assert.equal(formatNumber('group0@g.us'), null);
  assert.equal(formatNumber('120363@g.us'), null);
  assert.equal(formatNumber('12345'), null);
  assert.equal(formatNumber('447700900123@c.us'), '+447700900123');
});
