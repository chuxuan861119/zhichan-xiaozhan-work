// @vitest-environment node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { type DailyAggregate, emptyBuckets } from "../../src/shared/usage-statistics/model.js";
import { createUsageReceiver } from "./server.js";
import { UsageStore } from "./store.js";

const payload = (platform = "windows", version = "1.2.3", channel = "stable") =>
  ({
    schema_version: 2,
    day: "2026-10-16",
    platform,
    app_version: version,
    release_channel: channel,
    active_installation_days: 1,
    duration_buckets: { ...emptyBuckets(), m1_5: 1 },
  }) as DailyAggregate;

test("receiver accepts exactly released platform/version/channel tuples over real HTTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-releases-http-"));
  const store = new UsageStore(join(dir, "usage.sqlite"));
  const releases = ["windows", "macos", "harmonyos"].map((platform) => ({
    platform,
    version: "1.2.3",
    channel: "stable",
  }));
  const server = createUsageReceiver({
    acceptLegacy: true, // Explicit historical protocol coverage.
    store,
    publicVersionGroups: [],
    releases: releases as never,
    clock: () => Date.parse("2026-10-17T12:00:00+08:00"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/usage/daily-aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const platform of ["windows", "macos", "harmonyos"])
      expect((await post(payload(platform))).status).toBe(204);
    for (const body of [
      payload("linux"),
      payload("windows", "1.2.4"),
      payload("windows", "1.2.3", "preview"),
      { ...payload(), device_id: "no" },
    ])
      expect((await post(body)).status).toBe(400);
    expect(store.readySnapshots("2026-10-17", "releases")).toEqual([]);
    const groups = store.readySnapshots("2026-10-18", "releases")[0]?.groups;
    expect(groups).toHaveLength(3);
    expect(groups?.every((g) => g.activeInstallationDays === null && g.duration === null)).toBe(
      true,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("release snapshots separate patch versions, platforms and channels without complementary totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-releases-store-"));
  const store = new UsageStore(join(dir, "usage.sqlite"));
  try {
    for (let i = 0; i < 10; i++) {
      store.accept(payload());
      store.accept(payload("macos"));
      store.accept(payload("windows", "1.2.4"));
    }
    store.accept(payload("harmonyos", "1.2.3", "preview"));
    const snap = store.publish("2026-10-16", "2026-10-18", "releases");
    expect(snap.groups).toHaveLength(4);
    expect(snap.groups.filter((g) => g.activeInstallationDays === 10)).toHaveLength(3);
    expect(snap.groups.find((g) => g.platform === "harmonyos")).toMatchObject({
      version: "1.2.3",
      channel: "preview",
      activeInstallationDays: null,
      duration: null,
    });
    expect(snap.groups.map((g) => g.platform).sort()).toEqual([
      "harmonyos",
      "macos",
      "windows",
      "windows",
    ]);
    expect(() => store.publish("2026-10-16", "2026-10-18", "all")).toThrow();
  } finally {
    store.close();
  }
});

test("legacy database rows are preserved as unknown and existing frozen views are immutable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-releases-migrate-"));
  const path = join(dir, "usage.sqlite");
  let store = new UsageStore(path);
  store.accept({
    schema_version: 1,
    day: "2026-10-15",
    version_group: "1.1",
    active_installation_days: 1,
    duration_buckets: { ...emptyBuckets(), m1_5: 1 },
  });
  const old = store.publish("2026-10-15", "2026-10-18", "all");
  store.close();
  store = new UsageStore(path);
  try {
    store.accept({
      schema_version: 1,
      day: "2026-10-16",
      version_group: "1.1",
      active_installation_days: 1,
      duration_buckets: { ...emptyBuckets(), m1_5: 1 },
    });
    store.accept(payload());
    const snaps = store.readySnapshots("2026-10-18", "releases");
    expect(snaps.find((s) => s.day === "2026-10-15")).toEqual(old);
    expect(
      snaps.find((s) => s.day === "2026-10-16")?.groups.find((g) => g.platform === "unknown"),
    ).toMatchObject({ version: "未知（版本组 1.1）", channel: "unknown" });
  } finally {
    store.close();
  }
});

test("release transaction failures roll back and retention covers the new tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-releases-rollback-"));
  const path = join(dir, "usage.sqlite"),
    store = new UsageStore(path),
    db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER reject_v2 BEFORE INSERT ON release_duration BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    expect(() => store.accept(payload())).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_activity").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER reject_v2");
    store.accept({ ...payload(), day: "2024-01-01" });
    store.prune("2026-10-17", 18);
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_activity").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_duration").get()).toEqual({ n: 0 });
  } finally {
    db.close();
    store.close();
  }
});
