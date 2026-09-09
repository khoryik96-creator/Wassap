#!/usr/bin/env node
/**
 * Fill the local database with synthetic conversations so the CLI and dashboard
 * can be tried without linking a real WhatsApp account.
 *
 *   WASSAP_HOME=/tmp/wassap-demo node scripts/seed-demo.js
 *   WASSAP_HOME=/tmp/wassap-demo node bin/wassap.js review
 *
 * It refuses to touch a database that already holds real synced data.
 */
import { openDb, upsertChat, upsertMessages, setMeta, counts, getMeta } from '../src/db.js';
import { dataDir } from '../src/config.js';

const DAY = 86400000;
const HOUR = 3600000;
const now = Date.now();
const ago = (days) => Math.round(now - days * DAY);

const PEOPLE = [
  ['Priya Mehta', '447700900123', true, 12.4, 3, 'did you get a chance to look at the deck?'],
  ['Daniel Okafor', '447700900456', true, 31.2, 2, 'no rush, whenever suits'],
  ['Mum', '447700900789', true, 0.3, 1, 'call me when you land'],
  ['Aisha Rahman', '447700900222', true, 5.8, 1, 'shall we say Thursday 7pm?'],
  ['Tom Fletcher', '447700900333', true, 68.9, 4, 'still keen if you are'],
  [null, '19998887777', false, 2.1, 1, 'Hi, following up on the quote I sent'],
  [null, '447700911001', false, 44.5, 1, 'Hello! Is this still available?'],
  [null, '61412345678', false, 9.7, 2, 'Re: your enquiry - happy to discuss'],
  ['Dr Kaur (surgery)', '447700900555', true, 1.2, 1, 'appointment confirmed for the 14th'],
  [null, '4915112345678', false, 121.0, 1, 'Guten Tag, wir haben Ihre Anfrage erhalten'],
  ['Yuki 田中', '819012345678', true, 17.3, 2, 'let me know about the weekend'],
  ['Sofia Rossi', '393331234567', true, 0.9, 1, 'grazie! see you soon'],
  ['Landlord', '447700900666', true, 6.4, 3, 'about the boiler - any update?'],
  [null, '447700911002', false, 3.3, 1, 'You have won a prize, click here'],
  ['Marcus Bell', '447700900777', true, 88.1, 1, 'good catching up last week'],
  ['Chen Wei', '8613800138000', true, 23.6, 2, 'sent the files over'],
  [null, '447700911003', false, 0.4, 1, 'Hi, saw your listing'],
  ['Grace Adeyemi', '2348012345678', true, 14.9, 1, 'happy birthday!!'],
  ['Ben (plumber)', '447700900888', true, 2.7, 2, 'can you do Tuesday morning?'],
  ['Nadia Petrova', '447700900999', true, 55.0, 1, 'thanks for the intro'],
];

const GROUPS = [
  ['Five-a-side', 11, 1.6, 1, 'who is in for Sunday?'],
  ['Flat 3B', 4, 8.2, 2, 'bins go out tonight'],
  ['Project Falcon', 9, 0.6, 1, 'standup moved to 10am'],
  ['Family', 6, 26.4, 1, 'photos from the trip'],
];

function conversation(chatId, { waitDays, streak, lastFromMe, lastBody, history = 6 }) {
  const messages = [];
  // Some back-and-forth first, all comfortably older than the unanswered streak.
  let t = waitDays + history * 3;
  for (let i = 0; i < history; i += 1) {
    messages.push({
      id: `${chatId}:h${i}`,
      chat_id: chatId,
      timestamp: ago(t),
      from_me: i % 2 === 0 ? 1 : 0,
      type: 'chat',
      body: i % 2 === 0 ? 'sure, that works' : 'sounds good',
      has_media: 0,
    });
    t -= 3;
  }
  // Then the unanswered streak, all from the same side.
  for (let i = 0; i < streak; i += 1) {
    const offset = waitDays - (i * waitDays) / (streak + 1);
    messages.push({
      id: `${chatId}:s${i}`,
      chat_id: chatId,
      timestamp: ago(offset),
      from_me: lastFromMe ? 1 : 0,
      type: 'chat',
      body: i === streak - 1 ? lastBody : 'just following up',
      has_media: 0,
    });
  }
  return messages;
}

const db = openDb();
const existing = counts(db);
if (existing.chats > 0 && getMeta(db, 'demo') !== '1') {
  process.stderr.write(
    `Refusing to seed: ${dataDir()} already holds ${existing.chats} synced chats.\n` +
      'Point WASSAP_HOME at a scratch directory instead.\n'
  );
  process.exit(1);
}

setMeta(db, 'demo', '1');
setMeta(db, 'account', 'demo@c.us');
setMeta(db, 'last_sync', now - 2 * HOUR);

let seeded = 0;
PEOPLE.forEach(([name, number, saved, waitDays, streak, lastBody], i) => {
  const id = `${number}@c.us`;
  // Alternate who is left waiting so both buckets are populated.
  const lastFromMe = i % 3 !== 1;
  upsertChat(db, {
    id,
    name: name ?? null,
    is_group: 0,
    is_archived: i === 14 ? 1 : 0,
    is_muted: i === 13 ? 1 : 0,
    unread_count: lastFromMe ? 0 : (i % 4),
    number,
    is_my_contact: saved ? 1 : 0,
    contact_name: saved ? name : null,
    push_name: saved ? null : ['Sam', 'Alex', 'Jo', null, 'Chris'][i % 5],
    is_business: i === 7 ? 1 : 0,
    synced_at: now,
  });
  upsertMessages(db, conversation(id, { waitDays, streak, lastFromMe, lastBody }));
  seeded += 1;
});

GROUPS.forEach(([name, participants, waitDays, streak, lastBody], i) => {
  const id = `group${i}@g.us`;
  upsertChat(db, {
    id, name, is_group: 1, participants, unread_count: i, synced_at: now,
  });
  upsertMessages(db, conversation(id, { waitDays, streak, lastFromMe: i % 2 === 0, lastBody }));
  seeded += 1;
});

const totals = counts(db);
process.stdout.write(
  `Seeded ${seeded} demo chats into ${dataDir()} ` +
    `(${totals.chats} chats, ${totals.messages} messages).\n`
);
