import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { AssetDescriptorSchema } from "../../shared/document/model.js";
import { CadCheckpointSchema } from "../../shared/drawing-markup/cad-state.js";
import { MAX_CAD_IMPORT_BYTES } from "../../shared/drawing-markup/import-limits.js";
import type { CadPrepareRequestSchema } from "../../shared/ipc/contract.js";
import { AppOperationError } from "../app-operation-error.js";
import type { StoredAsset } from "./asset-store.js";
import { runCadCodec } from "./cadcraft-runtime.js";

export const CADCRAFT_REVISION = "00c7613f1af3c73f7157fa91d9fe2635c6f23c06";
const FrameSchema = z.object({
  origin: z.tuple([z.number().finite(), z.number().finite()]),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

export async function prepareCadAssets(
  root: string,
  request: z.infer<typeof CadPrepareRequestSchema>,
  signal?: AbortSignal,
  run: typeof runCadCodec = runCadCodec,
) {
  if (!request.frame && request.bytes.byteLength > MAX_CAD_IMPORT_BYTES[request.format])
    throw new AppOperationError({ code: "CAD_IMPORT_TOO_LARGE", message: "CAD import limit" });
  const options = signal ? { signal } : {};
  const dxf =
    request.format === "dwg"
      ? await run(root, "dwg-to-dxf", request.bytes, options)
      : request.bytes;
  // Fixed-frame checkpoints already know their bounds. The SVG codec below still
  // parses and validates the DXF; exporting a full scene here would only discard it.
  const fixedFrame = request.preserveFrame ? request.frame : undefined;
  const scene = fixedFrame
    ? {
        svgFrame: {
          origin: [fixedFrame.mapping.originX, fixedFrame.mapping.originY] as [number, number],
          width: fixedFrame.width / fixedFrame.mapping.scale,
          height: fixedFrame.height / fixedFrame.mapping.scale,
        },
        entityCount: undefined,
      }
    : z
        .object({ svgFrame: FrameSchema, entityCount: z.number().int().nonnegative().optional() })
        .parse(
          JSON.parse(Buffer.from(await run(root, "dxf-to-scene", dxf, options)).toString("utf8")),
        );
  // An empty kernel has a one-unit sentinel extent, not a useful engineering sheet.
  const natural =
    scene.entityCount === 0
      ? request.frame
        ? {
            origin: [request.frame.mapping.originX, request.frame.mapping.originY] as [
              number,
              number,
            ],
            width: request.frame.width / request.frame.mapping.scale,
            height: request.frame.height / request.frame.mapping.scale,
          }
        : { origin: [0, 1000] as [number, number], width: 1000, height: 1000 }
      : scene.svgFrame;
  const fitScale = 2000 / Math.max(natural.width, natural.height);
  const mapping = {
    ...(request.frame?.mapping ?? {
      originX: natural.origin[0],
      originY: natural.origin[1],
      scale: fitScale,
    }),
  };
  let width = request.frame?.width ?? Math.max(1, natural.width * fitScale);
  let height = request.frame?.height ?? Math.max(1, natural.height * fitScale);
  if (request.frame && !request.preserveFrame) {
    const right = Math.max(
      mapping.originX + width / mapping.scale,
      natural.origin[0] + natural.width,
    );
    const bottom = Math.min(
      mapping.originY - height / mapping.scale,
      natural.origin[1] - natural.height,
    );
    mapping.originX = Math.min(mapping.originX, natural.origin[0]);
    mapping.originY = Math.max(mapping.originY, natural.origin[1]);
    width = (right - mapping.originX) * mapping.scale;
    height = (mapping.originY - bottom) * mapping.scale;
  }
  if (width > 100_000 || height > 100_000)
    throw new Error("图形超出当前图纸的可编辑范围，请缩小操作距离或倍率后重试。原工作稿未改变。");
  const svg = await run(root, "dxf-to-svg", dxf, {
    ...options,
    args: [
      "--patent-preview",
      "--frame",
      String(mapping.originX),
      String(mapping.originY),
      String(width / mapping.scale),
      String(height / mapping.scale),
    ],
  });
  // Intrinsic dimensions are bounded independently of real-world drawing extents.
  const safeSvg = Buffer.from(
    Buffer.from(svg)
      .toString("utf8")
      .replace(/^<svg\b[^>]*>/u, (opening) =>
        opening
          .replace(
            /\bwidth="[^"]*"/u,
            `width="${Math.max(1, Math.ceil(width * Math.min(1, 2000 / Math.max(width, height))))}"`,
          )
          .replace(
            /\bheight="[^"]*"/u,
            `height="${Math.max(1, Math.ceil(height * Math.min(1, 2000 / Math.max(width, height))))}"`,
          ),
      ),
  );
  const preview = await sharp(safeSvg, { limitInputPixels: 32_000_000 })
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  signal?.throwIfAborted();
  const make = (
    bytes: Uint8Array,
    kind: "drawing-source" | "vector-image",
    extension: "dwg" | "dxf" | "svg",
    name: string,
  ): StoredAsset => ({
    original: bytes,
    preview,
    descriptor: AssetDescriptorSchema.parse({
      assetId: randomUUID(),
      kind,
      originalName: name,
      mediaType: extension === "svg" ? "image/svg+xml" : `image/vnd.${extension}`,
      extension,
      byteLength: bytes.byteLength,
      sha256: hash(bytes),
      widthPx: Math.ceil(width),
      heightPx: Math.ceil(height),
      previewByteLength: preview.byteLength,
      previewSha256: hash(preview),
    }),
  });
  const checkpoint = make(dxf, "drawing-source", "dxf", "CAD编辑工作稿.dxf");
  const assets =
    request.format === "dwg"
      ? [make(request.bytes, "drawing-source", "dwg", request.originalName), checkpoint]
      : [checkpoint];
  assets.push(make(safeSvg, "vector-image", "svg", "CAD编辑底图.svg"));
  return {
    assets,
    width,
    height,
    cad: CadCheckpointSchema.parse({
      version: 1,
      engine: "cadcraft",
      engineVersion: CADCRAFT_REVISION,
      assetId: checkpoint.descriptor.assetId,
      mapping,
    }),
  };
}
