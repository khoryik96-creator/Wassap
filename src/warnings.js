/**
 * Node and some dependencies emit warnings we cannot act on and the user
 * cannot either. Filtering them keeps CLI output readable. Importing this
 * module installs the filter; everything else is passed through untouched.
 */
const IGNORED = [
  { type: 'ExperimentalWarning', match: /sqlite/i },   // node:sqlite, used for local storage
  { type: 'DeprecationWarning', match: /punycode/i },  // pulled in transitively by whatsapp-web.js
];

let installed = false;

export function silenceKnownDependencyWarnings() {
  if (installed) return;
  installed = true;

  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === 'string' ? warning : warning?.message ?? '';
    const type = typeof warning === 'string' ? rest[0] : warning?.name;
    if (IGNORED.some((rule) => rule.type === type && rule.match.test(message))) return;
    return original.call(process, warning, ...rest);
  };
}

silenceKnownDependencyWarnings();
