'use client';
// Demand legend, bottom-left of the canvas (INT-37): swatches for 0 and the distinct values of
// {1, round(max/4), round(max/2), max}, an Open / All-time switch and an on/off switch. Off hides bands and counts
// but keeps release dates and attention flags. Both are remembered per user per board.
import { useBoard, useUi } from '../context';
import { demandColour, legendValues } from '../demand';

export default function DemandLegend() {
  const { demand } = useBoard();
  const view = useUi((s) => s.demand);
  if (!demand || !view?.available) return null;
  return (
    <section className="jb-legend" aria-label="Demand legend">
      <div className="jb-legend-swatches">
        {view.on && legendValues(view.max).map((v) => (
          <span key={v} className="jb-legend-item"><span className="jb-dot" style={{ background: demandColour(v, view.max) }} aria-hidden="true" />{v}</span>
        ))}
      </div>
      <div role="group" aria-label="Demand scope" className="jb-legend-controls">
        <button type="button" aria-pressed={view.scope === 'open'} onClick={() => demand.setScope('open')}>Open</button>
        <button type="button" aria-pressed={view.scope === 'all'} onClick={() => demand.setScope('all')}>All-time</button>
        <label className="jb-check"><input type="checkbox" checked={view.on} onChange={(e) => demand.setOn(e.target.checked)} /> Demand colours</label>
      </div>
    </section>
  );
}
