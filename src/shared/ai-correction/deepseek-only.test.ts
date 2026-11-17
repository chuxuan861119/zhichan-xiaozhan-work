import { describe, expect, test } from "vitest";
import { AiModelDiscoveryRequestSchema } from "./contract.js";
import {
  AI_PROVIDER_PRESETS,
  AiCorrectionSettingsRequestSchema,
  AiCorrectionSettingsSchema,
  AiModelProfileSchema,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "./model.js";

const deepseek = {
  profileId: "a878463b-d7d4-4e59-8471-e04a03ef5367",
  providerId: "deepseek",
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
};
const other = {
  ...deepseek,
  profileId: "752bcdd4-8032-4e3e-8521-05ae647f85fa",
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test",
};

describe("DeepSeek-only configuration", () => {
  test("offers only DeepSeek and rejects other providers and altered endpoints", () => {
    expect(AI_PROVIDER_PRESETS.map((item) => item.providerId)).toEqual(["deepseek"]);
    expect(AiModelProfileSchema.safeParse(other).success).toBe(false);
    expect(AiModelProfileSchema.safeParse({ ...other, providerId: "custom" }).success).toBe(false);
    expect(
      AiModelProfileSchema.safeParse({ ...deepseek, baseUrl: "https://proxy.example/v1" }).success,
    ).toBe(false);
    expect(AiModelProfileSchema.safeParse(deepseek).success).toBe(true);
  });
  test("loads old settings without enabling or silently substituting a different provider", () => {
    expect(
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        profiles: [deepseek, other],
        activeProfileId: other.profileId,
      }),
    ).toMatchObject({ enabled: false, activeProfileId: null, profiles: [deepseek] });
    expect(
      AiCorrectionSettingsSchema.parse({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        profiles: [deepseek, other],
        activeProfileId: deepseek.profileId,
      }),
    ).toMatchObject({ enabled: true, activeProfileId: deepseek.profileId, profiles: [deepseek] });
  });
  test("rejects discovery requests that could disclose keys to another endpoint", () => {
    expect(
      AiModelDiscoveryRequestSchema.safeParse({
        providerId: "custom",
        baseUrl: "https://proxy.example/v1",
        apiKey: "test-key",
      }).success,
    ).toBe(false);
    expect(
      AiModelDiscoveryRequestSchema.safeParse({
        providerId: "deepseek",
        baseUrl: "https://proxy.example/v1",
        apiKey: "test-key",
      }).success,
    ).toBe(false);
  });
});

test("new writes reject unsupported profiles even when AI is disabled", () => {
  expect(
    AiCorrectionSettingsRequestSchema.safeParse({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      profiles: [other],
    }).success,
  ).toBe(false);
});

test("retired provider identities cannot be reused with preserved credentials", () => {
  const migrated = AiCorrectionSettingsSchema.parse({
    ...DEFAULT_AI_CORRECTION_SETTINGS,
    profiles: [other],
    activeProfileId: other.profileId,
  });
  expect(migrated.retiredProfileIds).toContain(other.profileId);
  expect(
    AiCorrectionSettingsRequestSchema.safeParse({
      ...migrated,
      profiles: [{ ...deepseek, profileId: other.profileId }],
    }).success,
  ).toBe(false);
});
