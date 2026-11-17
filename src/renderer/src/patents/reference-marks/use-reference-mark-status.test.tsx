import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import * as operations from "../../../../shared/patent/reference-mark-operations";
import { inspectReferenceMarkStatus } from "../../../../shared/patent/reference-mark-operations";
import { useReferenceMarkStatus } from "./use-reference-mark-status";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("reports fallback failure for the newly selected patent instead of hiding it as an old result", async () => {
  class UnavailableWorker {
    constructor() {
      throw new Error("unavailable");
    }
  }
  vi.stubGlobal("Worker", UnavailableWorker);
  const inspect = operations.inspectReferenceMarkStatus;
  vi.spyOn(operations, "inspectReferenceMarkStatus").mockImplementation((patent, id) => {
    if (patent.referenceMarks.length > 0) throw new Error("scan failed");
    return inspect(patent, id);
  });
  const oldPatent = createBlankPatent({ patentType: "invention", name: "旧文档" });
  const newPatent = createBlankPatent({ patentType: "invention", name: "新文档" });
  newPatent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
  const { result, rerender } = renderHook(({ patent }) => useReferenceMarkStatus(patent), {
    initialProps: { patent: oldPatent },
  });
  rerender({ patent: newPatent });
  await waitFor(() => expect(result.current.error).toContain("检查未完成"));
});

test("runs in a worker and discards results from superseded document versions", async () => {
  const workers: Array<{
    onmessage: ((event: { data: unknown }) => void) | null;
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeWorker {
    onmessage = null;
    onerror = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const patent = createBlankPatent({ patentType: "invention", name: "后台检查" });
  patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
  const { result, rerender, unmount } = renderHook(({ p }) => useReferenceMarkStatus(p), {
    initialProps: { p: patent },
  });
  await waitFor(() => expect(workers).toHaveLength(1));
  const first = workers[0];
  if (!first) throw new Error("worker not created");
  expect(first.postMessage).toHaveBeenCalledWith(patent);
  const changed = {
    ...patent,
    revision: 1,
    referenceMarks: [
      ...patent.referenceMarks,
      {
        referenceMarkId: crypto.randomUUID(),
        number: 2,
        keyword: "底座",
      },
    ],
  };
  rerender({ p: changed });
  expect(first.terminate).toHaveBeenCalled();
  await waitFor(() => expect(workers).toHaveLength(2));
  act(() =>
    first.onmessage?.({
      data: {
        ...inspectReferenceMarkStatus(patent),
        sync: { status: "paused", message: "过期结果" },
      },
    }),
  );
  expect(result.current.status.sync).not.toEqual({ status: "paused", message: "过期结果" });
  const latest = inspectReferenceMarkStatus(changed);
  act(() => workers[1]?.onmessage?.({ data: latest }));
  expect(result.current.status).toEqual(latest);
  unmount();
  expect(workers[1]?.terminate).toHaveBeenCalled();
});

test("shares checks across retained books and ignores unrelated parent updates", async () => {
  const posted = vi.fn();
  const terminated = vi.fn();
  class SharedWorker {
    onmessage = null;
    onerror = null;
    postMessage = posted;
    terminate = terminated;
  }
  vi.stubGlobal("Worker", SharedWorker);
  const patent = createBlankPatent({ patentType: "invention", name: "共同检查" });
  patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
  const first = renderHook(({ p }) => useReferenceMarkStatus(p), { initialProps: { p: patent } });
  const second = renderHook(() =>
    useReferenceMarkStatus({ ...patent, activeBookKind: "abstract" }),
  );
  await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
  first.rerender({ p: { ...patent, revision: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(posted).toHaveBeenCalledTimes(1);
  first.unmount();
  expect(terminated).not.toHaveBeenCalled();
  second.unmount();
  expect(terminated).toHaveBeenCalled();
});

test("falls back to cancellable sliced checks if a worker fails", async () => {
  class BrokenWorker {
    onmessage = null;
    onerror: (() => void) | null = null;
    postMessage() {
      setTimeout(() => this.onerror?.(), 0);
    }
    terminate() {}
  }
  vi.stubGlobal("Worker", BrokenWorker);
  const patent = createBlankPatent({ patentType: "invention", name: "检查降级" });
  patent.referenceMarks = [{ referenceMarkId: crypto.randomUUID(), number: 1, keyword: "箱体" }];
  const { result } = renderHook(() => useReferenceMarkStatus(patent));
  await waitFor(() => expect(result.current.status.entries).toHaveLength(1));
  expect(result.current.status).toEqual(inspectReferenceMarkStatus(patent));
});
