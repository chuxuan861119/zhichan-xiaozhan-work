import { DEFAULT_APP_SETTINGS } from "../settings/model.js";
import {
  AutomationGeneralSettingsPatchSchema,
  AutomationModelsPatchSchema,
  generalSettings,
} from "./global.js";

test("automation cannot fabricate policy acceptance through general or model settings", () => {
  expect(generalSettings(DEFAULT_APP_SETTINGS)).not.toHaveProperty("aiPolicyAcceptedVersion");
  expect(
    AutomationGeneralSettingsPatchSchema.safeParse({ aiPolicyAcceptedVersion: "2026-10-05" })
      .success,
  ).toBe(false);
  expect(
    AutomationModelsPatchSchema.safeParse({
      aiConnectionsEnabled: true,
      aiPolicyAcceptedVersion: "2026-10-05",
    }).success,
  ).toBe(false);
});

test("CLI model updates reject unsupported profiles instead of silently retiring them", () => {
  expect(
    AutomationModelsPatchSchema.safeParse({
      aiCorrection: {
        ...DEFAULT_APP_SETTINGS.aiCorrection,
        profiles: [
          {
            profileId: "00000000-0000-4000-8000-000000000123",
            providerId: "custom",
            displayName: "unsupported fixture",
            baseUrl: "https://example.invalid/v1",
            model: "test-model",
          },
        ],
      },
    }).success,
  ).toBe(false);
});
