// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type DailyAggregate, emptyBuckets } from "../../shared/usage-statistics/model.js";
import type { UsageConfig } from "./usage-statistics-config.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";

const config: UsageConfig = {
  endpoint: "https://statistics.example.com/v1/usage/daily-aggregate",
  noticeVersion: "test-1",
  acceptedPlatforms: ["darwin"],
  publicVersionGroups: ["1.1"],
  releaseChannel: "stable",
  releases: [],
  disclosure: {
    operator: "测试主体",
    contact: "测试联系方式",
    recipient: "测试接收方",
    region: "测试地域",
    retentionMonths: 18,
    securityLogNotice: "测试说明",
  },
};
const services: UsageStatisticsService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.useRealTimers();
});
async function fixture(
  options: {
    root?: string;
    available?: boolean;
    send?: (payload: DailyAggregate, signal: AbortSignal) => Promise<number>;
    write?: (value: string) => Promise<void>;
    start?: number;
    versionGroup?: string;
    noticeVersion?: string;
    platform?: string;
  } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "usage-statistics-")));
  let wall = options.start ?? Date.parse("2026-10-05T12:00:00+08:00");
  let mono = 0;
  let active = true;
  const send = options.send ?? vi.fn(async () => 204);
  const service = new UsageStatisticsService({
    statePath: join(root, "usage-statistics.json"),
    versionGroup: options.versionGroup ?? "1.1",
    appVersion: `${options.versionGroup ?? "1.1"}.0`,
    platform: options.platform ?? "darwin",
    config: {
      ...config,
      acceptedPlatforms: ["darwin", "win32"],
      noticeVersion: options.noticeVersion ?? config.noticeVersion,
      publicVersionGroups: ["1.1", "1.2"],
      releases: ["windows", "macos"].flatMap((platform) =>
        ["1.1.0", "1.2.0"].map((version) => ({ platform, version, channel: "stable" })),
      ) as UsageConfig["releases"],
    },
    allowed: options.available ?? true,
    foreground: () => active,
    clock: () => ({ wall, mono }),
    send,
    jitterMs: () => 0,
    ...(options.write ? { write: options.write } : {}),
  });
  services.push(service);
  await service.read();
  const step = async (milliseconds: number, focused = active) => {
    wall += milliseconds;
    mono += milliseconds;
    active = focused;
    await service.observe(active);
  };
  const run = async (milliseconds: number) => {
    for (let remaining = milliseconds; remaining > 0; remaining -= 30_000)
      await step(Math.min(remaining, 30_000));
  };
  return {
    service,
    root,
    send,
    step,
    run,
    jump: async (delta: number) => {
      wall += delta;
      await service.observe(active);
    },
    stored: async () => JSON.parse(await readFile(join(root, "usage-statistics.json"), "utf8")),
  };
}
async function waitReport(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(async () => {
    expect((await f.service.read()).lastAttempt?.result).not.toBeUndefined();
    expect((await f.service.read()).lastAttempt?.result).not.toBe("attempted");
  });
}

test("new installations are opted out; unopened channel never collects", async () => {
  const f = await fixture();
  expect((await f.service.read()).enabled).toBe(false);
  expect((await f.service.read()).status).toBe("disabled");
  await f.run(180_000);
  expect((await f.stored()).current).toBeNull();
  expect(f.send).not.toHaveBeenCalled();
  const unavailable = await fixture({ available: false });
  await unavailable.service.choose({ enabled: true, noticeVersion: "test-1" });
  await unavailable.run(180_000);
  expect((await unavailable.stored()).current).toBeNull();
});

test("only new Windows profiles default on; saved opt-outs and other platforms stay off", async () => {
  const f = await fixture({ platform: "win32" });
  expect(await f.service.read()).toMatchObject({ enabled: true, accepted: false });
  await f.run(90_000);
  expect((await f.stored()).current).toBeNull();
  await f.service.choose({ enabled: false });
  const again = await fixture({ root: f.root, platform: "win32" });
  expect((await again.service.read()).enabled).toBe(false);
  const mac = await fixture();
  expect((await mac.service.read()).enabled).toBe(false);
});

