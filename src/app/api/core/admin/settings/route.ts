import { getAllSettings, requireWorkspaceAdmin, SettingsPatch, updateSettings } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/settings', auth: 'required' }, async ({ principal }) => {
  requireWorkspaceAdmin(principal);
  return { settings: await getAllSettings() };
});

export const PUT = route({ route: 'PUT /api/core/admin/settings', auth: 'required', body: SettingsPatch }, async ({ principal, body }) => {
  requireWorkspaceAdmin(principal);
  return { settings: await updateSettings(principal, body) };
});
