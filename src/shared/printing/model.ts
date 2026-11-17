import { z } from "zod";
import { CanonicalDocumentSchema, PageSettingsSchema } from "../document/model.js";
import { SessionIdSchema, StableIdSchema } from "../ipc/primitives.js";
import {
  getDefaultPaperSize,
  STANDARD_PAPER_SIZE_NAMES,
  type StandardPaperSize,
} from "./paper-sizes.js";

export const StandardPaperSizeSchema = z.enum(STANDARD_PAPER_SIZE_NAMES);
export type StandardPaperSizeName = z.infer<typeof StandardPaperSizeSchema>;

export const PrintOrientationSchema = z.enum(["portrait", "landscape"]);
export type PrintOrientation = z.infer<typeof PrintOrientationSchema>;

export const DuplexModeSchema = z.enum(["simplex", "longEdge", "shortEdge"]);
export type DuplexMode = z.infer<typeof DuplexModeSchema>;

export const PrinterCapabilityStatusSchema = z.enum(["supported", "unsupported", "unknown"]);
export type PrinterCapabilityStatus = z.infer<typeof PrinterCapabilityStatusSchema>;

export const PrintMarginsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("document") }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("custom"),
      topMm: z.number().nonnegative().max(200),
      rightMm: z.number().nonnegative().max(200),
      bottomMm: z.number().nonnegative().max(200),
      leftMm: z.number().nonnegative().max(200),
    })
    .strict(),
]);
export type PrintMargins = z.infer<typeof PrintMarginsSchema>;

export const PrintLayoutSettingsSchema = z
  .object({
    orientation: PrintOrientationSchema,
    paperSize: StandardPaperSizeSchema,
    scalePercent: z.number().int().min(10).max(200),
    margins: PrintMarginsSchema,
  })
  .strict();
export type PrintLayoutSettings = z.infer<typeof PrintLayoutSettingsSchema>;

export const PrintPageRangeSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.to >= range.from, "页码范围结束页不能小于起始页。");
export type PrintPageRange = z.infer<typeof PrintPageRangeSchema>;

export const PagesPerSheetSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(4),
  z.literal(6),
  z.literal(9),
  z.literal(16),
]);
export type PagesPerSheet = z.infer<typeof PagesPerSheetSchema>;

export const PrintOutputSettingsSchema = z
  .object({
    printerDeviceName: z.string().trim().min(1).max(1024).nullable(),
    copies: z.number().int().min(1).max(999),
    pageRanges: z.array(PrintPageRangeSchema).min(1).max(10_000).optional(),
    duplexMode: DuplexModeSchema,
    color: z.boolean(),
    pagesPerSheet: PagesPerSheetSchema,
    collate: z.boolean(),
  })
  .strict();
export type PrintOutputSettings = z.infer<typeof PrintOutputSettingsSchema>;

export const PrintSettingsSchema = z
  .object({
    layout: PrintLayoutSettingsSchema,
    output: PrintOutputSettingsSchema,
  })
  .strict();
export type PrintSettings = z.infer<typeof PrintSettingsSchema>;

export const PrintPreferencesSchema = z
  .object({
    printerDeviceName: z.string().trim().min(1).max(1024).nullable(),
    duplexMode: DuplexModeSchema,
    color: z.boolean(),
    orientation: PrintOrientationSchema,
    paperSize: StandardPaperSizeSchema,
  })
  .strict();
export type PrintPreferences = z.infer<typeof PrintPreferencesSchema>;

export const DEFAULT_PRINT_PREFERENCES: PrintPreferences = {
  printerDeviceName: null,
  duplexMode: "simplex",
  color: false,
  orientation: "portrait",
  paperSize: "A4",
};

export const PrinterDescriptorSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(1024),
    displayName: z.string().trim().min(1).max(1024),
    description: z.string().trim().max(4096).nullable(),
    duplex: PrinterCapabilityStatusSchema,
    color: PrinterCapabilityStatusSchema,
    paperSize: PrinterCapabilityStatusSchema,
  })
  .strict();
export type PrinterDescriptor = z.infer<typeof PrinterDescriptorSchema>;

export const PrintPreviewRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    targetId: StableIdSchema,
    document: CanonicalDocumentSchema,
    documents: z.array(CanonicalDocumentSchema).min(1).max(5).optional(),
    figureLabels: z.record(z.string().uuid(), z.string().max(30)).optional(),
    suggestedName: z.string().trim().min(1).max(255),
    layout: PrintLayoutSettingsSchema,
  })
  .strict();
export type PrintPreviewRequest = z.infer<typeof PrintPreviewRequestSchema>;

export const DirectPrintRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    previewId: z.string().uuid(),
    output: PrintOutputSettingsSchema,
  })
  .strict();
export type DirectPrintRequest = z.infer<typeof DirectPrintRequestSchema>;

export function createDefaultPrintSettings(
  documentPageSettings?: z.infer<typeof PageSettingsSchema> | null,
  preferences?: PrintPreferences | null,
): PrintSettings {
  const parsedDocumentPageSettings = documentPageSettings
    ? PageSettingsSchema.parse(documentPageSettings)
    : null;
  const parsedPreferences = preferences ? PrintPreferencesSchema.parse(preferences) : null;
  const paperSize: StandardPaperSize =
    parsedPreferences?.paperSize ?? getDefaultPaperSize(parsedDocumentPageSettings);

  return {
    layout: {
      orientation: parsedPreferences?.orientation ?? "portrait",
      paperSize,
      scalePercent: 100,
      margins: { mode: "document" },
    },
    output: {
      printerDeviceName: parsedPreferences?.printerDeviceName ?? null,
      copies: 1,
      pageRanges: undefined,
      duplexMode: parsedPreferences?.duplexMode ?? "simplex",
      color: parsedPreferences?.color ?? DEFAULT_PRINT_PREFERENCES.color,
      pagesPerSheet: 1,
      collate: true,
    },
  };
}
