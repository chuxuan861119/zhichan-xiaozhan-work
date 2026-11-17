// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { softwareUpdateConfig } from "./update-config.js";

afterEach(() => vi.unstubAllEnvs());
test("open-source builds do not consume the official binary update channel", () => {
  expect(softwareUpdateConfig(true)).toEqual({
    feedUrl: "",
    downloadOrigins: [],
    channel: "preview",
  });
  expect(softwareUpdateConfig(false).feedUrl).toBe("");
});
test("packaged builds ignore environment overrides; isolated tests accept only local TLS", () => {
  const production = softwareUpdateConfig(true);
  vi.stubEnv("PATENT_WORKBENCH_TEST", "1");
  vi.stubEnv("PATENT_WORKBENCH_UPDATE_TEST_FEED", "https://127.0.0.1:9443/stable.json");
  expect(softwareUpdateConfig(true)).toEqual(production);
  expect(softwareUpdateConfig(false).downloadOrigins).toEqual(["https://127.0.0.1:9443"]);
  for (const url of [
    "https://example.com/feed",
    "http://localhost/feed",
    "https://user:pass@localhost/feed",
  ]) {
    vi.stubEnv("PATENT_WORKBENCH_UPDATE_TEST_FEED", url);
    expect(() => softwareUpdateConfig(false)).toThrow();
  }
});
