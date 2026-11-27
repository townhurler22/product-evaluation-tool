// Feedback Hub intake routes (§10.5–10.7): call requests from the transcript agent and support button submissions.
// The gateway (Core) authenticates, writes the receipt and opens the transaction; these handlers write the idea.
// One transaction per accepted request (ING-22), ≤ 14 statements including the receipt insert.
import { sql } from 'kysely';
import { z } from 'zod';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import {
  discardUploads, enqueue, insertFileRows, newId, prepareUpload, registerIntakeRoute, resolveForIntake,
  type IntakeClient, type PreparedFile,
} from '@/modules/core/service';
import { CALL_TYPES, stripPageUrl, type IntakeMeta } from './intake-meta';
import { drainSoon, publishIdeas } from './live';
import { rowById } from './rows';
import { safeUrl, sanitise } from './text';
import type { Db } from './store';
import type { IdeaType } from './domain';

// ── schemas (ING-17, ING-20): strict, sanitised before the length check, never truncated ──────────────────
const text = (min: number, max: number) => z.string().max(max * 2)
  .transform((s) => sanitise(s) ?? '')
  .refine((s) => s.length >= min && s.length <= max, { message: 'length' });
const optText = (max: number) => z.string().max(max * 2).nullable().optional()
  .transform((s) => sanitise(s ?? null))
  .refine((s) => s === null || s.length <= max, { message: 'length' });
const email = z.string().max(320).transform((s) => s.trim().toLowerCase())
  .refine((s) => s.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), { message: 'email' });
const bareDomain = z.string().max(253).transform((s) => s.trim().toLowerCase())
  .refine((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s), { message: 'domain' });
const httpsLink = z.string().max(2000).refine((s) => safeUrl(s)?.startsWith('https://') ?? false, { message: 'https' });
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const CallRequestSchema = z.strictObject({
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  type: z.enum(['feature_request', 'improvement', 'bug']),
  title: text(1, 200),
  details: optText(5_000),
  quote: text(1, 5_000),
  quoteVerified: z.boolean(),
  requester: z.strictObject({ name: text(1, 120), email: email.nullable().optional() }).nullable().optional(),
  company: z.strictObject({ name: text(1, 120), domain: bareDomain.nullable().optional() }).nullable().optional(),
  call: z.strictObject({
    transcriptId: text(1, 64),
    title: optText(300),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), { message: 'date' }).nullable().optional(),
    type: z.enum(CALL_TYPES),
    timeInCall: z.string().regex(/^\d{1,2}:[0-5]\d:[0-5]\d$/),
    link: httpsLink.nullable().optional(),
  }),
});
export type CallRequest = z.infer<typeof CallRequestSchema>;

export const SupportSubmissionSchema = z.strictObject({
  type: z.enum(['feature_request', 'bug', 'question']),
  title: text(1, 200),
  details: optText(5_000),
  submitter: z.strictObject({ email, name: optText(120), externalUserId: optText(64) }),
  company: z.strictObject({ name: text(1, 200), externalAccountId: optText(64) }).nullable().optional(),
  context: z.strictObject({ module: optText(50), page: optText(500), appVersion: optText(50) }).nullable().optional(),
  attachments: z.array(z.strictObject({
    fileName: text(1, 200),
    contentType: z.enum(IMAGE_TYPES),
    dataBase64: z.string().max(3 * 1024 * 1024).regex(BASE64),
  })).max(3).optional(),
});
export type SupportSubmission = z.infer<typeof SupportSubmissionSchema>;

export const ATTACHMENTS_TOTAL_CAP = 2 * 1024 * 1024; // decoded bytes (ING-20)

// ── shared write path (ING-22) ───────────────────────────────────────────────────────────────────────────
interface IntakeIdea {
  ideaId: string;
  insightId: string;
  ideaType: IdeaType;
  title: string;
  description: string | null;
  insight: { value: string; source: 'CALL' | 'SUPPORT_BUTTON'; url: string | null; meta: IntakeMeta };
  resolve: Parameters<typeof resolveForIntake>[1];
  files: PreparedFile[];
}

/** Intake keys are unique per client: two clients may reuse a request key (ING-16). */
export const intakeKey = (client: IntakeClient, requestKey: string) => `${client.clientId}:${requestKey}`;

