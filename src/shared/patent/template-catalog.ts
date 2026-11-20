import { z } from "zod";
import { AssetDescriptorSchema, ParagraphNodeSchema } from "../document/model.js";
import { PatentTypeSchema as AllPatentTypesSchema } from "./model.js";

const PatentTypeSchema = AllPatentTypesSchema.exclude(["design"]);
import { PatentBookTemplateSchema } from "./templates.js";

export const PATENT_TEMPLATE_NAME_MAX_LENGTH = 30;

export const PatentTemplateSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blank") }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
  z.object({ kind: z.literal("custom"), templateId: z.string().uuid() }).strict(),
]);
export type PatentTemplateSelection = z.infer<typeof PatentTemplateSelectionSchema>;

const PatentTemplateLauncherGroupSchema = z
  .object({
    selection: PatentTemplateSelectionSchema,
    selectedTemplateName: z.string().trim().min(1).max(PATENT_TEMPLATE_NAME_MAX_LENGTH).nullable(),
  })
  .strict()
  .superRefine((group, ctx) => {
    if ((group.selection.kind === "custom") !== (group.selectedTemplateName !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "自定义模板摘要必须包含当前模板名称。",
        path: ["selectedTemplateName"],
      });
    }
  });

export const PatentTemplateLauncherSummarySchema = z
  .object({
    separatePatentTypes: z.boolean().optional(),
    invention: PatentTemplateLauncherGroupSchema,
    "utility-model": PatentTemplateLauncherGroupSchema,
  })
  .strict();
export type PatentTemplateLauncherSummary = z.infer<typeof PatentTemplateLauncherSummarySchema>;

export const PatentTemplateSlotSchema = z
  .object({
    templateId: z.string().uuid(),
    patentType: PatentTypeSchema,
    slotIndex: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    name: z.string().trim().min(1).max(PATENT_TEMPLATE_NAME_MAX_LENGTH),
    claims: PatentBookTemplateSchema.nullable(),
    description: PatentBookTemplateSchema.nullable(),
    abstract: PatentBookTemplateSchema.nullable(),
    unavailableReason: z.string().trim().min(1).max(200).nullable().default(null),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((slot, ctx) => {
    const present = [slot.claims, slot.description, slot.abstract].filter(
      (book) => book !== null,
    ).length;
    if (slot.unavailableReason !== null && present !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "损坏模板不能同时携带可编辑三书。",
        path: ["unavailableReason"],
      });
    } else if (slot.unavailableReason === null && present !== 0 && present !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "自定义模板必须同时包含三书，或保持为空。",
        path: ["claims"],
      });
    }
  });
export type PatentTemplateSlot = z.infer<typeof PatentTemplateSlotSchema>;

