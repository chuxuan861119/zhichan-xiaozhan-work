// @vitest-environment node
import { expect, test, vi } from "vitest";
import { APPLICATION_VERSION } from "../../shared/branding.js";
import {
  secureUsageEndpoint,
  usageConfigAvailable,
  usageScopeVersion,
  usageStatisticsConfig,
} from "./usage-statistics-config.js";

test("open-source builds never contribute to official production statistics by default", () => {
  const config = usageStatisticsConfig();
  expect(APPLICATION_VERSION).toBe("2.2.0");
  expect(config.releaseChannel).toBe("preview");
  expect(usageConfigAvailable(config, "win32", APPLICATION_VERSION)).toBe(false);
  expect(config.releases).toEqual([]);
  expect(usageConfigAvailable(config, "darwin", APPLICATION_VERSION)).toBe(false);
  expect(usageConfigAvailable(config, "openharmony", APPLICATION_VERSION)).toBe(false);
  expect(usageConfigAvailable(config, "ohos", APPLICATION_VERSION)).toBe(false);
  expect(usageConfigAvailable(config, "linux", APPLICATION_VERSION)).toBe(false);
  expect(usageConfigAvailable(config, "win32", "1.1.1")).toBe(false);
  expect(config.endpoint).toBe("");
});

test("no configured channel, incomplete disclosure or unaccepted platform may collect", () => {
  const empty = usageStatisticsConfig();
  expect(usageConfigAvailable(empty, "darwin", "1.1")).toBe(false);
  const config = {
    ...empty,
    endpoint: "https://stats.example.com/v1/usage/daily-aggregate",
    acceptedPlatforms: ["darwin" as const],
    publicVersionGroups: ["1.1"],
    releases: [{ platform: "macos" as const, version: "1.1.0", channel: "preview" as const }],
    disclosure: {
      operator: "测试",
      contact: "测试",
      recipient: "测试",
      region: "测试",
      retentionMonths: 18,
      securityLogNotice: "测试",
    },
  };
  expect(usageConfigAvailable(config, "darwin", "1.1.0")).toBe(true);
  expect(usageConfigAvailable(config, "openharmony", "1.1")).toBe(false);
  expect(
    usageConfigAvailable(
      { ...config, disclosure: { ...config.disclosure, contact: "" } },
      "darwin",
      "1.1",
    ),
  ).toBe(false);
  vi.stubEnv("PATENT_WORKBENCH_USAGE_ENDPOINT", "https://untrusted.example.com");
  expect(usageStatisticsConfig()).toEqual(empty);
  vi.unstubAllEnvs();
});
test("endpoint requires TLS, fixed path, no credentials, query or fragment", () => {
  for (const value of [
    "http://example.com/v1/usage/daily-aggregate",
    "https://a:b@example.com/v1/usage/daily-aggregate",
    "https://example.com/",
    "https://example.com/v1/usage/daily-aggregate?x=1",
    "https://example.com/v1/usage/daily-aggregate#x",
  ])
    expect(() => secureUsageEndpoint(value)).toThrow();
});

test("processing scope changes require new consent, while a normal software release does not", () => {
  const config = usageStatisticsConfig();
  expect(usageScopeVersion({ ...config, publicVersionGroups: ["1.2"] })).toBe(
    usageScopeVersion(config),
  );
  expect(
    usageScopeVersion({
      ...config,
      endpoint: "https://other.example.com/v1/usage/daily-aggregate",
    }),
  ).not.toBe(usageScopeVersion(config));
  expect(
    usageScopeVersion({ ...config, disclosure: { ...config.disclosure, retentionMonths: 12 } }),
  ).not.toBe(usageScopeVersion(config));
});
