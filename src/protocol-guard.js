/**
 * whatsapp-web.js re-injects its scripts on page events, and those calls are
 * not awaited by anything. When the browser goes away - normal teardown
 * included - they reject with "Target closed", which Node treats as a fatal
 * unhandled rejection and the whole command dies.
 *
 * This swallows that specific class of error, and only while a browser session
 * is live. Anything else still crashes the process, as it should.
 */

const PROTOCOL_NOISE =
  /Target closed|Protocol error|Session closed|Execution context was destroyed|Connection closed/i;

/** Is this the browser going away, rather than a real failure? */
export function isProtocolNoise(error) {
  return PROTOCOL_NOISE.test(String(error?.message ?? error));
}

let sessionDepth = 0;
let installed = false;

export function sessionsActive() {
  return sessionDepth;
}

export function beginSession() {
  sessionDepth += 1;
}

/**
 * Teardown rejections arrive shortly after the browser closes, so the guard
 * stays armed for a grace period rather than ending with the session.
 */
export function endSession(graceMs = 2000) {
  if (graceMs <= 0) {
    sessionDepth = Math.max(0, sessionDepth - 1);
    return;
  }
  setTimeout(() => {
    sessionDepth = Math.max(0, sessionDepth - 1);
  }, graceMs).unref();
}

export function installProtocolErrorGuard(onIgnored = defaultOnIgnored) {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    if (sessionDepth > 0 && isProtocolNoise(reason)) {
      onIgnored(reason);
      return;
    }
    throw reason;
  });
}

function defaultOnIgnored(reason) {
  if (process.env.WASSAP_DEBUG) {
    process.stderr.write(`[wassap] ignored browser teardown error: ${reason?.message ?? reason}\n`);
  }
}
