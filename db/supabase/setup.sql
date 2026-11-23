-- Supabase-only setup, run by `pnpm supabase:setup` after migrations. Idempotent.
-- Not part of db/migrations because these schemas (storage, realtime, cron) exist only on Supabase.
-- Placeholders :app_url and :cron_secret are filled in by scripts/supabase-setup.ts.

-- ── Storage: one private bucket (SEC-28). 5 MB matches the largest upload route (OD-42). ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('files', 'files', false, 5242880, ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── Realtime: private channels admitted only if listed in the app-minted token (§3.7). ──
DROP POLICY IF EXISTS pet_channels_receive ON realtime.messages;
CREATE POLICY pet_channels_receive ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() = ANY (ARRAY(SELECT jsonb_array_elements_text(coalesce(auth.jwt() -> 'channels', '[]'::jsonb)))));

-- Client-sent events (cursor, presence) on the same channels only.
DROP POLICY IF EXISTS pet_channels_send ON realtime.messages;
CREATE POLICY pet_channels_send ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() = ANY (ARRAY(SELECT jsonb_array_elements_text(coalesce(auth.jwt() -> 'channels', '[]'::jsonb)))));

-- ── App tables are reached only by the server's own connection, never through the Data API. ──
-- RLS on with no policies: Supabase's anon/authenticated roles get nothing.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── Scheduled jobs (DECISIONS: job runner) ──
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drain the job queue every minute.
SELECT cron.schedule('pet-jobs-drain', '* * * * *', $cron$
  SELECT net.http_post(
    url := :'app_url' || '/api/internal/jobs/drain',
    headers := jsonb_build_object('Authorization', 'Bearer ' || :'cron_secret', 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 25000)
$cron$);

-- Nightly and monthly jobs are enqueued straight into the queue.
SELECT cron.schedule('pet-files-sweep', '15 2 * * *',
  $cron$INSERT INTO core_job (id, kind) VALUES (gen_random_uuid(), 'core.files.sweep')$cron$);
SELECT cron.schedule('pet-retention', '30 2 * * *',
  $cron$INSERT INTO core_job (id, kind) VALUES (gen_random_uuid(), 'core.retention')$cron$);
SELECT cron.schedule('pet-logs-prune', '0 3 1 * *',
  $cron$INSERT INTO core_job (id, kind) VALUES (gen_random_uuid(), 'core.logs.prune')$cron$);
