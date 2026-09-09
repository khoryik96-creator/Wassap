import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Everything wassap writes lives under one directory so it is easy to inspect,
 * back up, or delete. Override with WASSAP_HOME (used by the test suite).
 */
export function dataDir() {
  const dir = process.env.WASSAP_HOME
    ? path.resolve(process.env.WASSAP_HOME)
    : path.join(os.homedir(), '.wassap');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dbPath = () => path.join(dataDir(), 'wassap.db');
export const sessionDir = () => path.join(dataDir(), 'session');

/**
 * Browsers to fall back on, per platform, when Puppeteer has no bundled build
 * of its own. Ordered best-first.
 */
function systemBrowserCandidates() {
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean);
    const suffixes = [
      String.raw`Google\Chrome\Application\chrome.exe`,
      String.raw`Chromium\Application\chrome.exe`,
      String.raw`Microsoft\Edge\Application\msedge.exe`,
    ];
    return roots.flatMap((root) => suffixes.map((suffix) => path.join(root, suffix)));
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }

  return [
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
  ];
}

/** First candidate that actually exists on disk, or undefined. */
export function chromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const candidate of systemBrowserCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable path - try the next candidate */
    }
  }
  return undefined;
}

/**
 * Which browser to hand Puppeteer.
 *
 * Puppeteer downloads a Chromium matched to its own protocol version during
 * `npm install`, and that is always the safest choice, so an explicit override
 * aside we let Puppeteer use it by returning undefined. Only when that download
 * was skipped or removed do we go looking for a system Chrome, Chromium or Edge.
 *
 * Throws a UserError when nothing is available, rather than letting Puppeteer
 * fail later with a less actionable message.
 */
export async function resolveBrowserPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  try {
    const puppeteer = (await import('puppeteer')).default;
    const bundled = puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) return undefined;
  } catch {
    /* puppeteer missing or unable to report a path - fall through */
  }

  const system = chromiumPath();
  if (system) return system;

  const { UserError } = await import('./errors.js');
  throw new UserError(
    'No browser available to drive WhatsApp Web.\n\n' +
      "Puppeteer's own Chromium is missing. That usually means its postinstall\n" +
      'script was blocked (npm prints "install scripts blocked" when this happens).\n\n' +
      'Fix it with either:\n' +
      '  npm install-scripts approve puppeteer && npm install\n' +
      'or point wassap at a browser you already have, for example:\n' +
      '  Windows      set PUPPETEER_EXECUTABLE_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
      '  macOS/Linux  export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome'
  );
}
