import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMillis, isGroupJid, contentKey, messageType, messageText,
  normalizeMessage, normalizeChat, chatsFromMessages,
} from '../src/backends/normalize.js';
import { analyzeChat } from '../src/analyze.js';

const JID = '447700900123@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

test('timestamps convert from seconds, in every shape Baileys uses', () => {
  assert.equal(toMillis(1757400000), 1757400000000);
  assert.equal(toMillis('1757400000'), 1757400000000);
  assert.equal(toMillis({ toNumber: () => 1757400000 }), 1757400000000, 'protobuf Long');
  assert.equal(toMillis({ low: 1757400000 }), 1757400000000);
  assert.equal(toMillis(null), 0);
  assert.equal(toMillis(undefined), 0);
});

test('group jids are recognised', () => {
  assert.equal(isGroupJid(GROUP), true);
  assert.equal(isGroupJid(JID), false);
  assert.equal(isGroupJid(null), false);
});

test('the content key ignores the context metadata that rides along', () => {
  assert.equal(contentKey({ messageContextInfo: {}, conversation: 'hi' }), 'conversation');
  assert.equal(contentKey({ imageMessage: { caption: 'x' } }), 'imageMessage');
  assert.equal(contentKey({}), null);
});

test('message types map to the vocabulary the analyser already speaks', () => {
  assert.equal(messageType({ conversation: 'hi' }), 'chat');
  assert.equal(messageType({ extendedTextMessage: { text: 'hi' } }), 'chat');
  assert.equal(messageType({ imageMessage: {} }), 'image');
  assert.equal(messageType({ documentMessage: {} }), 'document');
  assert.equal(messageType({ protocolMessage: {} }), 'protocol');
  assert.equal(messageType({ senderKeyDistributionMessage: {} }), 'e2e_notification');
  assert.equal(messageType({ reactionMessage: {} }), 'reaction');
});

test('disappearing and view-once envelopes are unwrapped', () => {
  assert.equal(messageType({ ephemeralMessage: { message: { conversation: 'hi' } } }), 'chat');
  assert.equal(messageText({ ephemeralMessage: { message: { conversation: 'hi' } } }), 'hi');
  assert.equal(messageType({ viewOnceMessageV2: { message: { imageMessage: {} } } }), 'image');
});

test('preview text comes from the body, then the caption, then the filename', () => {
  assert.equal(messageText({ conversation: 'plain' }), 'plain');
  assert.equal(messageText({ extendedTextMessage: { text: 'quoted reply' } }), 'quoted reply');
  assert.equal(messageText({ imageMessage: { caption: 'a photo' } }), 'a photo');
  assert.equal(messageText({ documentMessage: { fileName: 'cv.pdf' } }), 'cv.pdf');
  assert.equal(messageText({ stickerMessage: {} }), '');
  assert.equal(messageText(null), '');
});

test('a message becomes a storable row', () => {
  const row = normalizeMessage({
    key: { id: 'ABC123', remoteJid: JID, fromMe: true },
    messageTimestamp: 1757400000,
    message: { conversation: 'are we still on?' },
  });
  assert.equal(row.id, `${JID}:ABC123`);
  assert.equal(row.chat_id, JID);
  assert.equal(row.from_me, 1);
  assert.equal(row.timestamp, 1757400000000);
  assert.equal(row.type, 'chat');
  assert.equal(row.body, 'are we still on?');
  assert.equal(row.has_media, 0);
});

test('media messages are flagged as such', () => {
  const row = normalizeMessage({
    key: { id: 'X', remoteJid: JID, fromMe: false },
    messageTimestamp: 1,
    message: { imageMessage: { caption: 'look' } },
  });
  assert.equal(row.has_media, 1);
  assert.equal(row.type, 'image');
});

test('messages without a usable key are dropped', () => {
  assert.equal(normalizeMessage({}), null);
  assert.equal(normalizeMessage({ key: { id: 'X' } }), null, 'no chat to file it under');
  assert.equal(normalizeMessage({ key: { remoteJid: JID } }), null, 'no id to key on');
});

