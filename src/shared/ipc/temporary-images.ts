import { z } from "zod";
import { DesignEditorMetadataSchema } from "../patent/design-editor-project.js";
import { type AppResult, appResultSchema } from "./result.js";

const bytes = z
  .instanceof(Uint8Array)
  .refine((value) => value.byteLength > 0 && value.byteLength <= 50 * 1024 * 1024);
export const TemporaryRasterFormatSchema = z.enum([
  "png",
  "jpeg",
  "webp",
  "avif",
  "tiff",
  "gif",
  "bmp",
]);
export const TemporaryRasterOptionsSchema = z
  .object({
    format: TemporaryRasterFormatSchema,
    quality: z.number().int().min(1).max(100).optional(),
    width: z.number().int().min(1).max(10000).optional(),
    height: z.number().int().min(1).max(10000).optional(),
    density: z.number().int().min(1).max(1200).optional(),
    background: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
  })
  .strict();
export const TemporaryRasterDecodeSchema = z
  .object({
    bytes,
    page: z.number().int().min(0).max(255).default(0),
    density: z.number().int().min(1).max(1200).default(72),
  })
  .strict();
export const TemporaryRasterSchema = z
  .object({
    bytes,
    widthPx: z.number().int().positive().max(10000),
    heightPx: z.number().int().positive().max(10000),
    pageCount: z.number().int().positive(),
    page: z.number().int().min(0),
    mediaType: z.literal("image/png"),
  })
  .strict()
  .refine((value) => value.widthPx * value.heightPx <= 40_000_000);
export const TemporaryRasterExportSchema = z
  .object({
    bytes,
    suggestedName: z.string().trim().min(1).max(200),
    options: TemporaryRasterOptionsSchema,
  })
  .strict();
export const TemporaryRasterResultSchema = appResultSchema(TemporaryRasterSchema);
export const TemporaryPsdDecodeSchema = z.object({ bytes }).strict();
export const TemporaryLayerProjectSchema = z
  .object({
    composite: bytes.optional(),
    metadata: DesignEditorMetadataSchema,
    psd: bytes,
    backings: z.array(z.object({ id: z.string().min(1).max(200), bytes }).strict()).max(16),
  })
  .strict()
  .refine((value) => {
    const references = value.metadata.layers
      .filter((layer) => layer.backing)
      .map((layer) => layer.id);
    const ids = new Set(value.backings.map((item) => item.id));
    return (
      ids.size === value.backings.length &&
      ids.size === references.length &&
      references.every((id) => ids.has(id)) &&
      value.psd.byteLength + value.backings.reduce((sum, item) => sum + item.bytes.byteLength, 0) <=
        50 * 1024 ** 2
    );
  });
export const TemporaryPsdExportSchema = z
  .object({
    project: TemporaryLayerProjectSchema,
    composite: bytes,
    suggestedName: z.string().trim().min(1).max(200),
    density: z.number().int().min(1).max(1200).optional(),
  })
  .strict();
export const TemporaryPsdResultSchema = appResultSchema(TemporaryLayerProjectSchema);
export type TemporaryLayerProject = z.infer<typeof TemporaryLayerProjectSchema>;
export type TemporaryPsdExport = z.infer<typeof TemporaryPsdExportSchema>;
export const TemporaryExportResultSchema = appResultSchema(
  z
    .object({
      outputPath: z.string().min(1).max(32767),
    })
    .strict()
    .nullable(),
);
export type TemporaryRasterDecode = z.input<typeof TemporaryRasterDecodeSchema>;
export type TemporaryRaster = z.infer<typeof TemporaryRasterSchema>;
export type TemporaryRasterExport = z.infer<typeof TemporaryRasterExportSchema>;
export type TemporaryExportResult = { outputPath: string } | null;
export const TemporaryBatchBeginSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().trim().min(1).max(200),
            format: z.enum(["png", "jpeg", "webp", "avif", "tiff", "gif", "bmp", "psd"]),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length);
export const TemporaryBatchTokenSchema = z.object({ token: z.uuid() }).strict();
export const TemporaryBatchRasterSchema = z
  .object({
    token: z.uuid(),
    id: z.string().min(1).max(200),
    bytes,
    options: TemporaryRasterOptionsSchema,
  })
  .strict();
export const TemporaryBatchPsdSchema = z
  .object({
    token: z.uuid(),
    id: z.string().min(1).max(200),
    project: TemporaryLayerProjectSchema,
    composite: bytes,
    density: z.number().int().min(1).max(1200).optional(),
  })
  .strict();
export const TemporaryBatchBeginResultSchema = appResultSchema(
  z.object({ token: z.uuid() }).strict().nullable(),
);
export type TemporaryBatchBegin = z.infer<typeof TemporaryBatchBeginSchema>;
export type TemporaryBatchRaster = z.infer<typeof TemporaryBatchRasterSchema>;
export type TemporaryBatchPsd = z.infer<typeof TemporaryBatchPsdSchema>;
export type TemporaryImageApi = {
  beginBatch(request: TemporaryBatchBegin): Promise<AppResult<{ token: string } | null>>;
  writeBatchRaster(request: TemporaryBatchRaster): Promise<AppResult<TemporaryExportResult>>;
  writeBatchPsd(request: TemporaryBatchPsd): Promise<AppResult<TemporaryExportResult>>;
  finishBatch(request: { token: string }): Promise<AppResult<void>>;
  decodePsd(request: { bytes: Uint8Array }): Promise<AppResult<TemporaryLayerProject>>;
  exportPsd(request: TemporaryPsdExport): Promise<AppResult<TemporaryExportResult>>;
  decodeRaster(request: TemporaryRasterDecode): Promise<AppResult<TemporaryRaster>>;
  exportRaster(request: TemporaryRasterExport): Promise<AppResult<TemporaryExportResult>>;
};
