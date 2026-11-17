import { describe, expect, test } from "vitest";
import {
  AI_PROVIDER_PRESETS,
  AiCorrectionSettingsSchema,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "./model.js";

describe("AI correction settings", () => {
  test("uses conservative defaults when the feature has not been configured", () => {
    expect(AiCorrectionSettingsSchema.parse({})).toEqual(DEFAULT_AI_CORRECTION_SETTINGS);
  });

  test("defaults DeepSeek Thinking to enabled for existing settings", () => {
    const parsed = AiCorrectionSettingsSchema.parse({
      enabled: false,
      activeProfileId: null,
      profiles: [],
      timeoutMs: 60_000,
      maxUploadCharacters: 50_000,
    });

    expect(parsed.deepseekThinkingEnabled).toBe(true);
  });

  test.each([
    "http://provider.example/v1",
    "https://user:secret@provider.example/v1",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1#fragment",
  ])("rejects an unsafe service URL: %s", (baseUrl) => {
    expect(() =>
      AiCorrectionSettingsSchema.parse({ enabled: true, baseUrl, model: "compatible-model" }),
    ).toThrow();
  });

  test("exposes provider presets with fixed endpoints and selectable model identifiers", () => {
    expect(AI_PROVIDER_PRESETS.map(({ providerId }) => providerId)).toEqual(["deepseek"]);
    expect(AI_PROVIDER_PRESETS[0]).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      requiresApiKey: true,
      models: expect.arrayContaining([expect.objectContaining({ id: "deepseek-flash" })]),
    });
  });

  test("accepts several saved models but requires the active model to exist", () => {
    const first = {
      profileId: "a878463b-d7d4-4e59-8471-e04a03ef5367",
      providerId: "deepseek" as const,
      displayName: "DeepSeek · V4 Pro",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    };
    expect(
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        profiles: [first],
        activeProfileId: first.profileId,
      }).profiles,
    ).toEqual([first]);
    expect(() =>
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        profiles: [first],
        activeProfileId: "9c2bcfd4-8032-4e3e-8521-05ae647f85fa",
      }),
    ).toThrow(/默认模型/u);
  });

  test("accepts an account-discovered model while keeping the preset endpoint fixed", () => {
    const discovered = {
      profileId: "752bcdd4-8032-4e3e-8521-05ae647f85fa",
      providerId: "deepseek" as const,
      displayName: "DeepSeek · account-only-model",
      baseUrl: "https://api.deepseek.com",
      model: "account-only-model",
    };

    expect(
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        profiles: [discovered],
      }).profiles,
    ).toEqual([discovered]);
    expect(() =>
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        profiles: [{ ...discovered, baseUrl: "https://provider.example/v1" }],
      }),
    ).toThrow(/地址不可修改/u);
  });

  test("disables unsupported legacy single-model settings", () => {
    expect(
      AiCorrectionSettingsSchema.parse({
        enabled: true,
        baseUrl: "https://provider.example/v1",
        model: "compatible-model",
        timeoutMs: 60_000,
        maxUploadCharacters: 50_000,
      }),
    ).toMatchObject({ enabled: false, activeProfileId: null, profiles: [] });
  });

  test("rejects values outside the first-phase request limits", () => {
    expect(() => AiCorrectionSettingsSchema.parse({ timeoutMs: 4_999 })).toThrow();
    expect(() => AiCorrectionSettingsSchema.parse({ timeoutMs: 120_001 })).toThrow();
    expect(() => AiCorrectionSettingsSchema.parse({ maxUploadCharacters: 999 })).toThrow();
    expect(() => AiCorrectionSettingsSchema.parse({ maxUploadCharacters: 100_001 })).toThrow();
  });
});
