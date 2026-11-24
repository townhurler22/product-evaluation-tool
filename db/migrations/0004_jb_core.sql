-- 0004_jb_core: Journey Boards tables (SPEC §6.4) and the jb_board_scope view (§6.7).
-- Forward-only. Depends on Core (0001) only, never on Feedback Hub tables.

-- ── jb_board ───────────────────────────────────────────────────────────────
-- Board ids are text (§6.4) but always uuid-shaped here so they fit core_share_link.target_id (DECISIONS P4).
CREATE TABLE jb_board (
  id                   text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  owner_id             uuid NOT NULL REFERENCES core_user(id) ON DELETE RESTRICT,
  journey_of_board_id  text NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  journey_of_node_id   text NULL,
  workspace_can_edit   boolean NOT NULL DEFAULT false,
  settings             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  viewport             jsonb NULL,
  seq                  bigint NOT NULL DEFAULT 0,
  min_client_protocol  int NOT NULL DEFAULT 1,
  live_node_count      int NOT NULL DEFAULT 0,
  live_edge_count      int NOT NULL DEFAULT 0,
  live_field_count     int NOT NULL DEFAULT 0,
  compacted_seq        bigint NOT NULL DEFAULT 0,
  schema_version       int NOT NULL DEFAULT 1,
  updated_by           uuid NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Moves only on content batches, never on viewport or access changes (§6.4), so no touch trigger.
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((journey_of_board_id IS NULL) = (journey_of_node_id IS NULL)),
  CHECK (journey_of_board_id IS NULL OR NOT workspace_can_edit),
  UNIQUE (journey_of_board_id, journey_of_node_id)
);
CREATE INDEX jb_board_owner_idx ON jb_board (owner_id);
CREATE INDEX jb_board_journey_of_idx ON jb_board (journey_of_board_id);
CREATE INDEX jb_board_updated_idx ON jb_board (updated_at DESC);

-- INV-21: a journey's parent is top-level; a board that has journeys cannot become a journey.
CREATE FUNCTION jb_board_journey_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.journey_of_board_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jb_board WHERE id = NEW.journey_of_board_id AND journey_of_board_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a detailed journey cannot have its own journey' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jb_board WHERE journey_of_board_id = NEW.id) THEN
      RAISE EXCEPTION 'a board with journeys cannot become a journey' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jb_board_journey_guard BEFORE INSERT OR UPDATE OF journey_of_board_id ON jb_board
  FOR EACH ROW EXECUTE FUNCTION jb_board_journey_guard();

-- Op patches merge data one level deep with an explicit unset list (JB-1601). `fieldValues.<id>` keys
-- merge one level deeper, so two people setting different field values on one card both win (JB-1605).
CREATE FUNCTION jb_merge_data(base jsonb, patch jsonb, unset text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out jsonb := coalesce(base, '{}'::jsonb);
  fv jsonb;
  k text;
  v jsonb;
BEGIN
  FOR k, v IN SELECT key, value FROM jsonb_each(coalesce(patch, '{}'::jsonb)) LOOP
    IF k LIKE 'fieldValues.%' THEN
      fv := CASE WHEN jsonb_typeof(out->'fieldValues') = 'object' THEN out->'fieldValues' ELSE '{}'::jsonb END;
      out := jsonb_set(out, '{fieldValues}', fv || jsonb_build_object(substr(k, 13), v));
    ELSE
      out := out || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  FOREACH k IN ARRAY coalesce(unset, '{}'::text[]) LOOP
    IF k LIKE 'fieldValues.%' THEN
      fv := CASE WHEN jsonb_typeof(out->'fieldValues') = 'object' THEN out->'fieldValues' ELSE '{}'::jsonb END;
      out := jsonb_set(out, '{fieldValues}', fv - substr(k, 13));
    ELSE
      out := out - k;
    END IF;
  END LOOP;
  RETURN out;
END $$;

-- ── content tables ─────────────────────────────────────────────────────────
CREATE TABLE jb_node (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]*$'),
  x           double precision NOT NULL,
  y           double precision NOT NULL,
  width       double precision NULL,
  height      double precision NULL,
  z_index     int NULL,
  parent_id   text NULL,
  sort_key    text COLLATE "C" NOT NULL,
  data        jsonb NOT NULL CONSTRAINT jb_node_data_size CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 262144),
  version     int NOT NULL DEFAULT 1,
  last_seq    bigint NOT NULL,
  deleted_at  timestamptz NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX jb_node_live_idx ON jb_node (board_id) WHERE deleted_at IS NULL;
