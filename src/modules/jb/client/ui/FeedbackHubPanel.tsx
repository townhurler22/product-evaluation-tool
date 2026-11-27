'use client';
// Product card panel: Feedback Hub section and Detailed journey button (JB-502, §9.9, INT-06, INT-42 to INT-46).
// Registered into the Product card panel's extension slot. Collaborative mode only: share views have no Feedback Hub.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readProductCard } from '../../kinds';
import type { NodeRec } from '../../ops';
import { useBoard, useUi } from '../context';
import { formatTarget, type Attention } from '../demand';
import { productPanelSlots } from './Panel';

interface FeatureItem { id: string; name?: string; path?: string[]; depth?: number; openCount?: number; allCount?: number; gone?: true }
type JourneyState =
  | { state: 'none' }
  | { state: 'gone'; id: string }
  | { state: 'linked'; id: string; name: string; syncedAt: string | null; syncedByName: string | null; nameDiffers: boolean };
interface Summary {
  available: boolean; level: 'journey' | 'feature'; journeyBoardId: string | null; canEdit: boolean;
  scope?: 'open' | 'all'; linked?: boolean; total?: number; targetDate?: string | null; attention?: Attention;
  features?: FeatureItem[]; journey?: JourneyState; featureCount?: number;
}
interface IdeaRefT { id: string; number: number; title: string }

/** INT-44: last known panel state per `<boardId>:<nodeId>`; shown at once, refreshed behind it, never the truth. */
const panelCache = new Map<string, Summary>();
/** INT-45: retry a 404 for a card the client holds locally. */
export const SAVING_RETRIES_MS = [300, 600, 1000, 1500, 2500, 4000];
/** INT-46: syncs keep going after the panel closes. */
const syncing = new Set<string>();

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const api = (boardId: string, nodeId: string, rest: string) => `/api/jb/boards/${boardId}/nodes/${encodeURIComponent(nodeId)}/${rest}`;

