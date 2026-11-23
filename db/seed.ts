// Deterministic seed data (NFR-18, §13.4). Pure SQL with generate_series so 50,000 rows load in seconds.
// Each phase extends `fixture` with its own tables (ideas, insights, forum, boards).
import type { SqlRunner } from './migrate';

/** §13.4 base volumes for Core. `scale` = 10 builds the PT-16 10× fixture. */
export async function seedFixture(db: SqlRunner, scale = 1): Promise<{ companies: number; people: number }> {
  const companies = 5_000 * scale;
  const people = 50_000 * scale;
  await db.exec(`
    -- setseed makes random() repeatable, so every run builds the same fixture.
    SELECT setseed(0.42);
    INSERT INTO core_company (id, name, domain, arr, aliases)
    SELECT
      ('0190c3a0-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
      'Company ' || g,
      CASE WHEN g % 5 = 0 THEN NULL ELSE 'company' || g || '.test' END,
      CASE WHEN g % 7 = 0 THEN NULL ELSE round((random() * 500000)::numeric, 2) END,
      CASE WHEN g % 10 = 0 THEN ARRAY['co ' || g] ELSE '{}' END
    FROM generate_series(1, ${companies}) g
    ON CONFLICT DO NOTHING;

    INSERT INTO core_person (id, email, display_name, company_id, company_source)
    SELECT
      ('0190c3a1-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
      CASE WHEN g % 4 = 0 THEN NULL ELSE 'person' || g || '@company' || (1 + g % ${companies}) || '.test' END,
      'Person ' || g,
      ('0190c3a0-0000-7000-8000-' || lpad(to_hex(1 + g % ${companies}), 12, '0'))::uuid,
      'DOMAIN'
    FROM generate_series(1, ${people}) g
    ON CONFLICT DO NOTHING;

    INSERT INTO core_user (id, email, full_name, role, status)
    SELECT ('0190c3a2-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           'staff' || g || '@vendor.test', 'Staff ' || g,
           CASE WHEN g <= 2 THEN 'ADMIN' WHEN g <= 10 THEN 'PRODUCT' ELSE 'MEMBER' END, 'ACTIVE'
    FROM generate_series(1, 50) g
    ON CONFLICT DO NOTHING;
  `);
  return { companies, people };
}

export const DEMO_USER_EMAIL = 'demo@example.com';

/**
 * The shared demo account (DECISIONS OD-02): lives in the one live database, edits real data, never reset.
 * Adds only the account, so no sample records are mixed into the owner's data. Idempotent.
 */
export async function seedDemo(db: SqlRunner): Promise<void> {
  await db.exec(`
    INSERT INTO core_user (id, email, full_name, role, status)
    VALUES ('0190c3a2-0000-7000-8000-00000000d3e0', '${DEMO_USER_EMAIL}', 'Demo user', 'PRODUCT', 'ACTIVE')
    ON CONFLICT (email) DO UPDATE SET status = 'ACTIVE', role = 'PRODUCT';
  `);
}
