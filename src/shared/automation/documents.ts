import { z } from "zod";
import { CanonicalDocumentSchema } from "../document/model.js";
import { PrintLayoutSettingsSchema, PrintOutputSettingsSchema } from "../printing/model.js";

const documentId = z.string().uuid();
const expectedRevision = z.number().int().nonnegative();
export const AutomationDocumentReadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      scope: z.enum(["active", "trash"]).default("active"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z
    .object({ action: z.literal("get"), documentId, persisted: z.boolean().default(false) })
    .strict(),
  z
    .object({
      action: z.literal("asset"),
      documentId,
      assetId: z.string().uuid(),
      variant: z.enum(["original", "preview"]).default("preview"),
    })
    .strict(),
]);
export const AutomationDocumentCreateSchema = z
  .object({ title: z.string().trim().min(1).max(255) })
  .strict();
export const AutomationDocumentUpdateSchema = z
  .object({ documentId, expectedRevision, document: CanonicalDocumentSchema })
  .strict();
export const AutomationDocumentLifecycleSchema = z
  .object({ documentId, expectedRevision, expectedDeletedAt: z.string().datetime().nullable() })
  .strict();
export const AutomationDocumentAssetImportSchema = z
  .object({ documentId, expectedRevision, path: z.string().min(1) })
  .strict();
export const AutomationDocumentImportSchema = z.object({ path: z.string().min(1) }).strict();
export const AutomationDocumentExportSchema = z
  .object({
    documentId,
    expectedRevision,
    persisted: z.boolean().default(false),
    format: z.enum(["patdoc", "docx", "pdf"]),
    output: z.string().min(1),
    acceptWarnings: z.array(z.string()).max(100).default([]),
  })
  .strict();

export const AutomationLegacyReadSchema = z.object({}).strict();
export const AutomationLegacyImportSchema = z.object({ draftId: z.string().uuid() }).strict();

export const AutomationDocumentPrintSchema = z
  .object({
    documentId,
    expectedRevision,
    persisted: z.boolean().default(false),
    layout: PrintLayoutSettingsSchema,
    output: PrintOutputSettingsSchema.extend({
      printerDeviceName: z.string().trim().min(1).max(1024),
    }),
    acceptWarnings: z.array(z.string()).max(100).default([]),
  })
  .strict();