function FeedbackHubSection({ node, boardId, readOnly }: { node: NodeRec; boardId: string; readOnly: boolean }) {
  const { mode, demand, flush, announce, me } = useBoard();
  const key = `${boardId}:${node.id}`;
  const [summary, setSummary] = useState<Summary | null>(() => panelCache.get(key) ?? null);
  const [status, setStatus] = useState<'loading' | 'saving-card' | 'ready' | 'error'>(panelCache.has(key) ? 'ready' : 'loading');
  const [busy, setBusy] = useState<string | null>(syncing.has(key) ? 'Saving to Feedback Hub. You can carry on.' : null);
  const [error, setError] = useState<string | null>(null);
  const scope = useUi((s) => s.demand?.scope ?? 'open');
  const rev = useUi((s) => s.demand?.rev ?? 0);
  const current = useRef(key);
  useEffect(() => { current.current = key; }, [key]);

  const load = useCallback(async () => {
    const forKey = key;
    // INT-45: a card still in the outbox is sent first, then a 404 is retried while it saves.
    if (flush) await flush().catch(() => {});
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try { res = await fetch(api(boardId, node.id, `demand?scope=${scope}`)); } catch { if (current.current === forKey) setStatus('error'); return; }
      if (res.status === 404 && attempt < SAVING_RETRIES_MS.length) {
        if (current.current === forKey) setStatus('saving-card');
        await new Promise((r) => setTimeout(r, SAVING_RETRIES_MS[attempt]));
        continue;
      }
      if (!res.ok) { if (current.current === forKey) setStatus('error'); return; }
      const body = await res.json() as Summary;
      panelCache.set(forKey, body);
      if (current.current === forKey) { setSummary(body); setStatus('ready'); }
      return;
    }
  }, [boardId, node.id, scope, key, flush]);

  useEffect(() => { if (mode === 'collab') void load(); }, [load, rev, mode]);

  if (mode !== 'collab') return null;
  const canEdit = !readOnly && summary?.canEdit !== false;
  // The overlay refresh moves the demand revision, which reloads this panel (one request each).
  const refreshAll = () => { if (demand) void demand.refresh(); else void load(); };

  const removeLink = async (relation: string, toId: string) => {
    setError(null);
    // INT-46: optimistic; roll back with the reason on failure.
    if (summary?.features) setSummary({ ...summary, features: summary.features.filter((f) => f.id !== toId) });
    const r = await fetch(`${api(boardId, node.id, 'links')}?relation=${relation}&toId=${encodeURIComponent(toId)}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) setError('Could not remove the link. Try again.');
    refreshAll();
  };
  const addFeature = async (f: FeatureItem) => {
    setError(null);
    if (summary) setSummary({ ...summary, features: [...(summary.features ?? []), f], linked: true });
    const r = await fetch(api(boardId, node.id, 'links'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ featureId: f.id }) }).catch(() => null);
    if (!r?.ok) { const b = await r?.json().catch(() => null); setError(b?.message ?? 'Could not link the Feature. Try again.'); }
    refreshAll();
  };
  const runSync = async () => {
    setError(null);
    syncing.add(key);
    setBusy('Saving to Feedback Hub. You can carry on.');
    const title = readProductCard(node.data).title.trim();
    if (summary && summary.level === 'journey') {
      // INT-46: show the card as synced under its title at once.
      setSummary({ ...summary, journey: { state: 'linked', id: summary.journey?.state === 'linked' ? summary.journey.id : '', name: title, syncedAt: new Date().toISOString(), syncedByName: me?.name ?? null, nameDiffers: false } });
    }
    const r = await fetch(api(boardId, node.id, 'journey-sync'), { method: 'POST' }).catch(() => null);
    syncing.delete(key);
    const body = await r?.json().catch(() => null);
    if (current.current === key) setBusy(null);
    if (!r?.ok) {
      const msg = body?.message && r && r.status < 500 ? body.message : 'Sync did not finish. Run it again.';
      if (current.current === key) { setError(msg); void load(); }
      announce(msg);
      return;
    }
    announce(body.message);
    panelCache.delete(key);
    if (current.current === key) void load();
    void demand?.refresh();
  };

  if (!summary) {
    return (
      <section aria-label="Feedback Hub" className="jb-fh">
        <h3>Feedback Hub</h3>
        <p role="status" className="jb-quiet">{status === 'saving-card' ? 'Saving the card…' : status === 'error' ? 'Could not load Feedback Hub data.' : 'Loading…'}</p>
        {status === 'error' && <button type="button" onClick={() => void load()}>Try again</button>}
      </section>
    );
  }
  const noun = summary.scope === 'all' ? 'ideas' : 'open ideas';
  const attention = summary.attention ?? [];

  return (
    <>
      <section aria-label="Feedback Hub" className="jb-fh">
        <h3>Feedback Hub</h3>
        {!summary.available ? <p className="jb-quiet">You do not have access to Feedback Hub</p> : summary.level === 'feature' ? (
          <>
            <p>{summary.total ?? 0} {noun} under these Features</p>
            <p className="jb-quiet">{summary.targetDate ? `Target ${formatTarget(summary.targetDate)}` : formatTarget(null)}</p>
            <ul className="jb-fh-list" aria-label="Linked Features">
              {(summary.features ?? []).map((f) => (
                <li key={f.id}>
                  {f.gone ? (
                    <span className="jb-attention-text">Deleted in Feedback Hub, kept until you remove it</span>
                  ) : (
                    <>
                      <a href={`/fh/ideas?feature=${f.id}`}>{[...(f.path ?? []), f.name].join(' › ')}</a>
                      <span className="jb-quiet"> {summary.scope === 'all' ? f.allCount : f.openCount} {noun}</span>
                      <IdeasList boardId={boardId} nodeId={node.id} featureId={f.id} scope={summary.scope ?? 'open'} seeAll={`/fh/ideas?feature=${f.id}`} label={`ideas for ${f.name}`} />
                    </>
                  )}
                  {canEdit && <button type="button" onClick={() => void removeLink('maps-to-feature', f.id)} aria-label={`Remove ${f.gone ? 'deleted Feature' : f.name}`}>Remove</button>}
                </li>
              ))}
              {!summary.features?.length && <li className="jb-quiet">No Features linked yet</li>}
            </ul>
            {canEdit && <FeatureSearch boardId={boardId} linked={new Set((summary.features ?? []).map((f) => f.id))} onPick={(f) => void addFeature(f)} />}
          </>
        ) : (
          <>
            <JourneyLine journey={summary.journey ?? { state: 'none' }} onRemove={canEdit ? (id) => void removeLink('maps-to-journey', id) : undefined} />
            <p className="jb-quiet">{summary.featureCount ?? 0} {summary.featureCount === 1 ? 'Feature' : 'Features'} linked in the detailed journey</p>
            <p>{summary.total ?? 0} {noun} under them</p>
            {(summary.featureCount ?? 0) > 0 && (
              <IdeasList boardId={boardId} nodeId={node.id} featureId={null} scope={summary.scope ?? 'open'} label="ideas for this card"
                seeAll={summary.journey?.state === 'linked' && summary.journey.id ? `/fh/ideas?journey=${summary.journey.id}` : null} />
            )}
            <p className="jb-quiet">{summary.targetDate ? `Target ${formatTarget(summary.targetDate)}` : formatTarget(null)}</p>
            {canEdit && <button type="button" onClick={() => void runSync()} disabled={Boolean(busy)}>Sync with Feedback Hub</button>}
          </>
        )}
        {attention.length > 0 && summary.level === 'feature' && (
          <p className="jb-attention-text" role="note">{attention.length} {attention.length === 1 ? 'link needs' : 'links need'} attention</p>
        )}
        {busy && <p role="status" className="jb-quiet">{busy}</p>}
        {error && <p role="alert" className="jb-error">{error}</p>}
      </section>
      {summary.level === 'journey' && <DetailedJourney node={node} boardId={boardId} journeyBoardId={summary.journeyBoardId} canEdit={canEdit} />}
    </>
  );
}

function JourneyLine({ journey, onRemove }: { journey: JourneyState; onRemove?: (id: string) => void }) {
  if (journey.state === 'none') return <p className="jb-quiet">Not in Feedback Hub yet</p>;
  if (journey.state === 'gone') {
    return (
      <p className="jb-attention-text" role="note">Journey deleted in Feedback Hub. Sync to create it again.
        {onRemove && <> <button type="button" onClick={() => onRemove(journey.id)}>Remove</button></>}</p>
    );
  }
  return (
    <div>
      <p>Journey: {journey.id ? <a href={`/fh/ideas?journey=${journey.id}`}>{journey.name}</a> : journey.name}</p>
      <p className="jb-quiet">{journey.syncedAt ? `Last synced ${dateText(journey.syncedAt)}${journey.syncedByName ? ` by ${journey.syncedByName}` : ''}` : 'Not synced yet'}</p>
      {journey.nameDiffers && <p className="jb-warn" role="note">The Journey&apos;s name differs from this card&apos;s title. Sync to rename it.</p>}
    </div>
  );
}

/** INT-40: loaded only when expanded; up to 20 ideas, each opening the idea in Feedback Hub. */
function IdeasList({ boardId, nodeId, featureId, scope, seeAll, label }: { boardId: string; nodeId: string; featureId: string | null; scope: 'open' | 'all'; seeAll: string | null; label: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ total: number; ideas: IdeaRefT[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    let off = false;
    void fetch(api(boardId, nodeId, `ideas?scope=${scope}${featureId ? `&featureId=${featureId}` : ''}`)).then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (!off) setData(b); });
    return () => { off = true; };
  }, [open, boardId, nodeId, featureId, scope]);
  return (
    <div className="jb-ideas">
      <button type="button" className="jb-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {label}</button>
      {open && (
        !data ? <p role="status" className="jb-quiet">Loading…</p> : (
          <>
            <ul>{data.ideas.map((i) => <li key={i.id}><a href={`/fh/ideas?idea=${i.id}`}>#{i.number} {i.title}</a></li>)}</ul>
            {!data.ideas.length && <p className="jb-quiet">No ideas yet</p>}
            {data.total > data.ideas.length && seeAll && <a href={seeAll}>See all {data.total}</a>}
          </>
        )
      )}
    </div>
  );
}

/** INT-43: from the 3rd character, 250 ms debounce, up to 20 results indented by depth, linked ones hidden. */
function FeatureSearch({ boardId, linked, onPick }: { boardId: string; linked: Set<string>; onPick: (f: FeatureItem) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FeatureItem[]>([]);
  const inputId = `fs-${boardId}`;
  useEffect(() => {
    if (q.trim().length < 3) return;
    let off = false;
    const t = setTimeout(() => {
      void fetch(`/api/jb/boards/${boardId}/feature-search?q=${encodeURIComponent(q.trim())}`).then((r) => (r.ok ? r.json() : { features: [] }))
        .then((b) => { if (!off) setResults(b.features ?? []); });
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [q, boardId]);
  const shown = q.trim().length < 3 ? [] : results.filter((f) => !linked.has(f.id));
  return (
    <div className="jb-fh-search">
      <label htmlFor={inputId} className="jb-row-label">Link a Feature</label>
      <input id={inputId} type="search" value={q} placeholder="Type 3 or more letters" onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 3 && (
        <ul aria-label="Matching Features">
          {shown.map((f) => (
            <li key={f.id} style={{ paddingLeft: `${(f.depth ?? 0) * 12}px` }}>
              <button type="button" className="jb-link" onClick={() => { onPick(f); setQ(''); }}>{f.name}</button>
            </li>
          ))}
          {!shown.length && <li className="jb-quiet">No matching Features</li>}
        </ul>
      )}
    </div>
  );
}

/** INT-06: Create detailed journey (editors) or Open detailed journey (everyone who can view the parent). */
function DetailedJourney({ node, boardId, journeyBoardId, canEdit }: { node: NodeRec; boardId: string; journeyBoardId: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setError(null);
    const title = readProductCard(node.data).title.trim() || 'Untitled product';
    const r = await fetch('/api/jb/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${title}: detailed journey`.slice(0, 200), journeyOf: { boardId, nodeId: node.id } }) }).catch(() => null);
    const b = await r?.json().catch(() => null);
    setBusy(false);
    if (!r?.ok) { setError(b?.message ?? 'Could not create the detailed journey.'); return; }
    panelCache.delete(`${boardId}:${node.id}`);
    router.push(`/jb/${b.meta.id}`);
  };
  return (
    <section aria-label="Detailed journey" className="jb-fh">
      <h3>Detailed journey</h3>
      {journeyBoardId ? <Link href={`/jb/${journeyBoardId}`}>Open detailed journey</Link>
        : canEdit ? <button type="button" onClick={() => void create()} disabled={busy}>Create detailed journey</button>
          : <p className="jb-quiet">No detailed journey yet</p>}
      {error && <p role="alert" className="jb-error">{error}</p>}
    </section>
  );
}

// JB-502: the Feedback Hub section and the Detailed journey button sit after the overview. Registered once.
const SLOT = Object.assign((p: { node: NodeRec; boardId: string; readOnly: boolean }) => <FeedbackHubSection key={`fh-${p.boardId}-${p.node.id}`} {...p} />, { slotId: 'feedback-hub' });
if (!productPanelSlots.some((s) => (s as { slotId?: string }).slotId === SLOT.slotId)) productPanelSlots.push(SLOT);
