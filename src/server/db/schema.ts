// Kysely table types. Mirrors db/migrations; extend as each phase adds tables.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Created = ColumnType<Date, never, never>;

export interface CoreUser {
  id: string;
  email: string;
  full_name: string | null;
  role: Generated<'ADMIN' | 'PRODUCT' | 'MEMBER'>;
  status: Generated<'PENDING' | 'ACTIVE' | 'DISABLED'>;
  session_epoch: Generated<number>;
  avatar_url: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface CoreSession {
  id: string;
  user_id: string;
  created_at: Created;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  user_agent_hash: string | null;
}

export interface CoreMagicLink {
  id: string;
  email: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  ip_hash: string | null;
  created_at: Created;
}

export interface CoreSetting {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface CoreAuditLog {
  id: string;
  actor_kind: 'user' | 'visitor' | 'ingest' | 'system';
  actor_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  details: unknown | null;
  ip_hash: string | null;
  created_at: Created;
}

export interface CoreJob {
  id: string;
  kind: string;
  payload: Generated<unknown>;
  dedupe_key: string | null;
  state: Generated<'queued' | 'running' | 'done' | 'dead'>;
  run_at: Generated<Date>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_until: Timestamp | null;
  last_error: string | null;
  created_at: Created;
  finished_at: Timestamp | null;
}

export interface CoreRateWindow {
  key: string;
  window_start: Timestamp;
  count: Generated<number>;
}

export interface DB {
  core_user: CoreUser;
  core_session: CoreSession;
  core_magic_link: CoreMagicLink;
  core_setting: CoreSetting;
  core_audit_log: CoreAuditLog;
  core_job: CoreJob;
  core_rate_window: CoreRateWindow;
}
