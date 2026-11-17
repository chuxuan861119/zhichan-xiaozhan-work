// @vitest-environment node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { APPLICATION_VERSION } from "../../shared/branding.js";
import type { DailyAggregate } from "../../shared/usage-statistics/model.js";
import { usageStatisticsConfig } from "./usage-statistics-config.js";
import { UsageStatisticsService } from "./usage-statistics-service.js";

const services: UsageStatisticsService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-retry-"));
  const statePath = join(root, "usage.json");
  let wall = Date.parse("2026-10-10T12:00:00+08:00"),
    mono = 0;
  let status = 204;
  const sent: DailyAggregate[] = [];
  const config = {
    ...usageStatisticsConfig(),
    endpoint: "https://stats.example.com/v1/usage/daily-aggregate",
    noticeVersion: "retry-test",
    acceptedPlatforms: ["win32" as const],
    releases: [
      { platform: "windows" as const, version: APPLICATION_VERSION, channel: "preview" as const },
    ],
  };
  const make = () => {
    const service = new UsageStatisticsService({
      statePath,
      versionGroup: "1.1",
      appVersion: APPLICATION_VERSION,
      platform: "win32",
      config,
      allowed: true,
      foreground: () => true,
      send: async (payload) => {
        sent.push(payload);
        if (status === 0) throw Error("offline");
        return status;
      },
      jitterMs: () => 0,
      clock: () => ({ wall, mono }),
    });
    services.push(service);
    return service;
  };
  const first = make();
  await first.choose({ enabled: true, noticeVersion: config.noticeVersion });
  for (let i = 0; i < 4; i++) {
    wall += 30000;
    mono += 30000;
    await first.observe(true);
  }
  await first.close();
  return {
    make,
    first,
    sent,
    statePath,
    setStatus: (value: number) => {
      status = value;
    },
    reopenOn: (day: string) => {
      wall = Date.parse(`${day}T12:00:00+08:00`);
      mono = 0;
    },
    step: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    stored: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}
test("reopening after several days reports a durable contribution instead of dropping it", async () => {
  const f = await fixture();
  f.reopenOn("2026-10-13");
  const next = f.make();
  await next.read();
  await next.observe(true);
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent[0]).toMatchObject({
    schema_version: 5,
    notice_version: "2026-10-28.precise-v1",
    day: "2026-10-10",
    platform: "windows",
  });
  expect((f.sent[0] as { report_id?: string }).report_id).toMatch(/^[0-9a-f-]{36}$/);
});
test("offline and ambiguous responses retry the same report after restart without changing its credential", async () => {
  const f = await fixture();
  f.setStatus(0);
  f.reopenOn("2026-10-11");
  let next = f.make();
  await next.read();
  await next.observe(true);
  await vi.waitFor(async () => expect((await next.read()).lastAttempt?.result).toBe("unknown"));
  const id = (f.sent[0] as { report_id?: string }).report_id;
  expect(id).toBeTruthy();
  await next.close();
  f.setStatus(204);
  f.step(3600000);
  next = f.make();
  await next.read();
  await next.observe(true);
  await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  expect((f.sent[1] as { report_id?: string }).report_id).toBe(id);
  await vi.waitFor(async () => expect((await f.stored()).pending).toHaveLength(0));
});
test("withdrawal clears the complete outbox and restart cannot send it", async () => {
  const f = await fixture();
  f.setStatus(503);
  f.reopenOn("2026-10-11");
  const next = f.make();
  await next.read();
  await next.observe(true);
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  await next.choose({ enabled: false });
  expect((await f.stored()).pending).toEqual([]);
  await next.close();
  f.step(3600000);
  const again = f.make();
  await again.read();
  await again.observe(true);
  expect((await again.read()).enabled).toBe(false);
  expect(f.sent).toHaveLength(1);
});

test("clock rollback preserves a pending report and does not send a future-dated report", async () => {
  const f = await fixture();
  f.setStatus(503);
  f.reopenOn("2026-10-11");
  const next = f.make();
  await next.read();
  expect((await f.stored()).pending).toHaveLength(1);
  f.reopenOn("2026-10-10");
  await next.observe(true);
  expect((await f.stored()).pending).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 40));
  expect(f.sent).toHaveLength(0);
  await next.close();
  f.reopenOn("2026-10-11");
  const recovered = f.make();
  await recovered.read();
  f.setStatus(204);
  await recovered.observe(true);
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
});

test("a live forward date jump pauses without expiring counts and recovers after correction", async () => {
  const f = await fixture();
  f.reopenOn("2026-10-10");
  const next = f.make();
  await next.read();
  await next.observe(true);
  f.reopenOn("2026-11-10");
  await next.observe(true);
  expect((await next.read()).message).toContain("时间");
  expect((await f.stored()).current.day).toBe("2026-10-10");
  f.reopenOn("2026-10-10");
  await next.observe(true);
  f.step(30_000);
  await next.observe(true);
  expect((await f.stored()).current.openMs).toBe(30_000);
  expect((await next.read()).status).toBe("participating");
});

test("a legacy future watermark cannot prevent collecting after corrected-date restart", async () => {
  const f = await fixture();
  const stored = await f.stored();
  stored.highestDay = "2026-11-10";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.statePath, JSON.stringify(stored));
  const next = f.make();
  await next.read();
  await next.observe(true);
  f.step(30_000);
  await next.observe(true);
  expect((await f.stored()).current.openMs).toBe(30_000);
});

test("acknowledged dates cannot be collected again after a corrected-date restart", async () => {
  const f = await fixture();
  f.reopenOn("2026-10-11");
  const next = f.make();
  await next.read();
  await next.observe(true);
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  await vi.waitFor(async () => expect((await f.stored()).pending).toHaveLength(0));
  await next.close();
  f.reopenOn("2026-10-10");
  const previous = f.make();
  await previous.read();
  await previous.observe(true);
  f.step(30000);
  await previous.observe(true);
  expect((await f.stored()).current).toBeNull();
  expect(f.sent).toHaveLength(1);
});

test("inactive overnight intervals resume without counting sleep or remaining clock-paused", async () => {
  const f = await fixture();
  const next = f.make();
  await next.read();
  await next.observe(false);
  f.reopenOn("2026-10-11");
  await next.observe(true);
  f.step(30000);
  await next.observe(true);
  expect((await f.stored()).current.openMs).toBe(30000);
  expect((await next.read()).status).toBe("participating");
});
