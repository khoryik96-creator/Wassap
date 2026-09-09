import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  isProtocolNoise, beginSession, endSession, sessionsActive, installProtocolErrorGuard,
} from '../src/protocol-guard.js';

test('browser teardown errors are recognised', () => {
  for (const message of [
    'Protocol error (Runtime.callFunctionOn): Target closed',
    'Session closed. Most likely the page has been closed.',
    'Execution context was destroyed, most likely because of a navigation.',
    'Connection closed',
  ]) {
    assert.equal(isProtocolNoise(new Error(message)), true, message);
  }
});

test('real failures are not mistaken for teardown noise', () => {
  for (const message of [
    'ENOENT: no such file or directory',
    'WhatsApp authentication failed',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
  ]) {
    assert.equal(isProtocolNoise(new Error(message)), false, message);
  }
});

test('session depth tracks begin and end', () => {
  const before = sessionsActive();
  beginSession();
  assert.equal(sessionsActive(), before + 1);
  endSession(0);
  assert.equal(sessionsActive(), before);
});

test('the depth never goes negative', () => {
  endSession(0);
  endSession(0);
  assert.ok(sessionsActive() >= 0);
});

// The node test runner installs its own unhandledRejection handling, so the
// "does the process survive" question can only be answered in a child process.
function runChild(body) {
  const guard = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'protocol-guard.js')).href;
  const script = `
    import { installProtocolErrorGuard, beginSession } from ${JSON.stringify(guard)};
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('a teardown rejection during a session does not kill the process', () => {
  const { code, out } = runChild(`
    installProtocolErrorGuard(() => {});
    beginSession();
    Promise.reject(new Error('Protocol error (Runtime.callFunctionOn): Target closed'));
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 80);
  `);
  assert.equal(code, 0, 'the process exited cleanly');
  assert.match(out, /SURVIVED/);
});

test('the same rejection outside a session is still fatal', () => {
  const { code, err } = runChild(`
    installProtocolErrorGuard(() => {});
    // no beginSession(): nothing is meant to be shielded here
    Promise.reject(new Error('Protocol error (Runtime.callFunctionOn): Target closed'));
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 80);
  `);
  assert.notEqual(code, 0, 'an unexplained protocol error still fails loudly');
  assert.match(err, /Target closed/);
});

test('an unrelated rejection during a session is still fatal', () => {
  const { code, err } = runChild(`
    installProtocolErrorGuard(() => {});
    beginSession();
    Promise.reject(new Error('ENOENT: no such file or directory'));
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 80);
  `);
  assert.notEqual(code, 0, 'the guard must not swallow real failures');
  assert.match(err, /ENOENT/);
});
