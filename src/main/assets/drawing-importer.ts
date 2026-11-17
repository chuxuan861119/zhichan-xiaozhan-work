import { type ExecFileOptions, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { z } from "zod";
import { MAX_CAD_IMPORT_BYTES } from "../../shared/drawing-markup/import-limits.js";
import type { DrawingImportStage } from "../../shared/drawing-markup/import-progress.js";
import type { DrawingImportRequestSchema } from "../../shared/ipc/contract.js";
import { AppOperationError } from "../app-operation-error.js";
import type { StoredAsset } from "./asset-store.js";
import { DrawingConversionCache } from "./drawing-conversion-cache.js";
import { ProgressLineDecoder } from "./drawing-import-progress.js";
import { drawingRuntimeCacheIdentity, drawingRuntimeCommands } from "./drawing-runtime.js";
import { packDrawingTiles } from "./drawing-tiles.js";
import { convertDrawingWasm } from "./drawing-wasm.js";
import { decodeBmpToBgra, importImage } from "./image-importer.js";

const run = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  progress?: (value: DrawingImportStage) => void,
  budget = { elapsed: 0, last: performance.now() },
) =>
  new Promise<void>((resolve, reject) => {
    let expired = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const now = performance.now();
      budget.elapsed += Math.min(now - budget.last, 2000);
      budget.last = now;
      if (!expired && budget.elapsed >= 20 * 60 * 1000) {
        expired = true;
        child?.kill();
        force = setTimeout(() => child?.kill("SIGKILL"), 5000);
        force.unref();
      }
    }, 1000);
    timer.unref();
    const child = execFile(file, args, options, (error) => {
      clearInterval(timer);
      clearTimeout(force);
      const failure = expired
        ? new AppOperationError({
            code: "CAD_CONVERSION_TIMEOUT",
            message: "Conversion timed out",
          })
        : error;
      if (failure)
        queueMicrotask(() => {
          // Cancellation can report before the converter has finished exiting.
          if (child?.pid && child.exitCode === null && child.signalCode === null) {
            const force = setTimeout(() => child.kill("SIGKILL"), 5000);
            force.unref();
            child.once("close", () => {
              clearTimeout(force);
              reject(failure);
            });
          } else reject(failure);
        });
      else resolve();
    });
    if (progress) {
      const decoder = new ProgressLineDecoder(progress);
      child?.stderr?.on("data", (chunk: Buffer) => decoder.push(chunk));
    }
  });
