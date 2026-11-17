import { z } from "zod";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../flowcharts/limits.js";

const target = { patentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
const project = { ...target, projectId: z.string().uuid() };
const source = z.string().min(1).max(FLOWCHART_MAX_SOURCE_XML_BYTES);
export const AutomationFlowchartWriteSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...target,
      action: z.literal("import"),
      path: z.string().min(1),
      name: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal("create"),
      name: z.string().trim().min(1).max(120),
      source,
    })
    .strict(),
  z
    .object({
      ...project,
      action: z.literal("save"),
      expectedProjectRevision: z.number().int().nonnegative(),
      source,
    })
    .strict(),
  z
    .object({
      ...project,
      action: z.literal("rename"),
      expectedProjectRevision: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({ ...project, action: z.literal("duplicate"), name: z.string().trim().min(1).max(120) })
    .strict(),
  z.object({ ...project, action: z.literal("delete") }).strict(),
]);

export const AutomationFlowchartExportSchema = z
  .object({ ...project, output: z.string().min(1), persisted: z.boolean().optional() })
  .strict();

export const AutomationFlowchartRenderSchema = z
  .object({
    ...project,
    expectedProjectRevision: z.number().int().nonnegative(),
    persisted: z.boolean().default(false),
    pageIndex: z.number().int().min(0).max(99).default(0),
    selectedCellIds: z
      .array(z.string().min(1).max(500))
      .max(50_000)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
    borderMm: z.number().min(0).max(20).default(0),
    outputWidthMm: z.number().min(10).max(165).optional(),
  })
  .strict();
