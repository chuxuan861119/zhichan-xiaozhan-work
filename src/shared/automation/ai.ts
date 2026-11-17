import { z } from "zod";
import { AiCorrectionScopeSchema } from "../ai-correction/contract.js";
import { TextPolishScopeSchema } from "../ai-correction/text-polish-contract.js";

const target = {
  patentId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  persisted: z.boolean().optional(),
};
export const AutomationCorrectionSchema = z
  .object({
    ...target,
    scope: AiCorrectionScopeSchema,
    thinkingEnabled: z.boolean().default(false),
  })
  .strict();
export const AutomationPolishSchema = z
  .object({ ...target, scope: TextPolishScopeSchema, requirement: z.string().trim().max(2000) })
  .strict();
