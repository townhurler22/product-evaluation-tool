'use client';

// Workspace admin console (ARC-16). Server routes enforce access (SEC-01); this page only shows controls.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type Json = Record<string, unknown>;

async function api<T = Json>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body as T;
}

const TABS = ['Users', 'Intake', 'Settings', 'Audit log', 'Jobs'] as const;
type Tab = (typeof TABS)[number];

const btn = 'rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:border-[var(--accent)] disabled:opacity-50';
const cell = 'border-b border-[var(--border)] px-3 py-2 text-left align-top text-sm';

export default function AdminConsole() {
  const [tab, setTab] = useState<Tab>('Users');
  const [status, setStatus] = useState('');
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    fetch('/api/core/admin/settings').then((r) => setForbidden(r.status === 401 || r.status === 403));
  }, []);

  if (forbidden) return <p className="mt-6">This page is for workspace admins. <Link className="underline" href="/">Back to the start</Link></p>;

  return (
    <div className="mt-6">
      <div role="tablist" aria-label="Admin sections" className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-2">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? 'bg-[var(--accent)] text-white dark:text-black' : 'hover:underline'}`}>
            {t}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="min-h-6 py-2 text-sm text-[var(--muted)]">{status}</p>
      <div role="tabpanel">
        {tab === 'Users' && <Users onStatus={setStatus} />}
        {tab === 'Intake' && <Intake onStatus={setStatus} />}
        {tab === 'Settings' && <Settings onStatus={setStatus} />}
        {tab === 'Audit log' && <Audit />}
        {tab === 'Jobs' && <Jobs onStatus={setStatus} />}
      </div>
    </div>
  );
}

type User = { id: string; email: string; full_name: string | null; role: string; status: string };

