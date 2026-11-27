-- 0005_fh_triage: Feedback Hub triage, intake, people and reporting (SPEC §7.7, 7.9, 7.14, 7.15, §10; P2).
-- Forward-only. Applied by scripts/migrate.ts, never by the app (ARC-35, NFR-41).

-- ── FH-405: "Company missing" ignores internal calls ────────────────────────
-- external_intake = at least one Call or Support button insight that is not from an internal call (OD-22 (a):
-- internal calls credit the staff member with no company, so they must never raise "Company missing").
ALTER TABLE fh_idea_rollup ADD COLUMN external_intake bool NOT NULL DEFAULT false;

-- The roll-up function gains one output column, so both functions are replaced (fh_rollup_refresh selects c.*).
DROP FUNCTION fh_rollup_refresh(uuid[]);
DROP FUNCTION fh_rollup_compute(uuid[]);

CREATE FUNCTION fh_rollup_compute(p_ids uuid[]) RETURNS TABLE (
  idea_id uuid, user_count int, company_count int, arr numeric(14,2), insight_count int,
  vote_total int, distinct_voters int, sources text[], has_intake_source bool, on_forum bool, external_intake bool
) LANGUAGE sql STABLE AS $$
  WITH ideas AS (SELECT id FROM fh_idea WHERE id = ANY(p_ids)),
  ev AS (
    -- (a) insights: person, and the insight's company else the person's company
    SELECT i.idea_id, i.person_id, COALESCE(i.company_id, p.company_id) AS company_id
      FROM fh_insight i LEFT JOIN core_person p ON p.id = i.person_id WHERE i.idea_id = ANY(p_ids)
    UNION ALL -- (b) votes on linked posts: the voter and the voter's company (staff votes have no person)
    SELECT ip.idea_id, v.person_id, p.company_id
      FROM fh_idea_post ip JOIN fh_vote v ON v.post_id = ip.post_id LEFT JOIN core_person p ON p.id = v.person_id
     WHERE ip.idea_id = ANY(p_ids)
    UNION ALL -- (c) direct company links
    SELECT ic.idea_id, NULL::uuid, ic.company_id FROM fh_idea_company ic WHERE ic.idea_id = ANY(p_ids)
    UNION ALL -- (d) direct person links
    SELECT ipp.idea_id, ipp.person_id, p.company_id
      FROM fh_idea_person ipp JOIN core_person p ON p.id = ipp.person_id WHERE ipp.idea_id = ANY(p_ids)
  ),
  ppl AS (SELECT ev.idea_id, count(DISTINCT ev.person_id)::int AS n FROM ev WHERE ev.person_id IS NOT NULL GROUP BY 1),
  cos AS ( -- INV-05: each distinct company's ARR counts once
    SELECT d.idea_id, count(*)::int AS n, COALESCE(sum(c.arr), 0)::numeric(14,2) AS arr
      FROM (SELECT DISTINCT ev.idea_id, ev.company_id FROM ev WHERE ev.company_id IS NOT NULL) d
      JOIN core_company c ON c.id = d.company_id GROUP BY 1),
  ins AS (
    SELECT fi.idea_id, count(*)::int AS n, array_agg(DISTINCT fi.source ORDER BY fi.source) AS srcs,
           bool_or(fi.source IN ('CALL','SUPPORT_BUTTON') AND COALESCE(fi.meta #>> '{call,type}', '') <> 'internal') AS ext
      FROM fh_insight fi WHERE fi.idea_id = ANY(p_ids) GROUP BY 1),
  vts AS (
    SELECT ip.idea_id, count(v.id)::int AS total,
           count(DISTINCT COALESCE('p' || v.person_id::text, 'u' || v.user_id::text))::int AS voters,
           true AS on_forum
      FROM fh_idea_post ip LEFT JOIN fh_vote v ON v.post_id = ip.post_id
     WHERE ip.idea_id = ANY(p_ids) GROUP BY 1)
  SELECT ideas.id,
         COALESCE(ppl.n, 0), COALESCE(cos.n, 0), COALESCE(cos.arr, 0)::numeric(14,2), COALESCE(ins.n, 0),
         COALESCE(vts.total, 0), COALESCE(vts.voters, 0), COALESCE(ins.srcs, '{}'),
         COALESCE(ins.srcs && ARRAY['CALL','SUPPORT_BUTTON'], false), COALESCE(vts.on_forum, false),
         COALESCE(ins.ext, false)
    FROM ideas
    LEFT JOIN ppl ON ppl.idea_id = ideas.id
    LEFT JOIN cos ON cos.idea_id = ideas.id
    LEFT JOIN ins ON ins.idea_id = ideas.id
    LEFT JOIN vts ON vts.idea_id = ideas.id
$$;

CREATE FUNCTION fh_rollup_refresh(p_ids uuid[]) RETURNS int LANGUAGE sql AS $$
  WITH up AS (
    INSERT INTO fh_idea_rollup AS r (idea_id, user_count, company_count, arr, insight_count, vote_total,
                                     distinct_voters, sources, has_intake_source, on_forum, external_intake, updated_at)
    SELECT c.*, now() FROM fh_rollup_compute(p_ids) c
    ON CONFLICT (idea_id) DO UPDATE SET
      user_count = EXCLUDED.user_count, company_count = EXCLUDED.company_count, arr = EXCLUDED.arr,
      insight_count = EXCLUDED.insight_count, vote_total = EXCLUDED.vote_total,
      distinct_voters = EXCLUDED.distinct_voters, sources = EXCLUDED.sources,
      has_intake_source = EXCLUDED.has_intake_source, on_forum = EXCLUDED.on_forum,
      external_intake = EXCLUDED.external_intake, updated_at = now()
    RETURNING 1)
  SELECT count(*)::int FROM up
$$;

-- Backfill: before P2 every intake insight was external (no internal calls could arrive).
UPDATE fh_idea_rollup SET external_intake = has_intake_source WHERE has_intake_source;

-- ── People and companies management (FH-801, FH-811): searchable lists ───────
-- Core-owned tables; the indexes arrive with the phase that searches them.
CREATE INDEX core_company_name_trgm_idx ON core_company USING gin (name_key gin_trgm_ops);
CREATE INDEX core_person_name_trgm_idx ON core_person USING gin (lower(display_name) gin_trgm_ops);
CREATE INDEX core_person_email_trgm_idx ON core_person USING gin (email gin_trgm_ops);
CREATE INDEX fh_insight_staff_idx ON fh_insight (staff_user_id) WHERE staff_user_id IS NOT NULL;

-- ── Reporting (FH-851 to FH-854, §4.11) ──────────────────────────────────────
-- One materialised view with three kinds of row, refreshed concurrently every 5 minutes by the fh.reporting.refresh
-- job. Keys are never NULL so the unique index covers every row (required for REFRESH ... CONCURRENTLY).
--   tile:        k1 in (total, completed, dealbreakers)
--   theme_week:  k1 = theme id, k2 = ISO week start (Monday, YYYY-MM-DD), last 26 weeks of idea creation
--   feature:     k1 = Feature id; n = open ideas under the Feature and its sub-features; amount = ARR of the distinct
--                companies who asked for them (company links, plus the companies of linked people)
CREATE MATERIALIZED VIEW fh_reporting_mv AS
WITH live AS (SELECT * FROM fh_idea WHERE merged_into_id IS NULL),
open_live AS (SELECT id, feature_id FROM live WHERE feature_id IS NOT NULL AND fh_is_open(status, bug_status)),
feat_ideas AS (
  SELECT c.ancestor_id, o.id AS idea_id FROM fh_feature_closure c JOIN open_live o ON o.feature_id = c.descendant_id),
idea_cos AS (
  SELECT idea_id, company_id FROM fh_idea_company
  UNION
  SELECT ip.idea_id, p.company_id FROM fh_idea_person ip JOIN core_person p ON p.id = ip.person_id WHERE p.company_id IS NOT NULL),
feat_cos AS (
  SELECT DISTINCT fi.ancestor_id, ic.company_id FROM feat_ideas fi JOIN idea_cos ic ON ic.idea_id = fi.idea_id),
feat_arr AS (
  SELECT fc.ancestor_id, COALESCE(sum(co.arr), 0)::numeric(14,2) AS arr
  FROM feat_cos fc JOIN core_company co ON co.id = fc.company_id GROUP BY 1)
SELECT 'tile'::text AS kind, 'total'::text AS k1, ''::text AS k2, count(*)::int AS n, NULL::numeric(14,2) AS amount, now() AS refreshed_at FROM live
UNION ALL
SELECT 'tile', 'completed', '', count(*) FILTER (WHERE status = 'COMPLETE' OR bug_status = 'RELEASED')::int, NULL, now() FROM live
UNION ALL
SELECT 'tile', 'dealbreakers', '',
  count(*) FILTER (WHERE is_dealbreaker OR EXISTS (SELECT 1 FROM fh_insight s WHERE s.idea_id = live.id AND s.priority = 'DEALBREAKER'))::int,
  NULL, now() FROM live
UNION ALL
SELECT 'theme_week', it.theme_id::text, to_char(date_trunc('week', l.created_at), 'YYYY-MM-DD'), count(*)::int, NULL, now()
FROM live l JOIN fh_idea_theme it ON it.idea_id = l.id
WHERE l.created_at >= date_trunc('week', now()) - interval '25 weeks'
GROUP BY it.theme_id, date_trunc('week', l.created_at)
UNION ALL
SELECT 'feature', fi.ancestor_id::text, '', count(DISTINCT fi.idea_id)::int, COALESCE(max(fa.arr), 0)::numeric(14,2), now()
FROM feat_ideas fi LEFT JOIN feat_arr fa ON fa.ancestor_id = fi.ancestor_id
GROUP BY fi.ancestor_id;

CREATE UNIQUE INDEX fh_reporting_mv_key ON fh_reporting_mv (kind, k1, k2);

-- Materialised views are not covered by row level security. On Supabase, keep it away from the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON fh_reporting_mv FROM anon, authenticated';
  END IF;
END $$;
