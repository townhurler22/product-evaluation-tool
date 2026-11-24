'use client';

// People & Companies (§7.14): server-paginated, searchable lists; detail panels with inline editing for feedback
// admins; create, delete companies (FH-804) and erase people (FH-815, typed confirmation).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { statusKeyOf, SOURCE_LABEL } from '@/modules/fh/domain';
import { api, ApiFailure } from '../_lib/api';
import { useLookups } from '../_lib/data';
import { fmtCount } from '../_lib/selection';
import { btn, btnPrimary, Dialog, input, money, shortDate, StatusPill } from './ui';

interface CompanyRow { id: string; name: string; domain: string | null; arr: string | null; aliases: string[]; prospect: boolean; peopleCount: number; ideaCount: number }
interface PersonRow { id: string; name: string; email: string | null; verified: boolean; verifiedBy: string | null; companyName: string | null; voteCount: number; postCount: number; insightCount: number }
interface ListPage { total: number; nextOffset: number | null; companies?: unknown[]; people?: unknown[] }

type Tab = 'companies' | 'people';

function useDebounced(v: string, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function useList(kind: Tab, q: string) {
  return useInfiniteQuery({
    queryKey: ['fh', kind, 'list', q],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api<ListPage>(
      `/api/fh/${kind}?full=1&offset=${pageParam}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal }),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    staleTime: 30_000,
  });
}

export default function PeopleCompanies() {
  const lookups = useLookups();
  const isAdmin = lookups.data?.access.feedbackAdmin ?? false;
  const currency = lookups.data?.settings.currency ?? 'EUR';
  const [tab, setTab] = useState<Tab>('companies');
  const [message, setMessage] = useState('');
  return (
    <main className="mx-auto max-w-6xl px-4 py-4">
      <h1 className="text-2xl font-bold">People &amp; Companies</h1>
      <div role="tablist" aria-label="People and companies" className="mt-3 flex gap-1">
        {(['companies', 'people'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`${btn} aria-selected:bg-[var(--accent)] aria-selected:text-[var(--accent-fg)]`} onClick={() => { setTab(t); setMessage(''); }}>
            {t === 'companies' ? 'Companies' : 'People'}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-sm">{message}</p>
      {tab === 'companies'
        ? <Companies isAdmin={isAdmin} currency={currency} onMessage={setMessage} />
        : <People isAdmin={isAdmin} onMessage={setMessage} />}
    </main>
  );
}

function Toolbar({ q, setQ, label, children }: { q: string; setQ: (v: string) => void; label: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">{label}</span>
        <input type="search" className={`${input} w-56 max-w-full`} placeholder={label} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {children}
    </div>
  );
}

function errText(e: unknown) { return e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.'; }

// ── companies ────────────────────────────────────────────────────────────────────────────────────────────
function Companies({ isAdmin, currency, onMessage }: { isAdmin: boolean; currency: string; onMessage: (t: string) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useList('companies', dq);
  const rows = (list.data?.pages.flatMap((p) => p.companies as CompanyRow[]) ?? []);
  const total = list.data?.pages[0]?.total ?? 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['fh', 'companies'] });

  async function del() {
    const ids = [...selected];
    if (!window.confirm(`Delete ${fmtCount(ids.length)} ${ids.length === 1 ? 'company' : 'companies'}? Their people are detached and their ARR drops out of every idea's revenue figures. This cannot be undone.`)) return;
    try {
      const r = await api<{ deleted: number; peopleDetached: number; insightsUnlinked: number; rollupsPending: boolean }>('/api/fh/companies/delete', { method: 'POST', body: { ids } });
      onMessage(`Deleted ${fmtCount(r.deleted)}. ${fmtCount(r.peopleDetached)} people detached, ${fmtCount(r.insightsUnlinked)} insights unlinked.${r.rollupsPending ? ' Revenue figures updating.' : ''}`);
      setSelected(new Set());
      refresh();
    } catch (e) { onMessage(errText(e)); }
  }

  return (
    <section aria-label="Companies" className="mt-2 space-y-3">
      <Toolbar q={q} setQ={setQ} label="Search name or domain">
        <span className="text-sm text-[var(--muted)]">{fmtCount(total)} companies</span>
        {isAdmin && <button className={btnPrimary} onClick={() => setCreating(true)}>New company</button>}
        {isAdmin && selected.size > 0 && <button className={`${btn} text-[var(--danger)]`} onClick={del}>Delete ({fmtCount(selected.size)})</button>}
      </Toolbar>
      <div className="overflow-x-auto rounded-md border border-[var(--border)]">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-[var(--panel)] text-left">
            <tr>
              {isAdmin && <th className="w-8 px-2 py-1"><span className="sr-only">Select</span></th>}
              <th className="px-2 py-1">Name</th><th className="px-2 py-1">Domain</th>
              <th className="px-2 py-1 text-right">ARR</th><th className="px-2 py-1 text-right">People</th><th className="px-2 py-1 text-right">Ideas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-[var(--border)] hover:bg-[var(--hover)]">
                {isAdmin && <td className="px-2 py-1"><input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} /></td>}
                <td className="px-2 py-1"><button className="text-left font-medium text-[var(--accent)] underline-offset-2 hover:underline" onClick={() => setOpenId(c.id)}>{c.name}</button>
                  {c.prospect && <span className="ml-1 text-xs text-[var(--muted)]">Prospect</span>}</td>
                <td className="px-2 py-1">{c.domain ?? <span className="text-[var(--muted)]">None</span>}</td>
                <td className="px-2 py-1 text-right tabular-nums">{c.arr ? money(c.arr, currency) : <span className="text-[var(--muted)]">No ARR</span>}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtCount(c.peopleCount)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtCount(c.ideaCount)}</td>
              </tr>
            ))}
            {list.isSuccess && !rows.length && <tr><td colSpan={6} className="px-2 py-3 text-[var(--muted)]">No companies match.</td></tr>}
          </tbody>
        </table>
      </div>
      {list.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {list.hasNextPage && <button className={btn} disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Show more</button>}
      {creating && <CompanyForm onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); refresh(); onMessage(`Company created.${r.adopted ? ` ${fmtCount(r.adopted)} people attributed by domain.` : ''}`); setOpenId(r.company.id); }} />}
      {openId && <CompanyDetail id={openId} isAdmin={isAdmin} currency={currency} onClose={() => setOpenId(null)} onChanged={(t) => { refresh(); if (t) onMessage(t); }} />}
    </section>
  );
}

