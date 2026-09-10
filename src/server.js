import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setThreadState, threadState, messagesForChat, getMeta, setMeta, counts, THREAD_STATUSES } from './db.js';
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

/**
 * Loopback binding keeps other machines out, but not other pages in the
 * browser the user is already running: a POST with no custom headers is a
 * CORS "simple request" and fires without a preflight. So state-changing
 * routes must come from our own origin, and the Host header must be one we
 * served (which also blocks DNS rebinding).
 */
/**
 * Whether a device is actually linked. useMultiFileAuthState creates its
 * directory on the first attempt, so the directory existing proves nothing;
 * creds.json is only written once WhatsApp has answered.
 */
function hasLinkedSession() {
  const candidates = [
    path.join(sessionDir(), 'baileys', 'creds.json'),
    path.join(sessionDir(), 'session'), // whatsapp-web.js LocalAuth
  ];
  return candidates.some((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
}

export function isSameOrigin(req, port) {
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);

  const host = req.headers.host;
  if (!host || !allowedHosts.has(host)) return false;

  const origin = req.headers.origin;
  if (origin === undefined) return true; // same-origin fetch may omit it
  try {
    return allowedHosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  // Buffers are already the bytes to send; stringifying one yields JSON.
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
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
export function createJobRunner() {
  const watchers = new Set();
  let current = null; // { kind, log, qrAt, finished, error }
  let generation = 0; // bumped per job, so a replay can be told apart from live lines

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

  return {
    watch(res) {
      watchers.add(res);
      res.on('close', () => watchers.delete(res));

      // A reconnecting EventSource must be able to tell a replay from new
      // output, or it appends the whole log again on every reconnect.
      if (current) {
        res.write(`data: ${JSON.stringify({ type: 'replay', kind: current.kind, generation, log: current.log, qrAt: current.qrAt, running: !current.finished, error: current.error })}\n\n`);
      }
    },

    snapshot() {
      return current
        ? {
            kind: current.kind,
            running: !current.finished,
            error: current.error ?? null,
            log: current.log.slice(-40),
          }
        : null;
    },

    busy() {
      return Boolean(current && !current.finished);
    },

    /**
     * Begin a job. Returns false if one is already running; the check and the
     * assignment happen together so two requests cannot both get through.
     */
    start(kind, run) {
      if (current && !current.finished) return false;

      generation += 1;
      // Callbacks write to *this* job, not to whatever is current later on:
      // a backend can emit a late event while the next job is already running.
      const job = { kind, log: [], qrAt: null, finished: false, error: null };
      const mine = generation;
      current = job;

      const status = (message) => {
        job.log.push(message);
        if (current === job) broadcast({ type: 'status', generation: mine, message });
      };

      const onQr = async (qr, attempt = 1) => {
        const file = await writeQrImage(qr, path.join(dataDir(), 'qr.png'));
        if (!file) {
          // Without an image the page would show a stale QR from a past run.
          status('Could not render the QR code as an image. Use the terminal instead.');
          return;
        }
        job.qrAt = Date.now();
        status(
          attempt > 1
            ? `QR code refreshed (#${attempt}) - the previous one has expired, scan this one.`
            : 'Scan this QR code with WhatsApp: Settings > Linked devices > Link a device.'
        );
        if (current === job) broadcast({ type: 'qr', generation: mine, at: job.qrAt });
      };

      broadcast({ type: 'started', kind, generation: mine });

      // Deliberately not awaited: the request returns immediately. Every
      // outcome is captured, so this can never reject unhandled.
      Promise.resolve()
        .then(() => run({ onStatus: status, onQr }))
        .then((result) => {
          job.finished = true;
          broadcast({ type: 'done', kind, generation: mine, result: result ?? null });
        })
        .catch((err) => {
          job.finished = true;
          job.error = err?.message ?? String(err);
          broadcast({ type: 'error', kind, generation: mine, message: job.error });
        });

      return true;
    },
  };
}

export function createServer({ dbFile } = {}) {
  const db = openDb(dbFile);
  const jobs = createJobRunner();

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad request URL.' }, JSON_HEADERS);
    }
    const { pathname } = url;

    // Anything that starts a job or writes state must come from our own page.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const port = server.address()?.port;
      if (!isSameOrigin(req, port)) {
        return send(res, 403, {
          error: 'Refused: this request did not come from the wassap dashboard.',
        }, JSON_HEADERS);
      }
    }

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
          linked: hasLinkedSession(),
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
        const { loadBackend } = await import('./backends/index.js');
        const startedLogin = jobs.start('login', async ({ onStatus, onQr }) => {
          const { name, login } = await loadBackend();
          onStatus(`Linking via ${name}...`);
          const who = await login({ onStatus, onQr });
          // Record it here: sync used to be the only writer, so the page had
          // no way to tell that linking had succeeded.
          if (who?.account) setMeta(db, 'account', who.account);
          setMeta(db, 'backend', name);
          onStatus(`Linked as ${who.name ?? who.account ?? 'your account'}.`);
          return who;
        });
        if (!startedLogin) return send(res, 409, { error: 'Something is already running.' }, JSON_HEADERS);
        return send(res, 202, { started: 'login' }, JSON_HEADERS);
      }

      if (req.method === 'POST' && pathname === '/api/sync') {
        const { sync } = await import('./sync.js');
        const startedSync = jobs.start('sync', async ({ onStatus, onQr }) => {
          const result = await sync(db, { onStatus, onQr });
          onStatus(
            `Synced ${result.chats} chats and ${result.messages} messages. ` +
              `Stored: ${result.stored.chats} chats, ${result.stored.messages} messages.`
          );
          return result;
        });
        if (!startedSync) return send(res, 409, { error: 'Something is already running.' }, JSON_HEADERS);
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

  return server;
}

/** Start on loopback only. Resolves once listening. */
export function startServer({ port = 4173, host = '127.0.0.1', dbFile } = {}) {
  const server = createServer({ dbFile });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host }));
  });
}
