import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ContentSearchIndexDialog } from "./content-search-index-dialog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("keeps indexing progress in the confirmation dialog and completes body-search setup", async () => {
  vi.useFakeTimers();
  let statusRead = 0;
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === "start") {
      return {
        ok: true as const,
        value: {
          enabled: true,
          running: true,
          manual: true,
          completed: 1,
          total: 4,
          updatedAt: null,
          error: false,
          incomplete: true,
        },
      };
    }
    statusRead += 1;
    return {
      ok: true as const,
      value: {
        enabled: true,
        running: statusRead < 2,
        manual: statusRead < 2,
        completed: statusRead < 2 ? 3 : 4,
        total: 4,
        updatedAt: statusRead < 2 ? null : "2026-10-03T12:00:00.000Z",
        error: false,
        incomplete: statusRead < 2,
      },
    };
  });
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  const complete = vi.fn();
  render(<ContentSearchIndexDialog onCancel={vi.fn()} onComplete={complete} />);

  const dialog = screen.getByRole("dialog", { name: "建立正文索引" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "先建立索引" }));
    await Promise.resolve();
  });

  expect(screen.getByRole("dialog", { name: "建立正文索引" })).toBe(dialog);
  const progress = screen.getByRole("progressbar", { name: "正文索引进度" });
  expect(progress.getAttribute("aria-valuenow")).toBe("1");
  expect(progress.querySelector("span")?.style.width).toBe("25%");
  expect(screen.getByText("1 / 4")).toBeDefined();

  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
  expect(screen.getByText("3 / 4")).toBeDefined();
  expect(progress.querySelector("span")?.style.width).toBe("75%");
  expect(complete).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
  expect(complete).not.toHaveBeenCalled();
  expect(progress.querySelector("span")?.style.width).toBe("100%");
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  expect(complete).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith({ action: "start" });
  expect(request.mock.calls.filter(([input]) => input.action === "status")).toHaveLength(2);
});

test.each([
  { updatedAt: null, indexedCount: 0, indexPhase: "failed" as const },
  { updatedAt: "2026-10-03T12:00:00Z", indexedCount: 1, indexPhase: "partial" as const },
])("keeps a failed or partial index reviewable and closable", async (terminal) => {
  const complete = vi.fn(),
    cancel = vi.fn();
  vi.stubGlobal("patentApi", {
    contentSearch: {
      request: vi.fn(async () => ({
        ok: true,
        value: {
          enabled: false,
          running: false,
          completed: 1,
          total: 1,
          error: true,
          incomplete: true,
          ...terminal,
        },
      })),
    },
  });
  render(<ContentSearchIndexDialog onCancel={cancel} onComplete={complete} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "先建立索引" }));
  });
  expect(screen.getByRole("alert")).toBeDefined();
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(cancel).toHaveBeenCalledOnce();
});

test("stops an index before dismissing and does not complete from a late poll", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(),
    complete = vi.fn();
  const request = vi.fn(async (input: { action: string }) => ({
    ok: true,
    value: {
      enabled: false,
      running: input.action !== "stop",
      completed: 0,
      total: 1,
      updatedAt: null,
      error: false,
      incomplete: true,
    },
  }));
  vi.stubGlobal("patentApi", { contentSearch: { request } });
  render(<ContentSearchIndexDialog onCancel={cancel} onComplete={complete} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "先建立索引" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "停止索引" }));
  });
  expect(request).toHaveBeenCalledWith({ action: "stop" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
});