test('a group message records who sent it', () => {
  const row = normalizeMessage({
    key: { id: 'G1', remoteJid: GROUP, fromMe: false, participant: JID },
    messageTimestamp: 1,
    message: { conversation: 'who is in?' },
  });
  assert.equal(row.author, JID);
  assert.equal(row.chat_id, GROUP);
});

test('a contact with an address-book name counts as saved', () => {
  const row = normalizeChat({ id: JID, unreadCount: 2 }, { id: JID, name: 'Priya M.', notify: 'Priya' });
  assert.equal(row.is_my_contact, 1);
  assert.equal(row.contact_name, 'Priya M.');
  assert.equal(row.number, '447700900123');
  assert.equal(row.unread_count, 2);
  assert.equal(row.is_group, 0);
});

test('a contact with only a push name counts as unsaved', () => {
  const row = normalizeChat({ id: JID }, { id: JID, notify: 'Sam' });
  assert.equal(row.is_my_contact, 0);
  assert.equal(row.contact_name, null);
  assert.equal(row.push_name, 'Sam');
});

test('an unknown number is unsaved with no names at all', () => {
  const row = normalizeChat({ id: JID }, null);
  assert.equal(row.is_my_contact, 0);
  assert.equal(row.push_name, null);
  assert.equal(row.number, '447700900123');
});

test('groups carry no number and no saved flag', () => {
  const row = normalizeChat({ id: GROUP, name: 'Five-a-side' }, null);
  assert.equal(row.is_group, 1);
  assert.equal(row.number, null);
  assert.equal(row.is_my_contact, 0);
  assert.equal(row.name, 'Five-a-side');
});

test('mute is only current if it has not expired', () => {
  const past = Math.floor((Date.now() - 86400000) / 1000);
  const future = Math.floor((Date.now() + 86400000) / 1000);
  assert.equal(normalizeChat({ id: JID, muteEndTime: past }).is_muted, 0);
  assert.equal(normalizeChat({ id: JID, muteEndTime: future }).is_muted, 1);
  assert.equal(normalizeChat({ id: JID }).is_muted, 0);
});

test('chats only seen as message senders are still recorded', () => {
  const messages = [
    { chat_id: JID },
    { chat_id: GROUP },
    { chat_id: 'known@s.whatsapp.net' },
  ];
  const extra = chatsFromMessages(messages, new Set(['known@s.whatsapp.net']));
  assert.deepEqual(extra.map((c) => c.id).sort(), [GROUP, JID].sort());
  assert.equal(extra.length, 2, 'the already-known chat is not duplicated');
});

test('normalized rows feed the analyser unchanged', () => {
  // The point of the backend split: whatever the source, the engine sees one shape.
  const chat = normalizeChat({ id: JID }, { id: JID, name: 'Priya M.' });
  const now = Date.parse('2026-09-09T12:00:00Z');
  const day = 86400000;
  const messages = [
    normalizeMessage({ key: { id: 'a', remoteJid: JID, fromMe: false }, messageTimestamp: (now - 20 * day) / 1000, message: { conversation: 'hi' } }),
    normalizeMessage({ key: { id: 'b', remoteJid: JID, fromMe: true }, messageTimestamp: (now - 12 * day) / 1000, message: { conversation: 'still on?' } }),
    normalizeMessage({ key: { id: 'c', remoteJid: JID, fromMe: true }, messageTimestamp: (now - 9 * day) / 1000, message: { conversation: 'bump' } }),
    normalizeMessage({ key: { id: 'd', remoteJid: JID, fromMe: false }, messageTimestamp: (now - 1 * day) / 1000, message: { protocolMessage: {} } }),
  ];

  const thread = analyzeChat(chat, messages, now);
  assert.equal(thread.direction, 'awaiting_them');
  assert.equal(thread.isSaved, true);
  assert.equal(thread.unansweredCount, 2);
  assert.equal(thread.waitingMs, 12 * day, 'protocol noise did not count as a reply');
  assert.equal(thread.silenceMs, 9 * day);
});
