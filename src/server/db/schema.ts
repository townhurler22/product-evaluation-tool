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

export interface CoreCompany {
  id: string;
  name: string;
  name_key: ColumnType<string, never, never>;
  domain: string | null;
  arr: string | null;
  aliases: Generated<string[]>;
  prospect_at: Timestamp | null;
  created_at: Created;
  updated_at: Created;
}

export interface CorePerson {
  id: string;
  email: string | null;
  display_name: string | null;
  verified_at: Timestamp | null;
  verified_by: string | null;
  cookie_token_hash: string | null;
  company_id: string | null;
  company_source: 'DOMAIN' | 'MANUAL' | 'INTAKE' | null;
  created_at: Created;
  last_seen_at: Generated<Date>;
}

// ── Feedback Hub (0003_fh_core) ───────────────────────────────────────────────
export type IdeaType = 'FEATURE_REQUEST' | 'IMPROVEMENT' | 'INITIATIVE' | 'BUG' | 'QUESTION';
export type IdeaStatus = 'OPEN' | 'BACKLOG' | 'UNDER_REVIEW' | 'PLANNED' | 'IN_PROGRESS' | 'COMPLETE' | 'CLOSED';
export type BugStatus = 'OPEN' | 'TRIAGED' | 'IN_DEV' | 'FIXED' | 'RELEASED' | 'CANNOT_REPRODUCE' | 'CLOSED';

export interface FhGrant {
  user_id: string;
  role: 'ADMIN' | null;
  can_delete_posts: Generated<boolean>;
  granted_by: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface FhFeature {
  id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  depth: number;
  sort_order: Generated<number>;
  created_at: Created;
  updated_at: Created;
}

export interface FhFeatureClosure { ancestor_id: string; descendant_id: string; distance: number }

export interface FhFeatureDemand {
  feature_id: string;
  open_count: Generated<number>;
  all_count: Generated<number>;
  updated_at: Generated<Date>;
}

export interface FhJourney {
  id: string;
  name: string;
  name_key: ColumnType<string, never, never>;
  description: string | null;
  sort_order: Generated<number>;
  synced_at: Timestamp | null;
  synced_by: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface FhIdeaJourney { idea_id: string; journey_id: string; created_at: Created }

export interface FhTheme {
  id: string;
  name: string;
  name_key: ColumnType<string, never, never>;
  colour: string | null;
  is_seeded: Generated<boolean>;
  created_at: Created;
  updated_at: Created;
}

export interface FhIdeaTheme { idea_id: string; theme_id: string }

export interface FhMilestone {
  id: string;
  name: string;
  date: string;
  colour: string | null;
  description: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface FhIdea {
  id: string;
  number: ColumnType<string, never, never>;
  title: string;
  description: string | null;
  idea_type: Generated<IdeaType>;
  status: IdeaStatus | null;
  bug_status: BugStatus | null;
  feature_id: string | null;
  milestone_id: string | null;
  owner_id: string | null;
  merged_into_id: string | null;
  start_date: string | null;
  due_date: string | null;
  estimate_days: number | null;
  strategic_value: number | null;
  revenue_impact: number | null;
  customer_experience: number | null;
  risk_score: number | null;
  effort_score: number | null;
  is_dealbreaker: Generated<boolean>;
  is_committed: Generated<boolean>;
  reviewed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  public_summary: string | null;
  created_by: string | null;
  version: Generated<number>;
  search_tsv: ColumnType<string, never, never>;
  created_at: Created;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface FhIdeaRollup {
  idea_id: string;
  user_count: Generated<number>;
  company_count: Generated<number>;
  arr: Generated<string>;
  insight_count: Generated<number>;
  vote_total: Generated<number>;
  distinct_voters: Generated<number>;
  sources: Generated<string[]>;
  has_intake_source: Generated<boolean>;
  on_forum: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface FhStatusChange {
  id: string;
  idea_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  comment: string | null;
  changed_at: Generated<Date>;
}

export interface FhIdeaEvent {
  id: string;
  idea_id: string;
  actor_id: string | null;
  actor_label: string | null;
  field: string;
  from_value: string | null;
  to_value: string | null;
  created_at: Generated<Date>;
}

export interface FhComment {
  id: string;
  idea_id: string;
  author_id: string | null;
  body: string | null;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
  created_at: Generated<Date>;
}

export interface FhInsight {
  id: string;
  idea_id: string;
  value: string;
  source: Generated<'FORUM' | 'SUPPORT_BUTTON' | 'CALL' | 'MANUAL' | 'CRM' | 'CHAT' | 'EMAIL'>;
  source_ref: string | null;
  person_id: string | null;
  company_id: string | null;
  staff_user_id: string | null;
  priority: Generated<'LOW' | 'MEDIUM' | 'HIGH' | 'DEALBREAKER'>;
  url: string | null;
  meta: unknown | null;
  intake_key: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface FhIdeaCompany { idea_id: string; company_id: string; created_at: Created }
export interface FhIdeaPerson { idea_id: string; person_id: string; created_at: Created }

export interface FhMergeEvent {
  id: string;
  source_idea_id: string;
  target_idea_id: string;
  actor_id: string | null;
  snapshot: unknown;
  merged_at: Generated<Date>;
}

export interface FhIdeaMatch {
  idea_id: string;
  candidate_id: string;
  score: number;
  title_hits: number;
  computed_at: Generated<Date>;
}

export interface FhForum {
  id: string;
  name: string;
  slug: string;
  submission_prompt: string | null;
  is_archived: Generated<boolean>;
  is_main: Generated<boolean>;
  created_by: string | null;
  created_at: Created;
  updated_at: Created;
}

export interface FhPost {
  id: string;
  forum_id: string;
  title: string;
  details: string | null;
  author_person_id: string | null;
  author_user_id: string | null;
  vote_count: Generated<number>;
  image_count: Generated<number>;
  created_at: Created;
  updated_at: Created;
}

export interface FhIdeaPost { idea_id: string; post_id: string; created_at: Created }

export interface FhVote {
  id: string;
  post_id: string;
  person_id: string | null;
  user_id: string | null;
  created_at: Created;
}

export interface FhSavedView {
  id: string;
  name: string;
  owner_id: string | null;
  is_shared: Generated<boolean>;
  config: unknown;
  sort_order: Generated<number>;
  created_at: Created;
  updated_at: Created;
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
  core_company: CoreCompany;
  core_person: CorePerson;
  fh_grant: FhGrant;
  fh_feature: FhFeature;
  fh_feature_closure: FhFeatureClosure;
  fh_feature_demand: FhFeatureDemand;
  fh_journey: FhJourney;
  fh_idea_journey: FhIdeaJourney;
  fh_theme: FhTheme;
  fh_idea_theme: FhIdeaTheme;
  fh_milestone: FhMilestone;
  fh_idea: FhIdea;
  fh_idea_rollup: FhIdeaRollup;
  fh_status_change: FhStatusChange;
  fh_idea_event: FhIdeaEvent;
  fh_comment: FhComment;
  fh_insight: FhInsight;
  fh_idea_company: FhIdeaCompany;
  fh_idea_person: FhIdeaPerson;
  fh_merge_event: FhMergeEvent;
  fh_idea_match: FhIdeaMatch;
  fh_forum: FhForum;
  fh_post: FhPost;
  fh_idea_post: FhIdeaPost;
  fh_vote: FhVote;
  fh_saved_view: FhSavedView;
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
