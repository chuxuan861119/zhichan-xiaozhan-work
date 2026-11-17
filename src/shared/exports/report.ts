import { z } from "zod";

export type ExportIssue = {
  severity: "warning" | "error";
  code:
    | "FORMULA_RASTERIZED"
    | "CHEMISTRY_RENDERED_AS_IMAGE"
    | "FLOWCHART_RENDERED_AS_IMAGE"
    | "FONT_SUBSTITUTED"
    | "MISSING_ASSET"
    | "UNSUPPORTED_STYLE"
    | "EXPORT_FAILED";
  nodeId: string | null;
  message: string;
};

export const ExportIssueSchema: z.ZodType<ExportIssue> = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.enum([
      "FORMULA_RASTERIZED",
      "CHEMISTRY_RENDERED_AS_IMAGE",
      "FLOWCHART_RENDERED_AS_IMAGE",
      "FONT_SUBSTITUTED",
      "MISSING_ASSET",
      "UNSUPPORTED_STYLE",
      "EXPORT_FAILED",
    ]),
    nodeId: z.string().nullable(),
    message: z.string(),
  })
  .strict();

export type ExportReport = {
  format: "docx" | "pdf" | "patdoc";
  outputPath: string;
  issues: ExportIssue[];
};
