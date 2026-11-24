// Effective board rights (§8.13). The one pure function every route, the board list, realtime channel
// authorisation, the service interface and the share resolver use. A journey is judged by its parent.

export type CollaboratorRole = 'EDITOR' | 'COMMENTER' | 'VIEWER';
export type EffectiveRole = 'manager' | 'owner' | 'editor' | 'commenter' | 'viewer' | 'workspace' | 'none';

export interface RightsInput {
  isWorkspaceAdmin: boolean;
  isOwner: boolean;
  collaboratorRole: CollaboratorRole | null;
  /** The root board's switch (a journey's own is always off). */
  workspaceCanEdit: boolean;
}

export interface Rights { role: EffectiveRole; canView: boolean; canEdit: boolean; canComment: boolean; canManage: boolean }

export function effectiveRights(i: RightsInput): Rights {
  const wce = i.workspaceCanEdit;
  if (i.isWorkspaceAdmin) return { role: 'manager', canView: true, canEdit: true, canComment: true, canManage: true };
  if (i.isOwner) return { role: 'owner', canView: true, canEdit: true, canComment: true, canManage: true };
  // JB-1301: a collaborator role never reduces rights below what workspace edit gives.
  switch (i.collaboratorRole) {
    case 'EDITOR': return { role: 'editor', canView: true, canEdit: true, canComment: true, canManage: false };
    case 'COMMENTER': return { role: 'commenter', canView: true, canEdit: wce, canComment: true, canManage: false };
    case 'VIEWER': return { role: 'viewer', canView: true, canEdit: wce, canComment: wce, canManage: false };
  }
  if (wce) return { role: 'workspace', canView: true, canEdit: true, canComment: true, canManage: false };
  return { role: 'none', canView: false, canEdit: false, canComment: false, canManage: false };
}

/** JB-1402 / SEC-08: could this user share the board outward? Judged with workspace edit off. */
export const canShareOutward = (i: RightsInput) => effectiveRights({ ...i, workspaceCanEdit: false }).canView;