// Process-local only: never persist private drawings in an additional disk cache.
const conversionCache = new DrawingConversionCache();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
async function importDrawingNow(
  input: z.infer<typeof DrawingImportRequestSchema>,
  runtime: string,
  signal?: AbortSignal,
  progress?: (value: DrawingImportStage) => void,
): Promise<{
  assets: StoredAsset[];
  sourceKind: "dwg" | "pdf" | "image";
  warnings: string[];
}> {
  signal?.throwIfAborted();
  const signature = Buffer.from(input.bytes.subarray(0, 8)).toString("ascii");
  const kind = signature.startsWith("AC10")
    ? "dwg"
    : signature.startsWith("%PDF-")
      ? "pdf"
      : "image";
  if (kind === "image") {
    const bmpToPng = async (bytes: Uint8Array) => {
      const { pixels, width, height } = decodeBmpToBgra(bytes);
      return sharp(pixels, { raw: { width, height, channels: 4 } })
        .recomb([
          [0, 0, 1],
          [0, 1, 0],
          [1, 0, 0],
        ])
        .png()
        .toBuffer();
    };
    const source = await importImage(input, { bmpToPng });
    const decoded =
      source.descriptor.mediaType === "image/bmp" ? await bmpToPng(input.bytes) : input.bytes;
    const png = await sharp(decoded, { limitInputPixels: 32_000_000 }).rotate().png().toBuffer();
    const base = await importImage({ originalName: "图纸底图.png", bytes: png });
    signal?.throwIfAborted();
    return { assets: [source, base], sourceKind: kind, warnings: [] };
  }
  let tiles: Buffer | undefined;
  let svg: Buffer | undefined;
  let preview!: Buffer;
  let width = 1000,
    height = 1000;
  const warnings: string[] = [];
  if (kind === "dwg") {
    const harmony = ["openharmony", "ohos"].includes(process.platform as string);
    // Keep checking component availability even when a prior result is cached.
    const commands = harmony ? undefined : await drawingRuntimeCommands(runtime);
    const identity = await drawingRuntimeCacheIdentity(runtime);
    const key = JSON.stringify([
      "dwg-preview-v1",
      resolve(runtime),
      process.platform,
      process.arch,
      identity,
      hash(input.bytes),
    ]);
    signal?.throwIfAborted();
    const cached = conversionCache.get(key);
    if (cached) {
      ({ svg, tiles, preview, width, height } = cached);
      warnings.push(...cached.warnings);
    } else {
      const directory = await mkdtemp(join(tmpdir(), "patent-drawing-"));
      try {
        let reader: { unknownEntities?: unknown[]; recoveredBlockReferences?: unknown[] };
        let renderer: { skipped?: unknown[]; externalReferences?: number };
        if (harmony) {
          const output = join(directory, "render");
          const result = await convertDrawingWasm(runtime, input.bytes, signal, progress, output);
          if (result.tiled) {
            const packed = await packDrawingTiles(output, signal, (completed, total) =>
              progress?.({ phase: "preview", completed, total }),
            );
            tiles = packed.container;
            preview = packed.preview;
            width = Math.round(packed.index.width);
            height = Math.round(packed.index.height);
          } else svg = Buffer.from(result.svg);
          reader = result.reader;
          renderer = result.renderer;
        } else {
          const source = join(directory, "source.dwg");
          await writeFile(source, input.bytes, { flag: "wx" });
          const budget = { elapsed: 0, last: performance.now() };
          const options = {
            windowsHide: true,
            timeout: 0,
            maxBuffer: 1024 * 1024,
            ...(signal ? { signal } : {}),
          };
          progress?.({ phase: "read", completed: null, total: null });
          await run(commands!.reader, [source, join(directory, "read")], options, progress, budget);
          progress?.({ phase: "parse", completed: null, total: null });
          await run(
            commands!.renderer,
            [
              ...commands!.rendererArguments,
              join(directory, "read", "drawing.dxf"),
              join(directory, "render"),
              ...(commands!.drawingTiles ? ["--source-bytes", String(input.bytes.length)] : []),
            ],
            options,
            progress,
            budget,
          );
          const tiled = await access(join(directory, "render", "index.json")).then(
            () => true,
            () => false,
          );
          if (tiled) {
            const packed = await packDrawingTiles(
              join(directory, "render"),
              signal,
              (completed, total) => progress?.({ phase: "preview", completed, total }),
            );
            tiles = packed.container;
            preview = packed.preview;
            width = Math.round(packed.index.width);
            height = Math.round(packed.index.height);
          } else svg = await readFile(join(directory, "render", "drawing.svg"));
          if (svg && svg.length > 50 * 1024 * 1024)
            throw new AppOperationError({ code: "CAD_OUTPUT_TOO_LARGE", message: "normalized" });
          reader = JSON.parse(
            await readFile(join(directory, "read", "reader-report.json"), "utf8"),
          );
          renderer = JSON.parse(
            await readFile(join(directory, "render", "render-report.json"), "utf8"),
          );
        }
        warnings.push(
          "请核对字体、剖面线和特殊对象；显示不完整时，请在原 CAD 软件中导出 PDF 后导入。",
        );
        if (
          reader.unknownEntities?.length ||
          renderer.skipped?.length ||
          renderer.externalReferences
        )
          warnings.push("图纸包含无法完整还原的对象或外部引用，请与原图核对。");
        if (reader.recoveredBlockReferences?.length)
          warnings.push("已还原特殊详图引用，请核对详图位置与内容。");
        if (svg) {
          const viewBox = svg
            .toString("utf8")
            .match(/viewBox="([^"]+)"/u)?.[1]
            ?.split(/\s+/u)
            .map(Number);
          const vw = viewBox?.[2],
            vh = viewBox?.[3];
          if (!vw || !vh || !Number.isFinite(vw / vh)) throw new Error("图纸没有可用的绘图范围。");
          width = Math.round((2000 * vw) / Math.max(vw, vh));
          height = Math.round((2000 * vh) / Math.max(vw, vh));
          progress?.({ phase: "preview", completed: null, total: null });
          preview = await sharp(svg, { limitInputPixels: 100_000_000 })
            .resize({ width: 2000, height: 2000, fit: "inside" })
            .png()
            .toBuffer();
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof AppOperationError) throw error;
        throw new AppOperationError({
          code:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOSPC"
              ? "DISK_FULL"
              : error instanceof Error && error.message.includes("CAD_OUTPUT_TOO_LARGE")
                ? "CAD_OUTPUT_TOO_LARGE"
                : "CAD_CONVERSION_FAILED",
          message: "Drawing conversion failed",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      signal?.throwIfAborted();
      if (svg) conversionCache.set(key, { svg, preview, width, height, warnings });
      else if (tiles) conversionCache.set(key, { tiles, preview, width, height, warnings });
    }
  } else {
    if (!input.preview) throw new Error("PDF 页面预览不存在。");
    const image = await importImage({ originalName: "PDF预览.png", bytes: input.preview });
    preview = Buffer.from(image.preview);
    width = image.descriptor.widthPx;
    height = image.descriptor.heightPx;
  }
  const common = {
    widthPx: Math.max(1, width),
    heightPx: Math.max(1, height),
    previewByteLength: preview.length,
    previewSha256: hash(preview),
  };
  const source: StoredAsset = {
    original: input.bytes,
    preview,
    descriptor: {
      ...common,
      assetId: randomUUID(),
      kind: "drawing-source",
      originalName: input.originalName,
      mediaType: kind === "dwg" ? "image/vnd.dwg" : "application/pdf",
      extension: kind,
      byteLength: input.bytes.length,
      sha256: hash(input.bytes),
    },
  };
  const assets = [source];
  if (tiles)
    assets.push({
      original: tiles,
      preview: preview!,
      descriptor: {
        ...common,
        assetId: randomUUID(),
        kind: "drawing-tiles",
        originalName: "图纸底图.cadtiles",
        mediaType: "application/vnd.zxw.cad-tiles+zip",
        extension: "cadtiles",
        byteLength: tiles.length,
        sha256: hash(tiles),
      },
    });
  if (svg)
    assets.push({
      original: svg,
      preview,
      descriptor: {
        ...common,
        assetId: randomUUID(),
        kind: "vector-image",
        originalName: "图纸底图.svg",
        mediaType: "image/svg+xml",
        extension: "svg",
        byteLength: svg.length,
        sha256: hash(svg),
      },
    });
  signal?.throwIfAborted();
  return { assets, sourceKind: kind, warnings };
}

// Serialize heavy native conversion; queued requests remain cancellable.
let conversionTail: Promise<void> = Promise.resolve();
let queuedConversions = 0;
export async function importDrawing(
  ...args: Parameters<typeof importDrawingNow>
): ReturnType<typeof importDrawingNow> {
  if (!Buffer.from(args[0].bytes.subarray(0, 4)).toString("ascii").startsWith("AC10"))
    return importDrawingNow(...args);
  if (args[0].bytes.byteLength > MAX_CAD_IMPORT_BYTES.dwg)
    throw new AppOperationError({ code: "CAD_IMPORT_TOO_LARGE", message: "CAD import limit" });
  if (queuedConversions >= 16)
    throw new AppOperationError({ code: "OPERATION_IN_PROGRESS", message: "Converter queue full" });
  const prior = conversionTail;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  conversionTail = prior.then(() => done);
  queuedConversions++;
  const signal = args[2];
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      prior,
      new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    signal?.throwIfAborted();
    return await importDrawingNow(...args);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    queuedConversions--;
    release();
  }
}