async function writeIntakeIdea(tx: Db, client: IntakeClient, requestKey: string, x: IntakeIdea) {
  const key = intakeKey(client, requestKey);
  // ING-16: the second line of defence. An insight with this key means the idea exists (or was handled); write nothing.
  const seen = await sql<{ n: number }>`SELECT count(*)::int AS n FROM fh_insight WHERE intake_key = ${key}`.execute(tx);
  if (seen.rows[0].n) return { duplicate: true };

  const who = await resolveForIntake(tx, x.resolve);
  const isBug = x.ideaType === 'BUG';
  const label = `Intake: ${client.clientName}`;
  await tx.insertInto('fh_idea').values({
    id: x.ideaId, title: x.title, description: x.description, idea_type: x.ideaType,
    status: isBug ? null : 'OPEN', bug_status: isBug ? 'OPEN' : null,
    reviewed_at: null, owner_id: null, created_by: null, feature_id: null, // Unreviewed, unowned (FH-401)
  }).execute();
  // INV-02 history and the "Created by Intake: <client>" activity row, in one statement.
  await sql`
    WITH s AS (INSERT INTO fh_status_change (id, idea_id, from_status, to_status, actor_id)
               VALUES (${newId()}, ${x.ideaId}, NULL, ${isBug ? 'BUG_OPEN' : 'IDEA_OPEN'}, NULL))
    INSERT INTO fh_idea_event (id, idea_id, actor_id, actor_label, field, from_value, to_value)
    VALUES (${newId()}, ${x.ideaId}, NULL, ${label}, 'created', NULL, ${`Created by ${label}`})`.execute(tx);

  const meta: IntakeMeta = { ...x.insight.meta };
  if (!who.personId && !who.staffUserId && x.resolve.name) meta.requesterName = x.resolve.name.slice(0, 120);
  const ins = await sql<{ id: string }>`
    INSERT INTO fh_insight (id, idea_id, value, source, source_ref, person_id, company_id, staff_user_id, priority, url, meta, intake_key)
    VALUES (${x.insightId}, ${x.ideaId}, ${x.insight.value}, ${x.insight.source}, ${key}, ${who.personId}, ${who.companyId},
            ${who.staffUserId}, 'MEDIUM', ${x.insight.url}, ${JSON.stringify(meta)}::jsonb, ${key})
    ON CONFLICT (intake_key) DO NOTHING RETURNING id`.execute(tx);
  if (!ins.rows.length) {
    // A unique-index hit is treated like the check above (ING-16): undo the idea, keep the receipt.
    await sql`DELETE FROM fh_idea WHERE id = ${x.ideaId}::uuid`.execute(tx);
    return { duplicate: true };
  }
  // INV-13: naming a company or person implies the "who asked" rows. One statement.
  if (who.companyId || who.personId) {
    await sql`
      WITH c AS (INSERT INTO fh_idea_company (idea_id, company_id)
                 SELECT ${x.ideaId}::uuid, ${who.companyId}::uuid WHERE ${who.companyId}::uuid IS NOT NULL ON CONFLICT DO NOTHING)
      INSERT INTO fh_idea_person (idea_id, person_id)
      SELECT ${x.ideaId}::uuid, ${who.personId}::uuid WHERE ${who.personId}::uuid IS NOT NULL ON CONFLICT DO NOTHING`.execute(tx);
  }
  await insertFileRows(tx, x.files);
  await sql`SELECT fh_rollup_refresh(ARRAY[${x.ideaId}::uuid])`.execute(tx);
  await enqueue('fh.match.compute', { ideaId: x.ideaId }, { dedupeKey: `fh.match:${x.ideaId}` }, tx);
  return {
    afterCommit: async () => { // publish idea.upserted, then let matching run (ING-22 "after commit")
      publishIdeas([await rowById(getDb(), x.ideaId)]);
      drainSoon();
    },
  };
}

// ── call requests (ING-17, ING-18, ING-24) ─────────────────────────────────────────────────────────────
const CALL_IDEA_TYPE: Record<CallRequest['type'], IdeaType> = { feature_request: 'FEATURE_REQUEST', improvement: 'IMPROVEMENT', bug: 'BUG' };

