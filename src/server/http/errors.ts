// One error envelope for every route (ARC-08) with the status codes in ARC-09.

export type ErrorCode =
  | 'validation' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'gone'
  | 'too_large' | 'unsupported_type' | 'rule_violation' | 'client_outdated' | 'rate_limited'
  | 'unavailable' | 'files_unavailable' | 'internal'
  // Intake answers (ING-10, ING-20)
  | 'body_invalid' | 'file_type_mismatch' | 'file_type_not_allowed';

const STATUS: Record<ErrorCode, number> = {
  validation: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, gone: 410,
  too_large: 413, unsupported_type: 415, rule_violation: 422, client_outdated: 426, rate_limited: 429,
  unavailable: 503, files_unavailable: 503, internal: 500,
  body_invalid: 400, file_type_mismatch: 415, file_type_not_allowed: 415,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = () => new ApiError('not_found', 'Not found.');
export const unauthenticated = () => new ApiError('unauthenticated', 'Please sign in.');
export const forbidden = () => new ApiError('forbidden', 'You do not have permission to do that.');

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

/** Unexpected errors never expose exception text (ARC-08). */
export function toErrorBody(err: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.status, body: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } };
  }
  return { status: 500, body: { code: 'internal', message: 'Something went wrong', requestId } };
}
