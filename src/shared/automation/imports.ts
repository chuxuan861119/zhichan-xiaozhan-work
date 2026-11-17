import { z } from "zod";
export const AutomationPatentImportSchema = z
  .object({
    path: z.string().min(1),
    format: z.enum(["patdoc", "bundle"]),
    allowDuplicate: z.boolean().default(false),
  })
  .strict();
