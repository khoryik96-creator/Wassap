import { sessionDir, resolveBrowserPath } from './config.js';
import { showQr } from './qr.js';
import { UserError } from './errors.js';
import { resolveWebVersion, remotePathFor } from './webversion.js';
import { command } from './invocation.js';
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

export async function createClient({ onStatus = () => {} } = {}) {
  const { Client, LocalAuth } = await loadLibrary();
  const executablePath = await resolveBrowserPath();

  // WhatsApp Web occasionally ships changes that break whatsapp-web.js. Pinning
  // an archived page version is the usual mitigation. "oldest" is the closest
  // archived page to the era the installed library was written against.
  const pin = process.env.WASSAP_WEB_VERSION;
  let webVersionCache;
  if (pin) {
    const version = await resolveWebVersion(pin);
    webVersionCache = { type: 'remote', remotePath: remotePathFor(version) };
    onStatus(`Pinning WhatsApp Web version ${version}`);
  }

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
export async function withClient(fn, { onStatus = () => {} } = {}) {
  const client = await createClient({ onStatus });
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
          'Most often the browser build does not match what whatsapp-web.js\n' +
          'expects. Let Puppeteer use its own Chromium:\n' +
          '  npm install-scripts approve puppeteer\n' +
          '  npm install\n\n' +
          'If that is already so, WhatsApp Web has probably changed under the\n' +
          'library. Pin an older page version and retry:\n' +
          `  ${command('web-versions')}      list what can be pinned\n` +
          '  set WASSAP_WEB_VERSION=oldest\n\n' +
          'Re-run with WASSAP_DEBUG=1 for the underlying error.'
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
