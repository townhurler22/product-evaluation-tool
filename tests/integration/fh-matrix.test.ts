// NFR-16: authorisation matrix for every Feedback Hub route, generated from the route files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll, specQ } from '../fh';
import { clearPrincipalCache } from '@/modules/core/auth/principal';

const UX = '0190c3a0-0000-7000-8000-0000000000a1';
let member: string, pm: string;

// One database for the whole matrix: every call either fails the access check or touches a missing id.
beforeAll(async () => {
  const ctx = await freshDb();
  ({ member, pm } = await signInAll(ctx.pg));
}, 120_000);

// NFR-16 authorisation matrix for every Feedback Hub route: anonymous 401; members read but cannot change (403);
// feedback admins pass the access check. Generated from the route files so a new route cannot be missed.
describe('authorisation matrix (NFR-16)', () => {
  const ID = '0190c3a0-0000-7000-8000-000000000123';
  const ADMIN_ONLY: Record<string, unknown> = {
    'PATCH ideas/[id]': { title: 'x' }, 'PUT ideas/[id]/status': { status: 'IDEA_BACKLOG' }, 'PUT ideas/[id]/type': { ideaType: 'BUG' },
    'PUT ideas/[id]/dates': { startDate: '2026-01-01', dueDate: '2026-01-02' }, 'PUT ideas/[id]/companies': { ids: [] },
    'PUT ideas/[id]/people': { ids: [] }, 'PUT ideas/[id]/themes': { ids: [] }, 'POST ideas/[id]/insights': { value: 'x' },
    'DELETE insights/[id]': undefined, 'POST ideas/[id]/merge': { targetId: ID }, 'POST ideas/delete': { ids: [ID] },
    'POST ideas/bulk/accept': { ids: [ID] }, 'POST ideas/bulk/status': { ids: [ID], status: 'IDEA_BACKLOG' },
    'POST ideas/bulk/themes': { ids: [ID], themeId: UX, action: 'add' }, 'GET ideas/[id]/comments': undefined,
    'POST ideas/[id]/comments': { body: 'x' }, 'PATCH comments/[id]': { body: 'x' }, 'DELETE comments/[id]': undefined,
    'POST features': { name: 'x' }, 'PATCH features/[id]': { name: 'x' }, 'DELETE features/[id]': undefined,
    'DELETE journeys/[id]': undefined, 'POST themes': { name: 'x' }, 'PATCH themes/[id]': { name: 'x' }, 'DELETE themes/[id]': undefined,
    'POST milestones': { name: 'x', date: '2026-01-01' }, 'PATCH milestones/[id]': { name: 'x' }, 'DELETE milestones/[id]': undefined,
    'POST milestones/assign': { ids: [ID], milestoneId: null },
    // P2
    'POST companies': { name: 'x' }, 'PATCH companies/[id]': { name: 'x' }, 'POST companies/delete': { ids: [ID] },
    'POST people': { displayName: 'x' }, 'PATCH people/[id]': { displayName: 'x' },
    'POST people/erase': { ids: [ID], confirm: 'ERASE' },
    // P3
    'GET forums': undefined, 'POST forums': { name: 'x' }, 'GET forums/[id]': undefined, 'PATCH forums/[id]': { name: 'x' },
    'GET forums/[id]/posts': undefined, 'PATCH forums/[id]/posts/[postId]': { title: 'x' },
    'POST forums/[id]/posts/[postId]/team-vote': undefined, 'DELETE forums/[id]/posts/[postId]/team-vote': undefined,
    'GET status-config': undefined, 'PUT status-config': { items: [{ statusKey: 'IDEA_OPEN', isPublic: false, label: null, kind: null }] },
    'POST ideas/publish/preview': { ids: [ID] }, 'POST ideas/publish': { forumId: ID, items: [{ ideaId: ID, title: 'x' }] },
  };
  // OD-03 / SEC-02: the post-delete grant, never implied by a role. Feedback admins without it are refused too.
  const GRANT_ONLY: Record<string, unknown> = { 'DELETE forums/[id]/posts/[postId]': undefined };
  const MEMBER: Record<string, unknown> = {
    'GET lookups': undefined, 'GET ideas': undefined, 'POST ideas': { title: 'x' }, 'GET ideas/facets': undefined,
    'POST ideas/ids': { viewSpec: {} }, 'POST ideas/export': { viewSpec: {}, columns: ['title'] }, 'GET ideas/[id]': undefined,
    'GET ideas/[id]/evidence': undefined, 'GET ideas/[id]/activity': undefined, 'GET ideas/[id]/matches': undefined,
    'GET roadmap': undefined, 'GET board': undefined, 'GET features': undefined, 'GET journeys': undefined, 'GET themes': undefined,
    'GET milestones': undefined, 'GET saved-views': undefined, 'POST saved-views': { name: 'x', config: { version: 1, view: 'all' } },
    'PATCH saved-views/[id]': { name: 'x' }, 'DELETE saved-views/[id]': undefined, 'GET companies': undefined, 'GET people': undefined,
    // P2
    'GET companies/[id]': undefined, 'GET people/[id]': undefined, 'GET reporting': undefined,
    'GET ideas/triage-counts': undefined, 'GET ideas/[id]/images': undefined,
  };
  const root = join(process.cwd(), 'src', 'app', 'api', 'fh');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : [];
  });
  const routes = walk(root).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)]
    .map((m) => ({ key: `${m[1]} ${relative(root, f).split(sep).slice(0, -1).join('/')}`, file: f, method: m[1] })));

  it('covers every Feedback Hub route', () => {
    expect(routes.map((r) => r.key).sort()).toEqual([...Object.keys(ADMIN_ONLY), ...Object.keys(MEMBER), ...Object.keys(GRANT_ONLY)].sort());
  });

  for (const key of Object.keys(GRANT_ONLY)) {
    it(`${key} (grant only)`, async () => {
      const r = routes.find((x) => x.key === key)!;
      const h = (await import(/* @vite-ignore */ r.file))[r.method];
      const opts = { method: r.method, path: `/api/fh/${key.split(' ')[1]}`, params: { id: ID, postId: ID } };
      expect((await call(h, opts)).status).toBe(401);
      expect((await call(h, { ...opts, cookie: member })).status).toBe(403);
      clearPrincipalCache();
      expect((await call(h, { ...opts, cookie: pm })).status).toBe(403);
    });
  }

  for (const key of [...Object.keys(ADMIN_ONLY), ...Object.keys(MEMBER)]) {
    it(`${key}`, async () => {
      const r = routes.find((x) => x.key === key)!;
      const mod = await import(/* @vite-ignore */ r.file);
      const h = mod[r.method];
      const path = `/api/fh/${key.split(' ')[1].replace('[id]', ID)}?${key.startsWith('GET') ? `${specQ()}&column=status&from=2026-01-01&to=2026-02-01` : ''}`;
      const opts = { method: r.method, path, params: { id: ID }, body: key in ADMIN_ONLY ? ADMIN_ONLY[key] : MEMBER[key] };
      expect((await call(h, opts)).status).toBe(401);
      const asMember = (await call(h, { ...opts, cookie: member })).status;
      if (key in ADMIN_ONLY) expect(asMember).toBe(403);
      else expect([401, 403]).not.toContain(asMember);
      clearPrincipalCache();
      expect([401, 403]).not.toContain((await call(h, { ...opts, cookie: pm })).status);
    });
  }
});
