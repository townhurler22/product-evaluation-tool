// Share pipeline (SEC-06 to SEC-12). Anonymous visitors reach exactly one target through a token.
// Never reads the staff session (ARC-14). Every 404 on this path is byte-identical (SEC-07).
import { verify as argonVerify } from '@node-rs/argon2';
import { sql } from 'kysely';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/server/db';
import { newContext, runWithContext } from '@/server/context';
import { ApiError, toErrorBody } from '@/server/http/errors';
import { STATEMENT_BUDGETS } from '@/server/http/budgets';
import { hit } from '../rate-limit';
import { clientIp, hashIp, newId, randomToken, sha256 } from '../util';

export type Capability = 'VIEW' | 'SUBMIT' | 'VOTE';
export type ShareModule = 'fh' | 'jb';

export interface ShareLinkRow {
  id: string; module: ShareModule; target_kind: 'forum' | 'board'; target_id: string; capabilities: Capability[];
  password_hash: string | null; created_by: string; creator_status: string;
}

export interface ResolvedTarget { targetId: string; grant: Capability[]; journeyIds?: string[] }

/** Module-supplied resolver. Must fail closed: return null when anything is off (SEC-08). */
export type ShareResolver = (link: ShareLinkRow) => Promise<ResolvedTarget | null>;

const resolvers = new Map<ShareModule, ShareResolver>();
export function registerShareResolver(module: ShareModule, r: ShareResolver) { resolvers.set(module, r); }

export interface ShareContext {
  linkId: string;
  module: ShareModule;
  targetId: string;
  journeyIds: string[];
  capabilities: Capability[];
  ipHash: string | null;
  /** SHA-256 of the visitor cookie, if the browser sent one (SEC-11). Never the cookie itself. */
  visitorCookieHash: string | null;
  /** The visitor's `core_person`, looked up before a write on routes that declare `identity` (SEC-07 step 7). */
  visitorPersonId: string | null;
}

// ── Visitor cookie (SEC-11): 32 random bytes, stored only as SHA-256, scoped to the share API, set on first write. ──
export const VISITOR_COOKIE = 'pet_visitor';
const VISITOR_RE = /^[A-Za-z0-9_-]{43}$/;

export function readVisitorCookieHash(req: NextRequest): string | null {
  const v = req.cookies.get(VISITOR_COOKIE)?.value;
  return v && VISITOR_RE.test(v) ? sha256(v) : null;
}

/** A new visitor token and the Set-Cookie value that stores it in the browser. The caller stores only the hash. */
export function newVisitorCookie(): { token: string; hash: string; header: string } {
  const token = randomToken();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return {
    token, hash: sha256(token),
    header: `${VISITOR_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/api/share/; Max-Age=31536000`,
  };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const PW_ATTEMPTS = 10, PW_WINDOW_S = 900; // SEC-07 step 4

const SHARE_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** SEC-07: a wrong method answers the same 404. Export it as every method a share route file does not handle. */
export const shareWrongMethod = async (): Promise<Response> => shareNotFound();

const NOT_FOUND_BODY = JSON.stringify({ code: 'not_found', message: 'Not found.' });

/** The one 404 for every failure on the share path. Same bytes, same headers, every time. */
export function shareNotFound(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404, headers: { 'Content-Type': 'application/json', ...SHARE_HEADERS } });
}

class ShareMiss extends Error {}
const miss = () => new ShareMiss();

// Per-IP read brake: 240 per minute per instance (SEC-27).
const reads = new Map<string, { minute: number; count: number }>();
function readBrake(ip: string): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const e = reads.get(ip);
  if (!e || e.minute !== minute) { reads.set(ip, { minute, count: 1 }); if (reads.size > 50_000) reads.clear(); return true; }
  return ++e.count <= 240;
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const expected = process.env.APP_ORIGIN || new URL(req.url).origin;
  if (origin) return origin === expected;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

interface ShareRouteOptions {
  module: ShareModule;
  /** Exactly one required capability per route (SEC-09). */
  capability: Capability;
  route: string;
  /**
   * SEC-07 step 7 / SEC-27: per-IP and per-visitor limits for a non-VIEW route, checked before a use is spent.
   * `[limit, windowSeconds]`; counters are shared (`core_rate_window`).
   */
  limits?: { key: string; perIp: [number, number]; perIdentity?: [number, number] };
  /** Look up the visitor's person from the cookie before the limits (one statement when a cookie is present). */
  identity?: boolean;
  /**
   * A read that needs a non-VIEW capability (forum `similar` needs SUBMIT): the capability is checked, but no use is
   * spent and no write limits apply, so typing a title cannot use up a link (DECISIONS P3).
   */
  readOnly?: boolean;
}

type ShareHandler = (args: { req: NextRequest; share: ShareContext; params: Record<string, string> }) => Promise<unknown>;

export function shareRoute(opts: ShareRouteOptions, handler: ShareHandler) {
  if (!opts.capability) throw new Error(`share route ${opts.route} must declare one capability`);
  return async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const ctx = newContext(opts.route);
    return runWithContext(ctx, async () => {
      let res: Response;
      try {
        const p = await params;
        const share = await resolve(req, opts, p.token ?? '');
        const out = await handler({ req, share, params: p });
        // A handler's 404 (record outside the target, INV-15) is the same bytes as a missing link (SEC-07).
        if (out instanceof Response && out.status === 404) return shareNotFound();
        res = out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      } catch (e) {
        if (e instanceof ShareMiss || (e instanceof ApiError && e.code === 'not_found')) return shareNotFound();
        if (!(e instanceof ApiError)) console.error(JSON.stringify({ level: 'error', route: opts.route, requestId: ctx.requestId, err: String(e) }));
        const { status, body } = toErrorBody(e, ctx.requestId);
        res = NextResponse.json(body, { status });
        const retryAfter = e instanceof ApiError ? e.details?.retryAfter : undefined;
        if (status === 429 && typeof retryAfter === 'number') res.headers.set('Retry-After', String(Math.max(1, retryAfter))); // SEC-27
      }
      for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v);
      res.headers.set('x-statement-count', String(ctx.statements));
      const budget = (STATEMENT_BUDGETS as Record<string, number>)[opts.route];
      if (budget !== undefined) res.headers.set('x-statement-budget', String(budget)); // NFR-21, as on staff routes
      return res;
    });
  };
}

