'use client';
// Demand on a Product card (JB-503, INT-29, INT-30, INT-36, INT-39, INT-41): the band along the bottom edge with the
// count, the target release date line and the attention badge. Per-card selectors return primitives, so an overlay
// refresh re-renders only the cards whose values changed (D-14).
import { useId, useState } from 'react';
import { useBoard, useUi } from '../context';
import { demandColour, demandLabel, formatTarget } from '../demand';

interface BreakdownT {
  available?: boolean; total: number; byType: Record<string, number>; byStatus: Record<string, number>; companyCount: number;
  topCompanies: { id: string; name: string; arr: string | null; ideaCount: number }[];
}

export function DemandOnCard({ id }: { id: string }) {
  const available = useUi((s) => s.demand?.available === true);
  const count = useUi((s) => s.demand?.counts[id]);
  const max = useUi((s) => s.demand?.max ?? 0);
  const on = useUi((s) => s.demand?.on !== false);
  const scope = useUi((s) => s.demand?.scope ?? 'open');
  const date = useUi((s) => s.demand?.releaseDates[id]);
  const attention = useUi((s) => s.demand?.attention[id]?.length ?? 0);
  if (!available) return null;
  const linked = count !== undefined;
  return (
    <>
      {attention > 0 && (
        <div className="jb-attention" role="note">{attention} {attention === 1 ? 'link needs' : 'links need'} attention</div>
      )}
      {linked && date && <div className="jb-target">Target {formatTarget(date)}</div>}
      {linked && on && (
        <div className="jb-demand-band" style={{ background: `linear-gradient(90deg, ${demandColour(count, max)}, ${demandColour(count, max, 0.55)})` }}>
          <BreakdownCount id={id} count={count} scope={scope} />
        </div>
      )}
    </>
  );
}

/** INT-41: hovering (or focusing) the count shows the breakdown, loaded once per card and scope. */
function BreakdownCount({ id, count, scope }: { id: string; count: number; scope: 'open' | 'all' }) {
  const { demand } = useBoard();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BreakdownT | null>(null);
  const tipId = useId();
  const show = () => {
    setOpen(true);
    void demand?.breakdown(id).then((b) => setData((b as BreakdownT | null) ?? null));
  };
  const noun = scope === 'open' ? 'open ideas' : 'ideas';
  return (
    <span className="jb-demand-count-wrap">
      <button type="button" className="jb-demand-count nodrag" aria-describedby={open ? tipId : undefined}
        aria-label={`${count} ${noun}. Show the breakdown`}
        onMouseEnter={show} onMouseLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
        {count}
      </button>
      {open && (
        <span role="tooltip" id={tipId} className="jb-breakdown">
          {!data ? 'Loading…' : data.available === false ? 'You do not have access to Feedback Hub' : (
            <>
              <strong>{data.total} {noun}</strong>
              {Object.entries(data.byType).map(([k, v]) => <span key={k}>{demandLabel(k)}: {v}</span>)}
              <em>By status</em>
              {Object.entries(data.byStatus).map(([k, v]) => <span key={k}>{demandLabel(k)}: {v}</span>)}
              <em>{data.companyCount} {data.companyCount === 1 ? 'company' : 'companies'}</em>
              {data.topCompanies.map((c) => <span key={c.id}>{c.name}{c.arr ? ` (ARR ${c.arr})` : ''}: {c.ideaCount}</span>)}
            </>
          )}
        </span>
      )}
    </span>
  );
}
