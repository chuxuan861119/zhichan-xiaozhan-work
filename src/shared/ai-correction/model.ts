import { z } from "zod";

const MAX_SERVICE_URL_LENGTH = 2_048;

export const LEGACY_AI_PROFILE_ID = "00000000-0000-4000-8000-000000000001";

type AiProviderPreset = {
  providerId: AiPresetProviderId;
  category: "api" | "plan" | "local";
  requiresApiKey: boolean;
  label: string;
  baseUrl: string;
  docsUrl: string;
  models: readonly [
    { id: string; label: string; recommended?: boolean },
    ...{ id: string; label: string; recommended?: boolean }[],
  ];
};
export const AI_PROVIDER_PRESETS: readonly [AiProviderPreset, ...AiProviderPreset[]] = [
  {
    providerId: "deepseek",
    category: "api",
    requiresApiKey: true,
    label: "深度求索 / DeepSeek",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/",
    models: [
      { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", recommended: true },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（旧配置兼容）" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4.1 Flash（旧接口别名）" },
    ],
  },
];

// Historical identifiers are retained for reading old settings and history only.
export const AiPresetProviderIdSchema = z.enum([
  "deepseek",
  "zhipu",
  "kimi",
  "kimi-code-plan",
  "minimax",
  "minimax-token-plan",
  "xiaomi-mimo",
  "xiaomi-mimo-token-plan",
  "tencent-token-plan",
  "openai",
  "ollama",
]);
export type AiPresetProviderId = z.infer<typeof AiPresetProviderIdSchema>;
export const AiProviderIdSchema = z.union([AiPresetProviderIdSchema, z.literal("custom")]);
export type AiProviderId = z.infer<typeof AiProviderIdSchema>;

export function isSafeAiServiceBaseUrl(value: string): boolean {
  if (value === "") return true;
  try {
    const url = new URL(value);
    const safeHttps = url.protocol === "https:";
    const safeOllama =
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "11434" &&
      (url.pathname === "/v1" || url.pathname === "/v1/");
    return (
      (safeHttps || safeOllama) &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export const AiServiceBaseUrlSchema = z
  .string()
  .trim()
  .max(MAX_SERVICE_URL_LENGTH)
  .refine(
    isSafeAiServiceBaseUrl,
    "服务地址必须是安全 HTTPS 地址；Ollama 仅允许本机 127.0.0.1:11434。",
  );

const HISTORICAL_PROVIDER_ENDPOINTS: Record<AiPresetProviderId, string> = {
  deepseek: "https://api.deepseek.com",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  kimi: "https://api.moonshot.cn/v1",
  "kimi-code-plan": "https://api.kimi.com/coding/v1",
  minimax: "https://api.minimaxi.com/v1",
  "minimax-token-plan": "https://api.minimaxi.com/v1",
  "xiaomi-mimo": "https://api.xiaomimimo.com/v1",
  "xiaomi-mimo-token-plan": "https://token-plan-cn.xiaomimimo.com/v1",
  "tencent-token-plan": "https://api.lkeap.cloud.tencent.com/plan/v3",
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
};
export const LegacyAiModelProfileSchema = z
  .object({
    profileId: z.uuid(),
    providerId: AiProviderIdSchema,
    displayName: z.string().trim().min(1).max(120),
    baseUrl: AiServiceBaseUrlSchema,
    model: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.providerId !== "custom" &&
      profile.baseUrl !== HISTORICAL_PROVIDER_ENDPOINTS[profile.providerId]
    )
      context.addIssue({ code: "custom", message: "预置提供商地址不可修改。", path: ["baseUrl"] });
  });

export const AiModelProfileSchema = LegacyAiModelProfileSchema.superRefine((profile, context) => {
  if (profile.providerId !== "deepseek") {
    context.addIssue({
      code: "custom",
      message: "仅支持 DeepSeek 官方接口。",
      path: ["providerId"],
    });
    return;
  }
  const preset = AI_PROVIDER_PRESETS.find(
    (candidate) => candidate.providerId === profile.providerId,
  );
  if (!preset || profile.baseUrl !== preset.baseUrl) {
    context.addIssue({ code: "custom", message: "预置提供商地址不可修改。", path: ["baseUrl"] });
  }
});
export type AiModelProfile = z.infer<typeof AiModelProfileSchema>;

export const DEFAULT_AI_CORRECTION_SETTINGS = {
  enabled: false,
  activeProfileId: null,
  profiles: [],
  deepseekThinkingEnabled: true,
  timeoutMs: 60_000,
  maxUploadCharacters: 50_000,
};

export const AiCorrectionSettingsRequestSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_AI_CORRECTION_SETTINGS.enabled),
    activeProfileId: z.uuid().nullable().default(null),
    profiles: z.array(AiModelProfileSchema).max(20).default([]),
    retiredProfileIds: z.array(z.uuid()).max(400).optional(),
    deepseekThinkingEnabled: z
      .boolean()
      .default(DEFAULT_AI_CORRECTION_SETTINGS.deepseekThinkingEnabled),
    timeoutMs: z.number().int().min(5_000).max(120_000).default(60_000),
    maxUploadCharacters: z.number().int().min(1_000).max(100_000).default(50_000),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      new Set(settings.profiles.map(({ profileId }) => profileId)).size !== settings.profiles.length
    ) {
      context.addIssue({ code: "custom", message: "模型标识不能重复。", path: ["profiles"] });
    }
    if (
      settings.profiles.some((profile) => settings.retiredProfileIds?.includes(profile.profileId))
    )
      context.addIssue({
        code: "custom",
        message: "已停用的提供商标识不能复用，请创建新的 DeepSeek 配置。",
        path: ["profiles"],
      });
    if (!settings.enabled) return;
    if (
      !settings.activeProfileId ||
      !settings.profiles.some(({ profileId }) => profileId === settings.activeProfileId)
    ) {
      context.addIssue({
        code: "custom",
        message: "启用 AI 纠错前请选择有效的默认模型。",
        path: ["activeProfileId"],
      });
    }
  });

