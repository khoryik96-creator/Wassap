import path from 'node:path';
import { sessionDir, resolveBrowserPath, dataDir } from './config.js';
import { UserError } from './errors.js';
import {
  installProtocolErrorGuard,
  beginSession,
  endSession,
  isProtocolNoise,
} from './protocol-guard.js';

/**
 * whatsapp-web.js drives a real WhatsApp Web session in headless Chromium.
 * It is imported lazily so that `wassap review` (which only reads the local
 * database) works even if the browser stack is unavailable.
 */
async function loadLibrary() {
  try {
    const mod = await import('whatsapp-web.js');
    return mod.default ?? mod;
  } catch (err) {
    throw new Error(
      'whatsapp-web.js is not installed. Run `npm install` in the project directory first.\n' +
        `Underlying error: ${err.message}`
    );
  }
}

export async function createClient() {
  const { Client, LocalAuth } = await loadLibrary();
  const executablePath = await resolveBrowserPath();

  // WhatsApp Web occasionally ships changes that break whatsapp-web.js. Pinning
  // a known-good page version is the usual mitigation, so allow one to be named.
  const pinned = process.env.WASSAP_WEB_VERSION;
  const webVersionCache = pinned
    ? {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/' +
          `${pinned}.html`,
      }
    : undefined;

  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir() }),
    ...(webVersionCache ? { webVersionCache } : {}),
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });
}

/**
 * Bring a client up and hand it to `fn`. Prints a QR code when the session is
 * not yet linked. Always destroys the client afterwards.
 *
 * `onStatus` receives short progress strings so callers control the output.
 */
/** The QR as terminal block characters. Returned rather than printed, so it is testable. */
export async function renderQrText(qr) {
  const { default: qrcode } = await import('qrcode-terminal');
  return new Promise((resolve) => qrcode.generate(qr, { small: true }, resolve));
}

/**
 * Mirror the QR to a PNG, for terminals where the block characters are hard
 * for a phone camera to read. Returns the path, or null if it could not write.
 */
export async function writeQrImage(qr, file = path.join(dataDir(), 'qr.png')) {
  try {
    const { default: qrImage } = await import('qrcode');
    await qrImage.toFile(file, qr, { width: 512, margin: 2 });
    return file;
  } catch {
    return null; // the terminal code is still usable on its own
  }
}

/**
 * Present one QR code. `attempt` is 1 for the first and increases on every
 * refresh, because only the newest code will actually link.
 */
export async function showQr(qr, attempt, onStatus, write = process.stdout.write.bind(process.stdout)) {
  if (attempt === 1) {
    onStatus('Scan this QR code in WhatsApp: Settings > Linked devices > Link a device');
  } else {
    onStatus(`QR code refreshed (#${attempt}) - the previous one has expired, scan this one:`);
  }

  write(`${await renderQrText(qr)}\n`);
  return writeQrImage(qr);
}

export async function withClient(fn, { onStatus = () => {} } = {}) {
  const client = await createClient();
  let attempt = 0;
  let toldAboutImage = false;

  // WhatsApp rotates the QR roughly every 20 seconds. Each rotation emits a new
  // event, and only the newest code will link - so every one of them is drawn.
  client.on('qr', async (qr) => {
    attempt += 1;
    const image = await showQr(qr, attempt, onStatus);

    if (attempt === 1) {
      onStatus('This code expires about every 20 seconds and will redraw itself.');
      onStatus('Always scan the most recent one, at the bottom of your screen.');
    }
    if (image && !toldAboutImage) {
      toldAboutImage = true;
      onStatus(`If it will not scan from the terminal, open this image instead: ${image}`);
      onStatus('(it is rewritten on every refresh, so reopen it after each redraw)');
    }
  });

  client.on('authenticated', () => onStatus('Authenticated, restoring session...'));
  client.on('auth_failure', (m) => onStatus(`Authentication failed: ${m}`));
  client.on('loading_screen', (percent) => onStatus(`Loading WhatsApp: ${percent}%`));

  const ready = new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('auth_failure', (m) => reject(new Error(`WhatsApp authentication failed: ${m}`)));
  });

  installProtocolErrorGuard();
  beginSession();

  try {
    await client.initialize();
    await ready;
    onStatus('Connected.');
    return await fn(client);
  } catch (err) {
    // A protocol error that reaches us means the browser died mid-session,
    // which is worth explaining rather than dumping a puppeteer stack.
    if (isProtocolNoise(err)) {
      throw new UserError(
        'The browser closed unexpectedly while talking to WhatsApp Web.\n\n' +
          'This usually means the browser build does not match what\n' +
          'whatsapp-web.js expects. The most reliable fix is to let Puppeteer\n' +
          'use its own Chromium:\n' +
          '  npm install-scripts approve puppeteer\n' +
          '  npm install\n\n' +
          'If that is already the case, WhatsApp Web may have changed under the\n' +
          'library. Pin a known-good version and retry:\n' +
          '  set WASSAP_WEB_VERSION=2.3000.1027183017\n\n' +
          `Re-run with WASSAP_DEBUG=1 for the underlying error.`
      );
    }
    throw err;
  } finally {
    try {
      await client.destroy();
    } catch {
      /* the browser may already be gone; nothing useful to do */
    }
    endSession();
  }
}
