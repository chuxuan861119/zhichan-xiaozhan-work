// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ZipFile } from "yazl";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { prepareTileRasterSvg, tilePreviewStrokes } from "../../shared/drawing-markup/tiles.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import type { PatentPatdocPayload } from "../documents/patdoc-format.js";
import { probePatdocFormatVersion, readPatdoc } from "../documents/patdoc-reader.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import {
  packDrawingTiles,
  rasterizeDrawingTile,
  readDrawingTile,
  readDrawingTileIndex,
  validateDrawingContainer,
  validateDrawingTile,
} from "./drawing-tiles.js";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").toUpperCase();
const body =
  '<rect width="1000000" height="800000" fill="white"/><path d="M0 400000H1000000 M500000 0V800000" stroke="black" stroke-width="1000"/><circle cx="500000" cy="400000" r="130000" fill="none" stroke="black" stroke-width="800"/>';
const full = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1600" viewBox="0 0 1000000 800000">${body}</svg>`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cad-tiles-test-"));
  const tiles = [];
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 2; col++) {
      const x = col * 1000,
        y = row * 800,
        w = 1000,
        h = 800,
        left = Math.max(0, x - 8),
        top = Math.max(0, y - 8),
        right = Math.min(2000, x + w + 8),
        bottom = Math.min(1600, y + h + 8);
      const bytes = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${right - left}" height="${bottom - top}" viewBox="${left * 500} ${top * 500} ${(right - left) * 500} ${(bottom - top) * 500}">${body}</svg>`,
      );
      const id: string = `tile-${tiles.length}`;
      await writeFile(join(directory, `${id}.svg`), bytes);
      tiles.push({
        id,
        core: { x, y, width: w, height: h },
        render: { x: left, y: top, width: right - left, height: bottom - top },
        byteLength: bytes.length,
        sha256: hash(bytes),
      });
    }
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({ version: 1, width: 2000, height: 1600, tier: "large", primitives: 3, tiles }),
  );
  return directory;
}
test("WASM raster bytes leave shared memory before IPC and retain the exact PNG slice", async () => {
  const directory = await fixture();
  try {
    const packed = await packDrawingTiles(directory);
    const png = await sharp(Buffer.from(full)).resize(256, 256).png().toBuffer();
    const shared = Buffer.from(new SharedArrayBuffer(png.length + 32), 16, png.length);
    shared.set(png);
    const output = vi.spyOn(sharp.prototype, "toBuffer").mockResolvedValueOnce(shared);
    try {
      const result = await rasterizeDrawingTile(packed.container, "tile-0", {
        region: packed.index.tiles[0]!.render,
        width: 256,
        height: 256,
        strokeScale: 1,
        minimumPixels: 0.65,
      });
      expect(result.buffer).toBeInstanceOf(ArrayBuffer);
      expect(Buffer.from(result)).toEqual(png);
      shared.fill(0);
      expect(Buffer.from(result)).toEqual(png);
    } finally {
      output.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("capped preview allocation does not merge dense fine lines into a solid block", async () => {
  const lines = Array.from(
    { length: 300 },
    (_, i) => `<path d="M0 ${i * 2500}H1000000" stroke="black" stroke-width="100"/>`,
  ).join("");
  const source = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 750000"><rect width="1000000" height="750000" fill="white"/>${lines}</svg>`,
  );
  const raster = {
    region: { x: 0, y: 0, width: 400, height: 300 },
    width: 32,
    height: 24,
    ...tilePreviewStrokes(0.08, 2, 1, 2),
  };
  const { data } = await sharp(
    Buffer.from(prepareTileRasterSvg(source, { width: 400, height: 300 }, raster)),
  )
    .flatten({ background: "white" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  expect(average).toBeGreaterThan(50);
});
test("a bounded container retains geometry across seams, validates and survives PATDOC roundtrip", async () => {
  const directory = await fixture();
  try {
    const packed = await packDrawingTiles(directory);
    expect((await validateDrawingContainer(packed.container)).tiles).toHaveLength(4);
    expect(await readDrawingTileIndex(packed.container)).toEqual(packed.index);
    await expect(readDrawingTile(packed.container, "../other")).rejects.toMatchObject({
      code: "CAD_TILES_INVALID",
    });
    const expected = await sharp(Buffer.from(full)).removeAlpha().raw().toBuffer();
    const actual = await sharp(packed.preview).removeAlpha().raw().toBuffer();
    expect(actual.length).toBe(expected.length);
    let differences = 0;
    for (let i = 0; i < expected.length; i++)
      if (Math.abs(actual[i]! - expected[i]!) > 10) differences++;
    expect(differences).toBeLessThan(expected.length * 0.0002);
    const sourceId = randomUUID(),
      tileId = randomUUID();
    const common = {
      widthPx: 2000,
      heightPx: 1600,
      previewByteLength: packed.preview.length,
      previewSha256: hash(packed.preview),
    };
    const source = Buffer.from("AC1032 synthetic");
    const assets = [
      {
        original: source,
        preview: packed.preview,
        descriptor: {
          ...common,
          assetId: sourceId,
          kind: "drawing-source" as const,
          originalName: "synthetic.dwg",
          mediaType: "image/vnd.dwg" as const,
          extension: "dwg" as const,
          byteLength: source.length,
          sha256: hash(source),
        },
      },
      {
        original: packed.container,
        preview: packed.preview,
        descriptor: {
          ...common,
          assetId: tileId,
          kind: "drawing-tiles" as const,
          originalName: "synthetic.cadtiles",
          mediaType: "application/vnd.zxw.cad-tiles+zip" as const,
          extension: "cadtiles" as const,
          byteLength: packed.container.length,
          sha256: hash(packed.container),
        },
      },
    ];
    const patent = CanonicalPatentSchema.parse({
      ...createBlankPatent({ patentType: "invention", name: null }),
      assets: assets.map((a) => a.descriptor),
      drawingProjects: [
        {
          ...drawingProjectFixture(sourceId),
          baseAssetId: tileId,
          sourceKind: "dwg",
          width: 2000,
          height: 1600,
        },
      ],
    });
    expect(patent.formatVersion).toBe(13);
    const path = join(directory, "tiled.patdoc");
    await writePatdoc(path, {
      patent,
      assets: assets.map((a) => ({
        ...a,
        descriptor: patent.assets.find((d) => d.assetId === a.descriptor.assetId)!,
      })),
    });
    expect(await probePatdocFormatVersion(path)).toEqual({ kind: "current", version: "10" });
    const opened = await readPatdoc<PatentPatdocPayload>(path);
    expect(opened.patent).toEqual(patent);
    expect(
      Buffer.from(opened.assets.find((a) => a.descriptor.assetId === tileId)!.original),
    ).toEqual(packed.container);
    await writePatdoc(join(directory, "normal.patdoc"), {
      patent: createBlankPatent({ patentType: "invention", name: null }),
      assets: [],
    });
    expect(await probePatdocFormatVersion(join(directory, "normal.patdoc"))).toEqual({
      kind: "current",
      version: "9",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("background region painting preserves fine strokes at different zooms and bounds requests", async () => {
  const directory = await fixture();
  try {
    const { container } = await packDrawingTiles(directory);
    const region = { x: 0, y: 760, width: 400, height: 48 };
    const darkRows = [];
    for (const zoom of [1, 2]) {
      const png = await rasterizeDrawingTile(container, "tile-0", {
        region,
        width: 400 * zoom,
        height: 48 * zoom,
        strokeScale: zoom,
        minimumPixels: 0.65,
      });
      const { data, info } = await sharp(png)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(400 * zoom);
      expect(info.height).toBe(48 * zoom);
      let dark = 0;
      for (let y = 0; y < info.height; y++) if (data[(y * info.width + 20) * 3]! < 128) dark++;
      darkRows.push(dark);
    }
    expect(darkRows).toEqual([2, 2]);
    await expect(
      rasterizeDrawingTile(container, "tile-0", {
        region: { ...region, x: 1500 },
        width: 400,
        height: 100,
        strokeScale: 1,
        minimumPixels: 0.65,
      }),
    ).rejects.toMatchObject({ code: "CAD_TILES_INVALID" });
    await expect(
      rasterizeDrawingTile(container, "tile-0", {
        region,
        width: 2048,
        height: 2048,
        strokeScale: 1,
        minimumPixels: 0.65,
      }),
    ).rejects.toMatchObject({ code: "CAD_TILES_INVALID" });
    const controller = new AbortController();
    controller.abort();
    await expect(packDrawingTiles(directory, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test.each([
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg xmlns="http://www.w3.org/2000/svg"/>',
  '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.invalid/a"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:url(https://example.invalid/a)}</style></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(&#104;ttps://example.invalid/a)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https://example.invalid/a)"/></svg>',
])("rejects executable and external SVG content", (svg) =>
  expect(() => validateDrawingTile(Buffer.from(svg))).toThrow(),
);
test("rejects containers with unknown entries before reading their payloads", async () => {
  const zip = new ZipFile(),
    chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (b) => chunks.push(b));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  zip.addBuffer(Buffer.from("secret"), "other/file.txt");
  zip.end();
  await expect(readDrawingTileIndex(await done)).rejects.toMatchObject({
    code: "CAD_TILES_INVALID",
  });
});

test("rejects overlapping cores even when their total area still equals the page", async () => {
  const directory = await fixture();
  try {
    const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
    index.tiles[3].core.x = 990;
    index.tiles[3].render.x = 990;
    index.tiles[3].render.width = 1010;
    await writeFile(join(directory, "index.json"), JSON.stringify(index));
    await expect(packDrawingTiles(directory)).rejects.toMatchObject({ code: "CAD_TILES_INVALID" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visible Retina crops can use four million pixels without losing source detail", async () => {
  const directory = await fixture();
  try {
    const packed = await packDrawingTiles(directory);
    const png = await rasterizeDrawingTile(packed.container, "tile-0", {
      region: packed.index.tiles[0]!.render,
      width: 2048,
      height: 1500,
      strokeScale: 1,
      minimumPixels: 0.65,
    });
    const meta = await sharp(Buffer.from(png)).metadata();
    expect([meta.width, meta.height]).toEqual([2048, 1500]);
    await expect(
      rasterizeDrawingTile(packed.container, "tile-0", {
        region: packed.index.tiles[0]!.render,
        width: 4096,
        height: 4096,
        strokeScale: 1,
        minimumPixels: 0.65,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling overview generation stops reporting and does not start another batch", async () => {
  const directory = await fixture();
  const controller = new AbortController();
  const raster = vi.spyOn(sharp.prototype, "toBuffer");
  const progress = vi.fn(() => controller.abort());
  try {
    await expect(packDrawingTiles(directory, controller.signal, progress)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(progress.mock.calls).toHaveLength(1);
    expect(raster.mock.calls).toHaveLength(2);
  } finally {
    raster.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("overview failure waits for the other active raster before releasing its input", async () => {
  const directory = await fixture();
  let finish!: (bytes: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    finish = resolve;
  });
  const raster = vi
    .spyOn(sharp.prototype, "toBuffer")
    .mockRejectedValueOnce(new Error("raster failed"))
    .mockReturnValueOnce(pending);
  let settled = false;
  try {
    const result = packDrawingTiles(directory).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(raster.mock.calls).toHaveLength(2));
    expect(settled).toBe(false);
    finish(Buffer.alloc(0));
    expect(await result).toMatchObject({ message: "raster failed" });
    expect(raster.mock.calls).toHaveLength(2);
  } finally {
    finish(Buffer.alloc(0));
    raster.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