function migrateLegacySettings(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input) || "profiles" in input)
    return input;
  const legacy = input as Record<string, unknown>;
  if (!("baseUrl" in legacy) && !("model" in legacy)) return input;
  const baseUrl = typeof legacy.baseUrl === "string" ? legacy.baseUrl : "";
  const model = typeof legacy.model === "string" ? legacy.model : "";
  const hasProfile = baseUrl !== "" || model !== "";
  return {
    enabled: legacy.enabled ?? false,
    activeProfileId: hasProfile ? LEGACY_AI_PROFILE_ID : null,
    profiles: hasProfile
      ? [
          {
            profileId: LEGACY_AI_PROFILE_ID,
            providerId: "custom",
            displayName: model || "原有自定义模型",
            baseUrl,
            model,
          },
        ]
      : [],
    deepseekThinkingEnabled: true,
    timeoutMs: legacy.timeoutMs ?? 60_000,
    maxUploadCharacters: legacy.maxUploadCharacters ?? 50_000,
  };
}

function restrictHistoricalProviders(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const settings = input as Record<string, unknown>;
  if (!Array.isArray(settings.profiles)) return input;
  // Validate historical records before discarding unsupported providers; malformed settings
  // still use the existing settings recovery path rather than hiding corruption.
  const parsed = z.array(LegacyAiModelProfileSchema).max(20).safeParse(settings.profiles);
  if (!parsed.success) return input;
  const old = parsed.data;
  const profiles = old.flatMap((profile) => {
    if (profile.providerId === "deepseek") return [profile];
    if (
      profile.providerId === "custom" &&
      profile.baseUrl === "https://api.deepseek.com" &&
      profile.model.startsWith("deepseek-")
    )
      return [{ ...profile, providerId: "deepseek" as const }];
    return [];
  });
  const removedActive =
    old.some((profile) => profile.profileId === settings.activeProfileId) &&
    !profiles.some((profile) => profile.profileId === settings.activeProfileId);
  const retired = [
    ...new Set([
      ...(Array.isArray(settings.retiredProfileIds) ? settings.retiredProfileIds : []),
      ...old
        .filter((profile) => !profiles.some((current) => current.profileId === profile.profileId))
        .map((profile) => profile.profileId),
    ]),
  ];
  return {
    ...settings,
    profiles,
    ...(retired.length ? { retiredProfileIds: retired } : {}),
    ...(removedActive ? { enabled: false, activeProfileId: null } : {}),
  };
}

export const AiCorrectionSettingsSchema = z.preprocess(
  (input) => restrictHistoricalProviders(migrateLegacySettings(input)),
  AiCorrectionSettingsRequestSchema,
);
export type AiCorrectionSettings = z.infer<typeof AiCorrectionSettingsSchema>;

export function activeAiModel(settings: AiCorrectionSettings): AiModelProfile | null {
  const profile = settings.profiles.find(({ profileId }) => profileId === settings.activeProfileId);
  return profile && AiModelProfileSchema.safeParse(profile).success ? profile : null;
}