CREATE INDEX jb_node_parent_idx ON jb_node (board_id, parent_id) WHERE deleted_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX jb_node_product_idx ON jb_node (board_id) WHERE kind = 'product-card' AND deleted_at IS NULL;
CREATE INDEX jb_node_tombstone_idx ON jb_node (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE jb_edge (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  source_id   text NOT NULL,
  target_id   text NOT NULL,
  sort_key    text COLLATE "C" NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 65536),
  version     int NOT NULL DEFAULT 1,
  last_seq    bigint NOT NULL,
  deleted_at  timestamptz NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX jb_edge_source_idx ON jb_edge (board_id, source_id) WHERE deleted_at IS NULL;
CREATE INDEX jb_edge_target_idx ON jb_edge (board_id, target_id) WHERE deleted_at IS NULL;
CREATE INDEX jb_edge_tombstone_idx ON jb_edge (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE jb_field (
  board_id     text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  id           text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind         text NOT NULL CHECK (kind IN ('picker','text','toggle','date')),
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  options      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  show_on_card boolean NOT NULL DEFAULT false,
  sort_key     text COLLATE "C" NOT NULL,
  preset_key   text NULL,
  extra        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object'),
  version      int NOT NULL DEFAULT 1,
  last_seq     bigint NOT NULL,
  deleted_at   timestamptz NULL,
  PRIMARY KEY (board_id, id),
  -- The built-in Design status picker can never be deleted (JB-901).
  CONSTRAINT jb_field_status_kept CHECK (preset_key IS DISTINCT FROM 'status' OR deleted_at IS NULL)
);
CREATE INDEX jb_field_live_idx ON jb_field (board_id) WHERE deleted_at IS NULL;

-- Change log (JB-1601, INV-22). Retention: JB-1606 / OD-25 (30 days).
CREATE TABLE jb_change (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  batch_id    text NOT NULL CHECK (char_length(batch_id) BETWEEN 1 AND 128),
  client_id   text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 128),
  user_id     uuid NULL,
  ops         jsonb NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq),
  UNIQUE (board_id, batch_id)
);
CREATE INDEX jb_change_created_idx ON jb_change (created_at);

CREATE TABLE jb_snapshot (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('compaction','manual','import','pre-migration')),
  doc         jsonb NOT NULL,
  doc_hash    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq)
);

-- ── access, comments, images ───────────────────────────────────────────────
CREATE TABLE jb_collaborator (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES core_user(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'EDITOR' CHECK (role IN ('EDITOR','COMMENTER','VIEWER')),
  added_by    uuid NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX jb_collaborator_user_idx ON jb_collaborator (user_id);

CREATE TABLE jb_comment_thread (
  id              uuid PRIMARY KEY,
  board_id        text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  author_id       uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  anchor_type     text NOT NULL CHECK (anchor_type IN ('BOARD','NODE')),
  anchor_node_id  text NULL,
  x               double precision NOT NULL,
  y               double precision NOT NULL,
  resolved_at     timestamptz NULL,
  resolved_by     uuid NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((anchor_type = 'NODE') = (anchor_node_id IS NOT NULL))
);
CREATE INDEX jb_comment_thread_board_idx ON jb_comment_thread (board_id, updated_at DESC);
CREATE INDEX jb_comment_thread_anchor_idx ON jb_comment_thread (board_id, anchor_node_id);

CREATE TABLE jb_comment_message (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL REFERENCES jb_comment_thread(id) ON DELETE CASCADE,
  author_id   uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  edited_at   timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jb_comment_message_thread_idx ON jb_comment_message (thread_id, created_at);

CREATE TABLE jb_image (
  board_id    text NOT NULL REFERENCES jb_board(id) ON DELETE CASCADE,
  image_id    text NOT NULL CHECK (image_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  file_id     uuid NOT NULL REFERENCES core_file(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, image_id)
);

-- §6.7 / §11.4: the read-only view Journey Boards publishes so a board and its journeys read in one statement.
CREATE VIEW jb_board_scope AS
  SELECT id AS board_id, coalesce(journey_of_board_id, id) AS root_board_id FROM jb_board;
