import { z } from "zod";
import { LegacyAiModelProfileSchema } from "../ai-correction/model.js";
import { BackupSettingsSchema } from "../backup/model.js";
import { PatentTemplateSettingsSchema } from "../patent/templates.js";
import { PrintPreferencesSchema } from "../printing/model.js";
import { CustomDualViewPresetsSchema } from "../settings/custom-dual-view.js";
import { EditorColorsSchema } from "../settings/editor-colors.js";
import { InventionContentPrefixSchema } from "../settings/invention-content.js";
import { type AppSettings, AppSettingsSchema } from "../settings/model.js";
import { PageMarginsSchema } from "../settings/page-margins.js";
import { ShortcutSettingsSchema } from "../settings/shortcuts.js";
import { SnapshotSettingsSchema } from "../snapshot/model.js";

export type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const PortableAiModelProfileSchema = LegacyAiModelProfileSchema.refine(
  (profile) => profile.providerId !== "custom",
  { message: "迁移设置不允许包含自定义 AI 模型。", path: ["providerId"] },
).readonly();

const PortableAiCorrectionSettingsSchema = z
  .object({
    activeProfileId: z.uuid().nullable(),
    profiles: z.array(PortableAiModelProfileSchema).max(20).readonly(),
    deepseekThinkingEnabled: z.boolean(),
    timeoutMs: z.number().int().min(5_000).max(120_000),
    maxUploadCharacters: z.number().int().min(1_000).max(100_000),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      new Set(settings.profiles.map(({ profileId }) => profileId)).size !== settings.profiles.length
    ) {
      context.addIssue({ code: "custom", message: "模型标识不能重复。", path: ["profiles"] });
    }
  })
  .readonly();

const PortableSettingsObjectSchema = z
  .object({
    version: z.literal(1),
    contentSearchEnabled: z.boolean().optional(),
    editorColors: EditorColorsSchema.optional(),
    drawingDetailDefaultRatio: z.number().finite().min(0.1).max(100).optional(),
    inventionContentPrefix: InventionContentPrefixSchema.optional(),
    referenceMarkSyncIntroDismissed: z.boolean(),
    referenceMarkLocatorEnabled: z.boolean().default(true),
    printPreferences: PrintPreferencesSchema.omit({ printerDeviceName: true }).readonly(),
    patentTemplates: PatentTemplateSettingsSchema.readonly(),
    snapshot: SnapshotSettingsSchema.readonly(),
    pageMargins: PageMarginsSchema.readonly(),
    shortcuts: ShortcutSettingsSchema.readonly(),
    customDualViewPresets: CustomDualViewPresetsSchema.readonly(),
    backup: BackupSettingsSchema.pick({ intervalMinutes: true }).readonly(),
    aiCorrection: PortableAiCorrectionSettingsSchema,
  })
  .strict();

export const PortableSettingsSchema = PortableSettingsObjectSchema.transform((settings) =>
  deepFreeze(settings),
);
export type PortableSettings = z.infer<typeof PortableSettingsSchema>;

// Every setting must explicitly choose migration or machine-local ownership.
// Adding an AppSettings field without updating this policy is a type error.
export const SETTING_TRANSFER_POLICY = {
  autoCheckUpdates: "local",
  designEditorPreferences: "local",
  designAutoTrimDefaults: "local",
  designBriefExportFormat: "local",
  contentSearchEnabled: "portable",
  drawingDetailDefaultRatio: "portable",
  drawingAutoAdjustLabelSize: "local",
  drawingAutoLabelScale: "local",
  drawingAnnotationDefaults: "local",
  aiConnectionsEnabled: "local",
  aiPolicyAcceptedVersion: "local",
  uiScalePercent: "local",
  reducedMotion: "local",
  editorColors: "portable",
  dualColumnFlow: "local",
  closeToTray: "local",
  trayIntroDismissed: "local",
  zoomPercent: "local",
  recentDirectory: "local",
  windowBounds: "local",
  welcomeCompleted: "local",
  editorIntroductionSeen: "local",
  referenceMarkSyncIntroDismissed: "portable",
  referenceMarkLocatorEnabled: "portable",
  inventionContentPrefix: "portable",
  printPreferences: "mixed",
  patentTemplates: "portable",
  backup: "mixed",
  snapshot: "portable",
  pageMargins: "portable",
  shortcuts: "portable",
  customDualViewPresets: "portable",
  aiCorrection: "mixed",
  patentLibraryViewMode: "local",
} as const satisfies Record<keyof AppSettings, "local" | "portable" | "mixed">;

export function projectPortableSettings(current: AppSettings): PortableSettings {
  const profiles = current.aiCorrection.profiles
    .filter((profile) => profile.providerId === "deepseek")
    .map((profile) => PortableAiModelProfileSchema.parse(profile));
  const activeProfileId = profiles.some(
    ({ profileId }) => profileId === current.aiCorrection.activeProfileId,
  )
    ? current.aiCorrection.activeProfileId
    : null;

  return PortableSettingsSchema.parse({
    version: 1,
    editorColors: current.editorColors,
    drawingDetailDefaultRatio: current.drawingDetailDefaultRatio,
    inventionContentPrefix: current.inventionContentPrefix,
    ...(current.contentSearchEnabled !== undefined
      ? { contentSearchEnabled: current.contentSearchEnabled }
      : {}),
    referenceMarkSyncIntroDismissed: current.referenceMarkSyncIntroDismissed,
    referenceMarkLocatorEnabled: current.referenceMarkLocatorEnabled,
    printPreferences: {
      duplexMode: current.printPreferences.duplexMode,
      color: current.printPreferences.color,
      orientation: current.printPreferences.orientation,
      paperSize: current.printPreferences.paperSize,
    },
    patentTemplates: current.patentTemplates,
    snapshot: current.snapshot,
    pageMargins: current.pageMargins,
    shortcuts: current.shortcuts,
    customDualViewPresets: current.customDualViewPresets,
    backup: { intervalMinutes: current.backup.intervalMinutes },
    aiCorrection: {
      activeProfileId,
      profiles,
      deepseekThinkingEnabled: current.aiCorrection.deepseekThinkingEnabled,
      timeoutMs: current.aiCorrection.timeoutMs,
      maxUploadCharacters: current.aiCorrection.maxUploadCharacters,
    },
  });
}

