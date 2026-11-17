import { expect, test, vi } from "vitest";
import { createDetailView } from "../../../shared/drawing-markup/detail-view";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadDraftCheckpoints } from "./cad-draft-checkpoints";
import type { CadScene } from "./cadcraft-client";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const project = {
  ...drawingProjectFixture(id(1)),
  cad: {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "a".repeat(40),
    assetId: id(2),
    mapping: { originX: 0, originY: 800, scale: 1 },
    unified: 1 as const,
    objects: [],
  },
};
const scene: CadScene = {
  revision: 1,
  entityCount: 1,
  selection: [],
  entities: [],
  primitives: [],
  bounds: null,
  svgFrame: { origin: [-20, 820], width: 1040, height: 840 },
};

test("saving an unchanged legacy checkpoint cannot certify stale native labels as synchronized",async()=>{
  const prepare=vi.fn();
  const store=new CadDraftCheckpoints(prepare);
  const legacy={...project,cad:{...project.cad,semanticKey:"0000000000000000"}};
  const resolved=await store.resolve(legacy);
  expect(resolved.project.cad!.semanticKey).toBe(legacy.cad.semanticKey);
  expect(prepare).not.toHaveBeenCalled();
});

test("command checkpoints are interactive before materialization and preserve the exact history revision", async () => {
  const materialize = vi.fn(async () => new Uint8Array([9]));
  const prepare = vi.fn(async (_project: unknown, _bytes: Uint8Array) => ({cad: {...project.cad, assetId: id(9)}, assets: [], previewId: id(8)}));
  const store = new CadDraftCheckpoints(prepare, materialize);
  const checkpoint = {source: new Uint8Array([1]), edits: [{command: "line", params: {a: [0,0], b: [1,1]}}]};
  const draft = store.stage(project, checkpoint, scene, [], true);
  expect(materialize).not.toHaveBeenCalled();
  expect(store.get(draft.cad!.assetId)?.checkpoint).toBe(checkpoint);
  await store.resolve(draft);
  expect(materialize).toHaveBeenCalledExactlyOnceWith(checkpoint);
  expect(prepare.mock.calls[0]?.[1]).toEqual(new Uint8Array([9]));
  // Retaining an old command log after a successful save can replay it against
  // a different worker/solver. The immutable prepared asset is authoritative.
  expect(store.get(draft.cad!.assetId)?.checkpoint).toBeUndefined();
  expect(store.get(draft.cad!.assetId)?.prepared?.cad.assetId).toBe(id(9));
  expect(await store.readBytes(draft.cad!.assetId)).toBeUndefined();
  await store.resolve(draft);
  expect(materialize).toHaveBeenCalledTimes(1);
});

test("live checkpoints are immediately readable, storage resolves a separate immutable project", async () => {
  const prepare = vi.fn(async () => ({
    cad: { ...project.cad, assetId: id(3) },
    assets: [],
    previewId: id(4),
  }));
  const store = new CadDraftCheckpoints(prepare);
  const bytes = new Uint8Array([1, 2, 3]);
  const draft = store.stage(project, bytes, scene, []);
  expect(prepare).not.toHaveBeenCalled();
  expect(store.get(draft.cad!.assetId)?.bytes).toBe(bytes);
  expect(draft.cad!.mapping).toEqual({ originX: -20, originY: 820, scale: 1 });
  const saved = await store.resolve(draft);
  expect(saved.project.cad!.assetId).toBe(id(3));
  expect(saved.project.baseAssetId).toBe(id(4));
  expect(draft.cad!.assetId).not.toBe(id(3));
  expect(draft.baseAssetId).toBe(project.baseAssetId);
  expect(store.get(draft.cad!.assetId)?.bytes).toBeUndefined();
  await store.resolve(draft);
  expect(prepare).toHaveBeenCalledTimes(1);
});

test("label-only checkpoints preserve the camera mapping and all pending capture coordinates", () => {
  const store = new CadDraftCheckpoints(vi.fn());
  const draft = store.stage(project, new Uint8Array([1]), scene, [], true);
  expect(draft.cad!.mapping).toEqual(project.cad.mapping);
  expect([draft.width, draft.height]).toEqual([project.width, project.height]);
  expect(draft.regions).toEqual(project.regions);
  expect(draft.annotations).toEqual(project.annotations);
  expect(draft.cad!.assetId).not.toBe(project.cad.assetId);
});

