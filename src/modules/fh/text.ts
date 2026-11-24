// Sanitiser (SEC-13), limited Markdown parser (SEC-14), link rule (SEC-15) and CSV writer (SEC-18).
// Pure functions shared by client and server.

// C0/C1 controls except tab and newline; bidi overrides/isolates; zero-width characters.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩​-‍﻿]/g;

/** SEC-13. Returns null for empty text. Over-length is the caller's error, never truncated here. */
export function sanitise(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const out = input
    .replace(/\r\n?/g, '\n')
    .replace(STRIP, '')
    .normalize('NFC')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out === '' ? null : out;
}

/** SEC-15: http(s) only, no credentials, ≤ 2,000 characters. Returns the normalised URL or null. */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u.toString().length <= 2000 ? u.toString() : null;
  } catch {
    return null;
  }
}

// ── limited Markdown → span tree (SEC-14). Rendered as React elements; never as HTML. ───────────────
export type Span =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Span[] }
  | { t: 'i'; c: Span[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string };
export type Block = { t: 'p'; c: Span[] } | { t: 'ul'; items: Span[][] };

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;

export function parseInline(s: string): Span[] {
  const out: Span[] = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest[0] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (rest.startsWith('**')) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'b', c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if ((rest[0] === '*' || rest[0] === '_') && rest[1] && rest[1] !== ' ') {
      const end = s.indexOf(rest[0], i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'i', c: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    const m = /^https?:\/\//.test(rest) ? URL_RE.exec(rest) : null;
    if (m && m.index === 0) {
      const href = safeUrl(m[0]);
      flush();
      out.push(href ? { t: 'link', href, v: m[0] } : { t: 'text', v: m[0] });
      i += m[0].length;
      continue;
    }
    buf += s[i++];
  }
  flush();
  return out;
}

export function parseMarkdown(text: string | null): Block[] {
  if (!text) return [];
  const blocks: Block[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      blocks.push({ t: 'ul', items: lines.map((l) => parseInline(l.replace(/^\s*[-*]\s+/, ''))) });
    } else {
      blocks.push({ t: 'p', c: parseInline(lines.join('\n')) });
    }
  }
  return blocks;
}

// ── CSV (FH-157, SEC-18) ────────────────────────────────────────────────────
const FORMULA_START = /^[=+\-@\t\r]/;

/** Text cells that could be read as a formula get a leading single quote. Numbers are never prefixed. */
export function csvCell(v: string | number | boolean | null | undefined, numeric = false): string {
  if (v === null || v === undefined || v === '') return '';
  let s = String(v);
  if (!numeric && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: string[]) => cells.join(',') + '\r\n';
export const CSV_BOM = '﻿';
