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
} as const satisfies Record<string, number>;

export type BudgetKey = keyof typeof STATEMENT_BUDGETS;
