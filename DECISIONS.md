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

## P1 Feedback Hub core: deviations and notes (24 Nov 2026)

Flagged to the product owner per §0 rule 6. Each is the nearest sound version of the spec rule.

| Spec | Built | Why |
|---|---|---|
| `fh_idea.merged_into_id` FK `ON DELETE SET NULL` (§6.3) | `ON DELETE CASCADE` | Deleting a merge target with SET NULL would bring its tombstones back to life as live ideas. Cascading removes tombstones whose target is gone |
| `fh_feature_demand` maintained by write paths (§4.11) | Maintained by a trigger on `fh_idea` in the same transaction | Same consistency, and no write path (create, delete, merge, Feature, status or type change, Feature delete via `SET NULL`) can forget it. Nightly reconciliation still checks it |
| Feature depth trigger (INV-09) | Deferred constraint trigger checked at commit | A subtree move updates every row in one statement; a row-level check would see half-moved trees |
| `GET ideas` | Also accepts `?ids=` (≤ 100) to reload specific rows | Needed for a deep-linked panel (PERF-12) and the "Reload" action after a 409 (FH-104), without a full list refetch |
| `?feature=` deep link "applies a Feature column filter covering the Feature and its descendants" (FH-003) | Selects the Feature in the rail with "Include sub-features" on | Same rows; the filter stays visible and clearable. Unknown ids are ignored |
| Forum tables (`fh_forum`, `fh_post`, `fh_idea_post`, `fh_vote`) | Created in P1; write paths in P3 | The roll-up definition (FH-504) and merge (FH-452) read and move them now. `fh_status_config`, `fh_vote_event` and `fh_reporting_mv` wait for the phases that use them (D-37) |
| CSV export streams (FH-157) | One statement reads up to 50,000 rows; the response body streams in 500-row chunks | PGlite has no server-side cursors, and a fixed statement count keeps PT-16 stable. First bytes depend on the query time (PT-20 measures it) |
| §7.7 Triage, publish to forum (FH-411–413) | Not in P1 | Needs the forum (P3). Accept, Unreviewed and duplicate matching are built |
| Company missing excludes internal calls (FH-405) | Not yet | Internal calls arrive with intake in P2 |
| Screenshots section and `GET ideas/:id/images` (FH-218) | Not in P1 | Images come only from intake insights (P2) and forum posts (P3) |
| "Mapped on boards" (FH-222, FH-605, FH-655), `features/:id/cards`, `journeys/:id/cards` | Placeholder text | Needs Journey Boards' `resolveCards` (P4) and card links (P5) |
| `feedbackHub` cross-module service (§11.4) | Not in P1 | Its callers are Journey mapping (P5). The data it reads (closure, demand counts, in-flight index) is in place |
| Companies and people (§7.14) | Read-only, searchable pickers (`GET fh/companies`, `GET fh/people`, ≤ 50 rows) | Management is P2. People pickers never return emails |
| Column reorder by drag (FH-111) | "Move up / Move down" in the Columns menu; widths by drag or arrow keys on the resize handle | The keyboard path NFR-02 requires; drag reorder can follow |
| Left rail on narrow screens | Hidden below 768 px | Staff editing targets ≥ 1280 px (NFR-11); filters from the rail stay applied |
| NFR-07 axe-core in Playwright and screen-reader pass; NFR-17 E2E journeys | Not run | There is no Playwright harness yet (same as P0). Grid semantics, focus management, labels and live regions are built in; the pass is owed before P6 |
| PT-04 (scroll 5,000 rows at 60 fps), PT-05 client half, PT-01 paint | Not automated | Browser measurements. `scripts/perf-p1.ts` measures the server halves; PT-04 is a DevTools check |
| Timing budgets at fixture scale | Measured on the live data by `pnpm perf:p1 <url>` | Per OD-02 the synthetic fixture never loads into the live database. Statement counts and payload sizes are proven at 1× and 10× on PGlite (PT-16) |

New dependencies: `@tanstack/react-query` 5 (client cache, §4.3 default) and `@tanstack/react-virtual` 3 (virtualised table and board columns). Both are actively maintained by TanStack.

Operations: re-run `pnpm supabase:setup` to add the nightly `fh.reconcile` cron job, and `pnpm db:migrate` before deploying P1 (migration `0003_fh_core`).

## P4 Journey Boards: choices and deviations (24 Nov 2026)

