import { z } from "zod";
import {
  AiCorrectionSettingsRequestSchema,
  AiCorrectionSettingsSchema,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "../ai-correction/model.js";
import { BackupSettingsSchema, DEFAULT_BACKUP_SETTINGS } from "../backup/model.js";
import { createFactoryPatentTemplates, PatentTemplateSettingsSchema } from "../patent/templates.js";
import { DEFAULT_PRINT_PREFERENCES, PrintPreferencesSchema } from "../printing/model.js";
import { DEFAULT_SNAPSHOT_SETTINGS, SnapshotSettingsSchema } from "../snapshot/model.js";
import {
  CustomDualViewPresetsSchema,
  DEFAULT_CUSTOM_DUAL_VIEW_PRESETS,
} from "./custom-dual-view.js";
import { DEFAULT_EDITOR_COLORS, EditorColorsSchema } from "./editor-colors.js";
import {
  DEFAULT_INVENTION_CONTENT_PREFIX,
  InventionContentPrefixSchema,
} from "./invention-content.js";
import { DEFAULT_PAGE_MARGINS, PageMarginsSchema } from "./page-margins.js";
import { DEFAULT_SHORTCUT_SETTINGS, ShortcutSettingsSchema } from "./shortcuts.js";

const WindowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const PatentLibraryViewModeSchema = z.enum(["single", "double", "illustrated"]);
export type PatentLibraryViewMode = z.infer<typeof PatentLibraryViewModeSchema>;

export const AppSettingsV1Schema = z
  .object({
    zoomPercent: z.number().int().min(50).max(200),
    recentDirectory: z.string().min(1).max(32_767).nullable(),
    windowBounds: WindowBoundsSchema.nullable(),
    welcomeCompleted: z.boolean(),
  })
  .strict();

export const DrawingAnnotationDefaultsSchema = z
  .object({
    fontSize: z.number().min(1).max(1000),
    lineWidth: z.number().min(0.1).max(100),
  })
  .strict();
export const DEFAULT_DRAWING_ANNOTATION_STYLE = { fontSize: 12, lineWidth: 0.3 };

export const DualColumnFlowSchema = z
  .object({
    style: z.enum(["classic", "slim", "ceramic", "graphite"]),
    mode: z.enum(["cable", "boxes", "off"]),
    margin: z.enum(["dust", "threads", "ticks", "chevrons", "none"]).default("dust"),
  })
  .strict();
export type DualColumnFlow = z.infer<typeof DualColumnFlowSchema>;
export const DEFAULT_DUAL_COLUMN_FLOW: DualColumnFlow = {
  style: "graphite",
  mode: "boxes",
  margin: "dust",
};

export const AppSettingsSchema = AppSettingsV1Schema.extend({
  autoCheckUpdates: z.boolean().default(true),
  contentSearchEnabled: z.boolean().default(true),
  drawingDetailDefaultRatio: z.number().finite().min(0.1).max(100).default(2),
  drawingAutoAdjustLabelSize: z.boolean().default(true),
  drawingAutoLabelScale: z.number().min(0.5).max(2).default(1),
  drawingAnnotationDefaults: DrawingAnnotationDefaultsSchema.default(
    DEFAULT_DRAWING_ANNOTATION_STYLE,
  ),
  aiConnectionsEnabled: z.boolean().default(false),
  aiPolicyAcceptedVersion: z.string().min(1).max(40).nullable().default(null),
  uiScalePercent: z.number().int().min(85).max(125).default(100),
  reducedMotion: z.boolean().default(false),
  editorColors: EditorColorsSchema.default(DEFAULT_EDITOR_COLORS),
  dualColumnFlow: DualColumnFlowSchema.default(DEFAULT_DUAL_COLUMN_FLOW),
  closeToTray: z.boolean().default(true),
  trayIntroDismissed: z.boolean().default(false),
  editorIntroductionSeen: z.boolean().default(false),
  referenceMarkSyncIntroDismissed: z.boolean(),
  referenceMarkLocatorEnabled: z.boolean(),
  inventionContentPrefix: InventionContentPrefixSchema.default(DEFAULT_INVENTION_CONTENT_PREFIX),
  printPreferences: PrintPreferencesSchema,
  patentTemplates: PatentTemplateSettingsSchema,
  backup: BackupSettingsSchema,
  snapshot: SnapshotSettingsSchema,
  pageMargins: PageMarginsSchema,
  shortcuts: ShortcutSettingsSchema,
  customDualViewPresets: CustomDualViewPresetsSchema,
  aiCorrection: AiCorrectionSettingsSchema,
  patentLibraryViewMode: PatentLibraryViewModeSchema,
}).strict();
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export const AppSettingsPatchSchema = AppSettingsSchema.partial()
  .extend({
    autoCheckUpdates: z.boolean().optional(),
    contentSearchEnabled: z.boolean().optional(),
    drawingDetailDefaultRatio: z.number().finite().min(0.1).max(100).optional(),
    drawingAutoAdjustLabelSize: z.boolean().optional(),
    drawingAutoLabelScale: z.number().min(0.5).max(2).optional(),
    drawingAnnotationDefaults: DrawingAnnotationDefaultsSchema.optional(),
    aiConnectionsEnabled: z.boolean().optional(),
    aiPolicyAcceptedVersion: z.string().min(1).max(40).nullable().optional(),
    aiCorrection: AiCorrectionSettingsRequestSchema.optional(),
    uiScalePercent: z.number().int().min(85).max(125).optional(),
    reducedMotion: z.boolean().optional(),
    editorColors: EditorColorsSchema.optional(),
    dualColumnFlow: DualColumnFlowSchema.optional(),
    closeToTray: z.boolean().optional(),
    trayIntroDismissed: z.boolean().optional(),
    editorIntroductionSeen: z.boolean().optional(),
    inventionContentPrefix: InventionContentPrefixSchema.optional(),
  })
  .superRefine((patch, ctx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Settings updates cannot contain undefined values.",
          path: [key],
        });
      }
    }
  });
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