test("unavailable, unconfirmed and disabled statistics never poll or rewrite on window events", async () => {
  vi.useFakeTimers();
  for (const mode of ["unavailable", "pending", "disabled"]) {
    const write = vi.fn(async (_value: string) => {});
    const f = await fixture({ available: mode !== "unavailable", write });
    if (mode === "disabled") await f.service.choose({ enabled: false });
    write.mockClear();
    f.service.start();
    await f.service.read();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await f.step(30_000, false);
    await f.step(0, true);
    await f.service.close();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }
});

test("background checkpoints skip unchanged writes; active checkpoints keep accumulated time", async () => {
  const write = vi.fn(async (_value: string) => {});
  const f = await fixture({ write });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(30_000, false);
  write.mockClear();
  await f.run(3_600_000);
  expect(write).not.toHaveBeenCalled();
  await f.step(0, true);
  await f.step(30_000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(write.mock.calls[0]?.[0] ?? "").current.openMs).toBe(60_000);
});

test("accepting after start activates polling and opting out cancels it", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.service.start();
  await f.service.read();
  expect(vi.getTimerCount()).toBe(0);
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  expect(vi.getTimerCount()).toBe(1);
  await f.service.choose({ enabled: false });
  expect(vi.getTimerCount()).toBe(0);
  await f.step(30_000);
  expect((await f.stored()).current).toBeNull();
});

test("foreground fragments in one process sum; absence, long sampling gaps and wall jumps do not", async () => {
  const f = await fixture();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(180_000);
  await f.step(0, false);
  await f.step(3_600_000, true);
  await f.run(180_000);
  await f.step(60_000);
  await f.jump(3_600_000);
  await f.service.close();
  expect((await f.stored()).current.buckets).toEqual({ ...emptyBuckets(), m5_15: 1 });
  expect((await f.stored()).current.openMs).toBe(0);
});

test("midnight splits one foreground process and reports yesterday once", async () => {
  const f = await fixture({ start: Date.parse("2026-10-05T23:59:50+08:00") });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(20_000);
  await waitReport(f);
  expect(f.send).toHaveBeenCalledTimes(1);
  const sent = vi.mocked(f.send).mock.calls[0]?.[0];
  expect(sent).toEqual({
    schema_version: 5, notice_version: "2026-10-28.precise-v1", foreground_seconds: 10,
    report_id: expect.any(String),
    day: "2026-10-05",
    platform: "macos",
    app_version: "1.1.0",
    release_channel: "stable",
    active_installation_days: 1,
    duration_buckets: { ...emptyBuckets(), lt_1m: 1 },
  });
  expect((await f.stored()).current.openMs).toBe(10_000);
  await f.service.close();
  const next = await fixture({ root: f.root, start: Date.parse("2026-10-06T10:00:00+08:00") });
  await next.step(30_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(next.send).not.toHaveBeenCalled();
});

test("crash checkpoint seals once and never counts downtime", async () => {
  const f = await fixture();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(180_000);
  const checkpoint = await readFile(join(f.root, "usage-statistics.json"), "utf8");
  await f.service.close();
  await writeFile(join(f.root, "usage-statistics.json"), checkpoint);
  const restart = await fixture({ root: f.root });
  expect((await restart.stored()).current.buckets.m1_5).toBe(1);
  expect((await restart.stored()).current.openMs).toBe(0);
  await restart.service.close();
  const again = await fixture({ root: f.root });
  expect((await again.stored()).current.buckets.m1_5).toBe(1);
});

test("disable clears unsent counts, persists across restart, and aborts an in-flight request", async () => {
  let aborted = false;
  const f = await fixture({
    start: Date.parse("2026-10-05T23:59:50+08:00"),
    send: vi.fn(async (_payload, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return 204;
    }),
  });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(20_000);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  const disabled = await f.service.choose({ enabled: false });
  expect(disabled.status).toBe("disabled");
  expect(aborted).toBe(true);
  await f.run(60_000);
  expect((await f.stored()).current).toBeNull();
  expect((await f.stored()).pending).toEqual([]);
  await f.service.close();
  const next = await fixture({ root: f.root });
  expect((await next.service.read()).enabled).toBe(false);
});

test("failed write prevents sending and keeps withdrawal stopped and honest", async () => {
  let fail = false;
  const f = await fixture({
    write: async () => {
      if (fail) throw new Error("disk");
    },
  });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(60_000);
  fail = true;
  const state = await f.service.choose({ enabled: false });
  expect(state.enabled).toBe(false);
  expect(state.status).toBe("error");
  await f.run(60_000);
  expect(f.send).not.toHaveBeenCalled();
  await expect(f.service.close()).resolves.toBeUndefined();
});

test("corrupt state is not replaced with an accepted default", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-corrupt-"));
  await writeFile(join(root, "usage-statistics.json"), "{bad");
  const f = await fixture({ root });
  expect((await f.service.read()).status).toBe("error");
  await f.run(60_000);
  expect(await readFile(join(root, "usage-statistics.json"), "utf8")).toBe("{bad");
  expect((await f.service.choose({ enabled: false })).status).toBe("disabled");
});

