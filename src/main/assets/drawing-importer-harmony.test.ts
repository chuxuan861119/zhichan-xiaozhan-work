// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const convert = vi.hoisted(() => vi.fn());
vi.mock("./drawing-wasm.js", () => ({ convertDrawingWasm: convert }));

import { importDrawing } from "./drawing-importer.js";
import { readDrawingTileIndex, validateDrawingContainer } from "./drawing-tiles.js";

test("Harmony import preserves the DWG and creates a vector base and PNG preview", async () => {
  const platform = process.platform;
  const root = await mkdtemp(join(tmpdir(), "harmony-import-"));
  await mkdir(join(root, "wasm"));
  await writeFile(join(root, "wasm/manifest.json"), JSON.stringify({ target: "wasm32-offline" }));
  await writeFile(join(root, "wasm/worker.mjs"), "fixture");
  Object.defineProperty(process, "platform", { value: "openharmony" });
  try {
    const bytes = Buffer.from("AC1032 fixture");
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="100" height="40"/></svg>',
    );
    convert.mockResolvedValue({ svg, reader: {}, renderer: {} });
    const result = await importDrawing(
      {
        sessionId: randomUUID(),
        operationId: randomUUID(),
        originalName: "fixture.dwg",
        declaredMediaType: null,
        bytes,
      },
      root,
    );
    expect(convert).toHaveBeenCalledWith(root, bytes, undefined, undefined, expect.any(String));
    expect(result.sourceKind).toBe("dwg");
    expect(result.assets).toHaveLength(2);
    const [source, vector] = result.assets;
    if (!source || !vector) throw new Error("Missing drawing assets");
    expect(Buffer.from(source.original)).toEqual(bytes);
    expect(vector.descriptor.kind).toBe("vector-image");
    expect(Buffer.from(vector.original)).toEqual(svg);
    expect(await sharp(vector.preview).metadata()).toMatchObject({
      format: "png",
      width: 2000,
      height: 1000,
    });
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    await rm(root, { recursive: true, force: true });
  }
});

test("Harmony tiles are validated, packed, cached and clean private intermediate files", async () => {
  const platform = process.platform;
  const root = await mkdtemp(join(tmpdir(), "harmony-tiles-import-"));
  await mkdir(join(root, "wasm"));
  await writeFile(
    join(root, "wasm/manifest.json"),
    JSON.stringify({ target: "wasm32-offline", drawingTiles: 1 }),
  );
  await writeFile(join(root, "wasm/worker.mjs"), "fixture");
  Object.defineProperty(process, "platform", { value: "openharmony" });
  let output = "";
  try {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0L100 50" stroke="black"/></svg>',
    );
    convert.mockImplementationOnce(async (_root, _bytes, _signal, _progress, directory) => {
      output = directory;
      await mkdir(output);
      await writeFile(join(output, "tile-0.svg"), svg);
      await writeFile(
        join(output, "index.json"),
        JSON.stringify({
          version: 1,
          tier: "huge",
          width: 100,
          height: 50,
          primitives: 500000,
          tiles: [
            {
              id: "tile-0",
              core: { x: 0, y: 0, width: 100, height: 50 },
              render: { x: 0, y: 0, width: 100, height: 50 },
              byteLength: svg.length,
              sha256: createHash("sha256").update(svg).digest("hex").toUpperCase(),
            },
          ],
        }),
      );
      return { tiled: true, reader: {}, renderer: {} };
    });
    const input = {
      sessionId: randomUUID(),
      operationId: randomUUID(),
      originalName: "tiles.dwg",
      declaredMediaType: null,
      bytes: Buffer.from("AC1032 tiled fixture"),
    };
    const result = await importDrawing(input, root);
    expect(result.assets.map((a) => a.descriptor.kind)).toEqual([
      "drawing-source",
      "drawing-tiles",
    ]);
    const base = result.assets[1]!;
    expect((await validateDrawingContainer(base.original)).tier).toBe("huge");
    expect((await readDrawingTileIndex(base.original)).tiles).toHaveLength(1);
    await expect(access(output)).rejects.toThrow();
    convert.mockClear();
    const cached = await importDrawing({ ...input, operationId: randomUUID() }, root);
    expect(convert).not.toHaveBeenCalled();
    expect(Buffer.from(cached.assets[1]!.original)).toEqual(Buffer.from(base.original));
    expect(cached.assets[1]!.descriptor.assetId).not.toBe(base.descriptor.assetId);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    await rm(root, { recursive: true, force: true });
  }
});
