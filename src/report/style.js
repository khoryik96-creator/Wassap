/** Minimal ANSI helpers plus grapheme-aware display width. */

const ESC = String.fromCharCode(27);

const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

const wrap = (open, close) => (s) =>
  enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s);

export const colorEnabled = enabled;
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);

const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

// Characters that occupy two terminal cells: CJK blocks, fullwidth forms, emoji.
const WIDE_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]|[\u{1F004}-\u{1F0CF}]|[\u{20000}-\u{3FFFD}]/u;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Terminal cell width of a string, ignoring ANSI escapes. */
export function displayWidth(input) {
  const text = stripAnsi(input ?? '');
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const code = segment.codePointAt(0);
    if (code === 0x200d) continue; // zero-width joiner inside emoji sequences
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue; // control chars
    width += WIDE_RE.test(segment) ? 2 : 1;
  }
  return width;
}

/** Truncate to `max` cells, appending an ellipsis when clipped. */
export function truncate(input, max) {
  const text = String(input ?? '');
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return max <= 0 ? '' : '…';

  let out = '';
  let width = 0;
  for (const { segment } of segmenter.segment(stripAnsi(text))) {
    const w = WIDE_RE.test(segment) ? 2 : 1;
    if (width + w > max - 1) break;
    out += segment;
    width += w;
  }
  return out + '…';
}

/** Pad to `width` cells. `align` is 'left' or 'right'. */
export function pad(input, width, align = 'left') {
  const text = String(input ?? '');
  const gap = Math.max(0, width - displayWidth(text));
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}
