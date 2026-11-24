// Intake evidence stored in fh_insight.meta (ING-18, ING-21, ING-27). Versioned on write; read back through a
// defensive reader that drops wrong shapes and any link that is not http(s). Pure: shared by server and browser.
import { safeUrl } from './text';

export const CALL_TYPES = ['prospect', 'client_interview', 'feedback_session', 'internal'] as const;
export type CallType = (typeof CALL_TYPES)[number];
export const CALL_TYPE_LABEL: Record<CallType, string> = {
  prospect: 'Prospect call', client_interview: 'Client interview', feedback_session: 'Feedback session', internal: 'Internal call',
};

export interface CallMeta {
  transcriptId: string; title: string | null; date: string | null; type: CallType; timeInCall: string; link: string | null;
}
export interface AttachmentMeta { fileId: string; name: string; contentType: string; size: number }
export interface IntakeMeta {
  v: 1;
  call?: CallMeta;
  quoteVerified?: boolean;
  /** A requester with a name but no person row (ING-23, ING-24). Removed on erasure. */
  requesterName?: string;
  context?: { module: string | null; page: string | null; appVersion: string | null };
  externalUserId?: string;
  externalAccountId?: string;
  attachments?: AttachmentMeta[];
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ING-27: anything unexpected is dropped, never rendered. Returns null when nothing usable remains. */
export function readIntakeMeta(raw: unknown): IntakeMeta | null {
  const m = obj(raw);
  if (!m) return null;
  const out: IntakeMeta = { v: 1 };
  const c = obj(m.call);
  const type = str(c?.type, 40) as CallType | null;
  if (c && type && (CALL_TYPES as readonly string[]).includes(type)) {
    const link = str(c.link, 2000);
    out.call = {
      transcriptId: str(c.transcriptId, 64) ?? '', title: str(c.title, 300), date: str(c.date, 10), type,
      timeInCall: str(c.timeInCall, 8) ?? '', link: link ? safeUrl(link) : null,
    };
  }
  if (typeof m.quoteVerified === 'boolean') out.quoteVerified = m.quoteVerified;
  const rn = str(m.requesterName, 120);
  if (rn) out.requesterName = rn;
  const ctx = obj(m.context);
  if (ctx) out.context = { module: str(ctx.module, 50), page: str(ctx.page, 500), appVersion: str(ctx.appVersion, 50) };
  const eu = str(m.externalUserId, 64);
  if (eu) out.externalUserId = eu;
  const ea = str(m.externalAccountId, 64);
  if (ea) out.externalAccountId = ea;
  if (Array.isArray(m.attachments)) {
    const atts = m.attachments.slice(0, 3).map(obj).filter((a): a is Record<string, unknown> => !!a)
      .filter((a) => typeof a.fileId === 'string' && UUID_RE.test(a.fileId))
      .map((a) => ({ fileId: a.fileId as string, name: str(a.name, 200) ?? 'Screenshot', contentType: str(a.contentType, 40) ?? '', size: typeof a.size === 'number' ? a.size : 0 }));
    if (atts.length) out.attachments = atts;
  }
  return Object.keys(out).length > 1 ? out : null;
}

/** ING-21: a product page URL keeps its origin and path; query and fragment can carry tokens or personal data. */
export function stripPageUrl(page: string | null): string | null {
  if (!page) return null;
  try {
    const u = new URL(page);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return page.split(/[?#]/)[0] || null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return page.split(/[?#]/)[0] || null; // a route name such as "/projects/12" is kept as it is
  }
}
