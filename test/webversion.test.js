import test from 'node:test';
import assert from 'node:assert/strict';
import { remotePathFor, resolveWebVersion } from '../src/webversion.js';
import { UserError } from '../src/errors.js';

test('a version maps to its archived page URL', () => {
  assert.equal(
    remotePathFor('2.3000.1042900067-alpha'),
    'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1042900067-alpha.html'
  );
});

test('an exact version is used as given, without a network call', async () => {
  const fetchSpy = () => assert.fail('should not have fetched for an exact version');
  const original = globalThis.fetch;
  globalThis.fetch = fetchSpy;
  try {
    assert.equal(await resolveWebVersion('2.3000.1042900067-alpha'), '2.3000.1042900067-alpha');
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty pin means no pin', async () => {
  assert.equal(await resolveWebVersion(''), null);
  assert.equal(await resolveWebVersion(null), null);
  assert.equal(await resolveWebVersion(undefined), null);
});

function stubIndex(payload, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => payload });
}

test('oldest and latest pick the ends of the archive', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubIndex({
    versions: [
      { version: 'a', beta: false, released: '2026-07-01' },
      { version: 'b', beta: false, released: '2026-08-01' },
      { version: 'c', beta: false, released: '2026-09-01' },
    ],
  });
  try {
    assert.equal(await resolveWebVersion('oldest'), 'a');
    assert.equal(await resolveWebVersion('latest'), 'c');
  } finally {
    globalThis.fetch = original;
  }
});

test('betas are excluded from the archive', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubIndex({
    versions: [
      { version: 'beta-one', beta: true, released: '2026-07-01' },
      { version: 'stable', beta: false, released: '2026-08-01' },
    ],
  });
  try {
    assert.equal(await resolveWebVersion('oldest'), 'stable');
  } finally {
    globalThis.fetch = original;
  }
});

test('an unreachable or empty index reports a usable error', async () => {
  const original = globalThis.fetch;

  globalThis.fetch = stubIndex({ versions: [] });
  try {
    await assert.rejects(() => resolveWebVersion('oldest'), (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /empty/i);
      return true;
    });

    globalThis.fetch = stubIndex(null, false, 503);
    await assert.rejects(() => resolveWebVersion('latest'), (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /503/);
      return true;
    });

    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    await assert.rejects(() => resolveWebVersion('latest'), (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /Pin an exact version/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
