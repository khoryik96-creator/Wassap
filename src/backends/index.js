import { UserError } from '../errors.js';

/**
 * Two ways to reach WhatsApp:
 *
 *   baileys - speaks the multi-device protocol directly. Does not depend on
 *             WhatsApp Web's own JavaScript, so it survives changes to it.
 *   webjs   - drives WhatsApp Web in a headless browser via whatsapp-web.js.
 *             Breaks whenever WhatsApp reshuffles that bundle ahead of the
 *             library, which is why it is no longer the default.
 */
export const BACKENDS = ['baileys', 'webjs'];
export const DEFAULT_BACKEND = 'baileys';

export function backendName(requested) {
  const name = (requested ?? process.env.WASSAP_BACKEND ?? DEFAULT_BACKEND).trim();
  if (!BACKENDS.includes(name)) {
    throw new UserError(
      `Unknown backend "${name}". Available: ${BACKENDS.join(', ')}.`
    );
  }
  return name;
}

export async function loadBackend(requested) {
  const name = backendName(requested);
  const module = name === 'webjs'
    ? await import('./webjs.js')
    : await import('./baileys.js');
  return { name, ...module };
}
