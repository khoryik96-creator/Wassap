import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setThreadState, threadState, messagesForChat, getMeta, counts, THREAD_STATUSES } from './db.js';
import { review } from './review.js';
import { previewBody } from './analyze.js';
import { renderApp } from './report/app.js';
import { dataDir, sessionDir } from './config.js';
import { writeQrImage } from './qr.js';

/**
 * A small local server behind the triage UI. Deliberately dependency-free and
 * bound to loopback: it exposes your entire message history, so it must not be
 * reachable from anywhere but this machine.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Turn query parameters into the same options object the CLI builds. */
export function filtersFromQuery(params) {
  const num = (key) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const flag = (key) => params.get(key) === 'true';

  const saved = params.get('saved');
  const statuses = params.get('statuses');

  return {
    direction: params.get('direction') ?? 'both',
    chatType: params.get('chatType') ?? 'all',
    saved: saved === 'saved' ? true : saved === 'unsaved' ? false : undefined,
    since: num('since'),
    until: num('until'),
    minWait: num('minWait'),
    maxWait: num('maxWait'),
    search: params.get('search') || null,
    minMessages: num('minMessages') ?? 1,
    unreadOnly: flag('unreadOnly'),
    archived: flag('archived'),
    muted: params.get('muted') !== 'false',
    blocked: flag('blocked'),
    sort: params.get('sort') ?? 'waiting',
    limit: num('limit') ?? 0,
    statuses: statuses === 'all' ? 'all' : (statuses ? statuses.split(',') : ['open']),
  };
}

/** The full message history of one chat, oldest first, for the detail pane. */
export function threadDetail(db, chatId) {
  const messages = messagesForChat(db, chatId).map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    from_me: Boolean(m.from_me),
    type: m.type,
    body: m.body,
    preview: previewBody(m, 4000),
    has_media: Boolean(m.has_media),
    author: m.author,
  }));
  return { chatId, messages, state: threadState(db, chatId) };
}

/**
 * Linking and syncing are long-running and can only sensibly happen one at a
 * time, so the server runs at most one job and streams its progress to any
 * page that is watching.
 */
function createJobRunner(db) {
  const watchers = new Set();
  let current = null; // { kind, startedAt, log, qrAt, finished, error }

  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of watchers) {
      try {
        res.write(line);
      } catch {
        watchers.delete(res);
      }
    }
  };

  const status = (message) => {
    if (current) current.log.push(message);
    broadcast({ type: 'status', message });
  };

  return {
    watch(res) {
      watchers.add(res);
      res.on('close', () => watchers.delete(res));
      if (current) {
        for (const message of current.log) res.write(`data: ${JSON.stringify({ type: 'status', message })}\n\n`);
        if (current.qrAt) res.write(`data: ${JSON.stringify({ type: 'qr', at: current.qrAt })}\n\n`);
      }
    },

    snapshot() {
      return current
        ? { kind: current.kind, running: !current.finished, error: current.error ?? null, log: current.log.slice(-40) }
        : null;
    },

    busy() {
      return Boolean(current && !current.finished);
    },

    async start(kind, run) {
      if (this.busy()) throw new Error(`A ${current.kind} is already running.`);
      current = { kind, startedAt: Date.now(), log: [], qrAt: null, finished: false, error: null };
      broadcast({ type: 'started', kind });

      const onQr = async (qr) => {
        await writeQrImage(qr, path.join(dataDir(), 'qr.png'));
        current.qrAt = Date.now();
        status('Scan the QR code below with WhatsApp: Settings > Linked devices > Link a device.');
        broadcast({ type: 'qr', at: current.qrAt });
      };

      try {
        const result = await run({ onStatus: status, onQr });
        current.finished = true;
        broadcast({ type: 'done', kind, result: result ?? null });
      } catch (err) {
        current.finished = true;
        current.error = err.message;
        broadcast({ type: 'error', kind, message: err.message });
      }
    },
  };
}

