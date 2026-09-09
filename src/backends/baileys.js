import path from 'node:path';
import { sessionDir } from '../config.js';
import { UserError } from '../errors.js';
import { showQr } from '../qr.js';
import { normalizeChat, normalizeMessage, chatsFromMessages, toMillis } from './normalize.js';

/**
 * Baileys speaks WhatsApp's multi-device protocol directly over a WebSocket.
 * Unlike a browser-driven client it does not call into WhatsApp Web's own
 * JavaScript, so it does not break when that bundle is reshuffled.
 *
 * The trade-off is how history arrives: WhatsApp pushes it after linking, in
 * batches, rather than letting us pull per chat. So we listen, accumulate, and
 * stop once the server says it is done or the stream goes quiet.
 */

const DEFAULT_QUIET_MS = 10000; // no new history batch for this long means done
const DEFAULT_MAX_MS = 180000; // hard ceiling so a sync cannot hang forever

function silentLogger() {
  const noop = () => {};
  const logger = {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  };
  logger.child = () => logger;
  return logger;
}

async function loadBaileys() {
  try {
    return await import('@whiskeysockets/baileys');
  } catch (err) {
    throw new UserError(
      'The Baileys library is not installed. Run `npm install` in the project\n' +
        `directory first.\n\nUnderlying error: ${err.message}`
    );
  }
}

/**
 * Connect, collect whatever history WhatsApp sends, and return normalized rows.
 * Resolves with { account, chats, messages }.
 */