interface CompanySaved { company: { id: string }; adopted?: number; released?: number; rollupsPending?: boolean }

function CompanyForm({ initial, id, onClose, onSaved }: {
  initial?: { name: string; domain: string | null; arr: string | null; aliases: string[] }; id?: string;
  onClose: () => void; onSaved: (r: CompanySaved) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [arr, setArr] = useState(initial?.arr ?? '');
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(', '));
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name, domain: domain.trim() || null, arr: arr.trim() || null, aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean) };
    try {
      const r = await api<CompanySaved>(id ? `/api/fh/companies/${id}` : '/api/fh/companies', { method: id ? 'PATCH' : 'POST', body });
      onSaved(r);
    } catch (err) { setError(errText(err)); }
  }
  return (
    <Dialog title={id ? 'Edit company' : 'New company'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">Name<input required maxLength={200} className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block">Domain (optional)<input className={`${input} mt-1 w-full`} placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} /></label>
        <label className="block">ARR (optional)<input inputMode="decimal" className={`${input} mt-1 w-full`} placeholder="120000" value={arr} onChange={(e) => setArr(e.target.value)} />
          <span className="mt-1 block text-xs text-[var(--muted)]">ARR is the multiplier behind every revenue figure for ideas this company asked for.</span></label>
        <label className="block">Other names, comma separated (optional)<input className={`${input} mt-1 w-full`} value={aliases} onChange={(e) => setAliases(e.target.value)} /></label>
        {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
        <div className="flex gap-2"><button type="submit" className={btnPrimary}>Save</button><button type="button" className={btn} onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

interface CompanyFull {
  id: string; name: string; domain: string | null; arr: string | null; aliases: string[]; prospect: boolean;
  people: { id: string; name: string; email: string | null; source: string | null }[]; peopleCount: number;
  ideas: { id: string; number: number; title: string; status: string | null; bugStatus: string | null }[]; ideaCount: number; openDemand: number;
}

function CompanyDetail({ id, isAdmin, currency, onClose, onChanged }: { id: string; isAdmin: boolean; currency: string; onClose: () => void; onChanged: (t?: string) => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['fh', 'companies', 'detail', id], queryFn: () => api<{ company: CompanyFull }>(`/api/fh/companies/${id}`).then((r) => r.company) });
  const [editing, setEditing] = useState(false);
  const c = d.data;
  return (
    <Dialog title={c?.name ?? 'Company'} onClose={onClose} wide>
      {d.isLoading && <p className="text-sm">Loading…</p>}
      {d.isError && <p className="text-sm text-[var(--danger)]">{errText(d.error)}</p>}
      {c && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border-2 border-[var(--accent)] p-2"><dt className="text-xs text-[var(--muted)]">ARR</dt><dd className="text-lg font-bold tabular-nums">{c.arr ? money(c.arr, currency) : 'None'}</dd></div>
            <div className="rounded-md border border-[var(--border)] p-2"><dt className="text-xs text-[var(--muted)]">Open demand</dt><dd className="text-lg font-semibold tabular-nums">{fmtCount(c.openDemand)}</dd></div>
            <div className="rounded-md border border-[var(--border)] p-2"><dt className="text-xs text-[var(--muted)]">Ideas</dt><dd className="text-lg font-semibold tabular-nums">{fmtCount(c.ideaCount)}</dd></div>
            <div className="rounded-md border border-[var(--border)] p-2"><dt className="text-xs text-[var(--muted)]">People</dt><dd className="text-lg font-semibold tabular-nums">{fmtCount(c.peopleCount)}</dd></div>
          </dl>
          <p className="text-xs text-[var(--muted)]">ARR multiplies into every revenue figure for the ideas this company asked for. Domain: {c.domain ?? 'none'}{c.aliases.length ? `. Also known as ${c.aliases.join(', ')}` : ''}{c.prospect ? '. Prospect (created by intake)' : ''}.</p>
          {isAdmin && <button className={btn} onClick={() => setEditing(true)}>Edit company</button>}
          <section><h3 className="font-semibold">Ideas asked for</h3>
            {c.ideas.length ? <ul className="mt-1 space-y-1">{c.ideas.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2"><StatusPill status={statusKeyOf(i)} /><a className="underline" href={`/fh/ideas?idea=${i.id}`}>#{i.number} {i.title}</a></li>
            ))}</ul> : <p className="text-[var(--muted)]">None yet.</p>}
          </section>
          <section><h3 className="font-semibold">People</h3>
            {c.people.length ? <ul className="mt-1 space-y-0.5">{c.people.map((p) => (
              <li key={p.id}>{p.name}{p.email ? ` (${p.email})` : ''}{p.source === 'DOMAIN' ? <span className="text-xs text-[var(--muted)]"> by domain</span> : null}</li>
            ))}</ul> : <p className="text-[var(--muted)]">None.</p>}
          </section>
        </div>
      )}
      {editing && c && <CompanyForm id={id} initial={c} onClose={() => setEditing(false)} onSaved={(r) => {
        setEditing(false);
        qc.invalidateQueries({ queryKey: ['fh', 'companies', 'detail', id] });
        onChanged(`Company saved.${r.adopted ? ` ${fmtCount(r.adopted)} people adopted by domain.` : ''}${r.released ? ` ${fmtCount(r.released)} released.` : ''}${r.rollupsPending ? ' Revenue figures updating.' : ''}`);
      }} />}
    </Dialog>
  );
}