export function createServer({ dbFile } = {}) {
  const db = openDb(dbFile);
  const jobs = createJobRunner(db);

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad request URL.' }, JSON_HEADERS);
    }
    const { pathname } = url;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return send(res, 200, renderApp(), { 'content-type': 'text/html; charset=utf-8' });
      }

      // Browsers request this unprompted; answering keeps the console clean.
      if (req.method === 'GET' && pathname === '/favicon.ico') {
        return send(res, 204, '');
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const totals = counts(db);
        return send(res, 200, {
          linked: fs.existsSync(path.join(sessionDir(), 'baileys')) || fs.existsSync(sessionDir()),
          account: getMeta(db, 'account'),
          backend: getMeta(db, 'backend'),
          lastSync: Number(getMeta(db, 'last_sync')) || null,
          isDemo: getMeta(db, 'demo') === '1',
          chats: totals.chats,
          messages: totals.messages,
          job: jobs.snapshot(),
        }, JSON_HEADERS);
      }

      // Server-sent events: progress for whichever job is running.
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        jobs.watch(res);
        return undefined;
      }

      if (req.method === 'GET' && pathname === '/api/qr.png') {
        const file = path.join(dataDir(), 'qr.png');
        if (!fs.existsSync(file)) return send(res, 404, { error: 'No QR code right now.' }, JSON_HEADERS);
        return send(res, 200, fs.readFileSync(file), { 'content-type': 'image/png' });
      }

      if (req.method === 'POST' && pathname === '/api/login') {
        if (jobs.busy()) return send(res, 409, { error: 'Something is already running.' }, JSON_HEADERS);
        const { loadBackend } = await import('./backends/index.js');
        jobs.start('login', async ({ onStatus, onQr }) => {
          const { name, login } = await loadBackend();
          onStatus(`Linking via ${name}...`);
          const who = await login({ onStatus, onQr });
          onStatus(`Linked as ${who.name ?? who.account ?? 'your account'}.`);
          return who;
        });
        return send(res, 202, { started: 'login' }, JSON_HEADERS);
      }

      if (req.method === 'POST' && pathname === '/api/sync') {
        if (jobs.busy()) return send(res, 409, { error: 'Something is already running.' }, JSON_HEADERS);
        const { sync } = await import('./sync.js');
        jobs.start('sync', async ({ onStatus, onQr }) => {
          const result = await sync(db, { onStatus, onQr });
          onStatus(
            `Synced ${result.chats} chats and ${result.messages} messages. ` +
              `Stored: ${result.stored.chats} chats, ${result.stored.messages} messages.`
          );
          return result;
        });
        return send(res, 202, { started: 'sync' }, JSON_HEADERS);
      }

      if (req.method === 'GET' && pathname === '/api/threads') {
        const opts = filtersFromQuery(url.searchParams);
        const result = review(db, opts, Date.now());
        return send(res, 200, {
          threads: result.threads,
          summary: result.summary,
          scanned: result.scanned,
          matched: result.matched,
        }, JSON_HEADERS);
      }

      const detail = pathname.match(/^\/api\/threads\/(.+)\/messages$/);
      if (req.method === 'GET' && detail) {
        const chatId = decodeURIComponent(detail[1]);
        return send(res, 200, threadDetail(db, chatId), JSON_HEADERS);
      }

      const state = pathname.match(/^\/api\/threads\/(.+)\/state$/);
      if (req.method === 'POST' && state) {
        const chatId = decodeURIComponent(state[1]);
        const body = await readJsonBody(req);

        if (body.status !== undefined && !THREAD_STATUSES.includes(body.status)) {
          return send(res, 400, {
            error: `Unknown status. Use one of: ${THREAD_STATUSES.join(', ')}.`,
          }, JSON_HEADERS);
        }
        const updated = setThreadState(db, chatId, {
          status: body.status,
          note: body.note,
          snoozed_until: body.snoozedUntil,
        });
        return send(res, 200, updated ?? {}, JSON_HEADERS);
      }

      return send(res, 404, { error: 'Not found.' }, JSON_HEADERS);
    } catch (err) {
      return send(res, 500, { error: err.message }, JSON_HEADERS);
    }
  });
}

/** Start on loopback only. Resolves once listening. */
export function startServer({ port = 4173, host = '127.0.0.1', dbFile } = {}) {
  const server = createServer({ dbFile });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host }));
  });
}
