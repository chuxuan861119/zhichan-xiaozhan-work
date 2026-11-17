import { z } from "zod";
import { PatentBookKindSchema } from "../patent/model.js";
import { PrintLayoutSettingsSchema, PrintOutputSettingsSchema } from "../printing/model.js";

export const AutomationPrintSchema = z
  .object({
    patentId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    bookKind: PatentBookKindSchema.optional(),
    auxiliaryDocumentId: z.string().uuid().optional(),
    layout: PrintLayoutSettingsSchema,
    output: PrintOutputSettingsSchema.extend({
      printerDeviceName: z.string().trim().min(1).max(1024),
    }),
    acceptWarnings: z.array(z.string()).max(100).default([]),
    persisted: z.boolean().default(false),
  })
  .strict()
  .refine(
    (input) => !(input.bookKind && input.auxiliaryDocumentId),
    "不能同时选择书册和辅助文档。",
  );
