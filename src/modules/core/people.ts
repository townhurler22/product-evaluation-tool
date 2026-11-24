// Companies and external people: domain rules shared by Feedback Hub management (FH-802) and intake (ING-23, ING-24).
// Core owns core_company and core_person; modules reach them through these functions (§11.4 `people.*`).
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@/server/db';
import { getSettings } from './settings';
import { newId, normaliseEmail } from './util';

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * FH-802: lower case; strip scheme, leading "@", path, query and port; must contain a dot. Returns null when what is
 * left is not a domain. Used for company domains and for the domain part of an email.
 */
export function normaliseDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.normalize('NFC').trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^@+/, '');
  d = d.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (d.includes('@')) d = d.slice(d.lastIndexOf('@') + 1);
  return d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

/** The domain of an email address, normalised, or null. */
export const emailDomain = (email: string | null | undefined): string | null =>
  email && email.includes('@') ? normaliseDomain(email.slice(email.lastIndexOf('@') + 1)) : null;

/** Case- and space-insensitive company name key (ING-23 step 3). */
export const companyNameKey = (name: string): string => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface IntakeResolutionInput {
  /** Candidate company domains in priority order: (a) the sent company domain, (b) the requester's email domain. */
  domains: (string | null | undefined)[];
  companyName: string | null;
  email: string | null;
  name: string | null;
  /** Set when the sender authenticated this person (support button): `ingest:<client name>` (ING-21). */
  vouchedBy?: string | null;
  /** call.type = internal: no company and no external person (OD-22 (a)). */
  internal?: boolean;
}

export interface IntakeResolution {
  companyId: string | null;
  personId: string | null;
  staffUserId: string | null;
  /** True when the requester's email is on the staff email domains list (ING-24). */
  isStaff: boolean;
  /** True when a prospect company was created for this request. */
  createdCompany: boolean;
}

/**
 * ING-23 and ING-24, inside the caller's transaction (ARC-05). Email domain before name; staff and public email
 * domains never identify a Client; an existing person keeps every field that is set and only empty ones are filled.
 * At most 4 statements: settings (cached 60 s), one lookup, a prospect company insert, a person upsert.
 */
export async function resolveForIntake(tx: Kysely<DB> | Transaction<DB>, input: IntakeResolutionInput): Promise<IntakeResolution> {
  const settings = await getSettings(tx);
  const staff = new Set(settings['intake.staff_domains'] ?? []);
  const publicDomains = new Set(settings['intake.public_email_domains'] ?? []);
  const email = input.email ? normaliseEmail(input.email) : null;
  const ownDomain = emailDomain(email);
  const isStaff = !!ownDomain && staff.has(ownDomain);

  const candidates = input.internal ? [] : [...new Set(input.domains.map((d) => normaliseDomain(d))
    .filter((d): d is string => !!d && !staff.has(d) && !publicDomains.has(d)))];
  const nameKey = !input.internal && input.companyName ? companyNameKey(input.companyName) : null;

  const { rows } = await sql<{ by_domain: string | null; by_name: string | null; staff_user: string | null }>`
    SELECT
      (SELECT c.id::text FROM core_company c WHERE c.domain = ANY(${candidates}::text[])
        ORDER BY array_position(${candidates}::text[], c.domain) LIMIT 1) AS by_domain,
      (SELECT c.id::text FROM core_company c
        WHERE ${nameKey}::text IS NOT NULL
          AND (regexp_replace(c.name_key, '[[:space:]]+', ' ', 'g') = ${nameKey}
               OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE regexp_replace(lower(btrim(a)), '[[:space:]]+', ' ', 'g') = ${nameKey}))
        ORDER BY c.created_at, c.id LIMIT 1) AS by_name,
      (SELECT u.id::text FROM core_user u WHERE u.email = ${email}::text AND (${isStaff} OR ${!!input.internal})) AS staff_user`.execute(tx);
  const found = rows[0];

  let companyId = found.by_domain ?? found.by_name ?? null;
  let createdCompany = false;
  if (!companyId && nameKey && input.companyName) {
    // Step 4: a prospect, with domain (a) when it was sent and no company claims it (none did, or step 2 had matched).
    const sentDomain = normaliseDomain(input.domains[0]);
    const domain = sentDomain && candidates.includes(sentDomain) ? sentDomain : null;
    const id = newId();
    const ins = await sql<{ id: string }>`
      INSERT INTO core_company (id, name, domain, prospect_at) VALUES (${id}, ${input.companyName.trim().slice(0, 200)}, ${domain}, now())
      ON CONFLICT (domain) DO UPDATE SET updated_at = core_company.updated_at RETURNING id::text`.execute(tx);
    companyId = ins.rows[0].id;
    createdCompany = companyId === id;
  }

  let personId: string | null = null;
  if (email && !isStaff && !input.internal) {
    const vouched = input.vouchedBy ?? null;
    const res = await sql<{ id: string }>`
      INSERT INTO core_person (id, email, display_name, company_id, company_source, verified_at, verified_by, last_seen_at)
      VALUES (${newId()}, ${email}, ${input.name?.slice(0, 200) ?? null}, ${companyId}, ${companyId ? 'INTAKE' : null},
              ${vouched ? sql`now()` : null}, ${vouched}, now())
      ON CONFLICT (email) DO UPDATE SET
        display_name   = COALESCE(core_person.display_name, EXCLUDED.display_name),
        company_id     = COALESCE(core_person.company_id, EXCLUDED.company_id),
        company_source = CASE WHEN core_person.company_id IS NULL AND EXCLUDED.company_id IS NOT NULL THEN 'INTAKE' ELSE core_person.company_source END,
        verified_at    = COALESCE(core_person.verified_at, EXCLUDED.verified_at),
        verified_by    = CASE WHEN core_person.verified_at IS NULL THEN EXCLUDED.verified_by ELSE core_person.verified_by END,
        last_seen_at   = now()
      RETURNING id::text`.execute(tx);
    personId = res.rows[0].id;
  }

  return { companyId: input.internal ? null : companyId, personId, staffUserId: found.staff_user, isStaff, createdCompany };
}