function Users({ onStatus }: { onStatus: (s: string) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const load = useCallback(() => api<{ users: User[] }>('/api/core/admin/users').then((r) => setUsers(r.users)), []);
  useEffect(() => { load(); }, [load]);

  async function change(u: User, patch: Partial<Pick<User, 'role' | 'status'>>) {
    try {
      const r = await api<{ user: User }>(`/api/core/admin/users/${u.id}`, { method: 'PATCH', body: patch });
      setUsers((list) => list.map((x) => (x.id === u.id ? r.user : x)));
      onStatus(`Updated ${u.email}.`);
    } catch (e) { onStatus((e as Error).message); }
  }

  return (
    <table className="w-full border-collapse">
      <thead><tr><th className={cell}>Email</th><th className={cell}>Role</th><th className={cell}>Status</th></tr></thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <td className={cell}>{u.email}</td>
            <td className={cell}>
              <select aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => change(u, { role: e.target.value })}
                className="rounded border border-[var(--border)] bg-transparent px-2 py-1">
                <option value="MEMBER">Member</option><option value="PRODUCT">Product</option><option value="ADMIN">Admin</option>
              </select>
            </td>
            <td className={cell}>
              {u.status === 'DISABLED'
                ? <button className={btn} onClick={() => change(u, { status: 'ACTIVE' })}>Reactivate</button>
                : <button className={btn} onClick={() => change(u, { status: 'DISABLED' })}>
                    {u.status === 'PENDING' ? 'Reject' : 'Deactivate'}
                  </button>}
              {u.status === 'PENDING' && <button className={`${btn} ml-2`} onClick={() => change(u, { status: 'ACTIVE' })}>Approve</button>}
              <span className="ml-2 text-[var(--muted)]">{u.status.toLowerCase()}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Key = { id: string; status: string; last_used_at: string | null };
type Client = {
  id: string; name: string; environment: string; routes: string[]; paused_at: string | null; pause_reason: string | null;
  keys: Key[]; outcomes: { outcome: string; d1: number; d7: number }[];
};

function Intake({ onStatus }: { onStatus: (s: string) => void }) {
  const [data, setData] = useState<{ clients: Client[]; modules: { module: string; paused_at: string | null }[] } | null>(null);
  const [issued, setIssued] = useState<{ keyId: string; secret: string; baseUrl: string } | null>(null);
  const load = useCallback(() => api<typeof data>('/api/core/admin/intake/clients').then(setData), []);
  useEffect(() => { load(); }, [load]);

  const act = (fn: () => Promise<unknown>, msg: string) => async () => {
    try { await fn(); onStatus(msg); await load(); } catch (e) { onStatus((e as Error).message); }
  };

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await act(() => api('/api/core/admin/intake/clients', { method: 'POST', body: {
      name: f.get('name'), environment: f.get('environment'),
      routes: String(f.get('routes')).split(',').map((s) => s.trim()).filter(Boolean),
    } }), 'Client created.')();
  }

  const fhPaused = Boolean(data?.modules.find((m) => m.module === 'fh')?.paused_at);

  return (
    <div className="space-y-6">
      {issued && (
        <div role="alert" className="rounded-lg border-2 border-amber-500 p-4">
          <p className="font-semibold">Copy this secret now. It will not be shown again.</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
            <dt>Key id</dt><dd>{issued.keyId}</dd>
            <dt>Secret</dt><dd className="break-all">{issued.secret}</dd>
            <dt>Base URL</dt><dd>{issued.baseUrl}</dd>
          </dl>
          <button className={`${btn} mt-3`} onClick={() => navigator.clipboard.writeText(issued.secret)}>Copy secret</button>
          <button className={`${btn} ml-2 mt-3`} onClick={() => setIssued(null)}>I have stored it</button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span>Feedback Hub intake is <strong>{fhPaused ? 'paused' : 'running'}</strong>.</span>
        <button className={btn} onClick={act(() => api('/api/core/admin/intake/pause', { method: 'PUT', body: {
          module: 'fh', paused: !fhPaused, reason: fhPaused ? undefined : 'Paused from the admin console' } }), fhPaused ? 'Intake resumed.' : 'Intake paused.')}>
          {fhPaused ? 'Resume intake' : 'Pause all intake'}
        </button>
      </div>

      {data?.clients.map((c) => (
        <section key={c.id} className="rounded-lg border border-[var(--border)] p-4">
          <h2 className="font-semibold">{c.name} <span className="text-sm font-normal text-[var(--muted)]">({c.environment}; routes: {c.routes.join(', ')})</span></h2>
          {c.paused_at && <p className="text-sm">Paused: {c.pause_reason ?? 'no reason given'}</p>}
          <p className="mt-1 text-sm text-[var(--muted)]">
            Last 24 h / 7 days: {c.outcomes.length ? c.outcomes.map((o) => `${o.outcome} ${o.d1}/${o.d7}`).join(' · ') : 'no requests'}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {c.keys.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <code>{k.id}</code> <span>{k.status}</span>
                <span className="text-[var(--muted)]">last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</span>
                {k.status === 'active' && (
                  <button className={btn} onClick={act(() => api(`/api/core/admin/intake/clients/${c.id}/keys/${k.id}/revoke`, { method: 'POST' }), `Key ${k.id} revoked.`)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button className={btn} onClick={async () => {
              try { setIssued(await api(`/api/core/admin/intake/clients/${c.id}/keys`, { method: 'POST' })); await load(); }
              catch (e) { onStatus((e as Error).message); }
            }}>Issue key</button>
            <button className={btn} onClick={act(() => api('/api/core/admin/intake/pause', { method: 'PUT', body: {
              clientId: c.id, paused: !c.paused_at, reason: 'Paused from the admin console' } }), c.paused_at ? 'Client resumed.' : 'Client paused.')}>
              {c.paused_at ? 'Resume client' : 'Pause client'}
            </button>
          </div>
        </section>
      ))}

      <form onSubmit={create} className="grid gap-3 rounded-lg border border-[var(--border)] p-4 sm:grid-cols-4 sm:items-end">
        <label className="text-sm">Client name<input name="name" required maxLength={100} className="mt-1 block w-full rounded border border-[var(--border)] bg-transparent px-2 py-1" /></label>
        <label className="text-sm">Environment
          <select name="environment" className="mt-1 block w-full rounded border border-[var(--border)] bg-transparent px-2 py-1">
            <option value="staging">staging</option><option value="production">production</option>
          </select>
        </label>
        <label className="text-sm">Routes<input name="routes" defaultValue="call-requests" className="mt-1 block w-full rounded border border-[var(--border)] bg-transparent px-2 py-1" /></label>
        <button className={btn}>Add client</button>
      </form>
    </div>
  );
}

const LIST_SETTINGS = ['auth.allowed_domains', 'intake.staff_domains', 'intake.public_email_domains'] as const;

function Settings({ onStatus }: { onStatus: (s: string) => void }) {
  const [s, setS] = useState<Json | null>(null);
  useEffect(() => { api<{ settings: Json }>('/api/core/admin/settings').then((r) => setS(r.settings)); }, []);
  if (!s) return <p>Loading…</p>;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Json = {
      'release_train.anchor': f.get('anchor'),
      'release_train.length_days': Number(f.get('length')),
      'planning_year.start_month': Number(f.get('month')),
      currency: String(f.get('currency')).toUpperCase(),
      'forum.default_label': f.get('label'),
      'export.include_personal_data': f.get('personal') === 'on',
    };
    for (const k of LIST_SETTINGS) body[k] = String(f.get(k)).split(/[\s,]+/).filter(Boolean);
    try { setS((await api<{ settings: Json }>('/api/core/admin/settings', { method: 'PUT', body })).settings); onStatus('Settings saved.'); }
    catch (err) { onStatus((err as Error).message); }
  }

  const field = 'mt-1 block w-full rounded border border-[var(--border)] bg-transparent px-2 py-1';
  return (
    <form onSubmit={save} className="grid max-w-2xl gap-4">
      {LIST_SETTINGS.map((k) => (
        <label key={k} className="text-sm">{k} <span className="text-[var(--muted)]">(comma separated)</span>
          <textarea name={k} defaultValue={(s[k] as string[]).join(', ')} rows={2} className={field} />
        </label>
      ))}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <label className="text-sm">Release train anchor<input name="anchor" type="date" defaultValue={String(s['release_train.anchor'])} className={field} /></label>
        <label className="text-sm">Train length (days)<input name="length" type="number" min={7} max={90} defaultValue={Number(s['release_train.length_days'])} className={field} /></label>
        <label className="text-sm">Planning year starts (month)<input name="month" type="number" min={1} max={12} defaultValue={Number(s['planning_year.start_month'])} className={field} /></label>
        <label className="text-sm">Currency<input name="currency" maxLength={3} defaultValue={String(s.currency)} className={field} /></label>
      </div>
      <label className="text-sm">Default forum status label<input name="label" maxLength={40} defaultValue={String(s['forum.default_label'])} className={field} /></label>
      <label className="flex items-center gap-2 text-sm">
        <input name="personal" type="checkbox" defaultChecked={Boolean(s['export.include_personal_data'])} />
        Allow feedback admins to include requester contact details in CSV exports
      </label>
      <button className={`${btn} justify-self-start`}>Save settings</button>
    </form>
  );
}

type AuditRow = { id: string; created_at: string; actor_kind: string; actor_id: string | null; action: string; target_kind: string | null; target_id: string | null };

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api<{ entries: AuditRow[] }>(`/api/core/admin/audit?action=${encodeURIComponent(action)}`).then((r) => setRows(r.entries)), 250);
    return () => clearTimeout(t);
  }, [action]);
  return (
    <div>
      <label className="text-sm">Filter by action prefix
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. ing.key"
          className="ml-2 rounded border border-[var(--border)] bg-transparent px-2 py-1" />
      </label>
      <table className="mt-4 w-full border-collapse">
        <thead><tr><th className={cell}>When</th><th className={cell}>Actor</th><th className={cell}>Action</th><th className={cell}>Target</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={cell}>{new Date(r.created_at).toLocaleString()}</td>
              <td className={cell}>{r.actor_kind} <code className="text-xs">{r.actor_id?.slice(0, 8)}</code></td>
              <td className={cell}><code>{r.action}</code></td>
              <td className={cell}>{r.target_kind} <code className="text-xs">{r.target_id?.slice(0, 12)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type DeadJob = { id: string; kind: string; attempts: number; last_error: string | null; created_at: string };

function Jobs({ onStatus }: { onStatus: (s: string) => void }) {
  const [dead, setDead] = useState<DeadJob[]>([]);
  const load = useCallback(() => api<{ dead: DeadJob[] }>('/api/core/admin/jobs').then((r) => setDead(r.dead)), []);
  useEffect(() => { load(); }, [load]);
  if (!dead.length) return <p>No failed jobs.</p>;
  return (
    <ul className="space-y-2">
      {dead.map((j) => (
        <li key={j.id} className="rounded border border-[var(--border)] p-3 text-sm">
          <code>{j.kind}</code> failed {j.attempts} times. <span className="text-[var(--muted)]">{j.last_error}</span>
          <button className={`${btn} ml-3`} onClick={async () => {
            try { await api(`/api/core/admin/jobs/${j.id}/retry`, { method: 'POST' }); onStatus('Job queued again.'); await load(); }
            catch (e) { onStatus((e as Error).message); }
          }}>Retry</button>
        </li>
      ))}
    </ul>
  );
}
