# Decisions

Answers to the open decisions in `SPEC.md` §16, plus deviations from the spec's defaults.
Product owner: Shane O'Donnell. Confirmed 23 Nov 2026 unless stated.

## Product framing

| Topic | Decision |
|---|---|
| Name | **Product Evaluation Tool**: the spec's Feedback Hub and Journey Boards as one app |
| Publishing | Public repo and live demo. The original employer has agreed to publication |
| Scope | MVP phases P0 to P5 in order. P6 reduced to a demo-grade pass (no pen test, on-call or quarterly restore drill). P7 (transcript agent) out of scope |

## §16.1 Platform and hosting

| ID | Decision |
|---|---|
| OD-01 | **Magic-link email sign-in** for staff (no company identity provider exists), plus a **"Try the demo"** button that signs a visitor in as the shared demo account. Deviation from default (a) |
| OD-02 | (a) Single tenant, **one deployment and one database** (changed 23 Nov 2026; replaces the earlier two-deployment plan). The demo account works in the same live data as the owner, **can edit it, and is never reset**. The owner accepted that visitors can add to and change the permanent record. Demo actions are audited under the demo user's id, and the demo account can never be a workspace admin |
| Environments (ARC-37, NFR-40) | **No separate staging.** Migrations run against the live database as their own step before a deploy (NFR-41). The synthetic §13.4 fixture is never loaded into it: statement-count and size checks (PT-16) run on PGlite in CI; timing checks run on the live deployment with its real data, so timing budgets at fixture scale are not proven until a throwaway database is used |
| OD-13 | (a) Deactivation applies elsewhere within 30 s |
| OD-26 | 24 months audit log retention |
| OD-27 | **Vercel** (functions pinned to `dub1`, Dublin) + **Supabase** project in `eu-west-1` (Ireland). Same AWS region, to meet ARC-32 (≤ 5 ms p50) |
| OD-28 | (a) Managed: Supabase for Postgres, Realtime (broadcast and presence) and Storage. Each Supabase project is one environment (ARC-37) |
| OD-33 | Release train anchor **Monday 5 January 2026**, 21-day trains, planning year starts 1 May |
| OD-34 | Reporting currency **EUR** |

## §16.2 Feedback Hub

All recommended defaults: OD-03 (a), OD-04 (a), OD-05 (a), OD-06 CSV only with visible columns and no emails, OD-07 (a), OD-08 (a), OD-09 later phase, OD-10 later phase, OD-11 distinct voters, OD-12 (a), OD-14 (a), OD-15 first day of the current month, OD-20 (a), OD-21 (a), OD-22 (a).

## §16.3 Journey Boards and journey mapping

All recommended defaults: OD-16 (a), OD-17 (a), OD-18 (a), OD-19 (a), OD-24 (a), OD-25 30 days.

**OD-23 vs OD-35 conflict:** the spec gives opposite defaults for "Everyone in the workspace can edit" on new boards. Resolved: **off**, and the owner turns it on (OD-23). The sample template board starts on. OD-35 is therefore (b).

## §16.4 Remaining decisions

- **OD-29 to OD-32 and OD-49** (transcript agent): parked, because P7 is out of scope.
- **OD-36 to OD-48**: recommended default (a) for each. OD-41 matches OD-25 (30 days) and OD-48 matches OD-26 (24 months).

## Deviations from §3.3 tech defaults

Each is flagged to the product owner, per §0 rule 6.

| Spec default | Used instead | Why |
|---|---|---|
| Long-lived Node process, ≥ 2 warm instances (ARC-33) | Vercel Functions with Fluid compute, pooled connection string | Chosen host. The spec allows serverless with warm instances and pooling. Cold start (PT-08) is measured on Vercel |
| Separate worker process for pg-boss or Graphile Worker (§3.9) | Postgres-backed `core_job` table. Drained by (1) Next.js `after()` straight after the request that enqueued the job, and (2) Supabase `pg_cron` calling `POST /api/internal/jobs/drain` every minute. Nightly jobs come from `pg_cron` | Vercel has no always-on worker, and the Hobby plan cron runs only daily. Jobs stay idempotent with retries and a dead-letter state (ARC-31) |
| Ably or Pusher for realtime | Supabase Realtime (broadcast and presence), with private channels authorised by the app | Same provider and region as the database |
| Direct database connection for migrations | Supabase **session pooler** (port 5432) | The direct host is IPv6-only on the free plan; the session pooler supports the session-level transactions migrations need |
| S3 bucket | Supabase Storage, private bucket, signed URLs | Same provider and region |
| Testcontainers Postgres for integration tests | **PGlite** (real PostgreSQL compiled to WASM, run in-process) locally and in CI. Timing budgets measured against the Supabase staging project | No Docker on the dev machine. PGlite runs every migration from empty, as NFR-16 requires |
| OIDC single sign-on | Magic-link email through Resend | See OD-01 |

## Known gaps at P0 sign-off (24 Nov 2026)

- **Realtime tokens:** the Supabase project signs with asymmetric (ES256) keys. The app mints HS256 tokens, so it needs the project's *legacy* JWT secret in `SUPABASE_JWT_SECRET`. Until that is set, clients fall back to polling. Server-side publishing works.
- **Owner sign-in in production** needs `RESEND_API_KEY` (magic-link email). Without it only the demo button works.