| Topic | Decision | Why |
|---|---|---|
| Canvas library | **@xyflow/react 12** (React Flow, MIT, maintained by xyflow). PERF-21 already assumes it | Pan, zoom, viewport culling (`onlyRenderVisibleElements`), handles, connections, rubber-band selection and a minimap would otherwise be hand-written. Its own keyboard handling is off; the board handles the NFR-04 keys |
| Board ids | `jb_board.id` is text as in §6.4, but board ids are **always UUIDs** (a client-supplied id must be a UUID) | `core_share_link.target_id` is `uuid` and the share-links route validates UUIDs. Node, edge and field ids stay free text (`[A-Za-z0-9_-]{1,64}`) |
| Patch merge depth | Data merges one level deep (JB-1601) **plus** `fieldValues.<fieldId>` keys merge one level deeper (SQL function `jb_merge_data`) | Two people setting different field values on one card must both win (JB-1605, JB-1703 key `fieldValues.<fieldId>`) |
| Restore ops | The server fills `value` (the restored row) into stored restore ops | Tombstones are never sent on load (D-22), so other clients need the row to show it |
| Batch statements | Lock, seq and replay check are one statement; change row, counters and board patch are one; at most 2 per table; at most 1 integrity query. A 50-op patch batch is 4 statements plus the preamble; the route budget is 12 for the worst mixed batch | PERF-25 / PT-13: ≤ 8 for a 50-op batch and equal on 200 and 2,000 nodes (tested) |
| Arrow keys | Arrows move **focus** to the nearest card (NFR-04); **Alt+arrows** move the selection by 8, Shift+Alt by 1 | JB-204 and NFR-04 disagree on plain arrows; accessibility wins. Flagged to the product owner |
| Live updates fallback | Realtime needs `SUPABASE_JWT_SECRET` (server) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (browser). Without them a board polls `changes?since=` every 1 s while visible (10 s hidden); presence and cursors are then off, quietly | Production has no legacy JWT secret yet (P0 known gap). Polling converges through seq ordering |
| Image downscaling | On the **server** with sharp (long edge over 2,560 px becomes JPEG 0.9) before metadata stripping | One place, same result for every client. The 5 MB cap still applies |
| Image cache | Signed URLs are cached in memory per board view, not in IndexedDB; offline image uploads are not queued | Deviation from JB-1803; low value at demo scale |
| Import parsing | Validated on the server with the route schema (first error path returned), not in a Web Worker; export does not embed images; large rebases run on the main thread | Deviation from JB-1901/1902 and PERF-06 |
| Not built in P4 | Ctrl/Cmd+K cross-board search (JB-107); smart-guide lines (JB-204; the 512-unit grid exists in `DragSession`); "Create sub-item / linked card" when a connection is dropped on empty canvas (JB-701); reparent by dropping onto a card (JB-802; a "Parent" picker in the panel instead); touch box-select (JB-203); bulk align, distribute and Set field (JB-206); "mixed" state in a multi-select text toolbar (JB-602) | Each is additive. Detailed-journey creation exists in the API; the "Detailed journey" button belongs to P5 (§9.2). The Product card panel has an extension slot (`productPanelSlots`) and the node registry is shared |
| Sanitiser | `src/lib/text.ts` (SEC-13, SEC-15), applied server-side to board names and node and connector text keys | Feedback Hub needs the same functions; keep one copy when P1 merges |
| Core service interface | `src/modules/core/service.ts` re-exports what other modules may use | The ARC-03 lint rule only allows `@/modules/core/service` from `src/modules/jb/**` |
| Registrations | `src/server/registrations.ts` imports `@/modules/jb/register` (channel rule, share resolver and policy, file owner resolver, `jb.compact` job); the realtime token and share-link routes import it. `db/supabase/setup.sql` schedules `jb.compact` nightly | Registries fill at import time, as with jobs |

**Timing budgets (PT-09 to PT-13, PT-15)** are not measured here. `pnpm perf:p4 https://<deployment>` measures PT-09, PT-10 (server side), PT-13 and PT-15 on boards it creates (named `[perf-p4] …`, deleted afterwards) and prints the browser-only checks (PT-10 interactive time, PT-11, PT-12) as MANUAL steps. Statement counts are tested on PGlite, including the base and 10× fixture (PT-16).

## P5 Journey mapping and demand: choices and deviations (27 Nov 2026)

OD-16 to OD-19: recommended defaults (a), as confirmed above. Flagged to the product owner per §0 rule 6.

