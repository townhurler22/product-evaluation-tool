// Statement budget registry (NFR-21). PT-16 tests and the production alert both read this.
// Key: route template ("METHOD /api/...") or service method name. Value: max data statements.

export const STATEMENT_BUDGETS = {
  'GET /api/healthz': 0,
  'GET /api/readyz': 1,
  'GET /api/me': 1,                       // preamble only (ARC-07)
  'POST /api/auth/magic-link': 4,         // rate window, user lookup, insert link, audit
  'GET /api/auth/callback': 6,
  'POST /api/auth/demo': 4,
  'POST /api/auth/sign-out': 2,
  'POST /api/internal/jobs/drain': 3,     // claim + finish per batch; job bodies count separately
  'POST /api/core/realtime/token': 2,     // preamble + 1 per jb.board channel (clients ask for one board at a time)
  'GET /api/core/share-links': 3,           // principal + policy + list
  'POST /api/core/share-links': 5,          // principal + policy + module create guard + insert + audit
  'PATCH /api/core/share-links/:id': 5,
  'POST /api/core/share-links/:id/revoke': 5,
  // Workspace admin console (ARC-16). The preamble counts as 1 on a principal-cache miss.
  'GET /api/core/admin/users': 2,
  'PATCH /api/core/admin/users/:id': 6,          // lock row, admin count, update, audit
  'GET /api/core/admin/settings': 2,
  'PUT /api/core/admin/settings': 13,            // one upsert per key (at most 10), audit, read back
  'GET /api/core/admin/audit': 2,
  'GET /api/core/admin/jobs': 2,
  'POST /api/core/admin/jobs/:id/retry': 3,
  'GET /api/core/admin/intake/clients': 5,       // clients, keys, outcome counts, module pause
  'POST /api/core/admin/intake/clients': 4,
  'PATCH /api/core/admin/intake/clients/:id': 4,
  'POST /api/core/admin/intake/clients/:id/keys': 6,
  'POST /api/core/admin/intake/clients/:id/keys/:keyId/revoke': 3,
  'GET /api/core/admin/intake/clients/:id/log': 2,
  'POST /api/core/admin/intake/reviews': 3,
  'PUT /api/core/admin/intake/pause': 3,
  'PUT /api/core/admin/users/:id/fh-grant': 4,   // user check, upsert grant, audit
  // Feedback Hub (P1). Each budget includes the preamble (1 on a principal-cache miss).
  'GET /api/fh/lookups': 3,                // one json_agg statement + settings (cached 60 s)
  'GET /api/fh/ideas': 4,                  // page with aggregates for the page ids + total (PERF-B05)
  'GET /api/fh/ideas/facets': 2,
  'POST /api/fh/ideas/ids': 2,
  'POST /api/fh/ideas': 6,                 // insert, history, roll-up, match job, row (PERF-B01)
  'GET /api/fh/ideas/:id': 2,              // summary (PERF-B04: ≤ 3)
  'GET /api/fh/ideas/:id/evidence': 3,
  'GET /api/fh/ideas/:id/activity': 2,
  'GET /api/fh/ideas/:id/matches': 2,
  'GET /api/fh/ideas/:id/comments': 2,
  'POST /api/fh/ideas/:id/comments': 3,
  'PATCH /api/fh/comments/:id': 3,
  'DELETE /api/fh/comments/:id': 3,
  'PATCH /api/fh/ideas/:id': 7,            // lock, labels, write, activity, match job, row
  'PUT /api/fh/ideas/:id/status': 6,
  'PUT /api/fh/ideas/:id/type': 6,
  'PUT /api/fh/ideas/:id/dates': 5,
  'PUT /api/fh/ideas/:id/companies': 8,
  'PUT /api/fh/ideas/:id/people': 8,
  'PUT /api/fh/ideas/:id/themes': 8,
  'POST /api/fh/ideas/:id/insights': 9,
  'DELETE /api/fh/insights/:id': 10,       // includes file removal after commit
  'POST /api/fh/ideas/:id/merge': 14,      // lock, insights, 5 link sets, write, roll-ups, merge event, activity, audit, row
  'POST /api/fh/ideas/delete': 6,
  'POST /api/fh/ideas/bulk/accept': 5,
  'POST /api/fh/ideas/bulk/status': 6,
  'POST /api/fh/ideas/bulk/themes': 7,
  'POST /api/fh/ideas/export': 3,          // rows + audit (PERF-B21)
  'GET /api/fh/roadmap': 2,
  'GET /api/fh/board': 3,                  // every column's first page + totals
  'GET /api/fh/features': 3,
  'POST /api/fh/features': 7,
  'PATCH /api/fh/features/:id': 10,        // subtree move rewrites depth and closure in one transaction
  'DELETE /api/fh/features/:id': 4,
  'GET /api/fh/journeys': 3,
  'DELETE /api/fh/journeys/:id': 4,
  'GET /api/fh/themes': 3,
  'POST /api/fh/themes': 3,
  'PATCH /api/fh/themes/:id': 3,
  'DELETE /api/fh/themes/:id': 3,
  'GET /api/fh/milestones': 3,
  'POST /api/fh/milestones': 2,
  'PATCH /api/fh/milestones/:id': 2,
  'DELETE /api/fh/milestones/:id': 3,
  'POST /api/fh/milestones/assign': 6,
  'GET /api/fh/saved-views': 2,
  'POST /api/fh/saved-views': 2,
  'PATCH /api/fh/saved-views/:id': 3,
  'DELETE /api/fh/saved-views/:id': 3,
  'GET /api/fh/companies': 2,
  'GET /api/fh/people': 2,
  // Feedback Hub P2: triage, intake, people and reporting.
  'GET /api/fh/ideas/triage-counts': 2,        // one statement for the source chips and both Accept-all counts
  'GET /api/fh/ideas/:id/images': 3,           // files of the idea's insights, then the live core_file rows to sign
  'POST /api/fh/companies': 8,                 // domain check, insert, adopt, affected ideas, roll-ups, audit, detail
  'GET /api/fh/companies/:id': 2,
  'PATCH /api/fh/companies/:id': 10,           // lock, domain check, release, update, adopt, affected, roll-ups, audit, detail
  'POST /api/fh/companies/delete': 6,          // affected, detach + counts, delete, roll-ups, audit
  'POST /api/fh/people': 4,
  'GET /api/fh/people/:id': 2,
  'PATCH /api/fh/people/:id': 7,
  'POST /api/fh/people/erase': 14,             // exists, audit, FH erasePerson ≤ 8, files ≤ 2, delete, audit (any batch size)
  'GET /api/fh/reporting': 3,                  // one read of fh_reporting_mv (FH-854); + a debounced refresh job when stale
  // Feedback Hub P3: forum administration and publishing.
  'GET /api/fh/forums': 2,                     // forums with post counts and share links in one statement
  'POST /api/fh/forums': 4,                    // insert (slug clash via ON CONFLICT), audit, read back
  'GET /api/fh/forums/:id': 2,
  'PATCH /api/fh/forums/:id': 6,               // lock, clear previous main, update, audit, read back
  'GET /api/fh/forums/:id/posts': 2,           // page with voters, linked ideas and total in one statement
  'PATCH /api/fh/forums/:id/posts/:postId': 3,
  'DELETE /api/fh/forums/:id/posts/:postId': 12, // lock, ideas, files, delete ideas, delete post, roll-ups, audit, files ≤ 2, rows
  'POST /api/fh/forums/:id/posts/:postId/team-vote': 3,
  'DELETE /api/fh/forums/:id/posts/:postId/team-vote': 3,
  'GET /api/fh/status-config': 2,
  'PUT /api/fh/status-config': 4,
  'POST /api/fh/ideas/publish/preview': 3,     // main forum, ideas
  // FH-412 asks for one transaction per idea, so this grows with the request (≤ 50 items): main forum + 3 per idea +
  // audit + the changed rows. The PT-16 check is that it stays at 3 per idea on any fixture size.
  'POST /api/fh/ideas/publish': 155,
  // Public forum share routes (§11.3). Pipeline: link lookup (with the password-failure count) + resolver = 2.
  // Writes add: visitor lookup, IP and visitor limits, use consumption and the use row (≤ 5). PT-19: reads ≤ 3.
  'GET /api/share/:token/fh/forum': 3,
  'GET /api/share/:token/fh/forum/posts': 3,
  'GET /api/share/:token/fh/forum/roadmap': 3,
  'GET /api/share/:token/fh/forum/similar': 3,
  'GET /api/share/:token/fh/posts/:postId/images': 4,
  'POST /api/share/:token/fh/posts': 17,       // pipeline 7 + author ≤ 2, post, idea, insight, files, roll-up, match job, read back
  'PATCH /api/share/:token/fh/posts/:postId': 9,
  'POST /api/share/:token/fh/posts/:postId/vote': 10,
  'DELETE /api/share/:token/fh/posts/:postId/vote': 9,
  // Intake (§10): gateway ≤ 5 (key, rate window, receipt check, log, last used) + the accepted transaction ≤ 14 (ING-22).
  'POST /api/ingest/fh/v1/call-requests': 19,
  'POST /api/ingest/fh/v1/support-submissions': 19,
  // Journey Boards (§11.2). Board access is 1 statement (D-23); content is 4 (PERF-24).
  'GET /api/jb/boards': 2,                         // metadata only (PERF-24, PT-09)
  'POST /api/jb/boards': 11,                       // journey checks 2, board + fields + nodes + edges, content 4
  'GET /api/jb/boards/:id/content': 5,             // access, nodes, edges, fields
  'GET /api/jb/boards/:id/changes': 3,
  'POST /api/jb/boards/:id/ops': 12,               // access, lock+replay, ≤ 2 per table, integrity, change+counters, replay race
  'PATCH /api/jb/boards/:id/viewport': 3,
  'PATCH /api/jb/boards/:id/access': 4,
  'DELETE /api/jb/boards/:id': 7,
  'POST /api/jb/boards/:id/transfer': 6,
  'GET /api/jb/boards/:id/comments': 3,
  'POST /api/jb/boards/:id/comments': 6,
  'POST /api/jb/boards/:id/comments/:threadId': 6,
  'PATCH /api/jb/boards/:id/comments/:threadId': 5,
  'DELETE /api/jb/boards/:id/comments/:threadId': 4,
  'PATCH /api/jb/boards/:id/comments/:threadId/messages/:messageId': 6,
  'DELETE /api/jb/boards/:id/comments/:threadId/messages/:messageId': 7,
  'GET /api/jb/boards/:id/collaborators': 4,
  'POST /api/jb/boards/:id/collaborators': 5,
  'PATCH /api/jb/boards/:id/collaborators': 4,
  'DELETE /api/jb/boards/:id/collaborators': 4,
  'GET /api/jb/boards/:id/images': 4,              // access, jb_image, core_file (+ signing, no SQL)
  'POST /api/jb/boards/:id/images': 4,
  'POST /api/jb/boards/export': 5,                 // access for all boards, nodes, edges, fields (≤ 20 boards)
  'POST /api/jb/boards/import': 10,                // boards and journeys: 4 inserts each level, list 1
  // Journey mapping and demand (P5, §9). Each includes the preamble (1 on a principal-cache miss).
  'GET /api/jb/boards/:id/overlay': 4,             // access, board-scoped links + cards, demandForSets (PERF-30, PERF-B16)
  'GET /api/jb/boards/:id/nodes/:nodeId/demand': 4, // the overlay's sets for one card (INT-48)
  'GET /api/jb/boards/:id/nodes/:nodeId/journey': 4,
  'GET /api/jb/boards/:id/nodes/:nodeId/ideas': 4,  // access, links, ideasUnder (1)
  'GET /api/jb/boards/:id/nodes/:nodeId/breakdown': 4,
  'GET /api/jb/boards/:id/feature-search': 3,
  'GET /api/jb/boards/:id/nodes/:nodeId/links': 4,
  'POST /api/jb/boards/:id/nodes/:nodeId/links': 6, // access, live card, Feature exists, create, notify
  'DELETE /api/jb/boards/:id/nodes/:nodeId/links': 4,
  'POST /api/jb/boards/:id/nodes/:nodeId/journey-sync': 18, // fixed whatever the number of boards (PERF-B19, PT-18)
  'GET /api/fh/features/:id/cards': 3,             // link read by the to-end + one card resolve (INT-52)
  'GET /api/fh/journeys/:id/cards': 3,
  // Cross-module service methods (§11.4, ARC-02, ARC-18): fixed statements whatever the input size, up to their caps.
  'feedbackHub.demandForSets': 1,
  'feedbackHub.ideasUnder': 1,
  'feedbackHub.breakdown': 1,
  'feedbackHub.searchFeatures': 1,
  'feedbackHub.resolveFeatures': 1,
  'feedbackHub.resolveJourneys': 1,
  'feedbackHub.featureAncestors': 1,
  'feedbackHub.ensureJourneyComponent': 4,
  'feedbackHub.assignJourneyIdeas': 1,
  'journeyBoards.resolveCards': 1,
  'core.links.linksForBoard': 1,
  'core.links.listFrom': 1,
  'core.links.listTo': 1,
  'core.links.scopesLinkedTo': 1,
  'core.links.replaceFrom': 2,
} as const satisfies Record<string, number>;

export type BudgetKey = keyof typeof STATEMENT_BUDGETS;
