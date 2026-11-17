import { z } from "zod";
import { CadCheckpointSchema, CadDetailSourceSchema } from "./cad-state.js";

export const DrawingPointSchema = z
  .object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7) })
  .strict();
export type DrawingPoint = z.infer<typeof DrawingPointSchema>;
export const DrawingAnnotationSchema = z
  .object({
    id: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(100),
    x: z.number().finite().min(-1e7).max(1e7),
    y: z.number().finite().min(-1e7).max(1e7),
    fontSize: z.number().min(1).max(1000),
    lineWidth: z.number().min(0.1).max(100),
    points: z.array(DrawingPointSchema).max(100),
  })
  .strict();
export type DrawingAnnotation = z.infer<typeof DrawingAnnotationSchema>;
export const DrawingOutputSchema = z
  .object({
    widthMm: z.number().finite().min(10).max(165),
    dpi: z.union([z.literal(300), z.literal(600)]),
    mode: z.enum(["uniform", "drawing"]),
    labelHeightMm: z.number().finite().min(2).max(8),
    leaderWidthMm: z.number().finite().min(0.1).max(0.6),
  })
  .strict();
export type DrawingOutput = z.infer<typeof DrawingOutputSchema>;
export const DrawingRegionSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["rectangle", "lasso"]),
    points: z.array(DrawingPointSchema).min(3).max(5000),
    cadHandles: z
      .array(z.string().regex(/^[\dA-F]+$/iu))
      .min(1)
      .max(100_000)
      .optional(),
    figureId: z.string().uuid().optional(),
    bodyNodeId: z.string().uuid().optional(),
    bodyAssetId: z.string().uuid().optional(),
    exportedRevision: z.number().int().nonnegative().optional(),
    output: DrawingOutputSchema.optional(),
  })
  .strict();
export type DrawingRegion = z.infer<typeof DrawingRegionSchema>;
export const DrawingBaseFragmentSchema = z
  .object({
    id: z.string().min(1).max(100),
    offset: DrawingPointSchema,
    scale: z.number().finite().positive().max(10000).optional(),
    rotation: z.number().finite().optional(),
    clips: z.array(z.array(DrawingPointSchema).min(3).max(5000)).min(1).max(500),
    holes: z.array(z.array(DrawingPointSchema).min(3).max(5000)).max(500),
  })
  .strict();
export type DrawingBaseFragment = z.infer<typeof DrawingBaseFragmentSchema>;
export const DrawingDetailViewSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(100),
    source: DrawingPointSchema,
    radius: z.number().finite().positive().max(100000),
    center: DrawingPointSchema,
    title: DrawingPointSchema,
    marker: DrawingPointSchema,
    markerHidden: z.boolean().optional(),
    titleHidden: z.boolean().optional(),
    ratio: z.number().finite().min(0.1).max(100),
    sourceScale: z.number().finite().positive().optional(),
    fontSize: z.number().finite().min(1).max(1000),
    lineWidth: z.number().finite().min(0.1).max(100),
    fragments: z.array(DrawingBaseFragmentSchema).min(1).max(500),
    cadSource: CadDetailSourceSchema.optional(),
  })
  .strict();
export type DrawingDetailView = z.infer<typeof DrawingDetailViewSchema>;
export const DrawingProjectSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    sourceAssetId: z.string().uuid(),
    baseAssetId: z.string().uuid(),
    cad: CadCheckpointSchema.optional(),
    sourceKind: z.enum(["dwg", "dxf", "pdf", "image"]),
    pageNumber: z.number().int().min(1).max(10000),
    width: z.number().finite().positive().max(100000),
    height: z.number().finite().positive().max(100000),
    annotations: z.array(DrawingAnnotationSchema).max(5000),
    baseFragments: z.array(DrawingBaseFragmentSchema).max(500).optional(),
    detailViews: z.array(DrawingDetailViewSchema).max(100).optional(),
    regions: z.array(DrawingRegionSchema).max(500),
    warnings: z.array(z.string().max(1000)).max(100),
    revision: z.number().int().nonnegative(),
    nextLabel: z.string().trim().min(1).max(100).optional(),
    repeatLabel: z.boolean().optional(),
  })
  .strict()
  .superRefine((project, context) => {
    for (const field of ["annotations", "regions", "baseFragments", "detailViews"] as const) {
      const ids = (project[field] ?? []).map((item) => item.id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: "custom", message: "图纸对象编号重复", path: [field] });
    }
  });
export type DrawingProject = z.infer<typeof DrawingProjectSchema>;
export const DrawingProjectsSchema = z.array(DrawingProjectSchema).max(1000);
export const MAX_DRAWING_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_DRAWING_EXPORT_PIXELS = 32_000_000;