export function mergePortableSettings(
  current: AppSettings,
  portable: PortableSettings,
  createId: () => string,
): AppSettings {
  const parsed = PortableSettingsSchema.parse(portable);
  const customProfiles = current.aiCorrection.profiles.filter(
    (profile) => profile.providerId === "custom",
  );
  const usedProfileIds = new Set([
    ...customProfiles.map(({ profileId }) => profileId),
    ...(current.aiCorrection.retiredProfileIds ?? []),
  ]);
  const importedIdMap = new Map<string, string>();
  const importedProfiles = parsed.aiCorrection.profiles.map((profile) => {
    let profileId = profile.profileId;
    if (usedProfileIds.has(profileId)) {
      const attemptedProfileIds = new Set<string>();
      do {
        profileId = z.uuid().parse(createId());
        if (attemptedProfileIds.has(profileId)) {
          throw new Error("ID factory repeated an occupied profile UUID.");
        }
        attemptedProfileIds.add(profileId);
      } while (usedProfileIds.has(profileId));
    }
    usedProfileIds.add(profileId);
    importedIdMap.set(profile.profileId, profileId);
    return { ...profile, profileId };
  });
  const importedActiveProfileId = parsed.aiCorrection.activeProfileId
    ? importedIdMap.get(parsed.aiCorrection.activeProfileId)
    : undefined;
  const currentCustomActiveProfileId = customProfiles.some(
    ({ profileId }) => profileId === current.aiCorrection.activeProfileId,
  )
    ? current.aiCorrection.activeProfileId
    : null;

  return AppSettingsSchema.parse({
    ...current,
    ...(parsed.editorColors ? { editorColors: parsed.editorColors } : {}),
    ...(parsed.drawingDetailDefaultRatio !== undefined
      ? { drawingDetailDefaultRatio: parsed.drawingDetailDefaultRatio }
      : {}),
    ...(parsed.inventionContentPrefix !== undefined
      ? { inventionContentPrefix: parsed.inventionContentPrefix }
      : {}),
    autoCheckUpdates: current.autoCheckUpdates,
    ...(parsed.contentSearchEnabled !== undefined
      ? { contentSearchEnabled: parsed.contentSearchEnabled }
      : {}),
    drawingAnnotationDefaults: current.drawingAnnotationDefaults,
    drawingAutoAdjustLabelSize: current.drawingAutoAdjustLabelSize,
    drawingAutoLabelScale: current.drawingAutoLabelScale,
    aiConnectionsEnabled: current.aiConnectionsEnabled,
    aiPolicyAcceptedVersion: current.aiPolicyAcceptedVersion,
    uiScalePercent: current.uiScalePercent,
    reducedMotion: current.reducedMotion,
    dualColumnFlow: current.dualColumnFlow,
    zoomPercent: current.zoomPercent,
    patentLibraryViewMode: current.patentLibraryViewMode,
    recentDirectory: current.recentDirectory,
    windowBounds: current.windowBounds,
    welcomeCompleted: current.welcomeCompleted,
    editorIntroductionSeen: current.editorIntroductionSeen,
    referenceMarkSyncIntroDismissed: parsed.referenceMarkSyncIntroDismissed,
    referenceMarkLocatorEnabled: parsed.referenceMarkLocatorEnabled,
    printPreferences: {
      printerDeviceName: current.printPreferences.printerDeviceName,
      duplexMode: parsed.printPreferences.duplexMode,
      color: parsed.printPreferences.color,
      orientation: parsed.printPreferences.orientation,
      paperSize: parsed.printPreferences.paperSize,
    },
    patentTemplates: parsed.patentTemplates,
    backup: {
      enabled: false,
      folder: null,
      intervalMinutes: parsed.backup.intervalMinutes,
    },
    snapshot: parsed.snapshot,
    pageMargins: parsed.pageMargins,
    shortcuts: parsed.shortcuts,
    customDualViewPresets: parsed.customDualViewPresets,
    aiCorrection: {
      ...(current.aiCorrection.retiredProfileIds?.length
        ? { retiredProfileIds: current.aiCorrection.retiredProfileIds }
        : {}),
      enabled: false,
      activeProfileId: importedActiveProfileId ?? currentCustomActiveProfileId,
      profiles: [...customProfiles, ...importedProfiles],
      deepseekThinkingEnabled: parsed.aiCorrection.deepseekThinkingEnabled,
      timeoutMs: parsed.aiCorrection.timeoutMs,
      maxUploadCharacters: parsed.aiCorrection.maxUploadCharacters,
    },
  });
}
