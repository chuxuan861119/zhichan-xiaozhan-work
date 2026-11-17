// @vitest-environment node
import { expect, test } from "vitest";
import { DailyAggregateSchema, emptyBuckets } from "./model.js";

test.each(["windows", "macos", "harmonyos"])(
  "protocol 2 preserves the %s release identity and rejects identifiers",
  (platform) => {
    const payload = {
      schema_version: 2,
      day: "2026-10-16",
      platform,
      app_version: "1.2.3",
      release_channel: "stable",
      active_installation_days: 1,
      duration_buckets: { ...emptyBuckets(), m1_5: 1 },
    };
    expect(DailyAggregateSchema.parse(payload)).toEqual(payload);
    for (const invalid of [
      { platform: "linux" },
      { app_version: "1.2" },
      { app_version: "1.2.3-private" },
      { release_channel: "arbitrary" },
      { device_id: "no" },
      { version_group: "1.2" },
    ]) {
      expect(DailyAggregateSchema.safeParse({ ...payload, ...invalid }).success).toBe(false);
    }
  },
);
