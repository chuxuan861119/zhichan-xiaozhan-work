// @vitest-environment node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { emptyBuckets } from "../../src/shared/usage-statistics/model.js";
import { createUsageReceiver } from "./server.js";
import { UsageStore } from "./store.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const payload = (version = "1.1", buckets = { ...emptyBuckets(), m1_5: 1 }) => ({
  schema_version: 1 as const,
  day: "2026-10-05",
  version_group: version,
  active_installation_days: 1 as const,
  duration_buckets: buckets,
});
test("admin reports publish only closed windows and preserve the frozen privacy view", async () => {
  const f = await fixture();
  f.store.accept(payload());
  expect(f.store.readySnapshots("2026-10-06", "all")).toEqual([]);
  const snapshots = f.store.readySnapshots("2026-10-07", "all");
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.groups[0]?.activeInstallationDays).toBeNull();
  expect(snapshots[0]?.groups[0]?.duration).toBeNull();
  expect(f.store.readySnapshots("2026-10-07", "versions")).toEqual(snapshots);
});
async function fixture(limit = 600) {
  const root = await mkdtemp(join(tmpdir(), "usage-server-"));
  const path = join(root, "usage.sqlite");
  const store = new UsageStore(path);
  cleanups.push(() => store.close());
  const server = createUsageReceiver({
    acceptLegacy: true, // Historical protocol fixtures only; production rejects these payloads.
    store,
    publicVersionGroups: ["1.1", "1.2"],
    clock: () => Date.parse("2026-10-06T12:00:00+08:00"),
    requestsPerMinute: limit,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  // Windows can assign an ephemeral port on Fetch's forbidden-port list.
  // Rebind that fixture rather than silently skipping the real HTTP checks.
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = server.address();
    if (!probe || typeof probe === "string") throw new Error("address");
    try {
      await fetch(`http://127.0.0.1:${probe.port}/v1/usage/daily-aggregate`);
      break;
    } catch (error) {
      if (
        (error as { cause?: { message?: string } }).cause?.message !== "bad port" ||
        attempt === 9
      )
        throw error;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    }
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const url = `http://127.0.0.1:${address.port}/v1/usage/daily-aggregate`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { store, path, url, post };
}
test("real HTTP validates protocol, date, version, size, method and request budget", async () => {
  const f = await fixture();
  expect((await f.post(payload())).status).toBe(204);
  for (const invalid of [
    { ...payload(), id: "no" },
    { ...payload(), day: "2026-10-06" },
    payload("9.9"),
    { ...payload(), padding: "x".repeat(2500) },
  ])
    expect((await f.post(invalid)).status).toBe(400);
  expect((await fetch(f.url)).status).toBe(404);
  expect((await fetch(`${f.url}?id=x`, { method: "POST" })).status).toBe(404);
  const limited = await fixture(1);
  expect((await limited.post(payload())).status).toBe(204);
  expect((await limited.post(payload())).status).toBe(429);
});
test("legacy requests retain their historical aggregates and D+2 snapshots", async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.post(payload())));
  expect(responses.map((response) => response.status)).toEqual(Array(10).fill(204));
  expect(() => f.store.publish("2026-10-05", "2026-10-06", "all")).toThrow();
  const snapshot = f.store.publish("2026-10-05", "2026-10-07", "all");
  expect(snapshot.groups[0]?.activeInstallationDays).toBe(10);
  expect(snapshot.groups[0]?.duration?.counts).toEqual([0, 10, 0, 0, 0, 0]);
  expect(() => f.store.publish("2026-10-05", "2026-10-07", "versions")).toThrow();
  const db = new DatabaseSync(f.path);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  ).toEqual([
    { name: "daily_activity" },
    { name: "daily_duration" },
    { name: "daily_snapshot" },
    { name: "preview_activity" },
    { name: "preview_duration" },
    { name: "preview_snapshot" },
    { name: "release_activity" },
    { name: "release_duration" },
    { name: "reporting_window" },
    { name: "usage_receipt" },
    { name: "usage_reception" },
  ]);
  db.close();
});
test("transaction failure rolls back activity and buckets; HTTP returns unavailable", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  db.exec(
    "CREATE TRIGGER reject_bins BEFORE INSERT ON daily_duration BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
  );
  expect((await f.post(payload())).status).toBe(503);
  expect(db.prepare("SELECT COUNT(*) AS count FROM daily_activity").get()).toEqual({ count: 0 });
  db.close();
});
test("snapshot never discloses suppressed totals or a complementary version", async () => {
  const f = await fixture();
  f.store.accept(payload("1.1", { ...emptyBuckets(), lt_1m: 2, m1_5: 8 }));
  const snapshot = f.store.publish("2026-10-05", "2026-10-07", "all");
  expect(snapshot.groups[0]?.activeInstallationDays).toBeNull();
  expect(snapshot.groups[0]?.duration).toBeNull();
  expect(JSON.stringify(snapshot)).not.toContain('"1.1"');
  expect(JSON.stringify(snapshot)).not.toContain('"total"');
});
test("duration needs ten active contributions in both aggregate and version views", async () => {
  const small = await fixture();
  small.store.accept(payload("1.1", { ...emptyBuckets(), m1_5: 10 }));
  const below = small.store.publish("2026-10-05", "2026-10-07", "versions");
  expect(below.groups[0]).toMatchObject({ activeInstallationDays: null, duration: null });

  const mixed = await fixture();
  for (let index = 0; index < 9; index++) mixed.store.accept(payload("1.1"));
  mixed.store.accept(payload("1.2", { ...emptyBuckets(), m1_5: 10 }));
  const versions = mixed.store.publish("2026-10-05", "2026-10-07", "versions");
  expect(versions.groups.every((group) => group.duration === null)).toBe(true);

  const enough = await fixture();
  for (let index = 0; index < 10; index++) enough.store.accept(payload());
  expect(enough.store.publish("2026-10-05", "2026-10-07", "versions").groups[0]).toMatchObject({
    activeInstallationDays: 10,
    duration: { counts: [0, 10, 0, 0, 0, 0] },
  });
});
test("reading an older frozen snapshot also hides duration below the active floor", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  const old = {
    day: "2026-10-05",
    view: "all",
    metric: "参与统计的活跃安装贡献",
    notice: "旧版测试快照",
    groups: [
      {
        version: "全部版本",
        activeInstallationDays: null,
        duration: { labels: ["不足5分钟"], counts: [10] },
      },
    ],
  };
  db.prepare("INSERT INTO daily_snapshot VALUES (?,?,?)").run(
    old.day,
    old.view,
    JSON.stringify(old),
  );
  expect(f.store.snapshot(old.day)?.groups[0]?.duration).toBeNull();
  expect(f.store.snapshot(old.day)?.groups[0]?.activeInstallationDays).toBeNull();
  expect(f.store.publish(old.day, "2026-10-07", "all").groups[0]?.duration).toBeNull();
  expect(db.prepare("SELECT body FROM daily_snapshot WHERE day=?").get(old.day)).toEqual({
    body: JSON.stringify(old),
  });
  db.close();
});
test("retention deletes aggregates and published snapshots by Shanghai calendar month", async () => {
  const f = await fixture();
  f.store.accept({ ...payload(), day: "2025-04-04" });
  f.store.accept({ ...payload(), day: "2025-04-05" });
  f.store.publish("2025-04-04", "2026-10-05", "all");
  f.store.publish("2025-04-05", "2026-10-05", "all");
  f.store.prune("2026-10-05", 18);
  expect(f.store.snapshot("2025-04-04")).toBeNull();
  expect(f.store.snapshot("2025-04-05")).not.toBeNull();
});
