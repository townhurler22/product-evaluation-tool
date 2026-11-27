// Request schemas shared by Feedback Hub routes. Text passes the one sanitiser (SEC-13) before its length is
// checked, and over-length text is rejected, never truncated.
import { z } from 'zod';
import { Uuid } from './columns';
import { BULK_CHUNK, IDEA_TYPES, INSIGHT_PRIORITIES, STATUS_KEYS } from './domain';
import { sanitise } from './text';

/** Required sanitised text, 1..max characters after sanitising. */
export const reqText = (max: number, label = 'This field') => z.string().max(max * 2)
  .transform((s) => sanitise(s) ?? '')
  .refine((s) => s.length > 0, { message: `${label} is required.` })
  .refine((s) => s.length <= max, { message: `${label} must be at most ${max.toLocaleString('en-GB')} characters.` });

/** Optional sanitised text: empty becomes null. */
export const optText = (max: number, label = 'This field') => z.string().max(max * 2).nullable()
  .transform((s) => sanitise(s))
  .refine((s) => s === null || s.length <= max, { message: `${label} must be at most ${max.toLocaleString('en-GB')} characters.` });

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a real date');
export const Score = z.number().int().min(1).max(10).nullable();
export const IdeaTypeSchema = z.enum(IDEA_TYPES);
export const StatusKeySchema = z.enum(STATUS_KEYS as [string, ...string[]]);
export const BaseVersion = z.number().int().min(1).optional();
export const BulkIds = z.array(Uuid).min(1).max(BULK_CHUNK);

export const CreateIdeaBody = z.strictObject({
  title: reqText(200, 'Title'),
  ideaType: IdeaTypeSchema.optional(),
  featureId: Uuid.nullish(),
  description: optText(10_000, 'Description').optional(),
});

export const PatchIdeaBody = z.strictObject({
  baseVersion: BaseVersion,
  title: reqText(200, 'Title').optional(),
  description: optText(10_000, 'Description').optional(),
  ownerId: Uuid.nullable().optional(),
  featureId: Uuid.nullable().optional(),
  milestoneId: Uuid.nullable().optional(),
  startDate: DateStr.nullable().optional(),
  dueDate: DateStr.nullable().optional(),
  estimateDays: z.number().int().min(0).max(3650).nullable().optional(),
  strategicValue: Score.optional(),
  revenueImpact: Score.optional(),
  customerExperience: Score.optional(),
  riskScore: Score.optional(),
  effortScore: Score.optional(),
  isDealbreaker: z.boolean().optional(),
  isCommitted: z.boolean().optional(),
  publicSummary: optText(5_000, 'Public summary').optional(),
});
export type PatchIdea = z.infer<typeof PatchIdeaBody>;

export const StatusBody = z.strictObject({
  status: StatusKeySchema,
  comment: optText(500, 'Comment').optional(),
  baseVersion: BaseVersion,
});
export const TypeBody = z.strictObject({ ideaType: IdeaTypeSchema, baseVersion: BaseVersion });
export const DatesBody = z.strictObject({ startDate: DateStr, dueDate: DateStr, baseVersion: BaseVersion });
export const SetBody = (max: number) => z.strictObject({ ids: z.array(Uuid).max(max), baseVersion: BaseVersion });

export const InsightBody = z.strictObject({
  value: reqText(5_000, 'Insight'),
  companyId: Uuid.nullish(),
  personId: Uuid.nullish(),
  priority: z.enum(INSIGHT_PRIORITIES).optional(),
  url: z.string().max(2000).nullish(),
  // FH-501: a client cannot claim another source. Accepted only to refuse it explicitly.
  source: z.literal('MANUAL').optional(),
});

export const MergeBody = z.strictObject({ targetId: Uuid });
export const DeleteBody = z.strictObject({ ids: BulkIds });
export const BulkAcceptBody = z.strictObject({ ids: BulkIds });
export const BulkStatusBody = z.strictObject({ ids: BulkIds, status: StatusKeySchema, comment: optText(500, 'Comment').optional() });
export const BulkThemesBody = z.strictObject({ ids: BulkIds, themeId: Uuid, action: z.enum(['add', 'remove']) });
export const AssignMilestoneBody = z.strictObject({ ids: BulkIds, milestoneId: Uuid.nullable() });
export const CommentBody = z.strictObject({ body: reqText(2_000, 'Comment') });

// ── companies and people (§7.14) ──
const Arr = z.union([z.string().max(40), z.number()]).nullable();
const Aliases = z.array(reqText(200, 'Alias')).max(20);
export const CreateCompanyBody = z.strictObject({
  name: reqText(200, 'Name'), domain: z.string().max(300).nullish(), arr: Arr.optional(), aliases: Aliases.optional(),
});
export const PatchCompanyBody = z.strictObject({
  name: reqText(200, 'Name').optional(), domain: z.string().max(300).nullable().optional(), arr: Arr.optional(), aliases: Aliases.optional(),
});
export const DeleteCompaniesBody = z.strictObject({ ids: z.array(Uuid).min(1).max(100) });
export const CreatePersonBody = z.strictObject({
  displayName: optText(200, 'Name').optional(),
  email: z.string().trim().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email.').nullish(),
  companyId: Uuid.nullish(),
});
export const PatchPersonBody = z.strictObject({ displayName: optText(200, 'Name').optional(), companyId: Uuid.nullable().optional() });
export const EraseBody = z.strictObject({
  ids: z.array(Uuid).min(1).max(100),
  confirm: z.literal('ERASE', { message: 'Type ERASE to confirm.' }),
});
