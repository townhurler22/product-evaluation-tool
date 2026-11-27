// Public forum rules shared by the server and the browser (NFR-15): slugs, sort order, release batches, limits and
// the public response shapes. No I/O, no server imports.
import { addDays, daysBetween } from './domain';

export const POST_TITLE_MAX = 200;
export const POST_DETAILS_MAX = 5_000;
export const POST_EMAIL_MAX = 320;
export const POST_NAME_MAX = 120;
export const POST_IMAGES_MAX = 3;
/** FH-1211: ≤ 2 MB each after client-side downscaling to 2,560 px on the long edge. */
export const POST_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_LONG_EDGE = 2_560;
export const FORUM_PAGE = 50;
export const FORUM_NAME_MAX = 120;
export const FORUM_PROMPT_MAX = 500;
export const STATUS_LABEL_MAX = 60;
export const PUBLISH_MAX = 50;
export const ROADMAP_MAX = 100;
export const ADMIN_POSTS_PAGE = 50;
export const VOTERS_SHOWN = 200;

export const SORTS = ['trending', 'top', 'new', 'complete'] as const;
export type ForumSort = (typeof SORTS)[number];
export const SORT_LABEL: Record<ForumSort, string> = { trending: 'Trending', top: 'Top', new: 'New', complete: 'Complete' };

/** FH-1102: NFKD, strip diacritics, lower case, non-alphanumerics to `-`, trimmed of `-`, at most 60. */
export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/g, '');
}

/** FH-1205: (votes + 1) / (hours since posted + 2)^1.5, with "now" fixed when the page loads. */
export function trendingScore(votes: number, createdAt: string | Date, now: number): number {
  const hours = Math.max(0, (now - new Date(createdAt).getTime()) / 3_600_000);
  return (votes + 1) / Math.pow(hours + 2, 1.5);
}

/** FH-1208: an idea ships in the first release-train date on or after its due date. */
export function releaseOnOrAfter(due: string, anchor: string, lengthDays: number): string {
  const k = Math.ceil(daysBetween(anchor, due) / lengthDays);
  return addDays(anchor, k * lengthDays);
}

/** `PublicPost` (§11.3). No author, voter, internal status, theme or owner field (INV-16). */
export interface PublicPost {
  id: string;
  title: string;
  details: string | null;
  voteCount: number;
  createdAt: string;
  hasVoted: boolean;
  statusLabel: string;
  statusKind: 'complete' | 'closed' | null;
  isMine: boolean;
  imageCount: number;
}
export const PUBLIC_POST_KEYS = ['id', 'title', 'details', 'voteCount', 'createdAt', 'hasVoted', 'statusLabel', 'statusKind', 'isMine', 'imageCount'] as const;

export interface PublicRoadmapItem {
  id: string;
  title: string;
  /** OD-08: the public summary, never the internal description (D-36). Null shows the title only. */
  summary: string | null;
  statusLabel: string;
  startDate: string;
  dueDate: string | null;
  /** Distinct voters across the idea's linked posts (OD-11). */
  voterCount: number;
}
export const PUBLIC_ROADMAP_KEYS = ['id', 'title', 'summary', 'statusLabel', 'startDate', 'dueDate', 'voterCount'] as const;

export interface PublicForum {
  forum: { name: string; prompt: string | null };
  /** FH-1206: the default label first (always), then each public label present on this forum's posts. */
  statusChips: string[];
  can: { submit: boolean; vote: boolean };
  limits: { titleMax: number; detailsMax: number; emailMax: number; displayNameMax: number; images: number; imageBytes: number; pageSize: number };
}

export interface VoteResult { postId: string; hasVoted: boolean; voteCount: number; changed: boolean }

/** Groups roadmap items into release batches (FH-1208); undated ideas last. */
export function releaseBatches(items: PublicRoadmapItem[], anchor: string, lengthDays: number) {
  const map = new Map<string, PublicRoadmapItem[]>();
  const undated: PublicRoadmapItem[] = [];
  for (const it of items) {
    if (!it.dueDate) { undated.push(it); continue; }
    const r = releaseOnOrAfter(it.dueDate, anchor, lengthDays);
    map.set(r, [...(map.get(r) ?? []), it]);
  }
  const batches: { releaseDate: string | null; items: PublicRoadmapItem[] }[] = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([releaseDate, its]) => ({ releaseDate, items: its }));
  if (undated.length) batches.push({ releaseDate: null, items: undated });
  return batches;
}

/** "3 hours ago" style age, from a fixed "now" so a page does not reshuffle as it ages. */
export function relativeAge(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return fmt(Math.floor(s / 60), 'minute');
  if (s < 86_400) return fmt(Math.floor(s / 3600), 'hour');
  if (s < 30 * 86_400) return fmt(Math.floor(s / 86_400), 'day');
  if (s < 365 * 86_400) return fmt(Math.floor(s / (30 * 86_400)), 'month');
  return fmt(Math.floor(s / (365 * 86_400)), 'year');
}
