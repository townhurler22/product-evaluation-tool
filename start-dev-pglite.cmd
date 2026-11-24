@echo off
rem Local UI check on an in-memory PGlite database (src/server/db/dev-pglite.ts). Every variable the app reads is
rem set here so nothing from .env.local (the live services) is used.
cd /d "%~dp0"
set DATABASE_URL=pglite:memory
set DATABASE_URL_DIRECT=pglite:memory
set APP_SECRET=local-pglite-only-secret-0123456789abcdef
set CRON_SECRET=local-pglite-cron
set OWNER_EMAIL=owner@example.com
set RESEND_API_KEY=re_local_dummy
set MAIL_FROM=dev@example.com
set DEMO_MODE=1
set SUPABASE_URL=http://127.0.0.1:9
set SUPABASE_SERVICE_ROLE_KEY=local-dummy
set SUPABASE_JWT_SECRET=local-dummy-jwt-secret
set INGEST_MASTER_KEY=local-dummy-ingest-master-key-0123456789
set INGEST_ENVIRONMENT=staging
set APP_ORIGIN=http://localhost:3201
npx next dev -p 3201
