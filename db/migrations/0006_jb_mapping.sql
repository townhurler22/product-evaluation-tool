-- 0006_jb_mapping: Journey mapping and demand (SPEC §9, P5). Forward-only.
-- Independent of 0005 (P2): touches only Core links, the Journey Boards contract views, Feedback Hub demand
-- change tracking and one Journey Boards counter.

-- ── Journey Boards contract views (§6.7, §11.4) ─────────────────────────────
-- jb_board_scope gains the parent card of a journey (added at the end, so existing readers are unaffected).
CREATE OR REPLACE VIEW jb_board_scope AS
  SELECT id AS board_id, coalesce(journey_of_board_id, id) AS root_board_id, journey_of_node_id AS parent_node_id FROM jb_board;
-- A board and its journeys in one index scan (PERF-30).
CREATE INDEX jb_board_root_idx ON jb_board ((coalesce(journey_of_board_id, id)));

-- The live Product cards of every board, published read-only so Core's link read for a board returns the cards
-- with their links in one statement (PERF-30, INT-10: only live cards contribute demand).
CREATE VIEW jb_card_scope AS
  SELECT n.board_id, coalesce(b.journey_of_board_id, b.id) AS root_board_id, n.id AS node_id,
         n.board_id || ':' || n.id AS card_id, coalesce(n.data->>'title', '') AS title
  FROM jb_node n JOIN jb_board b ON b.id = n.board_id
  WHERE n.kind = 'product-card' AND n.deleted_at IS NULL;

-- Board demand revision (D-27): bumped by jb.demand.notify. Boards without realtime read it from the
-- `changes?since=` poll they already make every second, and refetch the overlay when it moves.
ALTER TABLE jb_board ADD COLUMN demand_rev bigint NOT NULL DEFAULT 0;

-- ── Feedback Hub demand change tracking (PERF-31, INT-53) ──────────────────
-- Every idea write that changes demand inputs (Feature, status, type, merge, delete, due date) and every
-- Feature or Journey delete or move marks the Feature or Journey here and queues one jb.demand.notify job
-- (deduplicated). Triggers, so no write path (including intake) can forget; the job reads and clears the rows.
CREATE TABLE fh_demand_dirty (
  kind       text NOT NULL CHECK (kind IN ('feature','journey')),
  id         uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);

CREATE FUNCTION fh_demand_dirty_mark(p_kind text, p_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;
  INSERT INTO fh_demand_dirty (kind, id)
    SELECT p_kind, x FROM unnest(p_ids) x WHERE x IS NOT NULL
    ON CONFLICT (kind, id) DO UPDATE SET changed_at = now();
  -- One queued job however many writes happen before it runs (§3.9 debounce).
  INSERT INTO core_job (id, kind, payload, dedupe_key)
    VALUES (gen_random_uuid(), 'jb.demand.notify', '{}'::jsonb, 'jb.demand.notify')
    ON CONFLICT (dedupe_key) WHERE state = 'queued' DO NOTHING;
END $$;

CREATE FUNCTION fh_idea_demand_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT feature_id) INTO ids FROM new_rows WHERE feature_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT feature_id) INTO ids FROM old_rows WHERE feature_id IS NOT NULL;
  ELSE
    SELECT array_agg(DISTINCT f) INTO ids FROM (
      SELECT unnest(ARRAY[o.feature_id, n.feature_id]) AS f
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      WHERE (o.feature_id, o.status, o.bug_status, o.merged_into_id, o.due_date, o.idea_type)
            IS DISTINCT FROM (n.feature_id, n.status, n.bug_status, n.merged_into_id, n.due_date, n.idea_type)) x
    WHERE f IS NOT NULL;
  END IF;
  PERFORM fh_demand_dirty_mark('feature', ids);
  RETURN NULL;
END $$;
CREATE TRIGGER fh_idea_demand_dirty_ins AFTER INSERT ON fh_idea REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fh_idea_demand_dirty();
CREATE TRIGGER fh_idea_demand_dirty_upd AFTER UPDATE ON fh_idea REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fh_idea_demand_dirty();
CREATE TRIGGER fh_idea_demand_dirty_del AFTER DELETE ON fh_idea REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fh_idea_demand_dirty();

-- A deleted Feature (attention flag, INT-28) or a moved one (its old ancestors lose its demand).
CREATE FUNCTION fh_feature_demand_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fh_demand_dirty_mark('feature', ARRAY[OLD.id, OLD.parent_id]);
  ELSIF OLD.parent_id IS DISTINCT FROM NEW.parent_id THEN
    PERFORM fh_demand_dirty_mark('feature', ARRAY[NEW.id, OLD.parent_id,
      (SELECT parent_id FROM fh_feature WHERE id = OLD.parent_id)]);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fh_feature_demand_dirty AFTER DELETE OR UPDATE OF parent_id ON fh_feature
  FOR EACH ROW EXECUTE FUNCTION fh_feature_demand_dirty();

CREATE FUNCTION fh_journey_demand_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fh_demand_dirty_mark('journey', ARRAY[OLD.id]);
  RETURN NULL;
END $$;
CREATE TRIGGER fh_journey_demand_dirty AFTER DELETE ON fh_journey
  FOR EACH ROW EXECUTE FUNCTION fh_journey_demand_dirty();

-- Ideas under a Feature set, newest first (INT-40), and the Journey sync's assignment (INT-19).
CREATE INDEX fh_idea_feature_updated_idx ON fh_idea (feature_id, updated_at DESC, id) WHERE merged_into_id IS NULL;
