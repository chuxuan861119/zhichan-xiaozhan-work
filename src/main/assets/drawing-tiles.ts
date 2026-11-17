import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import sharp from "sharp";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import {
  DRAWING_CONTAINER_MAX_BYTES,
  DRAWING_TILE_MAX_BYTES,
  DRAWING_TILE_RASTER_MAX_PIXELS,
  type DrawingTileIndex,
  DrawingTileIndexSchema,
  type DrawingTileRaster,
  DrawingTileRasterSchema,
  prepareTileRasterSvg,
} from "../../shared/drawing-markup/tiles.js";
import { AppOperationError } from "../app-operation-error.js";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").toUpperCase();
const invalid = () =>
  new AppOperationError({ code: "CAD_TILES_INVALID", message: "Invalid drawing resource" });
/** Sweep x and query compressed y intervals; validate a partition in O(n log n). */
function validateCorePartition(index: DrawingTileIndex) {
  const rectangles = index.tiles
    .map((t) => t.core)
    .filter((r) => r.width > 1e-6 && r.height > 1e-6);
  const coordinates = [...new Set(rectangles.flatMap((r) => [r.y, r.y + r.height - 1e-6]))].sort(
    (a, b) => a - b,
  );
  const positions = new Map(coordinates.map((y, i) => [y, i]));
  const count = coordinates.length - 1;
  if (count <= 0) return;
  const maximum = new Int32Array(count * 4),
    lazy = new Int32Array(count * 4);
  const change = (left: number, right: number, delta: number, node = 1, lo = 0, hi = count) => {
    if (right <= lo || hi <= left) return;
    if (left <= lo && hi <= right) {
      maximum[node]! += delta;
      lazy[node]! += delta;
      return;
    }
    const mid = (lo + hi) >>> 1;
    change(left, right, delta, node * 2, lo, mid);
    change(left, right, delta, node * 2 + 1, mid, hi);
    maximum[node] = lazy[node]! + Math.max(maximum[node * 2]!, maximum[node * 2 + 1]!);
  };
  const events = rectangles
    .flatMap((r) => [
      { x: r.x, delta: 1, left: positions.get(r.y)!, right: positions.get(r.y + r.height - 1e-6)! },
      {
        x: r.x + r.width - 1e-6,
        delta: -1,
        left: positions.get(r.y)!,
        right: positions.get(r.y + r.height - 1e-6)!,
      },
    ])
    .sort((a, b) => a.x - b.x || a.delta - b.delta);
  for (const event of events) {
    change(event.left, event.right, event.delta);
    if (maximum[1]! > 1) throw invalid();
  }
}
const validated = new Set<string>();
function externalUrl(text: string) {
  return [...text.matchAll(/url\s*\(\s*(['"]?)([^)'"\s]+)\1\s*\)/giu)].some(
    (match) => !/^#[\w.-]+$/u.test(match[2] ?? ""),
  );
}
export function validateDrawingTile(bytes: Uint8Array) {
  const key = digest(bytes);
  if (validated.has(key)) return;
  if (bytes.length > DRAWING_TILE_MAX_BYTES) throw invalid();
  const text = Buffer.from(bytes).toString("utf8");
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\b)|@import|@font-face|expression\s*\(/iu.test(text))
    throw invalid();
  let malformed = false;
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({
      onError: () => {
        malformed = true;
      },
    }).parseFromString(text, "image/svg+xml");
  } catch {
    throw invalid();
  }
  const root = doc.documentElement;
  const allowed = new Set([
    "svg",
    "g",
    "defs",
    "style",
    "path",
    "rect",
    "line",
    "polyline",
    "polygon",
    "circle",
    "ellipse",
    "clippath",
    "use",
    "title",
    "desc",
  ]);
  if (malformed || root?.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg")
    throw invalid();
  for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    if (element.namespaceURI !== root.namespaceURI) throw invalid();
    if (!allowed.has((element.localName ?? element.tagName).toLowerCase())) throw invalid();
    for (const a of Array.from(element.attributes)) {
      if (
        /^on|^src$/iu.test(a.name) ||
        externalUrl(a.value) ||
        (a.name === "style" && /\\|@/u.test(a.value)) ||
        (/^(?:href|xlink:href)$/iu.test(a.name) && !/^#[\w.-]+$/u.test(a.value))
      )
        throw invalid();
    }
  }
  const css = Array.from(root.getElementsByTagName("style"))
    .map((e) => e.textContent ?? "")
    .join("");
  if (/\\|@/u.test(css) || externalUrl(css)) throw invalid();
  for (const match of text.matchAll(/url\s*\(\s*(['"]?)([^)'"\s]+)\1\s*\)/giu))
    if (!/^#[\w.-]+$/u.test(match[2] ?? "")) throw invalid();
  if (validated.size >= 4096) validated.delete(validated.values().next().value!);
  validated.add(key);
}

/** Open a bounded local container; no paths ever escape the archive. */
async function entries(bytes: Uint8Array) {
  if (bytes.length > DRAWING_CONTAINER_MAX_BYTES) throw invalid();
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, autoClose: false },
      (error, value) => (error || !value ? reject(invalid()) : resolve(value)),
    ),
  );
  const files = new Map<string, yauzl.Entry>();
  try {
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        const name = entry.fileName;
        if (
          files.has(name) ||
          files.size >= 4096 ||
          total > 512 * 1024 * 1024 ||
          !/^(?:index\.json|overview\.png|tile-[0-9]{1,4}\.svg)$/u.test(name) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
          entry.uncompressedSize >
            (name === "index.json" ? 2 * 1024 * 1024 : DRAWING_TILE_MAX_BYTES)
        ) {
          reject(invalid());
          zip.close();
          return;
        }
        files.set(name, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    const read = async (name: string): Promise<Buffer> => {
      const entry = files.get(name);
      if (!entry) throw invalid();
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
        zip.openReadStream(entry, (error, value) =>
          error || !value ? reject(invalid()) : resolve(value),
        ),
      );
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > entry.uncompressedSize) throw invalid();
        chunks.push(chunk);
      }
      if (total !== entry.uncompressedSize) throw invalid();
      return Buffer.concat(chunks, total);
    };
    const index = DrawingTileIndexSchema.parse(
      JSON.parse((await read("index.json")).toString("utf8")),
    );
    if (
      files.size !== index.tiles.length + 2 ||
      !files.has("overview.png") ||
      index.tiles.some((t) => !files.has(`${t.id}.svg`))
    )
      throw invalid();
    const area = index.tiles.reduce((sum, t) => sum + t.core.width * t.core.height, 0);
    if (Math.abs(area - index.width * index.height) > index.width * index.height * 1e-8)
      throw invalid();
    validateCorePartition(index);
    return { index, read, close: () => zip.close() };
  } catch {
    zip.close();
    throw invalid();
  }
}
/** Keep one validated, buffer-backed directory for an immutable main-process asset. */
export async function openDrawingTileReader(bytes: Uint8Array) {
  const archive = await entries(bytes);
  let closed = false;
  const read = async (id: string) => {
    if (closed) throw invalid();
    const tile = archive.index.tiles.find((t) => t.id === id);
    if (!tile) throw invalid();
    const data = await archive.read(`${id}.svg`);
    if (data.length !== tile.byteLength || digest(data) !== tile.sha256) throw invalid();
    validateDrawingTile(data);
    return data;
  };
  return {
    index: () => structuredClone(archive.index),
    read,
    rasterize: async (id: string, raster: DrawingTileRaster) => {
      if (!DrawingTileRasterSchema.safeParse(raster).success) throw invalid();
      const tile = archive.index.tiles.find((t) => t.id === id),
        r = raster.region;
      if (
        !tile ||
        r.x < tile.render.x - 1e-6 ||
        r.y < tile.render.y - 1e-6 ||
        r.x + r.width > tile.render.x + tile.render.width + 1e-6 ||
        r.y + r.height > tile.render.y + tile.render.height + 1e-6
      )
        throw invalid();
      const source = await read(id);
      const png = await sharp(Buffer.from(prepareTileRasterSvg(source, archive.index, raster)), {
        limitInputPixels: DRAWING_TILE_RASTER_MAX_PIXELS,
      })
        .resize(raster.width, raster.height, { fit: "fill" })
        .png()
        .toBuffer()
        .catch(() => {
          throw invalid();
        });
      // Sharp WASM returns a view into shared linear memory. Electron IPC cannot
      // clone SharedArrayBuffer, and a later raster may reuse that memory.
      return png.buffer instanceof SharedArrayBuffer ? Buffer.from(png) : png;
    },
    close: () => {
      closed = true;
      archive.close();
    },
  };
}
export async function readDrawingTileIndex(bytes: Uint8Array) {
  const reader = await openDrawingTileReader(bytes);
  try {
    return reader.index();
  } finally {
    reader.close();
  }
}
export async function readDrawingTile(bytes: Uint8Array, id: string) {
  const reader = await openDrawingTileReader(bytes);
  try {
    return await reader.read(id);
  } finally {
    reader.close();
  }
}
export async function rasterizeDrawingTile(
  bytes: Uint8Array,
  id: string,
  raster: DrawingTileRaster,
) {
  const reader = await openDrawingTileReader(bytes);
  try {
    return await reader.rasterize(id, raster);
  } finally {
    reader.close();
  }
}
export async function validateDrawingContainer(bytes: Uint8Array, signal?: AbortSignal) {
  const archive = await entries(bytes);
  try {
    for (const tile of archive.index.tiles) {
      signal?.throwIfAborted();
      const data = await archive.read(`${tile.id}.svg`);
      if (digest(data) !== tile.sha256 || data.length !== tile.byteLength) throw invalid();
      validateDrawingTile(data);
    }
    const overview = await archive.read("overview.png");
    const meta = await sharp(overview, { limitInputPixels: 4_000_000 })
      .metadata()
      .catch(() => {
        throw invalid();
      });
    if (meta.format !== "png" || !meta.width || !meta.height) throw invalid();
    return archive.index;
  } finally {
    archive.close();
  }
}

export async function packDrawingTiles(
  directory: string,
  signal?: AbortSignal,
  progress?: (completed: number, total: number) => void,
) {
  const index: DrawingTileIndex = DrawingTileIndexSchema.parse(
    JSON.parse(await readFile(join(directory, "index.json"), "utf8")),
  );
  const width = Math.max(1, Math.round(index.width)),
    height = Math.max(1, Math.round(index.height));
  if (width * height > 4_000_000) throw invalid();
  const sx = width / index.width,
    sy = height / index.height;
  const canvas = Buffer.alloc(width * height * 4, 255);
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  let compressed = 0;
  const finished = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => {
      compressed += chunk.length;
      if (compressed > DRAWING_CONTAINER_MAX_BYTES) {
        (zip.outputStream as import("node:stream").Readable).destroy(invalid());
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks, compressed)));
  });
  // Attach a rejection handler immediately, while sequential rasterization is running.
  void finished.catch(() => {});
  const abort = () =>
    (zip.outputStream as import("node:stream").Readable).destroy(
      signal?.reason ?? new Error("Cancelled"),
    );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    zip.addBuffer(Buffer.from(JSON.stringify(index)), "index.json");
    for (let offset = 0; offset < index.tiles.length; offset += 2) {
      signal?.throwIfAborted();
      // Two bounded raster jobs use separate CPU cores; retain source order when
      // composing and reporting, and settle both before any failure/cleanup.
      const batch = await Promise.allSettled(
        index.tiles.slice(offset, offset + 2).map(async (tile) => {
          const bytes = await readFile(join(directory, `${tile.id}.svg`));
          signal?.throwIfAborted();
          if (bytes.length !== tile.byteLength || digest(bytes) !== tile.sha256) throw invalid();
          validateDrawingTile(bytes);
          const c = tile.core,
            r = tile.render;
          const x = Math.round(c.x * sx),
            y = Math.round(c.y * sy),
            right = Math.round((c.x + c.width) * sx),
            bottom = Math.round((c.y + c.height) * sy);
          const left = Math.floor(r.x * sx),
            top = Math.floor(r.y * sy),
            rw = Math.ceil((r.x + r.width) * sx) - left,
            rh = Math.ceil((r.y + r.height) * sy) - top;
          let pixels: Buffer | undefined;
          if (right > x && bottom > y) {
            const markup = prepareTileRasterSvg(bytes, index, {
              region: { x: left / sx, y: top / sy, width: rw / sx, height: rh / sy },
              width: rw,
              height: rh,
              strokeScale: 1,
              minimumPixels: 0.5,
            });
            pixels = await sharp(Buffer.from(markup), { limitInputPixels: 16_000_000 })
              .resize(rw, rh, { fit: "fill" })
              .ensureAlpha()
              .raw()
              .toBuffer();
          }
          return { tile, bytes, pixels, x, y, right, bottom, left, top, rw };
        }),
      );
      const failed = batch.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const [i, result] of batch.entries()) {
        signal?.throwIfAborted();
        if (result.status !== "fulfilled") throw invalid();
        const { tile, bytes, pixels, x, y, right, bottom, left, top, rw } = result.value;
        zip.addBuffer(bytes, `${tile.id}.svg`);
        if (pixels)
          for (let row = y; row < bottom; row++)
            pixels.copy(
              canvas,
              (row * width + x) * 4,
              ((row - top) * rw + x - left) * 4,
              ((row - top) * rw + right - left) * 4,
            );
        progress?.(offset + i + 1, index.tiles.length);
      }
    }
    const preview = await sharp(canvas, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    zip.addBuffer(preview, "overview.png");
    zip.end();
    const container = await finished;
    signal?.throwIfAborted();
    await validateDrawingContainer(container, signal);
    return { container, preview, index };
  } catch (error) {
    (zip.outputStream as import("node:stream").Readable).destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
