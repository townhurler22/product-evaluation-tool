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
} as const satisfies Record<string, number>;

export type BudgetKey = keyof typeof STATEMENT_BUDGETS;
