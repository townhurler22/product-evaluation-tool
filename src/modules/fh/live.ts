// Live updates on fh.workspace and fh.idea.<id> (§3.7). Published after the response, best effort (ARC-22):
// a failed publish is logged and never changes the write. Clients without realtime fall back to polling (ARC-25).
import { afterResponse } from '@/server/after';
import { drainJobs, publish, publishMany, registerChannelRule } from '@/modules/core/service';
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
}

export function publishDetail(ideaId: string, sections: DetailSection[]) {
  afterResponse(() => publish(`fh.idea.${ideaId}`, 'idea.detail.changed', { ideaId, sections }));
}

export function publishRemoved(items: { id: string; mergedIntoId?: string }[]) {
  if (!items.length) return;
  afterResponse(() => publishMany('fh.workspace', 'idea.removed', items));
}

export function publishLookup(kind: LookupKind, id: string) {
  afterResponse(() => publish('fh.workspace', 'lookup.changed', { kind, id }));
}

/** Runs queued background jobs (duplicate matching) straight after the response (DECISIONS: job runner). */
export function drainSoon() {
  afterResponse(() => drainJobs(5));
}
