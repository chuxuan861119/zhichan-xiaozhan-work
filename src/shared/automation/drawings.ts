import { z } from "zod";
import { DrawingProjectSchema } from "../drawing-markup/model.js";
import { randomUuid } from "../id.js";
import type { CanonicalPatent } from "../patent/model.js";

export const AutomationDrawingImportSchema = z
  .object({
    patentId: z.string().uuid(),
    path: z.string().min(1),
    previewPath: z.string().min(1).optional(),
    pageNumber: z.number().int().min(1).max(10000).default(1),
  })
  .strict();
export const AutomationDrawingRenderSchema = z
  .object({
    patentId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    persisted: z.boolean().default(false),
    projectId: z.string().uuid(),
    expectedProjectRevision: z.number().int().nonnegative(),
    regionId: z.string().min(1).max(100),
    widthMm: z.number().min(10).max(165).default(150),
    dpi: z.union([z.literal(300), z.literal(600)]).default(300),
    autoAdjustLabelSize: z.boolean().default(false),
    autoLabelScale: z.number().min(0.5).max(2).optional(),
  })
  .strict();
export const AutomationDrawingContentSchema = z
  .object(DrawingProjectSchema.shape)
  .omit({ projectId: true, revision: true })
  .strict();
export const DrawingOperationSchemas = [
  z
    .object({ type: z.literal("createDrawingProject"), project: AutomationDrawingContentSchema })
    .strict(),
  z
    .object({
      type: z.literal("updateDrawingProject"),
      projectId: z.string().uuid(),
      expectedProjectRevision: z.number().int().nonnegative(),
      project: AutomationDrawingContentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteDrawingProject"),
      projectId: z.string().uuid(),
      expectedProjectRevision: z.number().int().nonnegative(),
    })
    .strict(),
] as const;
export const DrawingOperationSchema = z.discriminatedUnion("type", DrawingOperationSchemas);
export const DRAWING_OPERATIONS = new Set<string>(
  DrawingOperationSchemas.map((schema) => schema.shape.type.value),
);
export function applyDrawingOperation(
  patent: CanonicalPatent,
  operation: z.infer<typeof DrawingOperationSchema>,
) {
  const current =
    operation.type === "createDrawingProject"
      ? undefined
      : patent.drawingProjects.find((project) => project.projectId === operation.projectId);
  if (operation.type !== "createDrawingProject") {
    if (!current) throw new Error("Drawing project is unavailable.");
    if (current.revision !== operation.expectedProjectRevision)
      throw new Error("Drawing project revision conflict.");
  }
  if (operation.type === "deleteDrawingProject") {
    patent.drawingProjects = patent.drawingProjects.filter((project) => project !== current);
    return;
  }
  const project = DrawingProjectSchema.parse({
    ...operation.project,
    projectId: current?.projectId ?? randomUuid(),
    revision: current ? current.revision + 1 : 0,
  });
  const source = patent.assets.find((asset) => asset.assetId === project.sourceAssetId);
  const base = patent.assets.find((asset) => asset.assetId === project.baseAssetId);
  if (
    !source ||
    !base ||
    (project.sourceKind === "pdf"
      ? base.assetId !== source.assetId
      : ![
          "image",
          "vector-image",
          ...(project.sourceKind === "dwg" ? ["drawing-tiles"] : []),
        ].includes(base.kind))
  )
    throw new Error("Drawing source assets are unavailable.");
  if (
    project.sourceKind === "image"
      ? source.kind !== "image"
      : source.kind !== "drawing-source" || source.extension !== project.sourceKind
  )
    throw new Error("Drawing source kind does not match its asset.");
  for (const region of project.regions) {
    if (region.bodyAssetId && !patent.assets.some((asset) => asset.assetId === region.bodyAssetId))
      throw new Error("Drawing region asset is unavailable.");
    if (region.figureId && !patent.figures.some((figure) => figure.figureId === region.figureId))
      throw new Error("Drawing region figure is unavailable.");
  }
  if (current)
    patent.drawingProjects = patent.drawingProjects.map((entry) =>
      entry === current ? project : entry,
    );
  else patent.drawingProjects.push(project);
}
