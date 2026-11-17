import { expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadAnnotationSync, cadMetadataEdit } from "./cad-annotation-sync";

test("capture ranges and label preferences do not change native CAD geometry", () => {
  const before = drawingProjectFixture("00000000-0000-4000-8000-000000000001");
  before.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: before.baseAssetId,
    unified: 1,
    mapping: { originX: 0, originY: 800, scale: 1 },
  };
  expect(cadMetadataEdit(before, { ...before, regions: [], nextLabel: "5" })).toBe(true);
  expect(cadMetadataEdit(before, { ...before, annotations: [] })).toBe(false);
  expect(
    cadMetadataEdit(before, { ...before, cad: { ...before.cad, assetId: crypto.randomUUID() } }),
  ).toBe(false);
  expect(cadMetadataEdit(before, { ...before, width: before.width + 1 })).toBe(false);
});

test("continuous labels coalesce while computation runs and never publish an older result", async () => {
  const releases: (() => void)[] = [];
  const compute = vi.fn(async (value: number) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return value * 2;
  });
  const publish = vi.fn();
  const queue = new CadAnnotationSync(compute, publish, vi.fn(), vi.fn());
  queue.enqueue(1);
  await Promise.resolve();
  queue.enqueue(2);
  queue.enqueue(3);
  releases.shift()!();
  await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
  expect(compute.mock.calls.map((call) => call[0])).toEqual([1, 3]);
  expect(publish).not.toHaveBeenCalled();
  releases.shift()!();
  expect(await queue.flush()).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith(3, 6);
  expect(queue.pending).toBe(false);
});

test("failed labels stay available and close cannot pass until a successful retry", async () => {
  const failed = vi.fn();
  const publish = vi.fn();
  let reject = true;
  const queue = new CadAnnotationSync(
    async (value: number) => {
      if (reject) throw new Error("failed");
      return value;
    },
    publish,
    vi.fn(),
    failed,
  );
  queue.enqueue(1);
  expect(await queue.flush()).toBe(false);
  expect(queue.latest).toBe(1);
  expect(publish).not.toHaveBeenCalled();
  reject = false;
  queue.enqueue(2);
  expect(await queue.flush()).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith(2, 2);
});

test("a corrected draft automatically retries after failure without needing a separate flush", async () => {
  const publish=vi.fn(),failed=vi.fn();
  const queue=new CadAnnotationSync(async(value:number)=>{if(value===1)throw new Error("invalid");return value;},publish,vi.fn(),failed);
  queue.enqueue(1);
  await vi.waitFor(()=>expect(failed).toHaveBeenCalledOnce());
  queue.enqueue(2);
  await vi.waitFor(()=>expect(publish).toHaveBeenCalledExactlyOnceWith(2,2));
  expect(queue.pending).toBe(false);
});

test("an obsolete computation failure does not poison a newer pending draft",async()=>{
  let reject!:(error:Error)=>void;
  const first=new Promise<number>((_,fail)=>{reject=fail;});
  const publish=vi.fn(),failed=vi.fn();
  const queue=new CadAnnotationSync((value:number)=>value===1?first:Promise.resolve(value),publish,vi.fn(),failed);
  queue.enqueue(1);await Promise.resolve();
  queue.enqueue(2);reject(new Error("old draft invalid"));
  await vi.waitFor(()=>expect(publish).toHaveBeenCalledExactlyOnceWith(2,2));
  expect(failed).not.toHaveBeenCalled();
  expect(queue.pending).toBe(false);
});