export const SettingsHealthSchema = z
  .object({
    state: z.enum(["healthy", "recovered", "degraded"]),
    message: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type SettingsHealth = z.infer<typeof SettingsHealthSchema>;

type SettingsCrypto = {
  getRandomValues(bytes: Uint8Array): Uint8Array;
  randomUUID?: () => string;
};

export function createSettingsId(
  webCrypto: SettingsCrypto = globalThis.crypto as unknown as SettingsCrypto,
): string {
  if (typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const DEFAULT_PATENT_TEMPLATE_SETTINGS = createFactoryPatentTemplates(createSettingsId);

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoCheckUpdates: true,
  contentSearchEnabled: true,
  drawingDetailDefaultRatio: 2,
  drawingAutoAdjustLabelSize: true,
  drawingAutoLabelScale: 1,
  drawingAnnotationDefaults: { ...DEFAULT_DRAWING_ANNOTATION_STYLE },
  aiConnectionsEnabled: false,
  aiPolicyAcceptedVersion: null,
  uiScalePercent: 100,
  reducedMotion: false,
  editorColors: { ...DEFAULT_EDITOR_COLORS },
  dualColumnFlow: { ...DEFAULT_DUAL_COLUMN_FLOW },
  closeToTray: true,
  trayIntroDismissed: false,
  zoomPercent: 100,
  recentDirectory: null,
  windowBounds: null,
  welcomeCompleted: false,
  editorIntroductionSeen: false,
  referenceMarkSyncIntroDismissed: false,
  referenceMarkLocatorEnabled: true,
  inventionContentPrefix: DEFAULT_INVENTION_CONTENT_PREFIX,
  printPreferences: structuredClone(DEFAULT_PRINT_PREFERENCES),
  patentTemplates: structuredClone(DEFAULT_PATENT_TEMPLATE_SETTINGS),
  backup: structuredClone(DEFAULT_BACKUP_SETTINGS),
  snapshot: structuredClone(DEFAULT_SNAPSHOT_SETTINGS),
  pageMargins: structuredClone(DEFAULT_PAGE_MARGINS),
  shortcuts: structuredClone(DEFAULT_SHORTCUT_SETTINGS),
  customDualViewPresets: structuredClone(DEFAULT_CUSTOM_DUAL_VIEW_PRESETS),
  aiCorrection: structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
  patentLibraryViewMode: "single",
};
