// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DailyAggregateSchema, type DailyAggregate, emptyBuckets, PRECISE_USAGE_NOTICE_VERSION } from "../../src/shared/usage-statistics/model.js";
import { PreciseUsageStore } from "./precise-store.js";
import { createUsageReceiver } from "./server.js";
import { DatabaseSync } from "node:sqlite";

const release = { platform: "windows" as const, version: "9.0.0", channel: "internal" as const };
const payload = (): Extract<DailyAggregate, { schema_version: 5 }> => ({ schema_version: 5, notice_version: PRECISE_USAGE_NOTICE_VERSION, foreground_seconds: 120, report_id: randomUUID(), day: "2026-10-27", platform: release.platform, app_version: release.version, release_channel: release.channel, active_installation_days: 1, duration_buckets: { ...emptyBuckets(), m1_5: 1 } });

test("precise aggregates require the explicit new notice and contain no stable identity", () => {
  const value = payload();
  expect(DailyAggregateSchema.safeParse(value).success).toBe(true);
  expect(DailyAggregateSchema.safeParse({ ...value, notice_version: "old" }).success).toBe(false);
  expect(DailyAggregateSchema.safeParse({ ...value, device_id: "forbidden" }).success).toBe(false);
  expect(DailyAggregateSchema.safeParse({ ...value, foreground_seconds: 86401 }).success).toBe(false);
  expect(DailyAggregateSchema.safeParse({ ...value, foreground_seconds: 1 }).success).toBe(false);
});

test("new-consent small counts are exact, retries idempotent, and final snapshots immutable", () => {
  const store = new PreciseUsageStore(join(mkdtempSync(join(tmpdir(), "usage-precise-")), "usage.sqlite"), [release]);
  try {
    const value = payload();
    expect(store.accept(value)).toBe("accepted");
    expect(store.accept(value)).toBe("duplicate");
    expect(store.accept({ ...value, duration_buckets: { ...emptyBuckets(), m5_15: 1 } })).toBe("conflict");
    expect(store.reports("2026-10-27", "releases")).toEqual([]);
    const preview = store.reports("2026-10-28", "releases")[0]!;
    expect(preview.status).toBe("provisional");
    expect(preview.groups[0]?.activeRange).toEqual([1, 1]);
    expect(preview.groups[0]?.foregroundSeconds).toBe(120);
    expect(preview.groups[0]?.durationRanges?.ranges).toContainEqual([1, 1]);
    expect(store.accept(payload())).toBe("accepted");
    expect(store.reports("2026-10-28", "releases")[0]?.groups[0]?.activeRange).toEqual([2, 2]);
    expect(store.reports("2026-10-28", "releases")[0]?.groups[0]?.foregroundSeconds).toBe(240);
    expect(store.reports("2026-11-04", "releases")[0]?.groups[0]?.activeInstallationDays).toBe(2);
    expect(store.accept(payload())).toBe("closed");
    expect(store.reports("2026-11-05", "releases")[0]?.groups[0]?.activeInstallationDays).toBe(2);
  } finally { store.close(); }
});

test("old cohorts retain suppression and cannot be relabeled as precise", () => {
  const store = new PreciseUsageStore(join(mkdtempSync(join(tmpdir(), "usage-precise-old-")), "usage.sqlite"), [release]);
  try {
    const { notice_version: _notice, foreground_seconds: _seconds, ...value } = payload();
    expect(store.accept({ ...value, schema_version: 4, app_version: "8.0.0" })).toBe("accepted");
    expect(store.reports("2026-10-28", "releases")[0]?.groups[0]?.activeRange).toBeNull();
    expect(() => store.accept({ ...payload(), app_version: "8.0.0" })).toThrow();
    expect(store.accept(payload())).toBe("accepted");
    expect(store.reports("2026-10-28", "releases")).toHaveLength(2);
  } finally { store.close(); }
});

test("precise transaction failure rolls back seconds and retry receipt; retention removes all precise tables", () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-precise-rollback-")), "usage.sqlite");
  const store = new PreciseUsageStore(path, [release]);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER reject_precise BEFORE INSERT ON precise_duration BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    const value = payload();
    expect(() => store.accept(value)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_receipt").get()?.n).toBe(0);
    expect(store.reports("2026-10-28", "releases")).toEqual([]);
    db.exec("DROP TRIGGER reject_precise");
    expect(store.accept(value)).toBe("accepted");
    store.reports("2026-11-04", "releases");
    store.prune("2026-12-01", 1);
    for (const table of ["usage_receipt", "precise_activity", "precise_duration", "precise_snapshot"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  } finally { db.close(); store.close(); }
});

test("HTTP requires a new precise release and rejects the old protocol for that release", async () => {
  for (const enabled of [false, true]) {
    const store = new PreciseUsageStore(join(mkdtempSync(join(tmpdir(), "usage-precise-http-")), "usage.sqlite"), enabled ? [release] : []);
    const server = createUsageReceiver({ store, publicVersionGroups: [], releases: [release], preciseReleases: enabled ? [release] : [], requestsPerMinute: 600, clock: () => Date.parse("2026-10-28T12:00:00+08:00") });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("address");
      const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/usage/daily-aggregate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect((await post(payload())).status).toBe(enabled ? 204 : 400);
      const { notice_version: _notice, foreground_seconds: _seconds, ...old } = payload();
      expect((await post({ ...old, schema_version: 4 })).status).toBe(enabled ? 400 : 204);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      store.close();
    }
  }
});
