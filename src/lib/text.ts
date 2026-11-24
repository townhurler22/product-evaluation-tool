// SEC-13 sanitiser and SEC-15 link rule. One implementation for client and server.
// NOTE for the P1 merge: Feedback Hub needs the same functions; keep one copy (this file or P1's).

// C0/C1 controls except tab and newline; bidi overrides and isolates; zero-width characters.
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩​-‍﻿]/g;

/** Cleans text one person writes and another reads. Returns null for empty text. Never truncates. */
export function sanitizeText(input: string): string | null {
  const out = input
    .replace(/\r\n?/g, '\n')
    .replace(STRIP, '')
    .normalize('NFC')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length ? out : null;
}

export class TextTooLong extends Error {
  constructor(readonly max: number) { super(`Must be at most ${max} characters.`); }
}

/** Sanitises and enforces a maximum length; over-length text is rejected, never truncated (SEC-13). */
export function cleanText(input: string, max: number): string | null {
  const out = sanitizeText(input);
  if (out && out.length > max) throw new TextTooLong(max);
  return out;
}

/** SEC-15: http(s) only, no credentials, ≤ 2,000 characters. Returns the normalised URL or null. */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input || input.length > 2000) return null;
  let u: URL;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.toString();
}

export const SAFE_LINK_REL = 'noopener noreferrer nofollow ugc';
