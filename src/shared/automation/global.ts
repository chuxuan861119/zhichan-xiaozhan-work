import { z } from "zod";
import { AiCorrectionSettingsRequestSchema } from "../ai-correction/model.js";
import { AppSettingsSchema } from "../settings/model.js";

/** Every domain is separately selected by the human; patent grants imply none of these. */
export const AUTOMATION_GLOBAL_DOMAINS = {
  settings: "软件通用设置",
  templates: "全局默认模板",
  models: "AI 模型配置",
  library: "整库管理与备份恢复",
  documents: "独立文档管理",
  transfer: "完整数据迁移（全部专利、文档、对话与设置）",
} as const;
export const AutomationGlobalDomainSchema = z.enum([
  "settings",
  "templates",
  "models",
  "library",
  "documents",
  "transfer",
]);
export type AutomationGlobalDomain = z.infer<typeof AutomationGlobalDomainSchema>;
export const AutomationGlobalPermissionsSchema = z.partialRecord(
  AutomationGlobalDomainSchema,
  z.enum(["read", "full"]),
);

// Paths, model settings, backup policy and templates belong to their own domains.
export const AutomationGeneralSettingsSchema = AppSettingsSchema.omit({
  aiCorrection: true,
  aiConnectionsEnabled: true,
  aiPolicyAcceptedVersion: true,
  backup: true,
  snapshot: true,
  patentTemplates: true,
  recentDirectory: true,
  windowBounds: true,
});
export const AutomationGeneralSettingsPatchSchema =
  AutomationGeneralSettingsSchema.partial().strict();
export function generalSettings(settings: z.infer<typeof AppSettingsSchema>) {
  const {
    aiCorrection,
    aiConnectionsEnabled,
    aiPolicyAcceptedVersion,
    backup,
    snapshot,
    patentTemplates,
    recentDirectory,
    windowBounds,
    ...general
  } = settings;
  return AutomationGeneralSettingsSchema.parse(general);
}
export const AutomationModelsSettingsSchema = AppSettingsSchema.pick({
  aiCorrection: true,
  aiConnectionsEnabled: true,
});
// Writes use current request validation, not the historical on-disk migration reader.
export const AutomationModelsPatchSchema = AutomationModelsSettingsSchema.extend({
  aiCorrection: AiCorrectionSettingsRequestSchema,
})
  .partial()
  .strict();
export function modelSettings(settings: z.infer<typeof AppSettingsSchema>) {
  return AutomationModelsSettingsSchema.parse({
    aiCorrection: settings.aiCorrection,
    aiConnectionsEnabled: settings.aiConnectionsEnabled,
  });
}
export function commandGlobalDomain(command: string): AutomationGlobalDomain | undefined {
  if (command.startsWith("global.transfer.")) return "transfer";
  if (command.startsWith("global.settings.")) return "settings";
  if (command.startsWith("global.template.")) return "templates";
  if (command.startsWith("global.models.")) return "models";
  if (command.startsWith("global.library.")) return "library";
  if (command.startsWith("global.documents.")) return "documents";
  return undefined;
}

export const AutomationModelProbeSchema = z.object({ profileId: z.string().uuid() }).strict();
