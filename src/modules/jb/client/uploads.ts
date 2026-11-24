// D-39: board image uploads run in parallel, at most 4 at a time.
export const UPLOAD_CONCURRENCY = 4;

/** Runs tasks with at most `limit` in flight; results keep input order. Failures are returned, not thrown. */
export async function runLimited<T>(tasks: (() => Promise<T>)[], limit = UPLOAD_CONCURRENCY): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; } catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function uploadBoardImages(boardId: string, files: { imageId: string; file: Blob; name: string }[], fetchImpl: typeof fetch = fetch) {
  return runLimited(files.map((f) => async () => {
    const form = new FormData();
    form.set('imageId', f.imageId);
    form.set('file', f.file, f.name);
    const res = await fetchImpl(`/api/jb/boards/${boardId}/images`, { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Upload failed');
    return f.imageId;
  }));
}
