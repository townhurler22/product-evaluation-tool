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
  'POST /api/core/realtime/token': 1,     // preamble; channel rules for boards add 1 in P4
  'GET /api/core/share-links': 3,           // principal + policy + list
  'POST /api/core/share-links': 4,          // principal + policy + insert + audit
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
} as const satisfies Record<string, number>;

export type BudgetKey = keyof typeof STATEMENT_BUDGETS;
