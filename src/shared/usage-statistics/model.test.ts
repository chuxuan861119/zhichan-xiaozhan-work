import { expect, test } from "vitest";
import { durationBucket } from "./model.js";

test("duration boundaries use foreground time and ignore zero", () => {
  expect(
    [0, 1, 59_999, 60_000, 300_000, 900_000, 1_800_000, 3_600_000].map(durationBucket),
  ).toEqual([null, "lt_1m", "lt_1m", "m1_5", "m5_15", "m15_30", "m30_60", "ge_60m"]);
});

import {
  DailyAggregateSchema,
  emptyBuckets,
  safeDurationDistribution,
  shanghaiDay,
} from "./model.js";

test("strict payload rejects identifiers, unknown bins and excessive session counts", () => {
  const payload = {
    schema_version: 1,
    day: "2026-10-05",
    version_group: "1.1",
    active_installation_days: 1,
    duration_buckets: { ...emptyBuckets(), m1_5: 1 },
  };
  expect(DailyAggregateSchema.safeParse(payload).success).toBe(true);
  expect(DailyAggregateSchema.safeParse({ ...payload, installation_id: "id" }).success).toBe(false);
  expect(
    DailyAggregateSchema.safeParse({
      ...payload,
      duration_buckets: { ...payload.duration_buckets, seconds: 10 },
    }).success,
  ).toBe(false);
  expect(
    DailyAggregateSchema.safeParse({
      ...payload,
      duration_buckets: { ...emptyBuckets(), lt_1m: 1024, m1_5: 1 },
    }).success,
  ).toBe(false);
  expect(DailyAggregateSchema.safeParse({ ...payload, day: "2026-02-30" }).success).toBe(false);
});

test("low samples publish only one complete safe hierarchy", () => {
  expect(safeDurationDistribution([2, 8, 0, 0, 0, 0])).toEqual({
    labels: ["不足5分钟", "5–30分钟", "30分钟以上"],
    counts: [10, 0, 0],
  });
  expect(safeDurationDistribution([1, 0, 0, 0, 0, 0])).toBeNull();
  expect(safeDurationDistribution([10, 10, 10, 10, 10, 10])?.counts).toHaveLength(6);
  expect(shanghaiDay(Date.parse("2026-10-05T16:00:00Z"))).toBe("2026-10-06");
});
