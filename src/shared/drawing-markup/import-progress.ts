import { z } from "zod";

export const DRAWING_IMPORT_PHASES = [
  "prepare",
  "read",
  "write",
  "parse",
  "audit",
  "draw",
  "svg",
  "serialize",
  "preview",
  "store",
] as const;
export const DRAWING_IMPORT_PHASE_LABELS: Record<(typeof DRAWING_IMPORT_PHASES)[number], string> = {
  prepare: "正在准备图纸",
  read: "正在读取和整理图纸",
  write: "正在准备绘图数据",
  parse: "正在解析绘图数据",
  audit: "正在检查图纸",
  draw: "正在生成图形",
  svg: "正在生成预览图形",
  serialize: "正在整理预览",
  preview: "正在准备画布",
  store: "正在保存导入结果",
};
export const DrawingImportStageSchema = z
  .object({
    phase: z.enum(DRAWING_IMPORT_PHASES),
    completed: z.number().int().min(0).max(1_000_000_000).nullable(),
    total: z.number().int().min(1).max(1_000_000_000).nullable(),
  })
  .strict()
  .refine((v) => v.total === null || (v.completed !== null && v.completed <= v.total));
export type DrawingImportStage = z.infer<typeof DrawingImportStageSchema>;
export const DrawingImportProgressSchema = z
  .object({
    sessionId: z.string().uuid(),
    operationId: z.string().uuid(),
    stage: DrawingImportStageSchema,
    overallPercent: z.number().int().min(0).max(99),
    elapsedMs: z.number().min(0).max(86_400_000),
    estimatedRemainingMs: z
      .tuple([z.number().min(0).max(86_400_000), z.number().min(0).max(86_400_000)])
      .nullable(),
    takingLonger: z.boolean(),
    waitingForActivity: z.boolean().optional(),
  })
  .strict();
export type DrawingImportProgressEvent = z.infer<typeof DrawingImportProgressSchema>;
export type DrawingImportProgressValue = Omit<
  DrawingImportProgressEvent,
  "sessionId" | "operationId"
>;