export async function harvest({
  includeGroups = true,
  onStatus = () => {},
  quietMs = DEFAULT_QUIET_MS,
  maxMs = DEFAULT_MAX_MS,
} = {}) {
  const baileys = await loadBaileys();
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  const authDir = path.join(sessionDir(), 'baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  onStatus(`Using WhatsApp protocol version ${version.join('.')}`);

  const chatsById = new Map();
  const contactsById = new Map();
  const messageRows = new Map();

  let account = null;
  let attempt = 0;

  // Resolved when history has settled; rejected on a fatal disconnect.
  return new Promise((resolve, reject) => {
    let quietTimer = null;
    let hardTimer = null;
    let settled = false;
    let socket = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try {
        socket?.end?.(undefined);
      } catch {
        /* already closing */
      }

      const chats = [...chatsById.values()]
        .map((chat) => normalizeChat(chat, contactsById.get(chat.id) ?? null))
        .filter(Boolean)
        .filter((row) => includeGroups || !row.is_group);

      const messages = [...messageRows.values()];
      const known = new Set(chats.map((c) => c.id));
      const inferred = chatsFromMessages(messages, known, contactsById)
        .filter((row) => includeGroups || !row.is_group);

      onStatus(`History ${reason}.`);
      resolve({
        account,
        chats: [...chats, ...inferred],
        messages: messages.filter((m) =>
          includeGroups ? true : !String(m.chat_id).endsWith('@g.us')
        ),
      });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try {
        socket?.end?.(undefined);
      } catch {
        /* already closing */
      }
      reject(err);
    };

    const bumpQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('stream went quiet'), quietMs);
    };

    hardTimer = setTimeout(() => finish(`hit the ${Math.round(maxMs / 1000)}s limit`), maxMs);

    const connect = () => {
      attempt += 1;
      socket = makeWASocket({
        version,
        auth: state,
        logger: silentLogger(),
        syncFullHistory: true,
        markOnlineOnConnect: false, // stay invisible; this is a read-only tool
        browser: ['wassap', 'Chrome', '1.0.0'],
      });

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          await showQr(qr, attempt === 1 ? 1 : attempt, onStatus);
        }

        if (connection === 'open') {
          account = socket.user?.id ?? null;
          onStatus(`Connected as ${socket.user?.name ?? account ?? 'your account'}.`);
          onStatus('Waiting for WhatsApp to send your history...');
          bumpQuietTimer();
        }

        if (connection === 'close') {
          const status =
            lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status ?? null;

          // WhatsApp asks for a reconnect right after pairing; that is expected.
          if (status === DisconnectReason.restartRequired && attempt < 4) {
            onStatus('WhatsApp asked for a reconnect, reconnecting...');
            connect();
            return;
          }
          if (status === DisconnectReason.loggedOut) {
            fail(
              new UserError(
                'This device is no longer linked to your WhatsApp account.\n' +
                  'Run `logout`, then `login` to link it again.'
              )
            );
            return;
          }
          // Anything collected before an unexpected drop is still worth keeping.
          if (messageRows.size > 0 || chatsById.size > 0) {
            finish(`ended early (connection closed, status ${status ?? 'unknown'})`);
            return;
          }
          fail(
            new UserError(
              `The connection to WhatsApp closed before any history arrived ` +
                `(status ${status ?? 'unknown'}).\nTry again; if it persists, run login once more.`
            )
          );
        }
      });

      socket.ev.on('messaging-history.set', (payload) => {
        const { chats = [], contacts = [], messages = [], isLatest, progress } = payload ?? {};

        for (const contact of contacts) {
          if (contact?.id) contactsById.set(contact.id, contact);
        }
        for (const chat of chats) {
          if (chat?.id) chatsById.set(chat.id, { ...chatsById.get(chat.id), ...chat });
        }
        for (const message of messages) {
          const row = normalizeMessage(message);
          if (row) messageRows.set(row.id, row);
        }

        const pct = typeof progress === 'number' ? ` ${progress}%` : '';
        onStatus(
          `  history${pct}: ${chatsById.size} chats, ${messageRows.size} messages`
        );

        if (isLatest) {
          finish('sync reported complete');
          return;
        }
        bumpQuietTimer();
      });

      // Live messages that arrive while we are still connected.
      socket.ev.on('messages.upsert', ({ messages = [] }) => {
        for (const message of messages) {
          const row = normalizeMessage(message);
          if (row) messageRows.set(row.id, row);
        }
      });

      socket.ev.on('contacts.upsert', (contacts = []) => {
        for (const contact of contacts) {
          if (contact?.id) contactsById.set(contact.id, { ...contactsById.get(contact.id), ...contact });
        }
      });

      socket.ev.on('chats.upsert', (chats = []) => {
        for (const chat of chats) {
          if (chat?.id) chatsById.set(chat.id, { ...chatsById.get(chat.id), ...chat });
        }
      });
    };

    connect();
  });
}

/** Link the device. Same connection dance, but stops as soon as it is open. */
export async function login({ onStatus = () => {} } = {}) {
  const baileys = await loadBaileys();
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  const authDir = path.join(sessionDir(), 'baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;
    let socket = null;

    const connect = () => {
      attempt += 1;
      socket = makeWASocket({
        version,
        auth: state,
        logger: silentLogger(),
        markOnlineOnConnect: false,
        browser: ['wassap', 'Chrome', '1.0.0'],
      });

      socket.ev.on('creds.update', saveCreds);
      socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) await showQr(qr, attempt === 1 ? 1 : attempt, onStatus);

        if (connection === 'open') {
          if (settled) return;
          settled = true;
          const name = socket.user?.name ?? socket.user?.id ?? 'your account';
          // Give Baileys a moment to persist credentials before closing.
          setTimeout(() => {
            try {
              socket.end(undefined);
            } catch {
              /* already closing */
            }
            resolve({ account: socket.user?.id ?? null, name });
          }, 1500);
        }

        if (connection === 'close' && !settled) {
          const status =
            lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status ?? null;
          if (status === DisconnectReason.restartRequired && attempt < 4) {
            connect();
            return;
          }
          settled = true;
          reject(
            new UserError(
              `Linking failed (status ${status ?? 'unknown'}).\n` +
                'Make sure you scanned the most recent QR code, then try again.'
            )
          );
        }
      });
    };

    connect();
  });
}
