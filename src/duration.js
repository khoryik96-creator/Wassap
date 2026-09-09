/**
 * Duration and date parsing/formatting.
 *
 * Filters accept either a duration ago ("30d", "2w", "1d12h") or an absolute
 * date ("2026-01-15", "2026-01-15T09:30"). Both resolve to an epoch-ms instant.
 */

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

// Longest units first so "mo" wins over "m".
const TOKEN_RE = /(\d+(?:\.\d+)?)\s*(mo|ms|[smhdwy])/gi;

/**
 * Parse a duration string into milliseconds.
 * Accepts compound forms: "1d12h", "2w 3d", "90m".
 * Returns null if the string is not a duration.
 */
export function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;

  // A bare number is interpreted as days — the unit people mean most often here.
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * UNIT_MS.d;

  let total = 0;
  let matched = false;
  let consumed = 0;

  TOKEN_RE.lastIndex = 0;
  for (const m of str.matchAll(TOKEN_RE)) {
    const value = Number(m[1]);
    let unit = m[2];
    if (unit === 'ms') continue; // not a filter unit; reject below via consumed check
    if (!(unit in UNIT_MS)) continue;
    total += value * UNIT_MS[unit];
    matched = true;
    consumed += m[0].length;
  }

  if (!matched) return null;
  // Reject strings with meaningful leftovers ("2026-01-15" would part-match otherwise).
  const stripped = str.replace(/[\s,]/g, '');
  if (consumed < stripped.length) return null;
  return total;
}

/**
 * Resolve a --since/--until value to an epoch-ms instant.
 * Durations are interpreted as "that long before `now`".
 * Throws on unparseable input so the CLI can report it clearly.
 */
export function resolveInstant(input, now = Date.now()) {
  if (input == null) return null;
  const str = String(input).trim();
  if (!str) return null;

  const lower = str.toLowerCase();
  if (lower === 'now' || lower === 'today') return now;

  const dur = parseDuration(str);
  if (dur !== null) return now - dur;

  const ts = Date.parse(str);
  if (!Number.isNaN(ts)) return ts;

  throw new Error(
    `Cannot read "${input}" as a date or duration. ` +
      `Use a duration like 30d, 2w, 1d12h, or a date like 2026-01-15.`
  );
}

/**
 * Human-readable duration: "12d 4h", "3h 20m", "45m", "just now".
 * Shows at most two units, largest first.
 */
export function humanizeDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 0) ms = 0;
  if (ms < 60 * 1000) return 'just now';

  const units = [
    ['y', UNIT_MS.y],
    ['mo', UNIT_MS.mo],
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
  ];

  const parts = [];
  let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || 'just now';
}

/** Short local date, e.g. "Sep 02" — or "Sep 02 2025" when not the current year. */
export function formatDate(ms, now = Date.now()) {
  if (!ms) return '—';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = String(d.getDate()).padStart(2, '0');
  return sameYear ? `${month} ${day}` : `${month} ${day} ${d.getFullYear()}`;
}

/** Full ISO-ish timestamp for JSON/CSV/HTML detail views. */
export function formatIso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}
