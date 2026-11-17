import { z } from "zod";
import { CadPatentObjectSchema } from "./cad-objects.js";
import type { DrawingPoint, DrawingProject } from "./model.js";

/** Fixed world-to-page mapping; viewport fit must never move patent annotations. */
export const CadMappingSchema = z
  .object({
    originX: z.number().finite().min(-1e12).max(1e12),
    originY: z.number().finite().min(-1e12).max(1e12),
    scale: z.number().finite().min(1e-9).max(1e9),
  })
  .strict();
export const CadCheckpointSchema = z
  .object({
    version: z.literal(1),
    engine: z.literal("cadcraft"),
    engineVersion: z.string().regex(/^[a-f0-9]{40}$/),
    assetId: z.string().uuid(),
    mapping: CadMappingSchema,
    unified: z.literal(1).optional(),
    objects: z.array(CadPatentObjectSchema).max(5100).optional(),
    overlayAssetId: z.string().uuid().optional(),
    backgroundSize: z
      .tuple([
        z.number().finite().positive().max(100000),
        z.number().finite().positive().max(100000),
      ])
      .optional(),
    semanticKey: z
      .string()
      .regex(/^[a-f\d]{16}$/u)
      .optional(),
  })
  .strict();
export const CadDetailSourceSchema = CadCheckpointSchema.extend({
  baseAssetId: z.string().uuid(),
  width: z.number().finite().positive().max(100000).optional(),
  height: z.number().finite().positive().max(100000).optional(),
});
export type CadCheckpoint = z.infer<typeof CadCheckpointSchema>;
export type CadMapping = z.infer<typeof CadMappingSchema>;

export function cadToPage(point: DrawingPoint, mapping: CadMapping): DrawingPoint {
  return {
    x: (point.x - mapping.originX) * mapping.scale,
    y: (mapping.originY - point.y) * mapping.scale,
  };
}
export function pageToCad(point: DrawingPoint, mapping: CadMapping): DrawingPoint {
  return {
    x: mapping.originX + point.x / mapping.scale,
    y: mapping.originY - point.y / mapping.scale,
  };
}
export function drawingAssetIds(project: DrawingProject): Set<string> {
  const ids = new Set([project.sourceAssetId, project.baseAssetId]);
  if (project.cad) ids.add(project.cad.assetId);
  if (project.cad?.overlayAssetId) ids.add(project.cad.overlayAssetId);
  for (const detail of project.detailViews ?? []) {
    if (detail.cadSource) {
      ids.add(detail.cadSource.assetId);
      ids.add(detail.cadSource.baseAssetId);
      if (detail.cadSource.overlayAssetId) ids.add(detail.cadSource.overlayAssetId);
    }
  }
  return ids;
}
