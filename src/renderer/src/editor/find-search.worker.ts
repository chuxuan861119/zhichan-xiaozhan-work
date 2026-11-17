import { searchPreparedChunks } from "./find-replace";
import type { FindSearchRequest } from "./find-search-task";

self.onmessage = (event: MessageEvent<FindSearchRequest>) => {
  try {
    const { chunks, query, options } = event.data;
    self.postMessage(searchPreparedChunks(chunks, query, options, undefined, true, false));
  } catch {
    self.postMessage({ matches: [], error: "查找未完成，请重新查找；此状态不代表没有匹配。" });
  }
};
