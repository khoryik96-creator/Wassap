import { UserError } from './errors.js';

/**
 * WhatsApp Web ships changes faster than whatsapp-web.js can follow, and a
 * newer page can break the library's internal calls. The WPPConnect project
 * archives past page versions, so one can be pinned until the library catches up.
 *
 * Builds are removed once they expire (roughly two months), so the pinnable
 * range is a moving window, not the whole history.
 */
const INDEX_URL = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json';
const HTML_BASE = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/';

/** The remote page URL whatsapp-web.js should load for a given version. */
export function remotePathFor(version) {
  return `${HTML_BASE}${version}.html`;
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new UserError(`Could not read the WhatsApp Web version list (HTTP ${response.status}).`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(
      `Could not reach the WhatsApp Web version list.\n${err.message}\n\n` +
        'Pin an exact version instead if you already know one.'
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Every archived page version, oldest first. Betas are excluded. */
export async function fetchVersions({ timeoutMs = 20000 } = {}) {
  const data = await getJson(INDEX_URL, timeoutMs);
  const versions = Array.isArray(data?.versions) ? data.versions : [];
  return versions
    .filter((entry) => entry && entry.version && !entry.beta)
    .map((entry) => ({
      version: entry.version,
      released: entry.released ?? null,
      expire: entry.expire ?? null,
    }));
}

/**
 * Turn a pin request into a concrete version.
 *
 * "oldest" is the useful default when the library has fallen behind: it is the
 * archived page closest to the era the library was written against. "latest"
 * is the newest archived page, which is rarely what fixes a breakage.
 */
export async function resolveWebVersion(spec, options = {}) {
  const wanted = String(spec ?? '').trim();
  if (!wanted) return null;
  if (wanted !== 'latest' && wanted !== 'oldest') return wanted;

  const versions = await fetchVersions(options);
  if (versions.length === 0) {
    throw new UserError('The WhatsApp Web version list came back empty.');
  }
  return wanted === 'latest' ? versions[versions.length - 1].version : versions[0].version;
}
