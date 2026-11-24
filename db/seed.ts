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

const uid = (prefix: string, expr: string) => `('${prefix}-0000-7000-8000-' || lpad(to_hex(${expr}), 12, '0'))::uuid`;

/**
 * §13.4 Feedback Hub fixture on top of `seedFixture` (same scale): 50,000 ideas (10% bugs, 5% merged tombstones),
 * 250,000 insights, 500 Features over three levels, 200 Journeys, 100 themes, 50 milestones, one main forum with
 * 300 posts and 20,000 votes. Deterministic. Roll-ups are built by the same function the write paths use.
 * Never load this into the live database (DECISIONS OD-02).
 */
export async function seedFeedbackHubFixture(db: SqlRunner, scale = 1) {
  const n = (x: number) => Math.max(1, Math.round(x * scale));
  const companies = n(5_000), people = n(50_000), staff = 50;
  const f0 = n(20), f1 = n(80), f2 = n(400), features = f0 + f1 + f2;
  const ideas = Math.max(40, n(50_000)), insights = n(250_000), journeys = n(200), themes = n(100), milestones = n(50);
  const posts = n(300), votes = Math.min(n(20_000), posts * people);
  await db.exec(`
    SELECT setseed(0.43);
    INSERT INTO fh_feature (id, parent_id, name, depth, sort_order)
    SELECT ${uid('0190c3a4', 'g')},
      CASE WHEN g <= ${f0} THEN NULL
           WHEN g <= ${f0 + f1} THEN ${uid('0190c3a4', `1 + (g - ${f0} - 1) % ${f0}`)}
           ELSE ${uid('0190c3a4', `${f0} + 1 + (g - ${f0 + f1} - 1) % ${f1}`)} END,
      'Feature ' || g, CASE WHEN g <= ${f0} THEN 0 WHEN g <= ${f0 + f1} THEN 1 ELSE 2 END, g
    FROM generate_series(1, ${features}) g;
    INSERT INTO fh_feature_closure (ancestor_id, descendant_id, distance)
    WITH RECURSIVE tree AS (
      SELECT id AS ancestor_id, id AS descendant_id, 0 AS distance FROM fh_feature
      UNION ALL SELECT t.ancestor_id, f.id, t.distance + 1 FROM tree t JOIN fh_feature f ON f.parent_id = t.descendant_id)
    SELECT ancestor_id, descendant_id, distance FROM tree;
    INSERT INTO fh_feature_demand (feature_id) SELECT id FROM fh_feature;

    INSERT INTO fh_journey (id, name, sort_order, synced_at)
    SELECT ${uid('0190c3a7', 'g')}, 'Journey ' || g, g, now() - g * interval '1 hour' FROM generate_series(1, ${journeys}) g;
    INSERT INTO fh_theme (id, name, colour)
    SELECT ${uid('0190c3a8', 'g')}, 'Theme ' || g, '#' || lpad(to_hex((g * 2654435) % 16777216), 6, '0') FROM generate_series(1, ${themes}) g;
    INSERT INTO fh_milestone (id, name, date)
    SELECT ${uid('0190c3a9', 'g')}, 'Milestone ' || g, DATE '2026-01-05' + g * 14 FROM generate_series(1, ${milestones}) g;

    -- Ideas: every 10th a bug; every 20th merged into the one before it (which is live); every 15th unreviewed.
    INSERT INTO fh_idea (id, title, description, idea_type, status, bug_status, feature_id, milestone_id, owner_id,
                         merged_into_id, start_date, due_date, estimate_days, strategic_value, revenue_impact,
                         customer_experience, risk_score, effort_score, is_dealbreaker, is_committed, reviewed_at, created_at, updated_at)
    SELECT ${uid('0190c3a5', 'g')},
      (ARRAY['Export','Import','Faster','Dark mode for','Bulk edit','Filter','Share','Audit'])[1 + g % 8] || ' ' ||
        (ARRAY['reports','dashboards','projects','tasks','users','invoices','schedules','boards'])[1 + (g / 8) % 8] || ' ' || g,
      CASE WHEN g % 3 = 0 THEN 'Clients asked for this in calls. Ref ' || g END,
      CASE WHEN g % 10 = 0 THEN 'BUG' ELSE (ARRAY['FEATURE_REQUEST','IMPROVEMENT','INITIATIVE','QUESTION'])[1 + g % 4] END,
      CASE WHEN g % 10 = 0 THEN NULL ELSE (ARRAY['OPEN','BACKLOG','UNDER_REVIEW','PLANNED','IN_PROGRESS','COMPLETE','CLOSED'])[1 + (g / 10) % 7] END,
      CASE WHEN g % 10 = 0 THEN (ARRAY['OPEN','TRIAGED','IN_DEV','FIXED','RELEASED','CANNOT_REPRODUCE','CLOSED'])[1 + (g / 10) % 7] END,
      CASE WHEN g % 9 = 0 THEN NULL ELSE ${uid('0190c3a4', `1 + g % ${features}`)} END,
      CASE WHEN g % 6 = 0 THEN ${uid('0190c3a9', `1 + g % ${milestones}`)} END,
      CASE WHEN g % 5 = 0 THEN NULL ELSE ${uid('0190c3a2', `1 + g % ${staff}`)} END,
      CASE WHEN g % 20 = 0 THEN ${uid('0190c3a5', 'g - 1')} END,
      CASE WHEN g % 2 = 0 THEN DATE '2026-01-01' + (g % 400) END,
      CASE WHEN g % 2 = 0 THEN DATE '2026-01-01' + (g % 400) + (g % 60) END,
      CASE WHEN g % 2 = 0 THEN g % 60 END,
      CASE WHEN g % 4 <> 0 THEN 1 + g % 10 END, CASE WHEN g % 4 <> 0 THEN 1 + (g / 3) % 10 END,
      CASE WHEN g % 4 <> 0 THEN 1 + (g / 5) % 10 END, CASE WHEN g % 4 <> 0 THEN 1 + (g / 7) % 10 END,
      CASE WHEN g % 4 <> 0 THEN 1 + (g / 11) % 10 END,
      g % 50 = 0,
      g % 10 <> 0 AND (g / 10) % 7 IN (3, 4) AND g % 4 = 0,
      CASE WHEN g % 15 = 0 THEN NULL ELSE now() END,
      now() - (g % 700) * interval '1 day' - (g % 1440) * interval '1 minute',
      now() - (g % 90) * interval '1 day' - (g % 1440) * interval '1 minute'
    FROM generate_series(1, ${ideas}) g;

    -- Evidence attaches to live ideas only (index 20k becomes 20k - 1).
    INSERT INTO fh_insight (id, idea_id, value, source, person_id, company_id, priority, intake_key)
    SELECT ${uid('0190c3a6', 'g')},
      ${uid('0190c3a5', `CASE WHEN (1 + g % ${ideas}) % 20 = 0 THEN g % ${ideas} ELSE 1 + g % ${ideas} END`)},
      'Client words ' || g,
      (ARRAY['CALL','SUPPORT_BUTTON','MANUAL','FORUM','MANUAL'])[1 + g % 5],
      CASE WHEN g % 4 = 0 THEN NULL ELSE ${uid('0190c3a1', `1 + g % ${people}`)} END,
      CASE WHEN g % 4 = 0 THEN ${uid('0190c3a0', `1 + g % ${companies}`)} END,
      (ARRAY['LOW','MEDIUM','MEDIUM','HIGH','DEALBREAKER'])[1 + g % 5],
      CASE WHEN g % 5 IN (0, 1) THEN 'fixture:' || g END
    FROM generate_series(1, ${insights}) g;
    INSERT INTO fh_idea_company (idea_id, company_id)
    SELECT DISTINCT i.idea_id, COALESCE(i.company_id, p.company_id) FROM fh_insight i LEFT JOIN core_person p ON p.id = i.person_id
    WHERE COALESCE(i.company_id, p.company_id) IS NOT NULL
    ON CONFLICT DO NOTHING;
    INSERT INTO fh_idea_person (idea_id, person_id)
    SELECT DISTINCT idea_id, person_id FROM fh_insight WHERE person_id IS NOT NULL ON CONFLICT DO NOTHING;
    INSERT INTO fh_idea_theme (idea_id, theme_id)
    SELECT ${uid('0190c3a5', 'g')}, ${uid('0190c3a8', `1 + g % ${themes}`)} FROM generate_series(1, ${ideas}) g WHERE g % 5 = 0 AND g % 20 <> 0;
    INSERT INTO fh_idea_journey (idea_id, journey_id)
    SELECT ${uid('0190c3a5', 'g')}, ${uid('0190c3a7', `1 + g % ${journeys}`)} FROM generate_series(1, ${ideas}) g WHERE g % 7 = 0 AND g % 20 <> 0;

    INSERT INTO fh_forum (id, name, slug, is_main) VALUES ('0190c3aa-0000-7000-8000-000000000001', 'Main forum', 'main', true);
    INSERT INTO fh_post (id, forum_id, title, author_person_id)
    SELECT ${uid('0190c3ab', 'g')}, '0190c3aa-0000-7000-8000-000000000001', 'Post ' || g, ${uid('0190c3a1', `1 + g % ${people}`)}
    FROM generate_series(1, ${posts}) g;
    INSERT INTO fh_vote (id, post_id, person_id)
    SELECT ${uid('0190c3ac', 'g + 1')}, ${uid('0190c3ab', `1 + g % ${posts}`)}, ${uid('0190c3a1', `1 + (g / ${posts}) % ${people}`)}
    FROM generate_series(0, ${votes - 1}) g;
    UPDATE fh_post p SET vote_count = (SELECT count(*) FROM fh_vote v WHERE v.post_id = p.id);
    INSERT INTO fh_idea_post (idea_id, post_id)
    SELECT ${uid('0190c3a5', `CASE WHEN (g * 7) % 20 = 0 THEN g * 7 - 1 ELSE g * 7 END`)}, ${uid('0190c3ab', 'g')}
    FROM generate_series(1, LEAST(${posts}, ${Math.floor(ideas / 7)})) g;

    SELECT fh_rollup_refresh(ARRAY(SELECT id FROM fh_idea));
  `);
  return { ideas, insights, features, journeys, themes, milestones, posts, votes };
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
