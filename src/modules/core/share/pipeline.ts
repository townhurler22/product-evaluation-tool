// Share pipeline (SEC-06 to SEC-12). Anonymous visitors reach exactly one target through a token.
// Never reads the staff session (ARC-14). Every 404 on this path is byte-identical (SEC-07).
import { verify as argonVerify } from '@node-rs/argon2';
import { sql } from 'kysely';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/server/db';
import { newContext, runWithContext } from '@/server/context';
import { ApiError, toErrorBody } from '@/server/http/errors';
import { hit } from '../rate-limit';
import { clientIp, hashIp, newId, sha256 } from '../util';

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
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

const SHARE_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

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
        res = out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      } catch (e) {
        if (e instanceof ShareMiss) return shareNotFound();
        if (!(e instanceof ApiError)) console.error(JSON.stringify({ level: 'error', route: opts.route, requestId: ctx.requestId, err: String(e) }));
        const { status, body } = toErrorBody(e, ctx.requestId);
        res = NextResponse.json(body, { status });
      }
      for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v);
      res.headers.set('x-statement-count', String(ctx.statements));
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
  const link = (await sql<ShareLinkRow & { revoked_at: Date | null; expires_at: Date | null; max_uses: number | null; use_count: number }>`
    SELECT l.id, l.module, l.target_kind, l.target_id, l.capabilities, l.password_hash, l.created_by,
           l.revoked_at, l.expires_at, l.max_uses, l.use_count, u.status AS creator_status
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
    await hit(`share-pw:${link.id}:${ipHash ?? 'unknown'}`, 10, 900);
    if (!(await argonVerify(link.password_hash, given))) throw new ApiError('forbidden', 'Wrong password.');
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

  // 7. Non-VIEW: consume a use atomically before the handler runs.
  if (opts.capability !== 'VIEW') {
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
    capabilities: caps, ipHash,
  };
}
