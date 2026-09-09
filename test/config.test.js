import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromiumPath, resolveBrowserPath, dataDir, dbPath, sessionDir } from '../src/config.js';

test('an explicit executable path always wins', async () => {
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = '/custom/chrome';
  try {
    assert.equal(chromiumPath(), '/custom/chrome');
    assert.equal(await resolveBrowserPath(), '/custom/chrome');
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test('browser lookup returns either a real file or undefined, never a guess', async () => {
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    for (const found of [chromiumPath(), await resolveBrowserPath()]) {
      if (found !== undefined) {
        assert.ok(fs.existsSync(found), `reported a path that does not exist: ${found}`);
      }
    }
  } finally {
    if (previous !== undefined) process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test('WASSAP_HOME redirects every stored path', () => {
  const previous = process.env.WASSAP_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-cfg-'));
  process.env.WASSAP_HOME = dir;
  try {
    assert.equal(dataDir(), path.resolve(dir));
    assert.equal(dbPath(), path.join(path.resolve(dir), 'wassap.db'));
    assert.equal(sessionDir(), path.join(path.resolve(dir), 'session'));
  } finally {
    if (previous === undefined) delete process.env.WASSAP_HOME;
    else process.env.WASSAP_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paths are built with the platform separator', () => {
  assert.ok(dbPath().includes(path.sep));
});
