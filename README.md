# Product Evaluation Tool

Collect what clients ask for, triage it into a roadmap, and see where demand sits on your user-journey maps.
One app with two modules, **Feedback Hub** and **Journey Boards**, built to `SPEC.md` in the phase order of SPEC §15.
Product decisions and deviations from the spec are recorded in `DECISIONS.md`.

## Status
- [x] P0 slice 1: Core schema, migrations, sessions, magic-link and demo sign-in, error envelope, Server-Timing, statement budgets, job queue, module-boundary lint, CI
- [ ] P0 slice 2: intake gateway, share pipeline, files, realtime authorisation, admin console, fixture seed, staging
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
