// Comments (§8.12). Not ops, not undoable. Each write publishes the changed thread only (JB-1204, D-25).
import { sql } from 'kysely';
import { newId, type Principal } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { cleanText, TextTooLong } from '@/lib/text';
import { forbidden, loadBoard, notFound, requireComment } from './access';
import { boardChannel, emit, eventBytes, MAX_EVENT_BYTES } from './events';

export interface CommentMessage { id: string; authorId: string | null; authorName: string | null; body: string; editedAt: string | null; createdAt: string }
export interface CommentThread {
  id: string; boardId: string; authorId: string | null; anchorType: 'BOARD' | 'NODE'; anchorNodeId: string | null;
  x: number; y: number; resolvedAt: string | null; resolvedBy: string | null; createdAt: string; updatedAt: string;
  messages: CommentMessage[];
}

function body(text: string): string {
  try {
    const b = cleanText(text, 2000);
    if (!b) throw new ApiError('validation', 'Write a comment first.', { field: 'body' });
    return b;
  } catch (e) {
    if (e instanceof TextTooLong) throw new ApiError('validation', 'Comments can be at most 2,000 characters.', { field: 'body' });
    throw e;
  }
}

/** Threads with messages, one statement. `threadId` narrows to one thread (refetch after a large event). */
async function readThreads(boardId: string, threadId?: string): Promise<CommentThread[]> {
  const rows = (await sql<{ t: CommentThread }>`
    SELECT jsonb_build_object(
      'id', t.id, 'boardId', t.board_id, 'authorId', t.author_id, 'anchorType', t.anchor_type, 'anchorNodeId', t.anchor_node_id,
      'x', t.x, 'y', t.y, 'resolvedAt', t.resolved_at, 'resolvedBy', t.resolved_by, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
      'messages', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'authorId', m.author_id, 'authorName', u.full_name,
        'body', m.body, 'editedAt', m.edited_at, 'createdAt', m.created_at) ORDER BY m.created_at)
        FROM jb_comment_message m LEFT JOIN core_user u ON u.id = m.author_id WHERE m.thread_id = t.id), '[]'::jsonb)) AS t
    FROM jb_comment_thread t
    WHERE t.board_id = ${boardId} ${threadId ? sql`AND t.id = ${threadId}` : sql``}
    ORDER BY (t.resolved_at IS NOT NULL), t.updated_at DESC
    LIMIT 500`.execute(getDb())).rows;
  return rows.map((r) => r.t);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listThreads(principal: Principal, boardId: string, threadId?: string) {
  await loadBoard(principal, boardId);
  if (threadId && !UUID_RE.test(threadId)) throw notFound();
  return readThreads(boardId, threadId);
}

function publishThread(boardId: string, thread: CommentThread) {
  // D-25: the event carries the changed thread; over 8 KB it names the thread and clients fetch only it.
  emit(boardChannel(boardId), 'comment.upserted', eventBytes({ thread }) > MAX_EVENT_BYTES ? { threadId: thread.id } : { thread });
}

async function one(boardId: string, threadId: string) {
  const [t] = await readThreads(boardId, threadId);
  if (!t) throw notFound();
  return t;
}

export async function createThread(principal: Principal, boardId: string, input: { anchorType: 'BOARD' | 'NODE'; anchorNodeId?: string | null; x: number; y: number; body: string }) {
  await requireComment(principal, boardId);
  const text = body(input.body);
  const id = newId();
  await getDb().transaction().execute(async (tx) => {
    if (input.anchorType === 'NODE') {
      // JB-1201: the card must be live.
      const live = await tx.selectFrom('jb_node').select('id').where('board_id', '=', boardId).where('id', '=', input.anchorNodeId ?? '')
        .where('deleted_at', 'is', null).executeTakeFirst();
      if (!live) throw new ApiError('rule_violation', 'That card no longer exists.');
    }
    await tx.insertInto('jb_comment_thread').values({
      id, board_id: boardId, author_id: principal.userId, anchor_type: input.anchorType,
      anchor_node_id: input.anchorType === 'NODE' ? input.anchorNodeId! : null, x: input.x, y: input.y,
    }).execute();
    await tx.insertInto('jb_comment_message').values({ id: newId(), thread_id: id, author_id: principal.userId, body: text }).execute();
  });
  const thread = await one(boardId, id);
  publishThread(boardId, thread);
  return thread;
}

async function threadRow(boardId: string, threadId: string) {
  if (!UUID_RE.test(threadId)) throw notFound();
  const t = await getDb().selectFrom('jb_comment_thread').select(['id', 'author_id']).where('board_id', '=', boardId).where('id', '=', threadId).executeTakeFirst();
  if (!t) throw notFound();
  return t;
}

export async function reply(principal: Principal, boardId: string, threadId: string, text: string) {
  await requireComment(principal, boardId);
  const b = body(text);
  await threadRow(boardId, threadId);
  await getDb().insertInto('jb_comment_message').values({ id: newId(), thread_id: threadId, author_id: principal.userId, body: b }).execute();
  await getDb().updateTable('jb_comment_thread').set({ updated_at: new Date() }).where('id', '=', threadId).execute();
  const thread = await one(boardId, threadId);
  publishThread(boardId, thread);
  return thread;
}

export async function setResolved(principal: Principal, boardId: string, threadId: string, resolved: boolean) {
  await requireComment(principal, boardId);
  await threadRow(boardId, threadId);
  await getDb().updateTable('jb_comment_thread').set({
    resolved_at: resolved ? new Date() : null, resolved_by: resolved ? principal.userId : null, updated_at: new Date(),
  }).where('id', '=', threadId).execute();
  const thread = await one(boardId, threadId);
  publishThread(boardId, thread);
  return thread;
}

export async function editMessage(principal: Principal, boardId: string, threadId: string, messageId: string, text: string) {
  await requireComment(principal, boardId);
  const b = body(text);
  await threadRow(boardId, threadId);
  if (!UUID_RE.test(messageId)) throw notFound();
  const m = await getDb().selectFrom('jb_comment_message').select('author_id').where('id', '=', messageId).where('thread_id', '=', threadId).executeTakeFirst();
  if (!m) throw notFound();
  if (m.author_id !== principal.userId) throw forbidden('You can only edit your own comments.');
  await getDb().updateTable('jb_comment_message').set({ body: b, edited_at: new Date() }).where('id', '=', messageId).execute();
  const thread = await one(boardId, threadId);
  publishThread(boardId, thread);
  return thread;
}

/** Delete a thread: its author, the owner or a manager (JB-1202, JB-1301). */
export async function deleteThread(principal: Principal, boardId: string, threadId: string) {
  const a = await requireComment(principal, boardId);
  const t = await threadRow(boardId, threadId);
  if (t.author_id !== principal.userId && !a.rights.canManage) throw forbidden('Only the author, the owner or a workspace admin can delete this thread.');
  await getDb().deleteFrom('jb_comment_thread').where('id', '=', threadId).execute();
  emit(boardChannel(boardId), 'comment.removed', { threadId });
}

/** Delete one message: its author, the owner or a manager. Removing the last message removes the thread. */
export async function deleteMessage(principal: Principal, boardId: string, threadId: string, messageId: string) {
  const a = await requireComment(principal, boardId);
  await threadRow(boardId, threadId);
  if (!UUID_RE.test(messageId)) throw notFound();
  const m = await getDb().selectFrom('jb_comment_message').select('author_id').where('id', '=', messageId).where('thread_id', '=', threadId).executeTakeFirst();
  if (!m) throw notFound();
  if (m.author_id !== principal.userId && !a.rights.canManage) throw forbidden('Only the author, the owner or a workspace admin can delete this comment.');
  await getDb().deleteFrom('jb_comment_message').where('id', '=', messageId).execute();
  const thread = (await readThreads(boardId, threadId))[0];
  if (!thread || !thread.messages.length) {
    await getDb().deleteFrom('jb_comment_thread').where('id', '=', threadId).execute();
    emit(boardChannel(boardId), 'comment.removed', { threadId });
    return null;
  }
  publishThread(boardId, thread);
  return thread;
}
