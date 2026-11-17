import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CadPreviewCache,
  type CadPreviewDecode,
  type CadPreviewRequest,
} from "./cad-preview-cache";

beforeEach(() => vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
const bytes = new Uint8Array([1]);
function request(x = 0, source = bytes): CadPreviewRequest {
  return {
    bytes: source,
    width: 1000,
    height: 800,
    region: { x, y: 0, width: 30, height: 30 },
    scaleKey: 1,
    screenStrokes: true,
    screenPixelScale: 1,
    rasterWidth: 100,
    rasterHeight: 100,
  };
}
function decode(url: string, encodedBytes = 100) {
  let finish = () => {};
  let fail = (_error: unknown) => {};
  const done = new Promise<void>((yes, no) => {
    finish = yes;
    fail = no;
  });
  const resource: CadPreviewDecode = { url, image: { src: url }, done, encodedBytes };
  return { resource, finish, fail };
}
async function settled() {
  await Promise.resolve();
  await Promise.resolve();
}

test("a normal preview cannot be reused as an editable one-pixel CAD checkpoint", async () => {
  const cache = new CadPreviewCache();
  const job = decode("normal");
  const normal = request();
  const lease = cache.acquire(normal, () => job.resource);
  job.finish();
  await lease.promise;
  expect(cache.find(normal, normal.region)).not.toBeNull();
  expect(cache.find({ ...normal, screenStrokeWidth: 1 }, normal.region)).toBeNull();
  lease.release();
});

test("shares an in-flight decode and aborts only after its last consumer releases", async () => {
  const cache = new CadPreviewCache();
  const job = decode("shared");
  const create = vi.fn(() => job.resource);
  const first = cache.acquire(request(), create);
  const second = cache.acquire(request(), create);
  first.release();
  first.release();
  expect(job.resource.image.src).toBe("shared");
  expect(create).toHaveBeenCalledOnce();
  const rejected = expect(second.promise).rejects.toMatchObject({ name: "AbortError" });
  second.release();
  await rejected;
  expect(job.resource.image.src).toBe("");
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("shared");
});

test("an aborted decode cannot publish over a replacement for the same region", async () => {
  const cache = new CadPreviewCache();
  const obsolete = decode("obsolete"),
    replacement = decode("replacement");
  const first = cache.acquire(request(), () => obsolete.resource);
  const rejected = expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
  first.release();
  await rejected;
  const second = cache.acquire(request(), () => replacement.resource);
  obsolete.finish();
  await settled();
  expect(cache.find(request(), request().region)).toBeNull();
  replacement.finish();
  const frame = await second.promise;
  expect(frame.url).toBe("replacement");
  expect(cache.find(request(), request().region)).toBe(frame);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("replacement");
  second.release();
});

test("releasing a worker job before it has a Blob URL marks it obsolete without revoking an empty URL", async () => {
  const cache = new CadPreviewCache();
  const job = decode("");
  const lease = cache.acquire(request(), () => job.resource);
  const rejected = expect(lease.promise).rejects.toMatchObject({ name: "AbortError" });
  lease.release();
  await rejected;
  expect(job.resource.cancelled).toBe(true);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  job.finish();
  await settled();
  expect(cache.find(request(), request().region)).toBeNull();
});

test("retains displayed frames through request replacement and evicts after DOM ownership ends", async () => {
  const cache = new CadPreviewCache({ pixels: 0, encodedBytes: 0, entries: 0 });
  const job = decode("displayed");
  const lease = cache.acquire(request(), () => job.resource);
  job.finish();
  const frame = await lease.promise;
  const releaseDisplay = cache.retain(frame);
  lease.release();
  await settled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  expect(cache.find(request(), request().region)).toBe(frame);
  releaseDisplay();
  releaseDisplay();
  await settled();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("displayed");
  expect(cache.find(request(), request().region)).toBeNull();
});

test("a failed decode releases its resource and permits a clean retry", async () => {
  const cache = new CadPreviewCache();
  const failed = decode("failed");
  const lease = cache.acquire(request(), () => failed.resource);
  const rejected = expect(lease.promise).rejects.toThrow("bad source");
  failed.fail(Error("bad source"));
  await rejected;
  lease.release();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("failed");
  const next = decode("retry");
  const retry = cache.acquire(request(), () => next.resource);
  next.finish();
  expect((await retry.promise).url).toBe("retry");
  retry.release();
});

test("offscreen frames return immediately and overlapping coverage can reuse an existing region", async () => {
  const cache = new CadPreviewCache();
  const job = decode("retained");
  const first = cache.acquire(request(), () => job.resource);
  job.finish();
  const frame = await first.promise;
  first.release();
  await settled();
  const create = vi.fn(() => decode("unexpected").resource);
  const second = cache.acquire(request(), create);
  expect(second.frame).toBe(frame);
  expect(create).not.toHaveBeenCalled();
  expect(cache.find(request(10), { x: 12, y: 3, width: 5, height: 5 })).toBe(frame);
  expect(cache.find(request(10), { x: 28, y: 3, width: 5, height: 5 })).toBeNull();
  second.release();
});

test("source, dimensions, stroke settings and raster density cannot borrow an incompatible frame", async () => {
  const cache = new CadPreviewCache();
  const job = decode("original");
  const lease = cache.acquire(request(), () => job.resource);
  job.finish();
  await lease.promise;
  for (const next of [
    request(0, bytes.slice()),
    { ...request(), width: 2000 },
    { ...request(), height: 1600 },
    { ...request(), scaleKey: 2 },
    { ...request(), screenStrokes: false },
    { ...request(), screenPixelScale: 2 },
    { ...request(), rasterWidth: 101 },
    { ...request(), rasterHeight: 101 },
  ])
    expect(cache.find(next, { x: 3, y: 3, width: 5, height: 5 })).toBeNull();
  lease.release();
});

test("long travel across sources stays inside shared pixel, entry and encoded-byte limits", async () => {
  const cache = new CadPreviewCache({ pixels: 20_000, encodedBytes: 200, entries: 2 });
  for (let i = 0; i < 20; i++) {
    const job = decode(`region-${i}`);
    const lease = cache.acquire(request(i * 40, new Uint8Array([i])), () => job.resource);
    job.finish();
    await lease.promise;
    lease.release();
    await settled();
    const stats = cache.statistics();
    expect(stats.idlePixels).toBeLessThanOrEqual(20_000);
    expect(stats.idleBytes).toBeLessThanOrEqual(200);
    expect(stats.idleFrames).toBeLessThanOrEqual(2);
  }
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(18);
});

test("a recently revisited frame survives LRU eviction", async () => {
  const cache = new CadPreviewCache({ pixels: 100_000, encodedBytes: 1000, entries: 2 });
  for (const x of [0, 40]) {
    const job = decode(`region-${x}`);
    const lease = cache.acquire(request(x), () => job.resource);
    job.finish();
    await lease.promise;
    lease.release();
    await settled();
  }
  const revisit = cache.acquire(request(), () => {
    throw Error("unexpected decode");
  });
  revisit.release();
  const job = decode("region-80");
  const last = cache.acquire(request(80), () => job.resource);
  job.finish();
  await last.promise;
  last.release();
  await settled();
  expect(cache.find(request(), request().region)?.url).toBe("region-0");
  expect(cache.find(request(40), request(40).region)).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("region-40");
});

test("oversized serialized SVGs are not kept as idle cache even with a small raster", async () => {
  const cache = new CadPreviewCache({ pixels: 100_000, encodedBytes: 200, entries: 8 });
  const job = decode("large-svg", 201);
  const lease = cache.acquire(request(), () => job.resource);
  job.finish();
  await lease.promise;
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  lease.release();
  await settled();
  expect(cache.statistics().idleBytes).toBe(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("large-svg");
});

test("obsolete preview work is aborted only after its last consumer releases", async () => {
  const cache = new CadPreviewCache();
  const job = decode("pending");
  const cancel = vi.fn();
  const first = cache.acquire(request(), () => ({ ...job.resource, cancel }));
  const rejected = expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
  const second = cache.acquire(request(), () => {
    throw Error("duplicate decode");
  });
  first.release();
  expect(cancel).not.toHaveBeenCalled();
  second.release();
  expect(cancel).toHaveBeenCalledTimes(1);
  await rejected;
  job.finish();
});
