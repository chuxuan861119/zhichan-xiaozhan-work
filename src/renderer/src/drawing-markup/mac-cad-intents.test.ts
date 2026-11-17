import { expect, test } from "vitest";
import { MacCadIntents } from "./mac-cad-intents";

test("preserves pick, tool and path order until geometry is ready", async () => {
  const queue = new MacCadIntents<string>();
  const applied: string[] = [];
  for (const action of ["pick", "arraypath", "path"]) queue.push(action);
  await queue.drain(
    () => false,
    async (x) => {
      applied.push(x);
    },
  );
  expect(applied).toEqual([]);
  await queue.drain(
    () => true,
    async (x) => {
      applied.push(x);
    },
  );
  expect(applied).toEqual(["pick", "arraypath", "path"]);
  expect(queue.pending).toBe(false);
});

test("Escape or session changes discard remaining input during an asynchronous pick", async () => {
  const queue = new MacCadIntents<string>();
  let finish!: () => void;
  const picked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const applied: string[] = [];
  queue.push("pick");
  queue.push("tool");
  queue.push("path");
  const task = queue.drain(
    () => true,
    async (x) => {
      applied.push(x);
      await picked;
    },
  );
  queue.clear();
  finish();
  await task;
  expect(applied).toEqual(["pick"]);
  expect(queue.pending).toBe(false);
});

test("pauses when geometry becomes busy again and bounds pending input", async () => {
  const queue = new MacCadIntents<number>();
  for (let i = 0; i < 32; i++) expect(queue.push(i)).toBe(true);
  expect(queue.push(33)).toBe(false);
  let ready = true;
  const applied: number[] = [];
  await queue.drain(
    () => ready,
    async (x) => {
      applied.push(x);
      ready = false;
    },
  );
  expect(applied).toEqual([0]);
  queue.clear();
  expect(queue.pending).toBe(false);
});
