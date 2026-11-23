-- 0001_core: Core- and intake-owned tables (SPEC §6.1, §6.2) plus the job queue (DECISIONS: job runner).
-- Forward-only. Applied by scripts/migrate.ts, never by the app (ARC-35, NFR-41).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared updated_at trigger
CREATE FUNCTION core_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ── core_user ──────────────────────────────────────────────────────────────
CREATE TABLE core_user (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  full_name     text NULL CHECK (char_length(full_name) <= 200),
  role          text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('ADMIN','PRODUCT','MEMBER')),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  session_epoch int  NOT NULL DEFAULT 0,
  avatar_url    text NULL CHECK (avatar_url ~ '^https?://'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_user_status_idx ON core_user (status);
CREATE TRIGGER core_user_touch BEFORE UPDATE ON core_user FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

CREATE TABLE core_session (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES core_user(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz NULL,
  user_agent_hash text NULL
);
CREATE INDEX core_session_user_idx ON core_session (user_id);

-- Magic-link sign-in tokens (DECISIONS OD-01). Hash only; single use.
CREATE TABLE core_magic_link (
  id          uuid PRIMARY KEY,
  email       text NOT NULL CHECK (email = lower(btrim(email))),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL,
  ip_hash     text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_magic_link_email_idx ON core_magic_link (email, created_at);

-- ── companies and external people ──────────────────────────────────────────
CREATE TABLE core_company (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  name_key    text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  domain      text NULL UNIQUE CHECK (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  arr         numeric(14,2) NULL CHECK (arr >= 0),
  aliases     text[] NOT NULL DEFAULT '{}',
  prospect_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_company_name_key_idx ON core_company (name_key);
CREATE INDEX core_company_aliases_idx ON core_company USING gin (aliases);
CREATE INDEX core_company_arr_idx ON core_company (arr DESC NULLS LAST, name);
CREATE TRIGGER core_company_touch BEFORE UPDATE ON core_company FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

CREATE TABLE core_person (
  id                uuid PRIMARY KEY,
  email             text NULL UNIQUE CHECK (email = lower(btrim(email))),
  display_name      text NULL CHECK (char_length(display_name) <= 200),
  verified_at       timestamptz NULL,
  verified_by       text NULL,
  cookie_token_hash text NULL UNIQUE,
  company_id        uuid NULL REFERENCES core_company(id) ON DELETE SET NULL,
  company_source    text NULL CHECK (company_source IN ('DOMAIN','MANUAL','INTAKE')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_person_company_idx ON core_person (company_id);
CREATE INDEX core_person_last_seen_idx ON core_person (last_seen_at DESC);
CREATE INDEX core_person_domain_idx ON core_person (split_part(email, '@', 2));

-- ── links (no FKs: either end may vanish and must resolve as gone, ARC-20) ──
CREATE TABLE core_link (
  id            uuid PRIMARY KEY,
  relation      text NOT NULL CHECK (relation IN ('maps-to-feature','maps-to-journey','references-card')),
  from_module   text NOT NULL,
  from_kind     text NOT NULL,
  from_id       text NOT NULL,
  from_scope_id text NULL,
  to_module     text NOT NULL,
  to_kind       text NOT NULL,
  to_id         text NOT NULL,
  created_by    uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (relation, from_kind, from_id, to_kind, to_id)
);
CREATE INDEX core_link_scope_idx ON core_link (from_scope_id, relation);
CREATE INDEX core_link_to_idx ON core_link (to_kind, to_id, relation);
CREATE INDEX core_link_from_idx ON core_link (from_kind, from_id);

-- ── files ──────────────────────────────────────────────────────────────────
CREATE TABLE core_file (
  id            uuid PRIMARY KEY,
  module        text NOT NULL CHECK (module IN ('fh','jb')),
  owner_kind    text NOT NULL,
  owner_id      text NOT NULL,
  storage_key   text NOT NULL UNIQUE,
  content_type  text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes    int  NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  original_name text NULL CHECK (char_length(original_name) <= 200),
  created_by    text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);
CREATE INDEX core_file_owner_idx ON core_file (module, owner_kind, owner_id);
CREATE INDEX core_file_deleted_idx ON core_file (deleted_at) WHERE deleted_at IS NOT NULL;

-- ── share links ────────────────────────────────────────────────────────────
CREATE TABLE core_share_link (
  id            uuid PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  module        text NOT NULL CHECK (module IN ('fh','jb')),
  target_kind   text NOT NULL CHECK (target_kind IN ('forum','board')),
  target_id     uuid NOT NULL,
  capabilities  text[] NOT NULL DEFAULT '{VIEW}'
                CHECK ('VIEW' = ANY (capabilities) AND capabilities <@ ARRAY['VIEW','SUBMIT','VOTE']),
  password_hash text NULL,
  expires_at    timestamptz NULL,
  max_uses      int NULL CHECK (max_uses >= 1),
  use_count     int NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES core_user(id) ON DELETE CASCADE,
  revoked_at    timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_share_link_target_idx ON core_share_link (module, target_kind, target_id);
CREATE TRIGGER core_share_link_touch BEFORE UPDATE ON core_share_link FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

CREATE TABLE core_share_link_use (
  id            uuid PRIMARY KEY,
  share_link_id uuid NOT NULL REFERENCES core_share_link(id) ON DELETE CASCADE,
  capability    text NOT NULL,
  ip_hash       text NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_share_link_use_idx ON core_share_link_use (share_link_id, created_at);

-- ── audit log (append-only; only the retention job may delete) ──────────────
CREATE TABLE core_audit_log (
  id          uuid PRIMARY KEY,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('user','visitor','ingest','system')),
  actor_id    text NULL,
  action      text NOT NULL,
  target_kind text NULL,
  target_id   text NULL,
  details     jsonb NULL,
  ip_hash     text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_audit_target_idx ON core_audit_log (target_kind, target_id, created_at);
CREATE INDEX core_audit_actor_idx ON core_audit_log (actor_id, created_at);
CREATE INDEX core_audit_created_idx ON core_audit_log (created_at);

CREATE FUNCTION core_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention_job', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'core_audit_log is append-only';
END $$;
CREATE TRIGGER core_audit_append_only BEFORE UPDATE OR DELETE ON core_audit_log
  FOR EACH ROW EXECUTE FUNCTION core_audit_guard();

CREATE TABLE core_rate_window (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE core_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── job queue (DECISIONS: replaces a separate pg-boss worker) ───────────────
CREATE TABLE core_job (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text NULL,            -- debounce: one queued job per key
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_until timestamptz NULL,
  last_error   text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz NULL
);
CREATE UNIQUE INDEX core_job_dedupe_idx ON core_job (dedupe_key) WHERE state = 'queued';
CREATE INDEX core_job_due_idx ON core_job (run_at) WHERE state IN ('queued','running');
CREATE INDEX core_job_dead_idx ON core_job (created_at) WHERE state = 'dead';

-- ── intake (SPEC §6.2) ──────────────────────────────────────────────────────
CREATE TABLE ing_client (
  id           uuid PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  environment  text NOT NULL CHECK (environment IN ('staging','production')),
  module       text NOT NULL DEFAULT 'fh' CHECK (module = 'fh'),
  routes       text[] NOT NULL,
  paused_at    timestamptz NULL,
  pause_reason text NULL,
  created_by   uuid NULL REFERENCES core_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ing_client_touch BEFORE UPDATE ON ing_client FOR EACH ROW EXECUTE FUNCTION core_touch_updated_at();

CREATE TABLE ing_key (
  id           text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  client_id    uuid NOT NULL REFERENCES ing_client(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz NULL,
  last_used_at timestamptz NULL
);
CREATE INDEX ing_key_client_idx ON ing_key (client_id) WHERE status = 'active';

CREATE TABLE ing_review (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('gateway','client')),
  client_id   uuid NULL REFERENCES ing_client(id) ON DELETE CASCADE,
  recorded_by uuid NOT NULL REFERENCES core_user(id),
  notes       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ing_receipt (
  id            uuid PRIMARY KEY,
  client_id     uuid NOT NULL REFERENCES ing_client(id) ON DELETE CASCADE,
  request_key   text NOT NULL,
  body_sha256   text NOT NULL,
  status        int  NOT NULL,
  content_type  text NULL,
  response_body text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, request_key)
);

CREATE TABLE ing_log (
  id          uuid PRIMARY KEY,
  client_id   uuid NULL,
  key_id      text NULL,
  route       text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('accepted','replayed','rejected','refused','failed')),
  reason      text NULL,
  status      int  NOT NULL,
  receipt_id  uuid NULL,
  body_sha256 text NULL,
  body_bytes  int  NULL,
  ip_hash     text NULL,
  latency_ms  int  NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ing_log_client_idx ON ing_log (client_id, created_at);

CREATE FUNCTION ing_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.created_at < now() - interval '12 months' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ing_log rows are immutable for 12 months';
END $$;
CREATE TRIGGER ing_log_append_only BEFORE UPDATE OR DELETE ON ing_log
  FOR EACH ROW EXECUTE FUNCTION ing_log_guard();

CREATE TABLE ing_unkeyed_count (
  module text NOT NULL,
  day    date NOT NULL,
  count  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (module, day)
);

CREATE TABLE ing_module_setting (
  module       text PRIMARY KEY,
  paused_at    timestamptz NULL,
  pause_reason text NULL
);

-- ── seed settings (DECISIONS OD-33, OD-34) ──────────────────────────────────
INSERT INTO core_setting (key, value) VALUES
  ('auth.allowed_domains',      '[]'),
  ('intake.staff_domains',      '[]'),
  ('release_train.anchor',      '"2026-01-05"'),
  ('release_train.length_days', '21'),
  ('planning_year.start_month', '5'),
  ('currency',                  '"EUR"'),
  ('forum.default_label',       '"Under consideration"');
