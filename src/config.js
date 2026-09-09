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
 * Chromium to drive. The bundled Playwright build is used when present so the
 * tool works without a separate Puppeteer download; PUPPETEER_EXECUTABLE_PATH
 * always wins if the user sets it.
 */
export function chromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* unreadable path — try the next candidate */
    }
  }
  return undefined; // let puppeteer fall back to its own bundled build
}
