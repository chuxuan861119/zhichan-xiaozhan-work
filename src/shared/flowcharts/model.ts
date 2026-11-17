import { z } from "zod";
import { FLOWCHART_MAX_OBJECTS, FLOWCHART_MAX_PAGES } from "./limits.js";

const FlowchartSha256Schema = z.string().regex(/^[0-9A-F]{64}$/u);
const FlowchartPageIdSchema = z.string().min(1).max(500);
const FlowchartCellIdSchema = z.string().min(1).max(500);

export const FlowchartProjectDescriptorSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    revision: z.number().int().nonnegative(),
    pageCount: z.number().int().min(1).max(FLOWCHART_MAX_PAGES),
    lastPageId: FlowchartPageIdSchema.nullable(),
    sourceSha256: FlowchartSha256Schema,
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
  })
  .strict();
export type FlowchartProjectDescriptor = z.infer<typeof FlowchartProjectDescriptorSchema>;

export const FlowchartProjectMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    pageCount: z.number().int().min(1).max(FLOWCHART_MAX_PAGES),
    lastPageId: FlowchartPageIdSchema.nullable(),
  })
  .strict();
export type FlowchartProjectMetadata = z.infer<typeof FlowchartProjectMetadataSchema>;

export const FlowchartFigureLinkSchema = z
  .object({
    projectId: z.string().uuid(),
    pageId: FlowchartPageIdSchema,
    exportScope: z.enum(["page", "selection"]),
    selectedCellIds: z.array(FlowchartCellIdSchema).max(FLOWCHART_MAX_OBJECTS),
    borderMm: z.number().min(0).max(20),
    exportedProjectRevision: z.number().int().nonnegative(),
    exportedSourceSha256: FlowchartSha256Schema,
    renderProfileVersion: z.literal(1),
  })
  .strict()
  .superRefine((link, context) => {
    if (new Set(link.selectedCellIds).size !== link.selectedCellIds.length) {
      context.addIssue({
        code: "custom",
        message: "流程图选区不能包含重复对象。",
        path: ["selectedCellIds"],
      });
    }
    if (link.exportScope === "page" && link.selectedCellIds.length > 0) {
      context.addIssue({
        code: "custom",
        message: "整页导出不能包含选区对象。",
        path: ["selectedCellIds"],
      });
    }
    if (link.exportScope === "selection" && link.selectedCellIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "选区导出必须包含对象。",
        path: ["selectedCellIds"],
      });
    }
  });
export type FlowchartFigureLink = z.infer<typeof FlowchartFigureLinkSchema>;
