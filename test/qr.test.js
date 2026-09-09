import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderQrText, writeQrImage, showQr } from '../src/qr.js';

const PAYLOAD = '2@ABCdefGHI123456789jklMNOpqrSTUvwxYZ==,xYz9876543210AbCdEf=,LmNoPqRs=,1';

test('a QR renders as terminal blocks', async () => {
  const text = await renderQrText(PAYLOAD);
  assert.ok(text.length > 100, 'produced a block of output');
  assert.match(text, /[▀-▟]/, 'uses block-drawing characters');
});

test('the PNG mirror is written and is a real PNG', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-qr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = await writeQrImage(PAYLOAD, path.join(dir, 'qr.png'));
  assert.ok(file, 'returned a path');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 500);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic number');
});

test('an unwritable image path degrades instead of throwing', async () => {
  const file = await writeQrImage(PAYLOAD, path.join(os.tmpdir(), 'no-such-dir-xyz', 'qr.png'));
  assert.equal(file, null, 'reports failure rather than crashing the login');
});

test('the first code and a refreshed one are announced differently', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wassap-qr-'));
  const previous = process.env.WASSAP_HOME;
  process.env.WASSAP_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.WASSAP_HOME;
    else process.env.WASSAP_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = [];
  const drawn = [];
  await showQr(PAYLOAD, 1, (m) => first.push(m), (s) => drawn.push(s));
  assert.match(first.join(' '), /Scan this QR code/);
  assert.ok(!/refreshed/.test(first.join(' ')));

  const second = [];
  await showQr(PAYLOAD, 2, (m) => second.push(m), (s) => drawn.push(s));
  assert.match(second.join(' '), /refreshed \(#2\)/);
  assert.match(second.join(' '), /expired/);

  assert.equal(drawn.length, 2, 'every code is drawn, not just the first');
});
