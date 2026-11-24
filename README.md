# Product Evaluation Tool

Collect what clients ask for, triage it into a roadmap, and see where demand sits on your user-journey maps.
One app with two modules, **Feedback Hub** and **Journey Boards**, built to `SPEC.md` in the phase order of SPEC §15.
Product decisions and deviations from the spec are recorded in `DECISIONS.md`.

## Status
- [x] P0 built: Core schema and migrations, magic-link and demo sign-in, request lifecycle with Server-Timing and statement budgets, job queue, intake gateway (§10), share pipeline (§12.2), files, realtime authorisation, admin console, fixture and demo seed, CI. 123 tests.
- [x] P0 signed off 24 Nov 2026 on https://product-evaluation-tool-two.vercel.app (dub1): PT-08 cold start 167 ms, ARC-32 DB round trip p50 3.2 ms, PT-06 preamble p95 6.3 ms with 1 statement, PT-07 20 concurrent p95 893 ms with no 5xx. Supabase setup applied (bucket, realtime policies, pg_cron).
- [x] P1 built (24 Nov 2026): Feedback Hub schema (`0003_fh_core`) with maintained roll-ups, Feature demand and closure, nightly reconciliation; ideas with both workflows, scores, merge, delete and chunked bulk actions; virtualised server-paginated table with facet filters, column layout and saved views; left rail; idea panel with lazy sections; roadmap Gantt and kanban board; CSV export; live updates on `fh.workspace` with a polling fallback; signed-in app shell. 246 tests. Deviations in `DECISIONS.md`.
- [ ] P1 sign-off: run `pnpm db:migrate`, `pnpm supabase:setup`, deploy, then `pnpm perf:p1 https://<deployment>` (PT-01 to 03, 05, 15, 20); PT-04 and the accessibility pass are browser checks
- [ ] P2 Triage and intake · P3 Public forum · P4 Journey Boards · P5 Journey mapping and demand

## Develop
```bash
pnpm install
pnpm test        # unit + integration tests on in-process PostgreSQL (PGlite)
pnpm dev
```
To click through the app without any real database, run `start-dev-pglite.cmd` (Windows): an in-memory PGlite database on http://localhost:3201 with every migration applied and the demo account; it sets every variable itself, so `.env.local` is not used.

Copy `.env.example` to `.env.local`. With no `RESEND_API_KEY`, sign-in links are printed to the dev console.

## Deploy
`pnpm db:migrate` runs as its own step before a deploy (NFR-41). Hosting: Vercel (`dub1`) + Supabase (`eu-west-1`).
