// Feedback Hub authorisation (ARC-13, §12.1). Members read and create ideas; feedback admins change data.
import { ApiError } from '@/server/http/errors';
import type { Principal } from '@/modules/core/service';

export function requireMember(p: Principal | null): asserts p is Principal {
  if (!p) throw new ApiError('unauthenticated', 'Please sign in.');
}

export function requireAdmin(p: Principal | null): asserts p is Principal {
  requireMember(p);
  if (!p.isFeedbackAdmin) throw new ApiError('forbidden', 'Only feedback admins can change this.');
}
