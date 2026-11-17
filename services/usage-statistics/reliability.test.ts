// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { type DailyAggregate, emptyBuckets } from "../../src/shared/usage-statistics/model.js";
import { createUsageReceiver } from "./server.js";
import { UsageStore } from "./store.js";

const dispose: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of dispose.splice(0).reverse()) await fn();
});
const contribution = (extra = {}) => ({
  schema_version: 3,
  report_id: randomUUID(),
  day: "2026-10-10",
  platform: "windows",
  app_version: "1.1.2",
  release_channel: "preview",
  active_installation_days: 1,
  duration_buckets: { ...emptyBuckets(), m1_5: 1 },
  ...extra,
});
async function fixture(limit = 300) {
  const root = await mkdtemp(join(tmpdir(), "usage-reliability-"));
  const path = join(root, "usage.sqlite"),
    store = new UsageStore(path);
  dispose.push(() => store.close());
  const server = createUsageReceiver({
    store,
    publicVersionGroups: [],
    releases: [{ platform: "windows", version: "1.1.2", channel: "preview" }],
    acceptLegacy: false,
    requestsPerMinute: limit,
    clock: () => Date.parse("2026-10-17T12:00:00+08:00"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  dispose.push(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/usage/daily-aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const raw = new DatabaseSync(path);
  dispose.push(() => raw.close());
  return { store, raw, post, path };
}
test("v3 replays commit exactly once, including concurrent submissions and receiver restarts", async () => {
  const f = await fixture();
  const body = contribution();
  expect((await f.post(body)).status).toBe(204);
  expect((await f.post({ ...body, report_id: body.report_id.toUpperCase() })).status).toBe(204);
  const repeats = await Promise.all(Array.from({ length: 10 }, () => f.post(body)));
  expect(repeats.map((r) => r.status)).toEqual(Array(10).fill(204));
  expect(
    f.raw.prepare("SELECT SUM(active_installation_days) AS n FROM release_activity").get(),
  ).toEqual({ n: 1 });
  const restartedStore = new UsageStore(f.path);
  expect(restartedStore.accept(body as DailyAggregate)).toBe("duplicate");
  restartedStore.close();
  expect(
    (await f.post({ ...body, duration_buckets: { ...emptyBuckets(), m5_15: 1 } })).status,
  ).toBe(409);
  expect(
    f.raw.prepare("SELECT SUM(active_installation_days) AS n FROM release_activity").get(),
  ).toEqual({ n: 1 });
});
test("distinct anonymous credentials preserve legitimate identical contributions; diagnostics expose no totals", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) expect((await f.post(contribution())).status).toBe(204);
  const snapshot = f.store.publish("2026-10-10", "2026-10-18", "releases");
  expect(snapshot.groups[0]?.activeInstallationDays).toBe(10);
  const health = f.store.receptionHealth("2026-10-17");
  expect(health.lastReceivedDay).toBe("2026-10-17");
  expect(health.outcomes.some((row) => "count" in row)).toBe(false);
  expect(JSON.stringify(health)).not.toMatch(/report_id|receipt_hash|payload_hash/);
});
test("v3 accepts the whole seven-day window, rejects today/expired days and old identity-free payloads", async () => {
  const f = await fixture();
  expect((await f.post(contribution())).status).toBe(204);
  expect((await f.post(contribution({ day: "2026-10-16" }))).status).toBe(204);
  for (const day of ["2026-10-09", "2026-10-17", "2026-10-18"])
    expect((await f.post(contribution({ day }))).status).toBe(400);
  const { report_id: _ignored, ...old } = contribution();
  expect((await f.post({ ...old, schema_version: 2 })).status).toBe(400);
  expect((await f.post(contribution({ device_id: "forbidden" }))).status).toBe(400);
});
test("v3 snapshots freeze only on D+8 and receipts cannot modify already frozen dates", async () => {
  const f = await fixture();
  expect((await f.post(contribution())).status).toBe(204);
  expect(f.store.readySnapshots("2026-10-17", "releases")).toEqual([]);
  expect(() => f.store.publish("2026-10-10", "2026-10-17", "releases")).toThrow();
  const snapshot = f.store.publish("2026-10-10", "2026-10-18", "releases");
  expect(snapshot.groups[0]?.activeInstallationDays).toBeNull();
  expect((await f.post(contribution())).status).toBe(410);
  expect(f.store.snapshot("2026-10-10")).toEqual(snapshot);
});
test("receipt, reporting window and aggregates roll back together on failure", async () => {
  const f = await fixture();
  f.raw.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON usage_receipt BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  const body = contribution();
  expect((await f.post(body)).status).toBe(503);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM release_activity").get()).toEqual({ n: 0 });
  f.raw.exec("DROP TRIGGER reject_receipt");
  expect((await f.post(body)).status).toBe(204);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM release_activity").get()).toEqual({ n: 1 });
});
test("short-lived receipts are pruned without deleting the D+8 window or aggregate", async () => {
  const f = await fixture();
  expect((await f.post(contribution())).status).toBe(204);
  f.store.prune("2026-10-18", 18);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM usage_receipt").get()).toEqual({ n: 0 });
  expect(f.store.readySnapshots("2026-10-18", "releases")).toHaveLength(1);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM release_activity").get()).toEqual({ n: 1 });
});
test("requests beyond the budget do not create an unbounded stream of diagnostic writes", async () => {
  const f = await fixture(1);
  expect((await f.post(contribution())).status).toBe(204);
  for (let i = 0; i < 20; i++) expect((await f.post(contribution())).status).toBe(429);
  expect(
    f.raw.prepare("SELECT count FROM usage_reception WHERE outcome='rate_limited'").get(),
  ).toEqual({ count: 1 });
});

test("consented v4 reports show next-day ranges, cache for the day, then freeze exactly", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++)
    expect((await f.post(contribution({ schema_version: 4, day: "2026-10-16" }))).status).toBe(204);
  const early = f.store.reports("2026-10-17", "releases")[0]!;
  expect(early.status).toBe("provisional");
  expect(early.finalizesOn).toBe("2026-10-24");
  expect(early.groups[0]!.activeInstallationDays).toBeNull();
  expect(early.groups[0]!.activeRange).toEqual([10, 19]);
  expect(early.groups[0]!.duration).toBeNull();
  expect(early.groups[0]!.durationRanges!.ranges).toEqual([
    [10, 19],
    [0, 0],
  ]);
  for (let i = 0; i < 10; i++) await f.post(contribution({ schema_version: 4, day: "2026-10-16" }));
  expect(f.store.reports("2026-10-17", "releases")[0]).toEqual(early);
  expect(f.store.reports("2026-10-18", "releases")[0]!.groups[0]!.activeRange).toEqual([20, 29]);
  const final = f.store.reports("2026-10-24", "releases")[0]!;
  expect(final.status).toBe("final");
  expect(final.groups[0]!.activeInstallationDays).toBe(22);
  expect(final.groups[0]!.activeRange).toBeUndefined();
});

