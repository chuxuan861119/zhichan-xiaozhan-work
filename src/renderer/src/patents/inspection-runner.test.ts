import { afterEach, describe, expect, test, vi } from "vitest";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { inspectPatent } from "../../../shared/patent/validation";
import { createInspectionRunner } from "./inspection-runner";

describe("background inspection runner", () => {
  afterEach(() => vi.useRealTimers());
  function setup() {
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    return { worker, runner: createInspectionRunner(() => worker) };
  }
  const patent = createBlankPatent({ patentType: "invention", name: "后台检查" });
  test("dispatches mode and returns the worker report", async () => {
    const { worker, runner } = setup();
    const pending = runner.inspect(patent, "instant");
    expect(worker.postMessage).toHaveBeenCalledWith({
      id: 1,
      patent,
      mode: "instant",
      changed: "unknown",
    });
    const report = inspectPatent(patent, "instant");
    worker.onmessage?.call(worker, new MessageEvent("message", { data: { id: 1, report } }));
    expect(await pending).toEqual(report);
    expect(worker.terminate).not.toHaveBeenCalled();
    runner.dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });
  test("cancels and terminates obsolete work", async () => {
    const { worker, runner } = setup();
    const pending = runner.inspect(patent);
    const rejected = expect(pending).rejects.toThrow();
    runner.cancel();
    await rejected;
    expect(worker.terminate).toHaveBeenCalled();
  });
  test("reports worker failures", async () => {
    const { worker, runner } = setup();
    const pending = runner.inspect(patent);
    const rejected = expect(pending).rejects.toThrow();
    worker.onerror?.call(worker, new ErrorEvent("error"));
    await rejected;
  });
  test("reuses a completed worker and sends only the changed book", async () => {
    const { worker, runner } = setup();
    const report = inspectPatent(patent, "instant");
    const first = runner.inspect(patent, "instant");
    worker.onmessage?.call(worker, new MessageEvent("message", { data: { id: 1, report } }));
    await first;
    const next = {
      ...patent,
      books: patent.books.map((book) =>
        book.kind === "claims"
          ? {
              ...book,
              document: { ...book.document, modifiedAt: "2026-10-04T00:00:00.000Z" },
            }
          : book,
      ),
    };
    const second = runner.inspect(next, "instant");
    const request = vi.mocked(worker.postMessage).mock.calls[1]?.[0];
    expect(request.patent).toBeUndefined();
    expect(request.patch.books.map((book: { kind: string }) => book.kind)).toEqual(["claims"]);
    expect(request.changed).toEqual(["claims", "patent-metadata"]);
    worker.onmessage?.call(worker, new MessageEvent("message", { data: { id: 1, report } }));
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage?.call(worker, new MessageEvent("message", { data: { id: 2, report } }));
    await second;
    runner.dispose();
  });
  test("late errors from cancelled workers cannot cancel a newer inspection", async () => {
    const first = setup().worker;
    const second = setup().worker;
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const runner = createInspectionRunner(factory);
    const old = runner.inspect(patent);
    const rejected = expect(old).rejects.toThrow();
    const lateError = first.onerror;
    const pending = runner.inspect(patent);
    await rejected;
    lateError?.call(first, new ErrorEvent("error"));
    expect(second.terminate).not.toHaveBeenCalled();
    const report = inspectPatent(patent);
    second.onmessage?.call(second, new MessageEvent("message", { data: { id: 2, report } }));
    expect(await pending).toEqual(report);
    runner.dispose();
  });
  test("times out pending jobs, expires idle state and restarts from a full snapshot", async () => {
    vi.useFakeTimers();
    const { worker, runner } = setup();
    const pending = runner.inspect(patent);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const report = inspectPatent(patent);
    const next = runner.inspect(patent);
    worker.onmessage?.call(worker, new MessageEvent("message", { data: { id: 2, report } }));
    await next;
    runner.cancel(); // Cancelling an already completed job must keep its reusable worker.
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
    const final = runner.inspect(patent);
    expect(vi.mocked(worker.postMessage).mock.calls[2]?.[0].patent).toBe(patent);
    const stopped = expect(final).rejects.toThrow();
    runner.dispose();
    await stopped;
  });
});
