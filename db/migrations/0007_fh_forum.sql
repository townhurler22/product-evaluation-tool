-- 0007: Public forum (P3, §7.17, §7.18, FH-411–413). fh_forum, fh_post, fh_idea_post and fh_vote exist since 0003;
-- this adds the vote event log, status visibility, the similar-post index and the forum write paths' touch triggers.
-- Independent of 0006 (journey mapping).

-- ── Vote events (§6.3): append-only, no foreign keys, so the history outlives posts and people ──────────────
CREATE TABLE fh_vote_event (
  id         uuid PRIMARY KEY,
  post_id    uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('UP','UNDO')),
  person_id  uuid NULL,
  user_id    uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fh_vote_event_post_idx ON fh_vote_event (post_id, created_at);
-- SEC-20: erasure clears the person from their vote events.
CREATE INDEX fh_vote_event_person_idx ON fh_vote_event (person_id) WHERE person_id IS NOT NULL;

-- ── Status visibility (FH-1105, FH-310). Missing rows read as "not public"; reads never insert defaults. ───
CREATE TABLE fh_status_config (
  status_key   text PRIMARY KEY CHECK (status_key IN (
                 'IDEA_OPEN','IDEA_BACKLOG','IDEA_UNDER_REVIEW','IDEA_PLANNED','IDEA_IN_PROGRESS','IDEA_COMPLETE','IDEA_CLOSED',
                 'BUG_OPEN','BUG_TRIAGED','BUG_IN_DEV','BUG_FIXED','BUG_RELEASED','BUG_CANNOT_REPRODUCE','BUG_CLOSED')),
  is_public    bool NOT NULL DEFAULT false,
  public_label text NULL CHECK (char_length(public_label) BETWEEN 1 AND 60),
  public_kind  text NULL CHECK (public_kind IN ('complete','closed')),
  sort_order   int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fh_status_config_touch BEFORE UPDATE ON fh_status_config FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();
-- Starting labels so a new forum shows progress; admins change them on the Forums page (DECISIONS P3).
INSERT INTO fh_status_config (status_key, is_public, public_label, public_kind, sort_order) VALUES
  ('IDEA_PLANNED',     true, 'Planned',     NULL,       1),
  ('IDEA_IN_PROGRESS', true, 'In progress', NULL,       2),
  ('IDEA_COMPLETE',    true, 'Complete',    'complete', 3),
  ('IDEA_CLOSED',      true, 'Closed',      'closed',   4),
  ('BUG_IN_DEV',       true, 'In progress', NULL,       2),
  ('BUG_FIXED',        true, 'Fixed',       NULL,       5),
  ('BUG_RELEASED',     true, 'Complete',    'complete', 3),
  ('BUG_CLOSED',       true, 'Closed',      'closed',   4);

-- ── Forum write paths ─────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER fh_forum_touch BEFORE UPDATE ON fh_forum FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();
-- updated_at on posts follows edits only (FH-1107, FH-1214); vote count changes must not look like edits.
CREATE INDEX fh_post_title_trgm_idx ON fh_post USING gin (lower(title) gin_trgm_ops); -- FH-1211 similar posts
CREATE INDEX fh_forum_list_idx ON fh_forum (is_archived, created_at DESC);

-- On Supabase the app tables are reached only by the server's own connection (setup.sql enables RLS on every
-- table); do the same here so the new tables are closed even before setup is re-run.
ALTER TABLE fh_vote_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE fh_status_config ENABLE ROW LEVEL SECURITY;