| Spec | Built | Why |
|---|---|---|
| Overlay link read on `core_link (from_scope_id, relation)` joined to `jb_board_scope` (PERF-30) | Core's `links.linksForBoard` reads, in **one statement**, the boards in scope, their live Product cards and their links. Journey Boards publishes two read-only contract views: `jb_board_scope` gains `parent_node_id`, and new `jb_card_scope` lists live Product cards (§6.7) | Only live cards contribute demand (INT-10); without the card list in the same statement the overlay would need a 5th statement |
| `demandForSets` returns counts, dates and gone Feature ids | Also takes optional `journeyIds` (gone Journeys) and `describe` (Feature refs with path and sub-feature counts), same statement | Attention for top-level cards and the panel's Feature list without extra statements (PERF-B16, INT-48) |
| Caps: §11.4 says 500 sets / 200 ids, INT-47 says 5,000 / 2,000 | 5,000 sets, 2,000 ids per set | The looser of the two; the statement count is unchanged |
| `ideasUnder` and `breakdown`: 2 statements | 1 statement each (total and page together) | Within budget |
| `assignJourneyIdeas(journeyId, featureIds)` | Batched `{assignments: [{journeyId, featureIds}]}`, one statement with data-modifying CTEs | INT-20 re-assigns every Journey left behind at a fixed statement count |
| Sync order "(a) Core link write, (b) Feedback Hub ensure and assign" (INT-24) | (1) ensure, (2) assign the target (with this card) and every Journey left behind (without it), (3) replace the card's link | The link write needs the ensured id; assigning left-behind Journeys before the link moves makes every partial failure converge on rerun (tested by injecting failures at steps 2 and 3) |
| `jb.demand.notify` after idea writes (PERF-31, INT-53) | Statement-level triggers (0006) on `fh_idea`, `fh_feature` and `fh_journey` mark changed Features or Journeys in `fh_demand_dirty` and queue one deduplicated `jb.demand.notify` job | No write path, including P2 intake, can forget. Feedback Hub still writes nothing on boards. The trigger inserts into `core_job` from SQL: the only cross-module SQL, and it lives in a migration, not module code |
| `demand.changed` on the board channel, no polling (PERF-31) | The job bumps `jb_board.demand_rev` (the board and its parent) and publishes `demand.changed`. Every `changes?since=` response carries `demandRev`; the client refetches the overlay when it moves | Production has no realtime yet (P0 known gap). Boards already poll every 1 s, so attention flags arrive within the poll interval (D-27) with no extra request |
| Debounce `jb.demand.notify` 2 s per board | One queued job per dedupe key, drained straight after the response; no 2 s per-board delay | D-27 needs the flag within 1 s; the job is 5 statements whatever the number of boards |
| Job drain | `drainJobs` claims only kinds the process has handlers for; Feedback Hub's after-response drain imports the job registry | A function bundle without the handler no longer burns an attempt and backs off a minute |
| Detailed journey name "<card title> — journey" (INT-06) | "<card title>: detailed journey" | No em dashes in UI copy |
| INT-08 breadcrumb "parent board › card title", "Card deleted", and a "Detailed journeys" list in parent board settings | Breadcrumb "parent board › Product card", the second part a deep link that opens the card or says "That card no longer exists" (JB-105); the journey's name already carries the card title. No "Detailed journeys" list yet | Needs a parent-card read outside the budgets; listed as not built |
| INT-18 "names only cards the user can view and counts the rest" | Built as written: `sharedBy {cards, hidden}` | Confirm with the product owner |
| ARC-19 `{available: false}` | Every active staff member reads Feedback Hub (members read, feedback admins write), so it appears only without a principal | §12.1 has no narrower Feedback Hub read grant |
| Breakdown statuses | `byStatus` keys bug statuses as `bug:<STATUS>` | One map; bug and idea statuses share names |
| Not built in P5 | "Detailed journeys" list in board settings; the panel's "Linked to a Journey you cannot see" (cannot occur, see ARC-19); NFR-07 axe-core and E2E (no Playwright harness yet, as P1 and P4); realtime `demand.changed` is tested only as a published event, the polling path end to end | |

Statement counts (PGlite, base and 10× fixture, identical): overlay 4 (PERF-B16 ≤ 4), panel summary 4, ideas 4, breakdown 4, Mapped on boards 3, Journey sync 15 on a first sync that leaves a Journey behind and 13 in steady state, the same with 10 and with 100 boards (PT-18). Service methods are in the budget registry and tested at two input sizes.

**Timing budgets (PT-14, PT-18, D-27 end to end)**: `pnpm perf:p5 https://<deployment>` signs in with the demo button, builds self-labelled data (`[perf-p5] …` Features, ideas, a 40-card board with 40 detailed journeys of 50 cards, links), measures, and deletes all of it afterwards. Never the fixture on the live database.

New dependencies: none. Operations: `pnpm db:migrate` before deploying P5 (migration `0006_jb_mapping`, independent of `0005`).
