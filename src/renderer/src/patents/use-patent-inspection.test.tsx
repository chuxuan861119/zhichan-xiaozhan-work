import { act, renderHook, waitFor } from "@testing-library/react";
import { createBlankPatent } from "../../../shared/patent/defaults";
import type { CanonicalPatent } from "../../../shared/patent/model";
import { inspectPatent } from "../../../shared/patent/validation";
import type { PatentInspectionReport } from "../../../shared/patent-inspection/types";
import { usePatentInspection } from "./use-patent-inspection";

function revision(patent: CanonicalPatent, value: number): CanonicalPatent {
  return { ...patent, revision: value };
}

describe("usePatentInspection", () => {
  test("invalidates cached reports for a coalesced edit with the same aggregate revision", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "合并保存" });
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { inspect, delayMs: 0, automaticMode: "instant" }),
      { initialProps: { value: patent } },
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    await act(async () => result.current.recheck());
    const oldReport = result.current.fullReport;
    const changed = {
      ...patent,
      books: patent.books.map((book) =>
        book.kind === "description" ? { ...book, localRevision: book.localRevision + 1 } : book,
      ),
    };
    rerender({ value: changed });
    expect(result.current.stale).toBe(true);
    expect(result.current.fullReportStale).toBe(true);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.fullReport).toBe(oldReport);
    expect(result.current.fullReportStale).toBe(true);
    await act(async () => result.current.recheck());
    expect(result.current.fullReportStale).toBe(false);
  });

  test("rejects a late report for an older coalesced edit", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "迟到结果" });
    const resolveReports: Array<(report: PatentInspectionReport) => void> = [];
    const inspect = vi.fn(
      () => new Promise<PatentInspectionReport>((resolve) => resolveReports.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { inspect, delayMs: 0 }),
      { initialProps: { value: patent } },
    );
    const changed = {
      ...patent,
      books: patent.books.map((book) => ({ ...book, localRevision: book.localRevision + 1 })),
    };
    rerender({ value: changed });
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    await act(async () => resolveReports[0]?.(inspectPatent(patent)));
    expect(result.current.report).toBeNull();
    await act(async () => resolveReports[1]?.(inspectPatent(changed)));
    expect(result.current.stale).toBe(false);
  });

  test("retains full results separately when background checks refresh and patents switch", async () => {
    const first = createBlankPatent({ patentType: "invention", name: "完整结果" });
    const second = createBlankPatent({ patentType: "invention", name: "另一专利" });
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { inspect, automaticMode: "instant", delayMs: 0 }),
      { initialProps: { value: first } },
    );
    await waitFor(() => expect(result.current.report?.mode).toBe("instant"));
    await act(async () => result.current.recheck());
    const full = result.current.report;
    rerender({ value: { ...first, activeBookKind: "description" } });
    expect(result.current.fullReport).toBe(full);
    expect(result.current.fullReportStale).toBe(false);
    rerender({ value: revision(first, 1) });
    await waitFor(() => expect(result.current.report?.patentRevision).toBe(1));
    expect(result.current.report?.mode).toBe("instant");
    expect(result.current.fullReport).toBe(full);
    expect(result.current.fullReportStale).toBe(true);
    rerender({ value: second });
    await waitFor(() => expect(result.current.report?.patentId).toBe(second.patentId));
    expect(result.current.fullReport).toBeNull();
    rerender({ value: revision(first, 1) });
    await waitFor(() => expect(result.current.fullReport).toBe(full));
    await act(async () => result.current.recheck());
    expect(result.current.fullReport?.patentRevision).toBe(1);
    expect(result.current.fullReportStale).toBe(false);
  });
  test("runs lightweight checks automatically and full checks on request", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "模式" });
    const inspect = vi.fn(inspectPatent);
    const { result } = renderHook(() =>
      usePatentInspection(patent, { inspect, automaticMode: "instant" }),
    );
    await waitFor(() => expect(result.current.report?.mode).toBe("instant"));
    await act(async () => result.current.recheck());
    expect(result.current.report?.mode).toBe("full");
  });
  test("does not replace a failed recheck with cached success and permits retry", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "失败重试" });
    const inspect = vi.fn(inspectPatent);
    const { result } = renderHook(() => usePatentInspection(patent, { inspect }));
    await waitFor(() => expect(result.current.report).not.toBeNull());
    inspect.mockImplementationOnce(() => {
      throw new Error("failed");
    });
    await act(async () => result.current.recheck());
    expect(result.current.report?.degradedRules).toHaveLength(1);
    expect(result.current.fullReport?.degradedRules).toHaveLength(1);
    await act(async () => result.current.recheck());
    expect(result.current.report?.degradedRules).toHaveLength(0);
  });
  test("keeps the old report stale and debounces rapid revisions", async () => {
    vi.useFakeTimers();
    const patent = createBlankPatent({ patentType: "invention", name: "防抖测试" });
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { delayMs: 250, inspect }),
      { initialProps: { value: patent } },
    );

    await act(async () => Promise.resolve());
    expect(result.current.report?.patentRevision).toBe(0);
    expect(result.current.stale).toBe(false);

    for (let nextRevision = 1; nextRevision <= 5; nextRevision += 1) {
      rerender({ value: revision(patent, nextRevision) });
    }
    expect(result.current.report?.patentRevision).toBe(0);
    expect(result.current.stale).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(result.current.report?.patentRevision).toBe(5);
    expect(result.current.stale).toBe(false);
    vi.useRealTimers();
  });

  test("rechecks immediately and cancels a pending debounce", async () => {
    vi.useFakeTimers();
    const patent = createBlankPatent({ patentType: "invention", name: "立即检查" });
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { delayMs: 250, inspect }),
      { initialProps: { value: patent } },
    );
    await act(async () => Promise.resolve());
    rerender({ value: revision(patent, 1) });

    await act(async () => result.current.recheck());
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(result.current.report?.patentRevision).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(inspect).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("stops a running check without publishing its late result", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "停止检查" });
    let resolveInspection: ((report: PatentInspectionReport) => void) | undefined;
    const inspect = vi.fn(
      () =>
        new Promise<PatentInspectionReport>((resolve) => {
          resolveInspection = resolve;
        }),
    );
    const cancel = vi.fn();
    const { result } = renderHook(() => usePatentInspection(patent, { inspect, cancel }));
    await waitFor(() => expect(result.current.running).toBe(true));

    act(() => result.current.cancel());
    expect(result.current.running).toBe(false);
    expect(cancel).toHaveBeenCalled();

    await act(async () => resolveInspection?.(inspectPatent(patent)));
    expect(result.current.report).toBeNull();
  });

  test("reuses a report when switching back to an unchanged patent", async () => {
    const first = createBlankPatent({ patentType: "invention", name: "缓存甲" });
    const second = createBlankPatent({ patentType: "invention", name: "缓存乙" });
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { inspect }),
      { initialProps: { value: first } },
    );
    await waitFor(() => expect(result.current.report?.patentId).toBe(first.patentId));

    rerender({ value: second });
    await waitFor(() => expect(result.current.report?.patentId).toBe(second.patentId));
    rerender({ value: first });
    await waitFor(() => expect(result.current.report?.patentId).toBe(first.patentId));

    expect(inspect).toHaveBeenCalledTimes(2);
  });

  test("does not publish an older asynchronous result or update after unmount", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "竞态测试" });
    const resolvers: Array<(report: PatentInspectionReport) => void> = [];
    const inspect = vi.fn(
      () =>
        new Promise<PatentInspectionReport>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ value }) => usePatentInspection(value, { delayMs: 0, inspect }),
      { initialProps: { value: patent } },
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));
    rerender({ value: revision(patent, 1) });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => resolvers[1]?.(inspectPatent(revision(patent, 1))));
    await act(async () => resolvers[0]?.(inspectPatent(patent)));
    expect(result.current.report?.patentRevision).toBe(1);

    rerender({ value: revision(patent, 2) });
    await waitFor(() => expect(resolvers).toHaveLength(3));
    unmount();
    await act(async () => resolvers[2]?.(inspectPatent(revision(patent, 2))));
  });

  test("evicts old patent reports instead of growing the cache without a limit", async () => {
    const patents = Array.from({ length: 21 }, (_, index) =>
      createBlankPatent({ patentType: "invention", name: `缓存专利${index + 1}` }),
    );
    const inspect = vi.fn(inspectPatent);
    const { result, rerender } = renderHook(
      ({ value }) => usePatentInspection(value, { inspect }),
      { initialProps: { value: patents[0] ?? null } },
    );

    for (const patent of patents) {
      rerender({ value: patent });
      await waitFor(() => expect(result.current.report?.patentId).toBe(patent.patentId));
    }
    rerender({ value: patents[0] ?? null });
    await waitFor(() => expect(result.current.report?.patentId).toBe(patents[0]?.patentId));

    expect(inspect).toHaveBeenCalledTimes(22);
  });
});