export const PatentTemplateAuxiliarySchema = z
  .object({
    patentType: PatentTypeSchema,
    figureExplanation: ParagraphNodeSchema,
    drawingLegend: ParagraphNodeSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PatentTemplateAuxiliary = z.infer<typeof PatentTemplateAuxiliarySchema>;

const PatentTypeTemplateCatalogSchema = z
  .object({
    selection: PatentTemplateSelectionSchema,
    slots: z.array(PatentTemplateSlotSchema).min(3).max(5),
  })
  .strict();

export const PatentTemplateCatalogSchema = z
  .object({
    separatePatentTypes: z.boolean().optional(),
    revision: z.number().int().nonnegative(),
    invention: PatentTypeTemplateCatalogSchema,
    "utility-model": PatentTypeTemplateCatalogSchema,
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (const patentType of ["invention", "utility-model"] as const) {
      const group = catalog[patentType];
      const indexes = new Set(group.slots.map((slot) => slot.slotIndex));
      if (
        ![3, 5].includes(group.slots.length) ||
        indexes.size !== group.slots.length ||
        !Array.from({ length: group.slots.length }, (_, index) => index + 1).every((index) =>
          indexes.has(index as 1 | 2 | 3 | 4 | 5),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message: "模板槽位必须连续且不重复。",
          path: [patentType, "slots"],
        });
      }
      group.slots.forEach((slot, index) => {
        if (slot.patentType !== patentType) {
          ctx.addIssue({
            code: "custom",
            message: "模板槽位的专利类型不匹配。",
            path: [patentType, "slots", index, "patentType"],
          });
        }
      });
      const selection = group.selection;
      if (selection.kind === "custom") {
        const selected = group.slots.find((slot) => slot.templateId === selection.templateId);
        if (!selected || selected.claims === null) {
          ctx.addIssue({
            code: "custom",
            message: "当前自定义模板必须指向同类型的非空槽位。",
            path: [patentType, "selection"],
          });
        }
      }
    }
  });
export type PatentTemplateCatalog = z.infer<typeof PatentTemplateCatalogSchema>;

export const PatentTemplateAuxiliaryCatalogSchema = z
  .object({
    invention: PatentTemplateAuxiliarySchema,
    "utility-model": PatentTemplateAuxiliarySchema,
  })
  .strict()
  .superRefine((catalog, ctx) => {
    if (catalog.invention.patentType !== "invention") {
      ctx.addIssue({ code: "custom", message: "发明辅助模板类型不匹配。", path: ["invention"] });
    }
    if (catalog["utility-model"].patentType !== "utility-model") {
      ctx.addIssue({
        code: "custom",
        message: "实用新型辅助模板类型不匹配。",
        path: ["utility-model"],
      });
    }
  });
export type PatentTemplateAuxiliaryCatalog = z.infer<typeof PatentTemplateAuxiliaryCatalogSchema>;

export const PatentTemplateEditorOpenRequestSchema = z
  .object({ patentType: PatentTypeSchema })
  .strict();
export type PatentTemplateEditorOpenRequest = z.infer<typeof PatentTemplateEditorOpenRequestSchema>;

export const PatentTemplateEditorSnapshotSchema = z
  .object({
    sessionId: z.string().uuid(),
    catalog: PatentTemplateCatalogSchema,
    auxiliary: PatentTemplateAuxiliaryCatalogSchema,
    assets: z.array(AssetDescriptorSchema).max(10_000).optional(),
  })
  .strict();
export type PatentTemplateEditorSnapshot = z.infer<typeof PatentTemplateEditorSnapshotSchema>;

export const PatentTemplateCaptureCurrentRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    patentId: z.string().uuid(),
    expectedPatentRevision: z.number().int().nonnegative(),
    targetPatentType: PatentTypeSchema,
    targetTemplateId: z.string().uuid(),
  })
  .strict();
export type PatentTemplateCaptureCurrentRequest = z.infer<
  typeof PatentTemplateCaptureCurrentRequestSchema
>;

export const PatentTemplateCapturedBooksSchema = z
  .object({
    templateId: z.string().uuid(),
    patentType: PatentTypeSchema,
    claims: PatentBookTemplateSchema,
    description: PatentBookTemplateSchema,
    abstract: PatentBookTemplateSchema,
    omittedOrdinaryImageCount: z.number().int().nonnegative(),
    referencedChemicalPreviewAssetIds: z.array(z.string().uuid()),
    referencedChemicalPreviewAssets: z.array(AssetDescriptorSchema).max(10_000).optional(),
  })
  .strict();
export type PatentTemplateCapturedBooks = z.infer<typeof PatentTemplateCapturedBooksSchema>;

export const PatentTemplateEditorSaveRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    catalog: PatentTemplateCatalogSchema,
    auxiliary: PatentTemplateAuxiliaryCatalogSchema,
  })
  .strict();
export type PatentTemplateEditorSaveRequest = z.infer<typeof PatentTemplateEditorSaveRequestSchema>;

export const PatentTemplateEditorCloseRequestSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type PatentTemplateEditorCloseRequest = z.infer<
  typeof PatentTemplateEditorCloseRequestSchema
>;

export function isFilledPatentTemplateSlot(slot: PatentTemplateSlot): slot is PatentTemplateSlot & {
  claims: NonNullable<PatentTemplateSlot["claims"]>;
  description: NonNullable<PatentTemplateSlot["description"]>;
  abstract: NonNullable<PatentTemplateSlot["abstract"]>;
} {
  return (
    slot.unavailableReason === null &&
    slot.claims !== null &&
    slot.description !== null &&
    slot.abstract !== null
  );
}