test("old consent remains fixed-only; provisional reports never leak tiny cells or raw counts", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++) await f.post(contribution({ day: "2026-10-16" }));
  expect(f.store.reports("2026-10-17", "releases")).toEqual([]);
  await f.post(contribution({ schema_version: 4, day: "2026-10-16" }));
  const early = f.store.reports("2026-10-17", "releases")[0]!;
  expect(early.groups[0]!.activeRange).toBeNull();
  expect(early.groups[0]!.activeInstallationDays).toBeNull();
  expect(early.groups[0]!.durationRanges).toBeNull();
  expect(f.store.reports("2026-10-24", "releases")[0]!.groups[0]!.activeInstallationDays).toBe(13);
});

test("provisional cache survives restart and suppresses an entire sparse duration split", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++)
    await f.post(
      contribution({
        schema_version: 4,
        day: "2026-10-16",
        duration_buckets: { ...emptyBuckets(), [i === 0 ? "ge_60m" : "m1_5"]: 1 },
      }),
    );
  const first = f.store.reports("2026-10-17", "releases")[0]!;
  expect(first.groups[0]!.activeRange).toEqual([10, 19]);
  expect(first.groups[0]!.durationRanges).toBeNull();
  const reopened = new UsageStore(f.path);
  expect(reopened.reports("2026-10-17", "releases")[0]).toEqual(first);
  reopened.prune("2026-10-24", 18);
  expect(reopened.reports("2026-10-24", "releases")[0]!.groups[0]!.activeInstallationDays).toBe(12);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM preview_snapshot").get()).toEqual({ n: 0 });
  reopened.close();
});
