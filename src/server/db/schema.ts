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

export interface CoreShareLink {
  id: string;
  token_hash: string;
  module: 'fh' | 'jb';
  target_kind: 'forum' | 'board';
  target_id: string;
  capabilities: Generated<string[]>;
  password_hash: string | null;
  expires_at: Timestamp | null;
  max_uses: number | null;
  use_count: Generated<number>;
  created_by: string;
  revoked_at: Timestamp | null;
  created_at: Created;
  updated_at: Created;
}

export interface CoreShareLinkUse {
  id: string;
  share_link_id: string;
  capability: string;
  ip_hash: string | null;
  created_at: Created;
}

export interface CoreFile {
  id: string;
  module: 'fh' | 'jb';
  owner_kind: string;
  owner_id: string;
  storage_key: string;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  size_bytes: number;
  sha256: string;
  original_name: string | null;
  created_by: string | null;
  created_at: Created;
  deleted_at: Timestamp | null;
}

export interface IngClient {
  id: string;
  name: string;
  environment: 'staging' | 'production';
  module: Generated<string>;
  routes: string[];
  target: string | null;
  rate_per_minute: Generated<number>;
  paused_at: Timestamp | null;
  pause_reason: string | null;
  created_by: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface IngKey {
  id: string;
  client_id: string;
  status: Generated<'active' | 'revoked'>;
  created_at: Created;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
}

export interface IngReview {
  id: string;
  kind: 'gateway' | 'client';
  client_id: string | null;
  recorded_by: string;
  notes: string;
  created_at: Created;
}

export interface IngReceipt {
  id: string;
  client_id: string;
  request_key: string;
  body_sha256: string;
  status: number;
  content_type: string | null;
  response_body: string | null;
  created_at: Created;
}

export interface IngLog {
  id: string;
  client_id: string | null;
  key_id: string | null;
  route: string;
  outcome: 'accepted' | 'replayed' | 'rejected' | 'refused' | 'failed';
  reason: string | null;
  status: number;
  receipt_id: string | null;
  body_sha256: string | null;
  body_bytes: number | null;
  ip_hash: string | null;
  latency_ms: number | null;
  created_at: Created;
}

export interface IngModuleSetting {
  module: string;
  paused_at: Timestamp | null;
  pause_reason: string | null;
}

// ── Journey Boards (§6.4, migration 0004) ──────────────────────────────────
type Json = ColumnType<unknown, string, string>;

export interface JbBoard {
  id: string;
  name: string;
  owner_id: string;
  journey_of_board_id: string | null;
  journey_of_node_id: string | null;
  workspace_can_edit: Generated<boolean>;
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  viewport: ColumnType<{ x: number; y: number; zoom: number } | null, string | null | undefined, string | null>;
  seq: ColumnType<string, number | string | undefined, number | string>;
  min_client_protocol: Generated<number>;
  live_node_count: Generated<number>;
  live_edge_count: Generated<number>;
  live_field_count: Generated<number>;
  compacted_seq: ColumnType<string, number | string | undefined, number | string>;
  schema_version: Generated<number>;
  updated_by: string | null;
  created_at: Created;
  updated_at: Timestamp;
}

export interface JbNode {
  board_id: string;
  id: string;
  kind: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  z_index: number | null;
  parent_id: string | null;
  sort_key: string;
  data: Json;
  version: Generated<number>;
  last_seq: ColumnType<string, number | string, number | string>;
  deleted_at: Timestamp | null;
}

export interface JbEdge {
  board_id: string;
  id: string;
  source_id: string;
  target_id: string;
  sort_key: string;
  data: Json;
  version: Generated<number>;
  last_seq: ColumnType<string, number | string, number | string>;
  deleted_at: Timestamp | null;
}

export interface JbField {
  board_id: string;
  id: string;
  kind: 'picker' | 'text' | 'toggle' | 'date';
  label: string;
  options: Json;
  show_on_card: Generated<boolean>;
  sort_key: string;
  preset_key: string | null;
  extra: Json;
  version: Generated<number>;
  last_seq: ColumnType<string, number | string, number | string>;
  deleted_at: Timestamp | null;
}

export interface JbChange {
  board_id: string;
  seq: ColumnType<string, number | string, never>;
  batch_id: string;
  client_id: string;
  user_id: string | null;
  ops: Json;
  result: Json;
  created_at: Created;
}

export interface JbSnapshot {
  board_id: string;
  seq: ColumnType<string, number | string, never>;
  reason: 'compaction' | 'manual' | 'import' | 'pre-migration';
  doc: Json;
  doc_hash: string;
  created_at: Created;
}

export interface JbCollaborator {
  board_id: string;
  user_id: string;
  role: 'EDITOR' | 'COMMENTER' | 'VIEWER';
  added_by: string | null;
  created_at: Created;
}

export interface JbCommentThread {
  id: string;
  board_id: string;
  author_id: string | null;
  anchor_type: 'BOARD' | 'NODE';
  anchor_node_id: string | null;
  x: number;
  y: number;
  resolved_at: Timestamp | null;
  resolved_by: string | null;
  created_at: Created;
  updated_at: Timestamp;
}

export interface JbCommentMessage {
  id: string;
  thread_id: string;
  author_id: string | null;
  body: string;
  edited_at: Timestamp | null;
  created_at: Created;
}

export interface JbImage {
  board_id: string;
  image_id: string;
  file_id: string;
  created_at: Created;
}

export interface DB {
  core_share_link: CoreShareLink;
  core_share_link_use: CoreShareLinkUse;
  core_file: CoreFile;
  ing_client: IngClient;
  ing_key: IngKey;
  ing_review: IngReview;
  ing_receipt: IngReceipt;
  ing_log: IngLog;
  ing_module_setting: IngModuleSetting;
  core_user: CoreUser;
  core_session: CoreSession;
  core_magic_link: CoreMagicLink;
  core_setting: CoreSetting;
  core_audit_log: CoreAuditLog;
  core_job: CoreJob;
  core_rate_window: CoreRateWindow;
  jb_board: JbBoard;
  jb_node: JbNode;
  jb_edge: JbEdge;
  jb_field: JbField;
  jb_change: JbChange;
  jb_snapshot: JbSnapshot;
  jb_collaborator: JbCollaborator;
  jb_comment_thread: JbCommentThread;
  jb_comment_message: JbCommentMessage;
  jb_image: JbImage;
}
