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
  await seedBoardsFixture(db, scale);
  return { companies, people };
}

/**
 * §13.4 Journey Boards part: 100 top-level boards; the largest has 2,000 nodes and 2,000 edges; one board has
 * 40 Product cards, each with a 50-card detailed journey. Owned by fixture staff user 1. Never loaded into the live DB.
 */
export async function seedBoardsFixture(db: SqlRunner, scale = 1) {
  const boards = Math.max(2, Math.round(100 * scale));
  const large = Math.max(20, Math.round(2000 * scale));
  const products = Math.max(2, Math.round(40 * scale));
  const journeyCards = Math.max(5, Math.round(50 * scale));
  const owner = `'0190c3a2-0000-7000-8000-000000000001'::uuid`;
  const boardId = (expr: string) => `('0190c3a3-0000-7000-8000-' || lpad(to_hex(${expr}), 12, '0'))`;
  const journeyId = (expr: string) => `('0190c3a4-0000-7000-8000-' || lpad(to_hex(${expr}), 12, '0'))`;
  const status = `'[{"id":"not-assessed","label":"Not assessed","colour":"gray"},{"id":"redesign","label":"Redesign planned","colour":"amber"},{"id":"current","label":"Current design","colour":"green"},{"id":"legacy","label":"Legacy","colour":"violet"},{"id":"deprecated","label":"Deprecated","colour":"rose"}]'::jsonb`;
  const card = (title: string) => `jsonb_build_object('title', ${title}, 'owner', 'Owner ' || (i % 7), 'area', 'Area ' || (i % 5),
    'fieldValues', jsonb_build_object('status', (ARRAY['not-assessed','redesign','current','legacy','deprecated'])[1 + i % 5]))`;
  await db.exec(`
    INSERT INTO jb_board (id, name, owner_id, live_node_count, live_edge_count, live_field_count, workspace_can_edit)
    SELECT ${boardId('g')}, 'Fixture board ' || g, ${owner},
           CASE WHEN g = 1 THEN ${large} WHEN g = 2 THEN ${products} ELSE 20 END, CASE WHEN g = 1 THEN ${large} ELSE 0 END, 1, g % 3 = 0
    FROM generate_series(1, ${boards}) g ON CONFLICT DO NOTHING;

    INSERT INTO jb_board (id, name, owner_id, journey_of_board_id, journey_of_node_id, live_node_count, live_field_count)
    SELECT ${journeyId('k')}, 'Journey ' || k, ${owner}, ${boardId('2')}, 'p' || k, ${journeyCards}, 1
    FROM generate_series(1, ${products}) k ON CONFLICT DO NOTHING;

    INSERT INTO jb_field (board_id, id, kind, label, options, show_on_card, sort_key, preset_key, last_seq)
    SELECT id, 'status', 'picker', 'Design status', ${status}, true, 'V', 'status', 0 FROM jb_board
    WHERE id LIKE '0190c3a3-%' OR id LIKE '0190c3a4-%' ON CONFLICT DO NOTHING;

    -- Largest board: ${large} Design cards in a grid and ${large} connectors.
    INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
    SELECT ${boardId('1')}, 'n' || i, 'design-card', (i % 50) * 300, (i / 50) * 200, 'k' || lpad(to_hex(i), 5, '0') || 'V', ${card(`'Card ' || i`)}, 0
    FROM generate_series(1, ${large}) i ON CONFLICT DO NOTHING;
    INSERT INTO jb_edge (board_id, id, source_id, target_id, sort_key, data, last_seq)
    SELECT ${boardId('1')}, 'e' || i, 'n' || i, 'n' || (i % ${large} + 1), 'k' || lpad(to_hex(i), 5, '0') || 'V', '{}', 0
    FROM generate_series(1, ${large}) i ON CONFLICT DO NOTHING;

    -- Demand board: Product cards, each owning a detailed journey of Design cards.
    INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
    SELECT ${boardId('2')}, 'p' || i, 'product-card', (i % 8) * 300, (i / 8) * 200, 'k' || lpad(to_hex(i), 5, '0') || 'V',
           jsonb_build_object('title', 'Product ' || i, 'journeyStage', 'Stage ' || (i % 4)), 0
    FROM generate_series(1, ${products}) i ON CONFLICT DO NOTHING;
    INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
    SELECT ${journeyId('k')}, 'n' || i, 'design-card', (i % 10) * 300, (i / 10) * 200, 'k' || lpad(to_hex(i), 5, '0') || 'V', ${card(`'Step ' || i`)}, 0
    FROM generate_series(1, ${products}) k, generate_series(1, ${journeyCards}) i ON CONFLICT DO NOTHING;

    -- Every other top-level board: 20 cards.
    INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
    SELECT ${boardId('g')}, 'n' || i, 'design-card', (i % 5) * 300, (i / 5) * 200, 'k' || lpad(to_hex(i), 5, '0') || 'V', ${card(`'Card ' || i`)}, 0
    FROM generate_series(3, ${boards}) g, generate_series(1, 20) i ON CONFLICT DO NOTHING;
  `);
  return { boards, large, products, journeyCards };
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