test("preserving a live frame still rejects geometry beyond the editable extent", () => {
  const store = new CadDraftCheckpoints(vi.fn());
  expect(() => store.stage(project, new Uint8Array([1]), {
    ...scene, svgFrame: { origin: [-200_000, 820], width: 201_000, height: 840 },
  }, [], true)).toThrow("超出当前图纸");
  expect(project.cad.mapping).toEqual({ originX: 0, originY: 800, scale: 1 });
});

test("frozen detail sources and restored history resolve to their own checkpoint, not the latest edit", async () => {
  let counter = 10;
  const store = new CadDraftCheckpoints(async () => ({
    cad: { ...project.cad, assetId: id(counter++) },
    assets: [],
    previewId: id(counter++),
  }));
  const first = store.stage(project, new Uint8Array([1]), scene, []);
  const detail = createDetailView(
    first,
    { x: 30, y: 30 },
    10,
    { x: 200, y: 200 },
    "A",
    2,
    12,
    1,
    id(6),
  );
  const second = store.stage({ ...first, detailViews: [detail] }, new Uint8Array([2]), scene, []);
  const savedFirst = await store.resolve(first);
  const savedSecond = await store.resolve(second);
  expect(savedSecond.project.detailViews![0]!.cadSource!.assetId).toBe(
    savedFirst.project.cad!.assetId,
  );
  expect(savedSecond.project.detailViews![0]!.cadSource!.baseAssetId).toBe(
    savedFirst.project.baseAssetId,
  );
  expect((await store.resolve(first)).project.cad).toEqual(savedFirst.project.cad);
  expect(savedSecond.project.cad!.assetId).not.toBe(savedFirst.project.cad!.assetId);
});

test("a failed preparation retains bytes for retry and never resolves an invalid asset reference", async () => {
  let fail = true;
  const store = new CadDraftCheckpoints(async () => {
    if (fail) throw new Error("storage failed");
    return { cad: { ...project.cad, assetId: id(8) }, assets: [], previewId: id(9) };
  });
  const bytes = new Uint8Array([4]);
  const draft = store.stage(project, bytes, scene, []);
  await expect(store.resolve(draft)).rejects.toThrow("storage failed");
  expect(store.get(draft.cad!.assetId)?.bytes).toBe(bytes);
  fail = false;
  expect((await store.resolve(draft)).project.cad!.assetId).toBe(id(8));
});

test("concurrent frozen-source resolution prepares a shared checkpoint only once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = vi.fn(async () => {
    await gate;
    return { cad: { ...project.cad, assetId: id(11) }, assets: [], previewId: id(12) };
  });
  const store = new CadDraftCheckpoints(prepare);
  const draft = store.stage(project, new Uint8Array([1]), scene, []);
  const a = store.resolve(draft),
    b = store.resolve(draft);
  expect(prepare).toHaveBeenCalledTimes(1);
  release();
  expect((await a).project.cad).toEqual((await b).project.cad);
});

test("stroke checkpoints share immutable source storage and retain failed snapshots for retry", async () => {
  let fail = true;
  const materialize = vi.fn(async () => {
    if (fail) throw new Error("export failed");
    return new Uint8Array([9]);
  });
  const store = new CadDraftCheckpoints(async () => ({cad:{...project.cad,assetId:id(11)},assets:[],previewId:id(12)}), materialize);
  const checkpoint = {source:new Uint8Array([1,2]),sourceId:"immutable-source",edits:[]};
  const first = store.stage(project, checkpoint, scene, []);
  const second = store.stage(first, structuredClone(checkpoint), scene, []);
  expect(store.get(second.cad!.assetId)?.checkpoint?.source).toBe(checkpoint.source);
  await expect(store.resolve(second)).rejects.toThrow("export failed");
  expect(store.get(second.cad!.assetId)?.checkpoint).toBeDefined();
  fail = false;
  expect((await store.resolve(second)).project.cad!.assetId).toBe(id(11));
});
