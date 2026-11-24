// Fractional sort keys (§6.4 sort_key, COLLATE "C"). Base-62 digits in ASCII order, so byte order = key order.
// A key is a fraction's digits with no trailing '0'; a new key always fits strictly between two others.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`sort keys out of order: ${a} >= ${b}`);
  if (b) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (null = open end). */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? '', b);
}

/** `n` evenly spread ascending keys of fixed width (a fresh board, a template, an import). */
export function spreadKeys(n: number): string[] {
  let w = 1;
  while (62 ** w < n + 2) w++;
  const span = 62 ** w;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * span) / (n + 1));
    let s = '';
    for (let d = 0; d < w; d++) { s = DIGITS[v % 62] + s; v = Math.floor(v / 62); }
    out.push(s.replace(/0+$/, ''));
  }
  return out;
}

/** `n` ascending keys after `a` (append at the end of an order). */
export function keysAfter(a: string | null, n: number): string[] {
  if (!n) return [];
  const spread = spreadKeys(n);
  return a ? spread.map((k) => a + k) : spread;
}

export const isSortKey = (k: string) => /^[0-9A-Za-z]{1,64}$/.test(k) && !k.endsWith('0');
