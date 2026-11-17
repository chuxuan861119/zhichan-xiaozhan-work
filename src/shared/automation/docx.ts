import { z } from "zod";
import { DocxImportCommitRequestSchema } from "../ipc/contract.js";

export const AutomationDocxPrepareSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();
export const AutomationDocxSessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const AutomationDocxAssetSchema = AutomationDocxSessionSchema.extend({
  assetId: z.string().uuid(),
});
export const AutomationDocxCommitSchema = DocxImportCommitRequestSchema.omit({ appendTo: true });
