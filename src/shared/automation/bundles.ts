import { z } from "zod";

export const AutomationBundleExportSchema = z
  .object({
    patents: z
      .array(
        z
          .object({
            patentId: z.string().uuid(),
            expectedRevision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    format: z.enum(["patdoc", "docx", "pdf"]),
    output: z.string().min(1),
    persisted: z.boolean().default(false),
    acceptWarnings: z.array(z.string()).max(100).default([]),
  })
  .strict()
  .refine((input) => new Set(input.patents.map((p) => p.patentId)).size === input.patents.length);
