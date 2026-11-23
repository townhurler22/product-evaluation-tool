# Product Evaluation Tool

Collect what clients ask for, triage it into a roadmap, and see where demand sits on your user-journey maps.
One app with two modules, **Feedback Hub** and **Journey Boards**, built to `SPEC.md` in the phase order of SPEC §15.
Product decisions and deviations from the spec are recorded in `DECISIONS.md`.

## Status
- [x] P0 built: Core schema and migrations, magic-link and demo sign-in, request lifecycle with Server-Timing and statement budgets, job queue, intake gateway (§10), share pipeline (§12.2), files, realtime authorisation, admin console, fixture and demo seed, CI. 138 tests.
- [ ] P0 sign-off: deploy the demo instance to Vercel, run `pnpm supabase:setup` and `pnpm perf:p0 <url>` (PT-06, PT-07, PT-08, ARC-32), then migrate the private instance
- [ ] P1 Feedback Hub core · P2 Triage and intake · P3 Public forum · P4 Journey Boards · P5 Journey mapping and demand

## Develop
```bash
pnpm install
pnpm test        # unit + integration tests on in-process PostgreSQL (PGlite)
pnpm dev
```
Copy `.env.example` to `.env.local`. With no `RESEND_API_KEY`, sign-in links are printed to the dev console.

## Deploy
`pnpm db:migrate` runs as its own step before a deploy (NFR-41). Hosting: Vercel (`dub1`) + Supabase (`eu-west-1`).
