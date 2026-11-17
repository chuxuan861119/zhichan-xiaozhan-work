import { z } from "zod";
import { ExportIssueSchema } from "../exports/report.js";
import { appResultSchema } from "./result.js";

export const PatentBundleExportSchema = z
  .object({
    format: z.enum(["patdoc", "docx", "pdf"]),
    patents: z
      .array(
        z
          .object({ patentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((value) => new Set(value.patents.map((p) => p.patentId)).size === value.patents.length);
export type PatentBundleExport = z.infer<typeof PatentBundleExportSchema>;
export const PatentBundleResultSchema = appResultSchema(
  z
    .object({
      count: z.number().int().positive(),
      path: z.string().optional(),
      issues: z.array(ExportIssueSchema).optional(),
    })
    .strict()
    .nullable(),
);
export type PatentBundleResult = z.infer<typeof PatentBundleResultSchema>;
