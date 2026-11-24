-- 0003_fh_core: Feedback Hub core tables (SPEC §6.3, P1).
-- Forward-only. Applied by scripts/migrate.ts, never by the app (ARC-35, NFR-41).
-- Forum, post, vote and idea-post tables are created here because the roll-up definition (FH-504) and merge
-- (FH-452) read and move them; the forum write paths arrive in P3. fh_status_config, fh_vote_event and
-- fh_reporting_mv arrive with the phases that read and write them (D-37).

-- ── grants (ARC-13) ────────────────────────────────────────────────────────
CREATE TABLE fh_grant (
  user_id          uuid PRIMARY KEY REFERENCES core_user(id) ON DELETE CASCADE,
  role             text NULL CHECK (role IN ('ADMIN')),
  can_delete_posts bool NOT NULL DEFAULT false,
  granted_by       uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fh_grant_touch BEFORE UPDATE ON fh_grant FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

-- ── Features (tree, closure, direct demand) ────────────────────────────────
CREATE TABLE fh_feature (
  id          uuid PRIMARY KEY,
  parent_id   uuid NULL REFERENCES fh_feature(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NULL CHECK (char_length(description) <= 1000),
  depth       smallint NOT NULL CHECK (depth BETWEEN 0 AND 2),
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX fh_feature_parent_idx ON fh_feature (parent_id, sort_order, name);
CREATE UNIQUE INDEX fh_feature_sibling_name_idx
  ON fh_feature (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE TRIGGER fh_feature_touch BEFORE UPDATE ON fh_feature FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

-- INV-09: depth = parent depth + 1. Deferred to commit so a subtree move can update every row in one statement.
CREATE FUNCTION fh_feature_depth_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected smallint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fh_feature WHERE id = NEW.id) THEN RETURN NULL; END IF; -- deleted since
  SELECT COALESCE((SELECT f.depth + 1 FROM fh_feature f JOIN fh_feature c ON c.parent_id = f.id WHERE c.id = NEW.id), 0)
    INTO expected;
  IF (SELECT depth FROM fh_feature WHERE id = NEW.id) <> expected THEN
    RAISE EXCEPTION 'fh_feature % depth must equal parent depth + 1', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fh_feature_depth AFTER INSERT OR UPDATE OF parent_id, depth ON fh_feature
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fh_feature_depth_check();

CREATE TABLE fh_feature_closure (
  ancestor_id   uuid NOT NULL REFERENCES fh_feature(id) ON DELETE CASCADE,
  descendant_id uuid NOT NULL REFERENCES fh_feature(id) ON DELETE CASCADE,
  distance      smallint NOT NULL CHECK (distance BETWEEN 0 AND 2),
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX fh_feature_closure_desc_idx ON fh_feature_closure (descendant_id);

CREATE TABLE fh_feature_demand (
  feature_id uuid PRIMARY KEY REFERENCES fh_feature(id) ON DELETE CASCADE,
  open_count int NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  all_count  int NOT NULL DEFAULT 0 CHECK (all_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Journeys (read-only here; filled by the Journey sync in P5) ────────────
CREATE TABLE fh_journey (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  name_key    text GENERATED ALWAYS AS (lower(btrim(name))) STORED UNIQUE, -- INV-23
  description text NULL,
  sort_order  int NOT NULL DEFAULT 0,
  synced_at   timestamptz NULL,
  synced_by   uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fh_journey_touch BEFORE UPDATE ON fh_journey FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

-- ── Themes and milestones ──────────────────────────────────────────────────
CREATE TABLE fh_theme (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  name_key   text GENERATED ALWAYS AS (lower(btrim(name))) STORED UNIQUE,
  colour     text NULL CHECK (colour ~ '^#[0-9a-f]{6}$'),
  is_seeded  bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fh_theme_touch BEFORE UPDATE ON fh_theme FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();
-- FH-704: seeded at install, amber, internal only.
INSERT INTO fh_theme (id, name, colour, is_seeded)
VALUES ('0190c3a0-0000-7000-8000-0000000000a1', 'UX required', '#f59e0b', true);

CREATE TABLE fh_milestone (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  date        date NOT NULL,
  colour      text NULL CHECK (colour ~ '^#[0-9a-f]{6}$'),
  description text NULL CHECK (char_length(description) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_milestone_date_idx ON fh_milestone (date, name);
CREATE TRIGGER fh_milestone_touch BEFORE UPDATE ON fh_milestone FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

-- ── Ideas ──────────────────────────────────────────────────────────────────
CREATE TABLE fh_idea (
  id                  uuid PRIMARY KEY,
  number              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description         text NULL CHECK (char_length(description) <= 10000),
  idea_type           text NOT NULL DEFAULT 'FEATURE_REQUEST'
                        CHECK (idea_type IN ('FEATURE_REQUEST','IMPROVEMENT','INITIATIVE','BUG','QUESTION')),
  status              text NULL CHECK (status IN ('OPEN','BACKLOG','UNDER_REVIEW','PLANNED','IN_PROGRESS','COMPLETE','CLOSED')),
  bug_status          text NULL CHECK (bug_status IN ('OPEN','TRIAGED','IN_DEV','FIXED','RELEASED','CANNOT_REPRODUCE','CLOSED')),
  feature_id          uuid NULL REFERENCES fh_feature(id) ON DELETE SET NULL,
  milestone_id        uuid NULL REFERENCES fh_milestone(id) ON DELETE SET NULL,
  owner_id            uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  -- Deleting a merge target deletes its tombstones too (a SET NULL would bring them back to life; DECISIONS).
  merged_into_id      uuid NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  start_date          date NULL,
  due_date            date NULL,
  estimate_days       int NULL CHECK (estimate_days BETWEEN 0 AND 3650),
  strategic_value     smallint NULL CHECK (strategic_value BETWEEN 1 AND 10),
  revenue_impact      smallint NULL CHECK (revenue_impact BETWEEN 1 AND 10),
  customer_experience smallint NULL CHECK (customer_experience BETWEEN 1 AND 10),
  risk_score          smallint NULL CHECK (risk_score BETWEEN 1 AND 10),
  effort_score        smallint NULL CHECK (effort_score BETWEEN 1 AND 10),
  is_dealbreaker      bool NOT NULL DEFAULT false,
  is_committed        bool NOT NULL DEFAULT false,
  reviewed_at         timestamptz NULL DEFAULT now(),
  public_summary      text NULL CHECK (char_length(public_summary) <= 5000),
  created_by          uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  version             int NOT NULL DEFAULT 1,
  search_tsv          tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', title), 'A') ||
                        setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  -- INV-01 status shape
  CHECK ((idea_type = 'BUG' AND bug_status IS NOT NULL AND status IS NULL)
      OR (idea_type <> 'BUG' AND status IS NOT NULL AND bug_status IS NULL)),
  -- INV-24
  CHECK (NOT is_committed OR coalesce(status, bug_status) <> 'OPEN')
);
-- Partial on live ideas: tombstones are excluded everywhere (INV-11).
CREATE INDEX fh_idea_status_idx      ON fh_idea (status, updated_at DESC, id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_bug_status_idx  ON fh_idea (bug_status, updated_at DESC, id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_feature_idx     ON fh_idea (feature_id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_owner_idx       ON fh_idea (owner_id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_milestone_idx   ON fh_idea (milestone_id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_window_idx      ON fh_idea (start_date, due_date) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_updated_idx     ON fh_idea (updated_at DESC, id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_created_idx     ON fh_idea (created_at DESC, id) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_unreviewed_idx  ON fh_idea (reviewed_at) WHERE reviewed_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX fh_idea_tsv_idx         ON fh_idea USING gin (search_tsv) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_title_trgm_idx  ON fh_idea USING gin (title gin_trgm_ops) WHERE merged_into_id IS NULL;
CREATE INDEX fh_idea_inflight_idx    ON fh_idea (feature_id, due_date DESC)
  WHERE merged_into_id IS NULL AND (status IN ('PLANNED','IN_PROGRESS') OR bug_status = 'IN_DEV');
CREATE INDEX fh_idea_merged_idx      ON fh_idea (merged_into_id);

-- Open demand (§5.2): ideas not Complete or Closed; bugs not Released, Closed or Cannot reproduce.
CREATE FUNCTION fh_is_open(p_status text, p_bug_status text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_status IS NOT NULL THEN p_status NOT IN ('COMPLETE','CLOSED')
              ELSE coalesce(p_bug_status NOT IN ('RELEASED','CLOSED','CANNOT_REPRODUCE'), false) END
$$;

-- §4.11: per-Feature direct demand, maintained in the same transaction as every idea write that can move it
-- (create, delete, merge, Feature change, status change, type change). A trigger means no write path can forget.
CREATE FUNCTION fh_feature_demand_track() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.feature_id IS NOT NULL AND OLD.merged_into_id IS NULL THEN
    UPDATE fh_feature_demand
       SET open_count = open_count - fh_is_open(OLD.status, OLD.bug_status)::int, all_count = all_count - 1, updated_at = now()
     WHERE feature_id = OLD.feature_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.feature_id IS NOT NULL AND NEW.merged_into_id IS NULL THEN
    UPDATE fh_feature_demand
       SET open_count = open_count + fh_is_open(NEW.status, NEW.bug_status)::int, all_count = all_count + 1, updated_at = now()
     WHERE feature_id = NEW.feature_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fh_idea_demand_ins AFTER INSERT ON fh_idea FOR EACH ROW EXECUTE FUNCTION fh_feature_demand_track();
CREATE TRIGGER fh_idea_demand_del AFTER DELETE ON fh_idea FOR EACH ROW EXECUTE FUNCTION fh_feature_demand_track();
CREATE TRIGGER fh_idea_demand_upd AFTER UPDATE OF feature_id, status, bug_status, merged_into_id ON fh_idea
  FOR EACH ROW WHEN (OLD.feature_id IS DISTINCT FROM NEW.feature_id OR OLD.status IS DISTINCT FROM NEW.status
                  OR OLD.bug_status IS DISTINCT FROM NEW.bug_status OR OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id)
  EXECUTE FUNCTION fh_feature_demand_track();

CREATE TABLE fh_idea_journey (
  idea_id    uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES fh_journey(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, journey_id)
);
CREATE INDEX fh_idea_journey_journey_idx ON fh_idea_journey (journey_id);

CREATE TABLE fh_idea_theme (
  idea_id  uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  theme_id uuid NOT NULL REFERENCES fh_theme(id) ON DELETE CASCADE,
  PRIMARY KEY (idea_id, theme_id)
);
CREATE INDEX fh_idea_theme_theme_idx ON fh_idea_theme (theme_id);

CREATE TABLE fh_idea_rollup (
  idea_id           uuid PRIMARY KEY REFERENCES fh_idea(id) ON DELETE CASCADE,
  user_count        int NOT NULL DEFAULT 0,
  company_count     int NOT NULL DEFAULT 0,
  arr               numeric(14,2) NOT NULL DEFAULT 0,
  insight_count     int NOT NULL DEFAULT 0,
  vote_total        int NOT NULL DEFAULT 0,
  distinct_voters   int NOT NULL DEFAULT 0,
  sources           text[] NOT NULL DEFAULT '{}',
  has_intake_source bool NOT NULL DEFAULT false,
  on_forum          bool NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_idea_rollup_arr_idx ON fh_idea_rollup (arr DESC);
CREATE INDEX fh_idea_rollup_users_idx ON fh_idea_rollup (user_count DESC);
CREATE INDEX fh_idea_rollup_companies_idx ON fh_idea_rollup (company_count);
CREATE INDEX fh_idea_rollup_sources_idx ON fh_idea_rollup USING gin (sources);

-- Append-only history (INV-02) and field activity.
CREATE TABLE fh_status_change (
  id          uuid PRIMARY KEY,
  idea_id     uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  from_status text NULL,
  to_status   text NOT NULL,
  actor_id    uuid NULL,
  comment     text NULL CHECK (char_length(comment) <= 500),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_status_change_idea_idx ON fh_status_change (idea_id, changed_at DESC);

CREATE TABLE fh_idea_event (
  id          uuid PRIMARY KEY,
  idea_id     uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  actor_id    uuid NULL,
  actor_label text NULL,
  field       text NOT NULL,
  from_value  text NULL,
  to_value    text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_idea_event_idea_idx ON fh_idea_event (idea_id, created_at DESC);

CREATE TABLE fh_comment (
  id         uuid PRIMARY KEY,
  idea_id    uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  author_id  uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  body       text NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  edited_at  timestamptz NULL,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NOT NULL OR body IS NOT NULL)
);
CREATE INDEX fh_comment_idea_idx ON fh_comment (idea_id, created_at);

-- ── Evidence ───────────────────────────────────────────────────────────────
CREATE TABLE fh_insight (
  id            uuid PRIMARY KEY,
  idea_id       uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  value         text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 5000),
  source        text NOT NULL DEFAULT 'MANUAL'
                  CHECK (source IN ('FORUM','SUPPORT_BUTTON','CALL','MANUAL','CRM','CHAT','EMAIL')),
  source_ref    text NULL,
  person_id     uuid NULL REFERENCES core_person(id) ON DELETE SET NULL,
  company_id    uuid NULL REFERENCES core_company(id) ON DELETE SET NULL,
  staff_user_id uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  priority      text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','DEALBREAKER')),
  url           text NULL CHECK (char_length(url) <= 2000 AND url ~ '^https?://'),
  meta          jsonb NULL,
  intake_key    text NULL UNIQUE,
  created_by    uuid NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_insight_idea_idx ON fh_insight (idea_id);
CREATE INDEX fh_insight_company_idx ON fh_insight (company_id);
CREATE INDEX fh_insight_person_idx ON fh_insight (person_id);

CREATE TABLE fh_idea_company (
  idea_id    uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES core_company(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, company_id)
);
CREATE INDEX fh_idea_company_company_idx ON fh_idea_company (company_id);

CREATE TABLE fh_idea_person (
  idea_id    uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES core_person(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, person_id)
);
CREATE INDEX fh_idea_person_person_idx ON fh_idea_person (person_id);

CREATE TABLE fh_merge_event (
  id             uuid PRIMARY KEY,
  source_idea_id uuid NOT NULL,
  target_idea_id uuid NOT NULL,
  actor_id       uuid NULL,
  snapshot       jsonb NOT NULL,
  merged_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_merge_event_source_idx ON fh_merge_event (source_idea_id);
CREATE INDEX fh_merge_event_target_idx ON fh_merge_event (target_idea_id);

CREATE TABLE fh_idea_match (
  idea_id      uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  score        real NOT NULL CHECK (score BETWEEN 0 AND 1),
  title_hits   smallint NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, candidate_id)
);
CREATE INDEX fh_idea_match_score_idx ON fh_idea_match (idea_id, score DESC);

-- ── Forum (write paths in P3; read by roll-ups and moved by merge now) ─────
CREATE TABLE fh_forum (
  id                uuid PRIMARY KEY,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug              text NOT NULL UNIQUE CHECK (char_length(slug) <= 60),
  submission_prompt text NULL CHECK (char_length(submission_prompt) <= 500),
  is_archived       bool NOT NULL DEFAULT false,
  is_main           bool NOT NULL DEFAULT false,
  created_by        uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (is_main AND is_archived))
);
CREATE UNIQUE INDEX fh_forum_main_idx ON fh_forum (is_main) WHERE is_main; -- INV-07

CREATE TABLE fh_post (
  id               uuid PRIMARY KEY,
  forum_id         uuid NOT NULL REFERENCES fh_forum(id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  details          text NULL CHECK (char_length(details) <= 5000),
  author_person_id uuid NULL REFERENCES core_person(id) ON DELETE SET NULL,
  author_user_id   uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  vote_count       int NOT NULL DEFAULT 0,
  image_count      smallint NOT NULL DEFAULT 0 CHECK (image_count BETWEEN 0 AND 3),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_post_votes_idx ON fh_post (forum_id, vote_count DESC, created_at DESC);
CREATE INDEX fh_post_created_idx ON fh_post (forum_id, created_at DESC);
CREATE INDEX fh_post_author_idx ON fh_post (author_person_id);

CREATE TABLE fh_idea_post (
  idea_id    uuid NOT NULL REFERENCES fh_idea(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES fh_post(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, post_id)
);
CREATE INDEX fh_idea_post_post_idx ON fh_idea_post (post_id);

CREATE TABLE fh_vote (
  id         uuid PRIMARY KEY,
  post_id    uuid NOT NULL REFERENCES fh_post(id) ON DELETE CASCADE,
  person_id  uuid NULL REFERENCES core_person(id) ON DELETE CASCADE,
  user_id    uuid NULL REFERENCES core_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((person_id IS NULL) <> (user_id IS NULL)), -- INV-03
  UNIQUE (post_id, person_id),
  UNIQUE (post_id, user_id)
);
CREATE INDEX fh_vote_person_idx ON fh_vote (person_id);
CREATE INDEX fh_vote_user_idx ON fh_vote (user_id);

-- ── Saved views (FH-901) ───────────────────────────────────────────────────
CREATE TABLE fh_saved_view (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  owner_id   uuid NULL REFERENCES core_user(id) ON DELETE CASCADE,
  is_shared  bool NOT NULL DEFAULT false,
  config     jsonb NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_saved_view_owner_idx ON fh_saved_view (owner_id, sort_order, name);
CREATE TRIGGER fh_saved_view_touch BEFORE UPDATE ON fh_saved_view FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();
-- Built-ins (owner null) cannot be deleted (FH-903).
INSERT INTO fh_saved_view (id, name, owner_id, is_shared, config, sort_order) VALUES
  ('0190c3a0-0000-7000-8000-0000000000b1', 'All',     NULL, true, '{"version":1,"view":"all"}', 1),
  ('0190c3a0-0000-7000-8000-0000000000b2', 'Triage',  NULL, true, '{"version":1,"view":"triage"}', 2),
  ('0190c3a0-0000-7000-8000-0000000000b3', 'Backlog', NULL, true, '{"version":1,"view":"backlog"}', 3),
  ('0190c3a0-0000-7000-8000-0000000000b4', 'Roadmap', NULL, true, '{"version":1,"view":"roadmap"}', 4),
  ('0190c3a0-0000-7000-8000-0000000000b5', 'Board',   NULL, true, '{"version":1,"view":"board"}', 5);

-- ── Roll-up definition (FH-504): one function for a set of ideas, used by write paths and reconciliation ──
CREATE FUNCTION fh_rollup_compute(p_ids uuid[]) RETURNS TABLE (
  idea_id uuid, user_count int, company_count int, arr numeric(14,2), insight_count int,
  vote_total int, distinct_voters int, sources text[], has_intake_source bool, on_forum bool
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
    SELECT fi.idea_id, count(*)::int AS n, array_agg(DISTINCT fi.source ORDER BY fi.source) AS srcs
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
         COALESCE(ins.srcs && ARRAY['CALL','SUPPORT_BUTTON'], false), COALESCE(vts.on_forum, false)
    FROM ideas
    LEFT JOIN ppl ON ppl.idea_id = ideas.id
    LEFT JOIN cos ON cos.idea_id = ideas.id
    LEFT JOIN ins ON ins.idea_id = ideas.id
    LEFT JOIN vts ON vts.idea_id = ideas.id
$$;

CREATE FUNCTION fh_rollup_refresh(p_ids uuid[]) RETURNS int LANGUAGE sql AS $$
  WITH up AS (
    INSERT INTO fh_idea_rollup AS r (idea_id, user_count, company_count, arr, insight_count, vote_total,
                                     distinct_voters, sources, has_intake_source, on_forum, updated_at)
    SELECT c.*, now() FROM fh_rollup_compute(p_ids) c
    ON CONFLICT (idea_id) DO UPDATE SET
      user_count = EXCLUDED.user_count, company_count = EXCLUDED.company_count, arr = EXCLUDED.arr,
      insight_count = EXCLUDED.insight_count, vote_total = EXCLUDED.vote_total,
      distinct_voters = EXCLUDED.distinct_voters, sources = EXCLUDED.sources,
      has_intake_source = EXCLUDED.has_intake_source, on_forum = EXCLUDED.on_forum, updated_at = now()
    RETURNING 1)
  SELECT count(*)::int FROM up
$$;
