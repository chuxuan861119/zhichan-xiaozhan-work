import { expect, test, vi } from "vitest";
import { InputDraftSaveQueue } from "./input-draft-save-queue";

test("scoped flush isolates another patent's failed draft without discarding it", async () => {
  const queue = new InputDraftSaveQueue();
  const failed = vi.fn(async () => false);
  queue.enqueue("a:one", failed);
  expect(await queue.flush((key) => key.startsWith("a:"))).toBe(false);
  const other = vi.fn(async () => true);
  queue.enqueue("b:one", other);
  expect(await queue.flush((key) => key.startsWith("b:"))).toBe(true);
  expect(other).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  expect(await queue.flush()).toBe(false);
});

test("coalesces typing and flush waits for the latest input behind an in-flight write", async () => {
  const queue = new InputDraftSaveQueue();
  let finish!: (ok: boolean) => void;
  const first = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const obsolete = vi.fn(async () => true);
  const latest = vi.fn(async () => true);
  queue.enqueue("a", first);
  const flushed = queue.flush();
  queue.enqueue("a", obsolete);
  queue.enqueue("a", latest);
  expect(first).toHaveBeenCalledTimes(1);
  expect(latest).not.toHaveBeenCalled();
  finish(true);
  expect(await flushed).toBe(true);
  expect(obsolete).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

test("retains failed input for an explicit retry and flushes every conversation", async () => {
  const queue = new InputDraftSaveQueue();
  const failed = vi.fn(async () => false);
  const other = vi.fn(async () => true);
  queue.enqueue("a", failed);
  queue.enqueue("b", other);
  expect(await queue.flush()).toBe(false);
  expect(failed).toHaveBeenCalledTimes(1);
  failed.mockResolvedValue(true);
  expect(await queue.flush()).toBe(true);
  expect(failed).toHaveBeenCalledTimes(2);
  expect(other).toHaveBeenCalledTimes(1);
});

test("a typing burst writes once after the pause", async () => {
  vi.useFakeTimers();
  try {
    const queue = new InputDraftSaveQueue();
    const write = vi.fn(async () => true);
    for (let i = 0; i < 10; i++) queue.enqueue("a", write);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await queue.flush()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("an obsolete failed write does not strand newer input", async () => {
  const queue = new InputDraftSaveQueue();
  let finish!: (ok: boolean) => void;
  queue.enqueue(
    "a",
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const flushed = queue.flush();
  const latest = vi.fn(async () => true);
  queue.enqueue("a", latest);
  finish(false);
  expect(await flushed).toBe(true);
  expect(latest).toHaveBeenCalledTimes(1);
});
