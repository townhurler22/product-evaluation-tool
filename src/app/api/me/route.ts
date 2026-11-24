import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/me', auth: 'required' }, async ({ principal }) => ({
  userId: principal!.userId,
  role: principal!.role,
  isFeedbackAdmin: principal!.isFeedbackAdmin,
  canDeletePosts: principal!.canDeletePosts,
  isWorkspaceAdmin: principal!.isWorkspaceAdmin,
}));
