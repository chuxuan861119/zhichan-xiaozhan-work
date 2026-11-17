import { z } from "zod";
import {
  ChemicalPreviewRequestSchema,
  FormulaDrawingRenderRequestSchema,
} from "../ipc/contract.js";

const target = { patentId: z.string().uuid() };
export const AutomationFormulaSchema = FormulaDrawingRenderRequestSchema.omit({
  sessionId: true,
}).extend(target);
export const AutomationChemicalSchema = ChemicalPreviewRequestSchema.omit({
  sessionId: true,
}).extend(target);
export const AutomationAssetImportSchema = z
  .object({ ...target, path: z.string().min(1) })
  .strict();
export const AutomationAssetExportSchema = z
  .object({
    ...target,
    expectedRevision: z.number().int().nonnegative(),
    assetId: z.string().uuid(),
    variant: z.enum(["original", "preview"]).default("preview"),
    output: z.string().min(1),
    persisted: z.boolean().optional(),
  })
  .strict();
