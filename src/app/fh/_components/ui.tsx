'use client';

// Small shared UI pieces: buttons, status pill, dialog with focus trap, markdown renderer, chips.
import { useEffect, useRef, type ReactNode } from 'react';
import { parseMarkdown, type Span } from '@/modules/fh/text';
import { statusLabel, type StatusKey } from '@/modules/fh/domain';

export const btn = 'inline-flex min-h-6 items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-sm font-medium hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--accent-fg)]';
export const btnPrimary = 'inline-flex min-h-6 items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-sm font-semibold text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50';
export const input = 'rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm';

// FH-309 pill colours, with text labels so colour never carries meaning alone (NFR-05).
const PILL: Record<string, string> = {
  IDEA_OPEN: 'bg-gray-200 text-gray-900', IDEA_BACKLOG: 'bg-gray-400 text-gray-950', IDEA_UNDER_REVIEW: 'bg-orange-200 text-orange-950',
  IDEA_PLANNED: 'bg-purple-800 text-white', IDEA_IN_PROGRESS: 'bg-purple-300 text-purple-950', IDEA_COMPLETE: 'bg-pink-200 text-pink-950',
  IDEA_CLOSED: 'bg-gray-700 text-white', BUG_OPEN: 'bg-gray-200 text-gray-900', BUG_TRIAGED: 'bg-gray-300 text-gray-900',
  BUG_IN_DEV: 'bg-purple-300 text-purple-950', BUG_FIXED: 'bg-pink-200 text-pink-950', BUG_RELEASED: 'bg-pink-300 text-pink-950',
  BUG_CANNOT_REPRODUCE: 'bg-gray-700 text-white', BUG_CLOSED: 'bg-gray-700 text-white',
};

export function StatusPill({ status }: { status: StatusKey | null }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${status ? PILL[status] : 'bg-red-100 text-red-900'}`}>
      {statusLabel(status)}
    </span>
  );
}

export function Chip({ children, colour, onRemove, removeLabel }: { children: ReactNode; colour?: string | null; onRemove?: () => void; removeLabel?: string }) {
  const safe = colour && /^#[0-9a-f]{6}$/.test(colour) ? colour : null; // SEC-16
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
      {safe && <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: safe }} />}
      <span className="truncate">{children}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? 'Remove'} className="-mr-1 grid h-6 w-6 place-items-center rounded-full hover:bg-[var(--hover)]">×</button>
      )}
    </span>
  );
}

/** Modal dialog: traps focus and returns it to the opener (NFR-06). */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    // Start in the first field, not on the Close button.
    (el.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={`max-h-[90vh] w-full overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded hover:bg-[var(--hover)]">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.t) {
          case 'text': return <span key={i}>{s.v}</span>;
          case 'b': return <strong key={i}><Spans spans={s.c} /></strong>;
          case 'i': return <em key={i}><Spans spans={s.c} /></em>;
          case 'code': return <code key={i} className="rounded bg-[var(--hover)] px-1">{s.v}</code>;
          case 'link': return <a key={i} href={s.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-[var(--accent)] underline">{s.v}</a>;
        }
      })}
    </>
  );
}

/** SEC-14: limited Markdown rendered as React elements, never as HTML. */
export function Markdown({ text }: { text: string | null }) {
  const blocks = parseMarkdown(text);
  if (!blocks.length) return null;
  return (
    <div className="space-y-2 whitespace-pre-wrap break-words text-sm">
      {blocks.map((b, i) => b.t === 'p'
        ? <p key={i}><Spans spans={b.c} /></p>
        : <ul key={i} className="list-disc pl-5">{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</ul>)}
    </div>
  );
}

export const money = (amount: string, currency: string) => {
  const n = Number(amount);
  if (!n) return '–'; // FH-221: no ARR
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n); }
  catch { return `${Math.round(n).toLocaleString('en-GB')} ${currency}`; }
};

export const shortDate = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