async function resolve(req: NextRequest, opts: ShareRouteOptions, token: string): Promise<ShareContext> {
  const ip = clientIp(req);
  const ipHash = hashIp(ip);

  // CSRF for state-changing share requests (SEC-04).
  if (req.method !== 'GET' && !sameOrigin(req)) throw new ApiError('forbidden', 'Cross-site request refused.');

  // 1. Read brake.
  if (!readBrake(ip ?? 'unknown')) throw new ApiError('rate_limited', 'Too many requests.', { retryAfter: 60 });

  // 2. Token shape, hash, lookup. Missing, revoked, expired or used up → 404.
  if (!TOKEN_RE.test(token)) throw miss();
  // The password-failure counter for this IP and link is read in the same statement (only failures count).
  const pwWindow = new Date(Math.floor(Date.now() / (PW_WINDOW_S * 1000)) * PW_WINDOW_S * 1000);
  const link = (await sql<ShareLinkRow & { revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; use_count: number; pw_failures: number | null }>`
    SELECT l.id, l.module, l.target_kind, l.target_id, l.capabilities, l.password_hash, l.created_by,
           l.revoked_at, l.expires_at, l.max_uses, l.use_count, u.status AS creator_status,
           (SELECT w.count FROM core_rate_window w
             WHERE w.key = 'share-pw:' || l.id::text || ':' || ${ipHash ?? 'unknown'}::text AND w.window_start = ${pwWindow}) AS pw_failures
    FROM core_share_link l JOIN core_user u ON u.id = l.created_by
    WHERE l.token_hash = ${sha256(token)}`.execute(getDb())).rows[0];
  if (!link || link.revoked_at || (link.expires_at && link.expires_at <= new Date())
      || (link.max_uses !== null && link.use_count >= link.max_uses)) throw miss();

  // 3. Module must match the route table's module.
  if (link.module !== opts.module) throw miss();

  // 4. Password (Argon2id). None → 401, wrong → 403, 10 tries / 15 min per IP and link → 429.
  if (link.password_hash) {
    const given = req.headers.get('x-share-password');
    if (!given) throw new ApiError('unauthenticated', 'This link needs a password.');
    if ((link.pw_failures ?? 0) >= PW_ATTEMPTS) {
      const retryAfter = Math.ceil((pwWindow.getTime() + PW_WINDOW_S * 1000 - Date.now()) / 1000);
      throw new ApiError('rate_limited', 'Too many requests. Try again shortly.', { retryAfter });
    }
    if (!(await argonVerify(link.password_hash, given))) {
      // Only wrong passwords count toward the 10 per 15 minutes; a visitor who knows it can keep using the forum.
      await hit(`share-pw:${link.id}:${ipHash ?? 'unknown'}`, PW_ATTEMPTS, PW_WINDOW_S);
      throw new ApiError('forbidden', 'Wrong password.');
    }
  }

  // 5. Module resolver, failing closed.
  const resolver = resolvers.get(link.module);
  let target: ResolvedTarget | null = null;
  try { target = resolver ? await resolver(link) : null; } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'share resolver threw', module: link.module, err: String(e) }));
  }
  if (!target) throw miss();

  // 6. Required capability must be in (link capabilities ∩ resolver grant).
  const caps = link.capabilities.filter((c) => target!.grant.includes(c));
  if (!caps.includes(opts.capability)) throw miss();

  // 7. Non-VIEW: per-IP and per-identity limits, then consume a use atomically before the handler runs.
  const visitorCookieHash = readVisitorCookieHash(req);
  let visitorPersonId: string | null = null;
  const writes = opts.capability !== 'VIEW' && !opts.readOnly;
  if (writes && opts.identity && visitorCookieHash) {
    visitorPersonId = (await sql<{ id: string }>`SELECT id::text FROM core_person WHERE cookie_token_hash = ${visitorCookieHash}`
      .execute(getDb())).rows[0]?.id ?? null;
  }
  if (writes && opts.limits) {
    const l = opts.limits;
    await hit(`share:${l.key}:ip:${ipHash ?? 'unknown'}`, l.perIp[0], l.perIp[1]);
    if (l.perIdentity && visitorPersonId) await hit(`share:${l.key}:person:${visitorPersonId}`, l.perIdentity[0], l.perIdentity[1]);
  }
  if (writes) {
    const used = await sql`UPDATE core_share_link SET use_count = use_count + 1
      WHERE id = ${link.id} AND (max_uses IS NULL OR use_count < max_uses) RETURNING id`.execute(getDb());
    if (!used.rows.length) throw miss();
    await getDb().insertInto('core_share_link_use').values({
      id: newId(), share_link_id: link.id, capability: opts.capability, ip_hash: ipHash,
    }).execute();
  }

  // 8. Handler context.
  return {
    linkId: link.id, module: link.module, targetId: target.targetId, journeyIds: target.journeyIds ?? [],
    capabilities: caps, ipHash, visitorCookieHash, visitorPersonId,
  };
}
