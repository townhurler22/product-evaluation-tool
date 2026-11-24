// Live updates on fh.workspace and fh.idea.<id> (§3.7). Published after the response, best effort (ARC-22):
// a failed publish is logged and never changes the write. Clients without realtime fall back to polling (ARC-25).
import { afterResponse } from '@/server/after';
import { drainJobs, publish, publishMany, registerChannelRule } from '@/modules/core/service';
import '@/server/jobs-registry';
import type { IdeaRow } from './rows';

// Any member with the panel open may join an idea's channel.
registerChannelRule('fh.idea', async () => true);

export type DetailSection = 'summary' | 'evidence' | 'comments' | 'activity' | 'matches';
export type LookupKind = 'feature' | 'journey' | 'theme' | 'milestone' | 'owner';

export function publishIdeas(rows: IdeaRow[], detail?: { sections: DetailSection[] }) {
  if (!rows.length) return;
  afterResponse(async () => {
    await publishMany('fh.workspace', 'idea.upserted', rows.map((row) => ({ row })));
    if (detail) {
      for (const r of rows) await publish(`fh.idea.${r.id}`, 'idea.detail.changed', { ideaId: r.id, sections: detail.sections });
    }
  });
  drainSoon(); // P5: idea writes queue jb.demand.notify (0006 triggers, INT-53)
}

export function publishDetail(ideaId: string, sections: DetailSection[]) {
  afterResponse(() => publish(`fh.idea.${ideaId}`, 'idea.detail.changed', { ideaId, sections }));
}

export function publishRemoved(items: { id: string; mergedIntoId?: string }[]) {
  if (!items.length) return;
  afterResponse(() => publishMany('fh.workspace', 'idea.removed', items));
  drainSoon();
}

export function publishLookup(kind: LookupKind, id: string) {
  afterResponse(() => publish('fh.workspace', 'lookup.changed', { kind, id }));
  // P5 (D-27): a deleted or moved Feature or a deleted Journey reaches open boards through jb.demand.notify now.
  if (kind === 'feature' || kind === 'journey') drainSoon();
}

/**
 * Runs queued background jobs (duplicate matching, jb.demand.notify) straight after the response (DECISIONS: job
 * runner). Every job kind is registered first, so a drain from a Feedback Hub route can run Journey Boards' notify job.
 */
export function drainSoon() {
  afterResponse(() => drainJobs(5));
}
