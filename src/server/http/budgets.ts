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
} as const satisfies Record<string, number>;

export type BudgetKey = keyof typeof STATEMENT_BUDGETS;
