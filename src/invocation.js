import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How the user should type this tool, so suggested commands are copy-pasteable.
 *
 * Run from a clone (`node bin/wassap.js review`) the script sits inside the
 * working directory, and that is the form to echo back. Installed globally or
 * via `npm link` it lives elsewhere, and the bare `wassap` command works.
 */
export function invocation(scriptUrl = import.meta.url, cwd = process.cwd()) {
  let scriptPath;
  try {
    scriptPath = fileURLToPath(scriptUrl);
  } catch {
    return 'wassap';
  }

  const relative = path.relative(cwd, scriptPath);
  // Outside the working directory: an installed binary on PATH.
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 'wassap';

  // Inside it: they are running the file directly. Use forward slashes, which
  // both cmd.exe and PowerShell accept, so one form works everywhere.
  return `node ${relative.split(path.sep).join('/')}`;
}

// Set once by the CLI entry point. Modules deeper in the tree cannot work out
// how the program was started, so they read it from here.
let registered = null;

/** Record how this process was invoked, for messages raised anywhere in the code. */
export function setInvocation(prefix) {
  registered = prefix;
}

/** `wassap sync` or `node bin/wassap.js sync`, whichever the user can actually type. */
export function command(subcommand, prefix = registered ?? 'wassap') {
  return subcommand ? `${prefix} ${subcommand}` : prefix;
}
