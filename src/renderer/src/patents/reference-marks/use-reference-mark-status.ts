import { useMemo, useSyncExternalStore } from "react";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import { inspectReferenceMarkStatus } from "../../../../shared/patent/reference-mark-operations";

type Status = ReturnType<typeof inspectReferenceMarkStatus>;
type Result = { patentId: string; status: Status; error: string | null };
const emptyStatus = (patent: CanonicalPatent): Status =>
  inspectReferenceMarkStatus({ ...patent, referenceMarks: [] });

function runCheck(
  patent: CanonicalPatent,
  setResult: (result: Result | ((previous: Result) => Result)) => void,
) {
  let cancelled = false;
  let worker: Worker | undefined;
  let fallbackStarted = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const finish = (status: Status) => {
    if (!cancelled) setResult({ patentId: patent.patentId, status, error: null });
    clearTimeout(watchdog);
    worker?.terminate();
  };
  const fallback = async () => {
    if (cancelled || fallbackStarted) return;
    fallbackStarted = true;
    worker?.terminate();
    clearTimeout(watchdog);
    try {
      const status = emptyStatus(patent);
      for (const mark of patent.referenceMarks) {
        // Never run the entire fallback scan as one UI-thread task.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled) return;
        const part = inspectReferenceMarkStatus(patent, mark.referenceMarkId);
        status.entries.push(...part.entries);
        for (const id of part.missingReferenceMarkIds) status.missingReferenceMarkIds.add(id);
      }
      finish(status);
    } catch {
      if (!cancelled)
        setResult((previous) => ({
          patentId: patent.patentId,
          status: previous.patentId === patent.patentId ? previous.status : emptyStatus(patent),
          error: "附图标记检查未完成，请重新打开文档后重试。",
        }));
    }
  };
  const timer = setTimeout(() => {
    if (patent.referenceMarks.length === 0) {
      finish(emptyStatus(patent));
      return;
    }
    try {
      worker = new Worker(new URL("./reference-mark-status.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<Status>) => {
        if (!fallbackStarted) finish(event.data);
      };
      worker.onerror = () => {
        void fallback();
      };
      watchdog = setTimeout(() => {
        void fallback();
      }, 10_000);
      worker.postMessage(patent);
    } catch {
      void fallback();
    }
  }, 150);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    worker?.terminate();
  };
}

type Entry = {
  patent: CanonicalPatent;
  documents: unknown[];
  result: Result;
  listeners: Set<() => void>;
  completed: boolean;
  cancel?: (() => void) | undefined;
};
// Only content used by the scan participates in its key. Saving, activating a
// book or rerendering a parent must not restart the same pending check.
const entries: Entry[] = [];
function entryFor(patent: CanonicalPatent) {
  const documents = ["claims", "description", "abstract"].map(
    (kind) => patent.books.find((book) => book.kind === kind)?.document,
  );
  const previous = entries.find(
    (entry) =>
      entry.patent.patentId === patent.patentId &&
      entry.patent.referenceMarks === patent.referenceMarks &&
      entry.patent.drawingBooksEnabled === patent.drawingBooksEnabled &&
      documents.every((doc, index) => doc === entry.documents[index]),
  );
  if (previous) return previous;
  const entry: Entry = {
    patent,
    documents,
    result: { patentId: patent.patentId, status: emptyStatus(patent), error: null },
    listeners: new Set(),
    completed: false,
  };
  entries.push(entry);
  // Bound completed/unsubscribed snapshots without evicting live jobs.
  while (entries.length > 32) {
    const index = entries.findIndex(
      (candidate) => candidate.listeners.size === 0 && candidate !== entry,
    );
    if (index < 0) break;
    entries.splice(index, 1);
  }
  return entry;
}
export function useReferenceMarkStatus(patent: CanonicalPatent): {
  status: Status;
  error: string | null;
} {
  const entry = entryFor(patent);
  const subscribe = useMemo(
    () => (listener: () => void) => {
      entry.listeners.add(listener);
      if (!entry.cancel && !entry.completed) {
        entry.cancel = runCheck(entry.patent, (next) => {
          entry.result = typeof next === "function" ? next(entry.result) : next;
          entry.completed = true;
          for (const notify of entry.listeners) notify();
        });
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
          entry.cancel?.();
          entry.cancel = undefined;
          if (!entry.completed) {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
          }
        }
      };
    },
    [entry],
  );
  return useSyncExternalStore(subscribe, () => entry.result);
}