// ── people ───────────────────────────────────────────────────────────────────────────────────────────────
function People({ isAdmin, onMessage }: { isAdmin: boolean; onMessage: (t: string) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useList('people', dq);
  const rows = (list.data?.pages.flatMap((p) => p.people as PersonRow[]) ?? []);
  const total = list.data?.pages[0]?.total ?? 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [erasing, setErasing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['fh', 'people'] });

  return (
    <section aria-label="People" className="mt-2 space-y-3">
      <Toolbar q={q} setQ={setQ} label={isAdmin ? 'Search name or email' : 'Search name'}>
        <span className="text-sm text-[var(--muted)]">{fmtCount(total)} people</span>
        {isAdmin && <button className={btnPrimary} onClick={() => setCreating(true)}>New person</button>}
        {isAdmin && selected.size > 0 && <button className={`${btn} text-[var(--danger)]`} onClick={() => setErasing(true)}>Erase ({fmtCount(selected.size)})</button>}
      </Toolbar>
      <div className="overflow-x-auto rounded-md border border-[var(--border)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-[var(--panel)] text-left">
            <tr>
              {isAdmin && <th className="w-8 px-2 py-1"><span className="sr-only">Select</span></th>}
              <th className="px-2 py-1">Name</th>{isAdmin && <th className="px-2 py-1">Email</th>}<th className="px-2 py-1">Company</th>
              <th className="px-2 py-1 text-right">Votes</th><th className="px-2 py-1 text-right">Posts</th><th className="px-2 py-1 text-right">Insights</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-[var(--border)] hover:bg-[var(--hover)]">
                {isAdmin && <td className="px-2 py-1"><input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} /></td>}
                <td className="px-2 py-1"><button className="text-left font-medium text-[var(--accent)] underline-offset-2 hover:underline" onClick={() => setOpenId(p.id)}>{p.name}</button>
                  {p.verified && <span className="ml-1 text-xs text-[var(--ok)]" title={p.verifiedBy ? `Verified by ${p.verifiedBy.replace(/^ingest:/, '')}` : 'Verified'}>Verified</span>}</td>
                {isAdmin && <td className="px-2 py-1 break-all">{p.email ?? <span className="text-[var(--muted)]">None</span>}</td>}
                <td className="px-2 py-1">{p.companyName ?? <span className="text-[var(--muted)]">Unattributed</span>}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtCount(p.voteCount)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtCount(p.postCount)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtCount(p.insightCount)}</td>
              </tr>
            ))}
            {list.isSuccess && !rows.length && <tr><td colSpan={7} className="px-2 py-3 text-[var(--muted)]">No people match.</td></tr>}
          </tbody>
        </table>
      </div>
      {list.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {list.hasNextPage && <button className={btn} disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Show more</button>}
      {creating && <PersonForm onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); refresh(); onMessage('Person created.'); setOpenId(id); }} />}
      {openId && <PersonDetail id={openId} isAdmin={isAdmin} onClose={() => setOpenId(null)} onChanged={(t) => { refresh(); if (t) onMessage(t); }} />}
      {erasing && <EraseDialog ids={[...selected]} onClose={() => setErasing(false)} onDone={(t) => { setErasing(false); setSelected(new Set()); refresh(); onMessage(t); }} />}
    </section>
  );
}

function CompanyPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (c: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const found = useQuery({ queryKey: ['fh', 'companies', 'pick', dq], enabled: dq.length > 0, queryFn: () => api<{ companies: { id: string; name: string }[] }>(`/api/fh/companies?q=${encodeURIComponent(dq)}`).then((r) => r.companies.slice(0, 8)) });
  return (
    <div>
      <p>Company: <strong>{value?.name ?? 'Unattributed'}</strong> {value && <button type="button" className="text-xs underline" onClick={() => onChange(null)}>Detach</button>}</p>
      <input className={`${input} mt-1 w-full`} aria-label="Search companies" placeholder="Search companies" value={q} onChange={(e) => setQ(e.target.value)} />
      {!!found.data?.length && <ul className="mt-1 max-h-40 overflow-auto rounded border border-[var(--border)]">{found.data.map((c) => (
        <li key={c.id}><button type="button" className="w-full px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => { onChange(c); setQ(''); }}>{c.name}</button></li>
      ))}</ul>}
    </div>
  );
}

function PersonForm({ id, initial, onClose, onSaved }: {
  id?: string; initial?: { displayName: string | null; companyId: string | null; companyName: string | null };
  onClose: () => void; onSaved: (id: string, pending?: boolean) => void;
}) {
  const [name, setName] = useState(initial?.displayName ?? '');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState<{ id: string; name: string } | null>(initial?.companyId ? { id: initial.companyId, name: initial.companyName ?? '' } : null);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const body = id ? { displayName: name || null, companyId: company?.id ?? null } : { displayName: name || null, email: email.trim() || null, companyId: company?.id ?? null };
      const r = await api<{ person: { id: string }; rollupsPending?: boolean }>(id ? `/api/fh/people/${id}` : '/api/fh/people', { method: id ? 'PATCH' : 'POST', body });
      onSaved(r.person.id, r.rollupsPending);
    } catch (err) { setError(errText(err)); }
  }
  return (
    <Dialog title={id ? 'Edit person' : 'New person'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">Display name<input maxLength={200} className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} /></label>
        {!id && <label className="block">Email<input type="email" maxLength={320} className={`${input} mt-1 w-full`} value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="mt-1 block text-xs text-[var(--muted)]">Give a name, an email or both. With no company, the email domain attributes them when a company claims it.</span></label>}
        <CompanyPicker value={company} onChange={setCompany} />
        {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
        <div className="flex gap-2"><button type="submit" className={btnPrimary}>Save</button><button type="button" className={btn} onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

interface PersonFull {
  id: string; email: string | null; displayName: string | null; verifiedAt: string | null; verifiedBy: string | null;
  companyId: string | null; companyName: string | null; lastSeenAt: string;
  posts: { id: string; title: string; voteCount: number }[];
  votes: { id: string; postTitle: string; createdAt: string }[];
  insights: { id: string; value: string; source: string; ideaId: string; ideaNumber: number; ideaTitle: string; createdAt: string }[];
}

function PersonDetail({ id, isAdmin, onClose, onChanged }: { id: string; isAdmin: boolean; onClose: () => void; onChanged: (t?: string) => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['fh', 'people', 'detail', id], queryFn: () => api<{ person: PersonFull }>(`/api/fh/people/${id}`).then((r) => r.person) });
  const [editing, setEditing] = useState(false);
  const p = d.data;
  return (
    <Dialog title={p?.displayName ?? 'Anonymous'} onClose={onClose} wide>
      {d.isLoading && <p className="text-sm">Loading…</p>}
      {d.isError && <p className="text-sm text-[var(--danger)]">{errText(d.error)}</p>}
      {p && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {isAdmin && <><dt className="text-[var(--muted)]">Email</dt><dd className="break-all">{p.email ?? 'None'}</dd></>}
            <dt className="text-[var(--muted)]">Company</dt><dd>{p.companyName ?? 'Unattributed'}</dd>
            <dt className="text-[var(--muted)]">Verified</dt><dd>{p.verifiedAt ? `Yes${p.verifiedBy ? `, by ${p.verifiedBy.replace(/^ingest:/, '')}` : ''}` : 'No'}</dd>
            <dt className="text-[var(--muted)]">Last seen</dt><dd>{shortDate(p.lastSeenAt)}</dd>
          </dl>
          {isAdmin && <button className={btn} onClick={() => setEditing(true)}>Edit person</button>}
          <section><h3 className="font-semibold">Insights ({p.insights.length})</h3>
            {p.insights.length ? <ul className="mt-1 space-y-1">{p.insights.map((i) => (
              <li key={i.id}><a className="underline" href={`/fh/ideas?idea=${i.ideaId}`}>#{i.ideaNumber} {i.ideaTitle}</a>
                <span className="text-xs text-[var(--muted)]"> · {SOURCE_LABEL[i.source as keyof typeof SOURCE_LABEL] ?? i.source} · {shortDate(i.createdAt)}</span>
                <p className="line-clamp-2 break-words">{i.value}</p></li>
            ))}</ul> : <p className="text-[var(--muted)]">None.</p>}
          </section>
          <section><h3 className="font-semibold">Posts ({p.posts.length})</h3>
            {p.posts.length ? <ul className="mt-1">{p.posts.map((x) => <li key={x.id}>{x.title} <span className="text-xs text-[var(--muted)]">({fmtCount(x.voteCount)} votes)</span></li>)}</ul> : <p className="text-[var(--muted)]">None.</p>}
          </section>
          <section><h3 className="font-semibold">Votes ({p.votes.length})</h3>
            {p.votes.length ? <ul className="mt-1">{p.votes.map((v) => <li key={v.id}>{v.postTitle} <span className="text-xs text-[var(--muted)]">{shortDate(v.createdAt)}</span></li>)}</ul> : <p className="text-[var(--muted)]">None.</p>}
          </section>
        </div>
      )}
      {editing && p && <PersonForm id={id} initial={p} onClose={() => setEditing(false)} onSaved={(_, pending) => {
        setEditing(false);
        qc.invalidateQueries({ queryKey: ['fh', 'people', 'detail', id] });
        onChanged(`Person saved.${pending ? ' Revenue figures updating.' : ''}`);
      }} />}
    </Dialog>
  );
}

/** FH-815: typed confirmation "ERASE". */
function EraseDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (t: string) => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ erased: number; postsRecounted: number; failed: { id: string; reason: string }[] }>('/api/fh/people/erase', { method: 'POST', body: { ids, confirm: typed } });
      onDone(`Erased ${fmtCount(r.erased)} ${r.erased === 1 ? 'person' : 'people'}; ${fmtCount(r.postsRecounted)} posts recounted.${r.failed.length ? ` ${fmtCount(r.failed.length)} not erased: ${r.failed[0].reason}` : ''}`);
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Dialog title={`Erase ${fmtCount(ids.length)} ${ids.length === 1 ? 'person' : 'people'}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <p>This removes their email and name, their votes, their screenshots and the link from their words to them. Their words stay, unattributed. Vote counts and roll-ups are recounted. This cannot be undone.</p>
        <label className="block">Type ERASE to confirm<input className={`${input} mt-1 w-full`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
        {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className={`${btnPrimary} bg-[var(--danger)]`} disabled={typed !== 'ERASE' || busy}>Erase</button>
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