registerIntakeRoute('fh', 'call-requests', {
  bodyCap: 64 * 1024,
  schema: CallRequestSchema,
  handler: async ({ tx, client, requestKey, body }) => {
    if (body.requestKey !== undefined && body.requestKey !== requestKey) {
      throw new ApiError('body_invalid', 'The body does not match the schema.', { issues: ['requestKey: mismatch'] });
    }
    const internal = body.call.type === 'internal';
    return writeIntakeIdea(tx, client, requestKey, {
      ideaId: newId(), insightId: newId(), ideaType: CALL_IDEA_TYPE[body.type], title: body.title, description: body.details,
      insight: {
        value: body.quote, source: 'CALL', url: body.call.link ?? null,
        meta: {
          v: 1,
          call: {
            transcriptId: body.call.transcriptId, title: body.call.title, date: body.call.date ?? null, type: body.call.type,
            timeInCall: body.call.timeInCall, link: body.call.link ?? null,
          },
          quoteVerified: body.quoteVerified,
        },
      },
      // A call requester's email is not vouched for (ING-18). Internal calls: no company, staff credited (OD-22 (a)).
      resolve: {
        domains: [body.company?.domain ?? null, body.requester?.email?.split('@')[1] ?? null],
        companyName: body.company?.name ?? null, email: body.requester?.email ?? null, name: body.requester?.name ?? null,
        internal,
      },
      files: [],
    });
  },
});

// ── support submissions (ING-20, ING-21, ING-25) ────────────────────────────────────────────────────────
const SUPPORT_IDEA_TYPE: Record<SupportSubmission['type'], IdeaType> = { feature_request: 'FEATURE_REQUEST', bug: 'BUG', question: 'QUESTION' };

interface SupportPrepared { ideaId: string; insightId: string; files: PreparedFile[]; attachments: IntakeMeta['attachments'] }

registerIntakeRoute<typeof SupportSubmissionSchema, SupportPrepared>('fh', 'support-submissions', {
  bodyCap: 3 * 1024 * 1024,
  schema: SupportSubmissionSchema,
  // ING-25: decode and check every attachment, then store each before any row is written.
  prepare: async ({ body }) => {
    const ideaId = newId(), insightId = newId();
    const decoded = (body.attachments ?? []).map((a) => ({ ...a, bytes: Buffer.from(a.dataBase64, 'base64') }));
    if (decoded.reduce((n, a) => n + a.bytes.length, 0) > ATTACHMENTS_TOTAL_CAP) {
      throw new ApiError('too_large', 'Attachments total more than 2 MiB.');
    }
    const files: PreparedFile[] = [];
    try {
      for (const a of decoded) {
        files.push(await prepareUpload({
          module: 'fh', ownerKind: 'insight', ownerId: insightId, bytes: a.bytes, declaredType: a.contentType,
          originalName: a.fileName, createdBy: null, maxBytes: ATTACHMENTS_TOTAL_CAP,
        }));
      }
    } catch (e) {
      await discardUploads(files);
      if (e instanceof ApiError && e.code === 'unsupported_type') {
        const mismatch = e.details?.reason === 'file_type_mismatch';
        throw new ApiError(mismatch ? 'file_type_mismatch' : 'file_type_not_allowed',
          mismatch ? 'An attachment does not match its declared type.' : 'Attachments must be PNG, JPEG or WebP images.');
      }
      throw e; // files_unavailable answers 503 before any row is written; the sender retries
    }
    return {
      ideaId, insightId, files,
      attachments: files.map((f) => ({ fileId: f.id, name: f.original_name ?? 'Screenshot', contentType: f.content_type, size: f.size_bytes })),
    };
  },
  discard: async (p) => { await discardUploads(p.files); },
  handler: async ({ tx, client, requestKey, body, prepared }) => {
    const meta: IntakeMeta = { v: 1 };
    if (body.context) {
      meta.context = { module: body.context.module, page: stripPageUrl(body.context.page), appVersion: body.context.appVersion };
    }
    if (body.submitter.externalUserId) meta.externalUserId = body.submitter.externalUserId;
    if (body.company?.externalAccountId) meta.externalAccountId = body.company.externalAccountId;
    if (prepared.attachments?.length) meta.attachments = prepared.attachments;
    return writeIntakeIdea(tx, client, requestKey, {
      ideaId: prepared.ideaId, insightId: prepared.insightId, ideaType: SUPPORT_IDEA_TYPE[body.type],
      title: body.title, description: body.details,
      insight: { value: body.details ?? body.title, source: 'SUPPORT_BUTTON', url: null, meta },
      // The core product authenticated this user, so the email is vouched for (ING-21). Domain from the email only.
      resolve: {
        domains: [body.submitter.email.split('@')[1] ?? null], companyName: body.company?.name ?? null,
        email: body.submitter.email, name: body.submitter.name, vouchedBy: `ingest:${client.clientName}`,
      },
      files: prepared.files,
    });
  },
});