test("withdrawal discards an ambiguous report rather than reviving it when enabled again", async () => {
  const f = await fixture({
    start: Date.parse("2026-10-05T23:59:50+08:00"),
    send: vi.fn(async () => {
      throw new Error("network");
    }),
  });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(20_000);
  await waitReport(f);
  expect((await f.service.read()).lastAttempt?.result).toBe("unknown");
  await f.service.choose({ enabled: false });
  await f.service.choose({ enabled: true });
  await f.step(30_000);
  expect(f.send).toHaveBeenCalledTimes(1);
});

test("same-day restarts count process sessions once and retain the first release group", async () => {
  const f = await fixture();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(180_000);
  await f.service.close();
  const next = await fixture({ root: f.root, versionGroup: "1.2" });
  await next.step(0);
  await next.run(1_200_000);
  await next.service.close();
  const current = (await next.stored()).current;
  expect(current.version).toBe("1.1");
  expect(current.buckets).toEqual({ ...emptyBuckets(), m1_5: 1, m15_30: 1 });
  expect(current.foregroundMs).toBe(1_380_000);
});

test("changed notice expires consent and does not collect new foreground time", async () => {
  const f = await fixture();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.service.close();
  const next = await fixture({ root: f.root, noticeVersion: "test-2" });
  expect((await next.service.read()).accepted).toBe(false);
  await next.run(180_000);
  expect((await next.stored()).current).toBeNull();
  expect(next.send).not.toHaveBeenCalled();
});

test("attempt-marker write failure prevents the request", async () => {
  const f = await fixture({
    start: Date.parse("2026-10-05T23:59:50+08:00"),
    write: async (value) => {
      if (JSON.parse(value).lastAttempt?.result === "attempted")
        throw new Error("fixture disk failure");
    },
  });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(20_000);
  await vi.waitFor(async () => expect((await f.service.read()).status).toBe("error"));
  expect(f.send).not.toHaveBeenCalled();
});

test("withdrawal while the attempt-marker write is pending prevents a later request", async () => {
  let release!: () => void;
  let marking = false;
  const f = await fixture({
    start: Date.parse("2026-10-05T23:59:50+08:00"),
    write: async (value) => {
      if (!marking && JSON.parse(value).lastAttempt?.result === "attempted") {
        marking = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
  });
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.step(20_000);
  await vi.waitFor(() => expect(marking).toBe(true));
  const disabled = f.service.choose({ enabled: false });
  expect(f.service.state().enabled).toBe(false);
  release();
  expect((await disabled).status).toBe("disabled");
  expect(f.send).not.toHaveBeenCalled();
});

test("clock jumps preserve the checkpoint; genuinely expired backlog is dropped after restart", async () => {
  const f = await fixture();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(60_000);
  await f.jump(-86_400_000);
  await f.run(60_000);
  expect((await f.stored()).current.openMs).toBe(60_000);
  await f.jump(10 * 86_400_000);
  expect((await f.service.read()).status).toBe("clock-paused");
  expect((await f.stored()).current.openMs).toBe(60_000);
  await f.service.close();
  const next = await fixture({ root: f.root, start: Date.parse("2026-10-15T12:00:00+08:00") });
  expect((await next.stored()).current).toBeNull();
  expect((await f.stored()).pending).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});

test("agreement gate pauses an existing consent without counting its waiting time", async () => {
  const f = await fixture();
  f.service.start();
  await f.service.choose({ enabled: true, noticeVersion: "test-1" });
  await f.run(60_000);
  f.service.setSessionAllowed(false);
  await f.run(300_000);
  expect(f.send).not.toHaveBeenCalled();
  const paused = (await f.stored()).current;
  f.service.setSessionAllowed(true);
  await f.run(60_000);
  const resumed = (await f.stored()).current;
  expect(resumed.openMs - paused.openMs).toBe(60_000);
});
