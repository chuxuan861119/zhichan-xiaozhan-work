// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { type DailyAggregate, emptyBuckets } from "../../shared/usage-statistics/model.js";
import {
  type UsageConfig,
  usageConfigAvailable,
  usageStatisticsConfig,
} from "./usage-statistics-config.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";

const config: UsageConfig = {
  ...usageStatisticsConfig(),
  endpoint: "https://statistics.example.com/v1/usage/daily-aggregate",
  noticeVersion: "v2-test",
  releaseChannel: "stable" as const,
  acceptedPlatforms: ["win32", "darwin", "openharmony"] as Array<
    "win32" | "darwin" | "openharmony"
  >,
  releases: (["windows", "macos", "harmonyos"] as const).flatMap((platform) =>
    ["1.2.3", "1.2.4"].map((version) => ({ platform, version, channel: "stable" as const })),
  ),
  disclosure: {
    operator: "测试主体",
    contact: "测试联系",
    recipient: "测试接收",
    region: "测试地域",
    retentionMonths: 18,
    securityLogNotice: "测试日志",
  },
};

test("release gates require the exact platform, patch version and channel", () => {
  expect(usageConfigAvailable(config as never, "win32", "1.2.3")).toBe(true);
  expect(usageConfigAvailable(config as never, "ohos", "1.2.3")).toBe(true);
  expect(usageConfigAvailable(config as never, "linux", "1.2.3")).toBe(false);
  expect(usageConfigAvailable(config as never, "darwin", "1.2.5")).toBe(false);
  expect(
    usageConfigAvailable({ ...config, releaseChannel: "preview" } as never, "darwin", "1.2.3"),
  ).toBe(false);
});

test.each(["win32", "darwin", "openharmony", "ohos"])(
  "%s sends full release metadata once and retains first same-day version",
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "usage-v2-"));
    const statePath = join(root, "usage-statistics.json");
    let wall = Date.parse("2026-10-16T23:59:00+08:00"),
      mono = 0;
    const send = vi.fn(async (_payload: DailyAggregate, _signal: AbortSignal) => 204);
    const make = (appVersion: string) =>
      new UsageStatisticsService({
        statePath,
        versionGroup: "1.2",
        appVersion,
        platform,
        config: config as never,
        allowed: true,
        foreground: () => true,
        send,
        jitterMs: () => 0,
        clock: () => ({ wall, mono }),
      });
    const first = make("1.2.3");
    let next: UsageStatisticsService | undefined;
    try {
      await first.choose({ enabled: true, noticeVersion: "v2-test" });
      wall += 20_000;
      mono += 20_000;
      await first.observe(true);
      await first.close();
      next = make("1.2.4");
      await next.read();
      await next.observe(true);
      for (let i = 0; i < 3; i++) {
        wall += 20_000;
        mono += 20_000;
        await next.observe(true);
      }
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        schema_version: 5, notice_version: "2026-10-28.precise-v1",
        day: "2026-10-16",
        platform: platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "harmonyos",
        app_version: "1.2.3",
        release_channel: "stable",
      });
      expect(send.mock.calls[0]?.[0]).not.toHaveProperty("version_group");
      expect(JSON.parse(await readFile(statePath, "utf8")).current.appVersion).toBe("1.2.4");
    } finally {
      await first.close();
      await next?.close();
    }
  },
);

test("legacy local counts are not relabelled; disabled choice and attempt watermarks survive migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-v1-migrate-"));
  const statePath = join(root, "usage-statistics.json");
  await writeFile(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      acceptedNotice: "old",
      highestDay: "2026-10-16",
      current: {
        day: "2026-10-16",
        version: "1.2",
        buckets: { ...emptyBuckets(), m1_5: 3 },
        openMs: 1234,
      },
      yesterday: null,
      lastAttempt: { day: "2026-10-15", result: "received" },
    }),
  );
  const service = new UsageStatisticsService({
    statePath,
    versionGroup: "1.2",
    appVersion: "1.2.3",
    platform: "darwin",
    config: config as never,
    allowed: true,
    foreground: () => true,
    send: vi.fn(),
    clock: () => ({ wall: Date.parse("2026-10-16T12:00:00+08:00"), mono: 0 }),
  });
  try {
    expect((await service.read()).enabled).toBe(false);
    const stored = JSON.parse(await readFile(statePath, "utf8"));
    expect(stored.schemaVersion).toBe(3);
    expect(stored.current).toBeNull();
    expect(stored.lastAttempt.day).toBe("2026-10-15");
    expect((await service.read()).accepted).toBe(false);
  } finally {
    await service.close();
  }
});

test("Harmony drops an interval ending with a locked or unconfirmed native state", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-harmony-interval-"));
  const statePath = join(root, "usage-statistics.json");
  let wall = Date.parse("2026-10-16T12:00:00+08:00");
  let mono = 0;
  const service = new UsageStatisticsService({
    statePath,
    versionGroup: "1.2",
    appVersion: "1.2.3",
    platform: "openharmony",
    config,
    allowed: true,
    foreground: () => true,
    send: vi.fn(),
    clock: () => ({ wall, mono }),
  });
  try {
    await service.choose({ enabled: true, noticeVersion: "v2-test" });
    for (const active of [true, false, true, true]) {
      wall += 20_000;
      mono += 20_000;
      await service.observe(active);
    }
    expect(JSON.parse(await readFile(statePath, "utf8")).current.openMs).toBe(40_000);
  } finally {
    await service.close();
  }
});
