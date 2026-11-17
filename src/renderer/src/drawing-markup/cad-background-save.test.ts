import { expect, test, vi } from "vitest";
import { CadBackgroundSave } from "./cad-background-save";

test("coalescing never crosses a figure-operation barrier or a different document context", async () => {
  const writes: number[] = [];
  const queue = new CadBackgroundSave(vi.fn(), vi.fn());
  queue.enqueueLatest(async () => {writes.push(1);}, "a");
  queue.enqueue(async () => {writes.push(2);});
  queue.enqueueLatest(async () => {writes.push(3);}, "a");
  queue.enqueueLatest(async () => {writes.push(4);}, "b");
  queue.enqueueLatest(async () => {writes.push(5);}, "b");
  expect(await queue.flush()).toBe(true);
  expect(writes).toEqual([1,2,3,5]);
});

test("full document snapshots replace obsolete pending writes without dropping the in-flight write", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: number[] = [];
  const queue = new CadBackgroundSave(vi.fn(), vi.fn());
  queue.enqueueLatest(async () => { await gate; writes.push(1); });
  queue.enqueueLatest(async () => { writes.push(2); });
  queue.enqueueLatest(async () => { writes.push(3); });
  release();
  expect(await queue.flush()).toBe(true);
  expect(writes).toEqual([1, 3]);
});

test("accepts later revisions while storage is blocked and flush waits for all revisions", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: number[] = [];
  const queue = new CadBackgroundSave(
    () => {},
    () => {},
  );
  queue.enqueue(async () => {
    await gate;
    writes.push(1);
  });
  queue.enqueue(async () => {
    writes.push(2);
  });
  expect(queue.pending).toBe(true);
  expect(writes).toEqual([]);
  let closed = false;
  const closing = queue.flush().then((ok) => {
    closed = ok;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await closing;
  expect(writes).toEqual([1, 2]);
  expect(queue.pending).toBe(false);
});

test("retains failures, accepts further edits, and retries in order without replaying successful writes", async () => {
  const errors: string[] = [],
    writes: number[] = [];
  let fail = true;
  const queue = new CadBackgroundSave(
    () => {},
    (error) => errors.push(error.message),
  );
  queue.enqueue(async () => {
    writes.push(1);
  });
  queue.enqueue(async () => {
    if (fail) throw new Error("disk unavailable");
    writes.push(2);
  });
  await vi.waitFor(() => expect(errors).toEqual(["disk unavailable"]));
  queue.enqueue(async () => {
    writes.push(3);
  });
  expect(writes).toEqual([1]);
  expect(await queue.flush()).toBe(false);
  fail = false;
  expect(await queue.flush()).toBe(true);
  expect(writes).toEqual([1, 2, 3]);
});
