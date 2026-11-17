// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const convert = vi.hoisted(() => vi.fn());
vi.mock("./drawing-wasm.js", () => ({ convertDrawingWasm: convert }));

import { importDrawing } from "./drawing-importer.js";

const platform = process.platform;
let root: string;
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><path d="M0 0L100 40"/></svg>',
);
const converted = () => ({ svg, reader: { unknownEntities: [{}] }, renderer: {} });
const request = (name = "fixture.dwg", bytes = Buffer.from("AC1032 fixture")) => ({
  sessionId: randomUUID(),
  operationId: randomUUID(),
  originalName: name,
  declaredMediaType: null,
  bytes,
});
beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "openharmony" });
  root = await mkdtemp(join(tmpdir(), "cad-cache-test-"));
  await mkdir(join(root, "wasm"));
  await writeFile(
    join(root, "wasm/manifest.json"),
    JSON.stringify({ target: "wasm32-offline", files: { renderer: "v1" } }),
  );
  await writeFile(join(root, "wasm/worker.mjs"), "fixture");
  convert.mockReset().mockImplementation(async () => converted());
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  await rm(root, { recursive: true, force: true });
});

test("repeated imports reuse conversion but retain independent assets, filenames and warnings", async () => {
  const first = await importDrawing(request(), root);
  first.assets[1]!.original.fill(9);
  first.warnings.length = 0;
  const second = await importDrawing(request("renamed.dwg"), root);
  expect(convert).toHaveBeenCalledTimes(1);
  expect(second.assets[1]!.original).toEqual(svg);
  expect(second.assets[0]!.descriptor.originalName).toBe("renamed.dwg");
  expect(second.assets[0]!.descriptor.assetId).not.toBe(first.assets[0]!.descriptor.assetId);
  expect(second.warnings.some((warning) => warning.includes("无法完整还原"))).toBe(true);
  expect(second.assets[1]!.preview).toEqual(first.assets[1]!.preview);
});

test("changed source bytes or converter inventory invalidate the cached result", async () => {
  await importDrawing(request(), root);
  await importDrawing(request("fixture.dwg", Buffer.from("AC1032 changed")), root);
  await writeFile(
    join(root, "wasm/manifest.json"),
    JSON.stringify({ target: "wasm32-offline", files: { renderer: "v2" } }),
  );
  await importDrawing(request(), root);
  expect(convert).toHaveBeenCalledTimes(3);
});

test("failed and cancelled conversions are never reused on retry", async () => {
  convert.mockRejectedValueOnce(new Error("conversion failed"));
  await expect(importDrawing(request(), root)).rejects.toMatchObject({
    code: "CAD_CONVERSION_FAILED",
  });
  const controller = new AbortController();
  convert.mockImplementationOnce(async () => {
    controller.abort();
    return converted();
  });
  await expect(importDrawing(request(), root, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  await importDrawing(request(), root);
  await importDrawing(request(), root);
  expect(convert).toHaveBeenCalledTimes(3);
  const aborted = new AbortController();
  aborted.abort();
  await expect(importDrawing(request(), root, aborted.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("a cache hit cannot hide a removed converter component", async () => {
  await importDrawing(request(), root);
  await rm(join(root, "wasm/worker.mjs"));
  await expect(importDrawing(request(), root)).rejects.toMatchObject({
    code: "CAD_RUNTIME_UNAVAILABLE",
  });
});
