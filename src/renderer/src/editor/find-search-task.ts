import type { DetailedSearchResult, FindOptions, SearchChunk } from "./find-replace";

export type FindSearchRequest = { chunks: SearchChunk[]; query: string; options: FindOptions };

/** No result caps or timeouts: an unfinished search is never an empty result.
 * Changing query/document or closing the panel terminates the isolated worker. */
export function startFindSearch(
  request: FindSearchRequest,
  complete: (result: DetailedSearchResult) => void,
  createWorker: () => Worker = () =>
    new Worker(new URL("./find-search.worker.ts", import.meta.url), { type: "module" }),
): () => void {
  let active = true;
  let worker: Worker | undefined;
  const finish = (result: DetailedSearchResult) => {
    if (!active) return;
    active = false;
    worker?.terminate();
    complete(result);
  };
  try {
    worker = createWorker();
    worker.onmessage = (event: MessageEvent<DetailedSearchResult>) => finish(event.data);
    worker.onerror = () =>
      finish({ matches: [], error: "查找未完成，请重新查找；此状态不代表没有匹配。" });
    worker.postMessage(request);
  } catch {
    finish({ matches: [], error: "查找未完成，请重新查找；此状态不代表没有匹配。" });
  }
  return () => {
    if (!active) return;
    active = false;
    worker?.terminate();
  };
}
