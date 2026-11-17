import { expect, test, vi } from "vitest";
import { CadDrawingPipeline } from "./cad-drawing-pipeline";

const deferred = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
};

test("executes the next stroke while a previous immutable checkpoint is saving", async () => {
  const gate = deferred();
  const drawn: number[] = [],
    saved: number[] = [];
  const pipeline = new CadDrawingPipeline<number, number>({
    execute: async (input) => {
      drawn.push(input);
      return input;
    },
    save: async (output) => {
      if (output === 1) await gate.promise;
      saved.push(output);
    },
    onPending: () => {},
    onError: () => {},
  });
  pipeline.enqueue(1);
  pipeline.enqueue(2);
  await vi.waitFor(() => expect(drawn).toEqual([1, 2]));
  expect(saved).toEqual([]);
  expect(pipeline.geometryPending).toBe(false);
  let closed = false;
  const closing = pipeline.flush().then((ok) => {
    closed = ok;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  gate.release();
  await closing;
  expect(saved).toEqual([1, 2]);
  expect(pipeline.pending).toBe(false);
});

test("keeps failed and subsequent checkpoints and retries without drawing twice", async () => {
  const drawn: number[] = [],
    saved: number[] = [],
    errors: string[] = [];
  let fail = true;
  const pipeline = new CadDrawingPipeline<number, number>({
    execute: async (input) => {
      drawn.push(input);
      return input;
    },
    save: async (output) => {
      if (output === 1 && fail) throw new Error("disk unavailable");
      saved.push(output);
    },
    onPending: () => {},
    onError: (error) => errors.push(error.message),
  });
  pipeline.enqueue(1);
  pipeline.enqueue(2);
  await vi.waitFor(() => expect(errors).toEqual(["disk unavailable"]));
  expect(pipeline.pending).toBe(true);
  expect(pipeline.enqueue(3)).toBe(false);
  fail = false;
  expect(await pipeline.flush()).toBe(true);
  expect(drawn).toEqual([1, 2]);
  expect(saved).toEqual([1, 2]);
});

test("retains an accepted stroke if the geometry worker fails before completing it", async () => {
  const saved: number[] = [];
  let fail = true;
  const pipeline = new CadDrawingPipeline<number, number>({
    execute: async (input) => {
      if (input === 1 && fail) throw new Error("worker unavailable");
      return input;
    },
    save: async (output) => {
      saved.push(output);
    },
    onPending: () => {},
    onError: () => {},
  });
  pipeline.enqueue(1);
  pipeline.enqueue(2);
  await vi.waitFor(() => expect(pipeline.error?.message).toBe("worker unavailable"));
  expect(await pipeline.flush()).toBe(false);
  fail = false;
  expect(await pipeline.flush()).toBe(true);
  expect(saved).toEqual([1, 2]);
});

test("bounds buffered checkpoints while retaining and eventually saving every accepted input", async () => {
  const gate = deferred();
  const drawn: number[] = [],
    saved: number[] = [];
  const pipeline = new CadDrawingPipeline<number, number>({
    execute: async (input) => {
      drawn.push(input);
      return input;
    },
    save: async (output) => {
      if (output === 0) await gate.promise;
      saved.push(output);
    },
    byteLength: () => 16 * 1024 * 1024,
    onPending: () => {},
    onError: () => {},
  });
  for (let index = 0; index < 10; index++) pipeline.enqueue(index);
  await vi.waitFor(() => expect(drawn.length).toBeGreaterThanOrEqual(2));
  expect(drawn.length).toBe(2);
  gate.release();
  expect(await pipeline.flush()).toBe(true);
  expect(saved).toEqual(Array.from({ length: 10 }, (_, index) => index));
});
