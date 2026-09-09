import { sessionDir, chromiumPath } from './config.js';

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

  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir() }),
    puppeteer: {
      headless: true,
      executablePath: chromiumPath(),
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
  const client = await createClient();
  let qrShown = false;

  client.on('qr', async (qr) => {
    if (qrShown) return;
    qrShown = true;
    const { default: qrcode } = await import('qrcode-terminal');
    onStatus('Scan this QR code in WhatsApp: Settings > Linked devices > Link a device');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => onStatus('Authenticated, restoring session...'));
  client.on('auth_failure', (m) => onStatus(`Authentication failed: ${m}`));
  client.on('loading_screen', (percent) => onStatus(`Loading WhatsApp: ${percent}%`));

  const ready = new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('auth_failure', (m) => reject(new Error(`WhatsApp authentication failed: ${m}`)));
  });

  try {
    await client.initialize();
    await ready;
    onStatus('Connected.');
    return await fn(client);
  } finally {
    try {
      await client.destroy();
    } catch {
      /* the browser may already be gone; nothing useful to do */
    }
  }
}
