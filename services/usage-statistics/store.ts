import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  BUCKETS,
  type DailyAggregate,
  dayStart,
  safeDurationDistribution,
  shanghaiDay,
  USAGE_PUBLICATION_DELAY_DAYS,
  USAGE_RETRY_DAYS,
  type UsageRelease,
} from "../../src/shared/usage-statistics/model.js";

type AggregateRow = { day: string; version_group: string; active_installation_days: number };
type DurationRow = { version_group: string; duration_bucket: string; count: number };
export type DailySnapshot = {
  day: string;
  status?: "provisional" | "final";
  asOf?: string;
  finalizesOn?: string;
  view: "all" | "versions" | "releases";
  metric: "参与统计的活跃安装贡献";
  notice: string;
  groups: Array<{
    version: string;
    platform?: UsageRelease["platform"] | "unknown";
    channel?: UsageRelease["channel"] | "unknown";
    activeInstallationDays: number | null;
    duration: ReturnType<typeof safeDurationDistribution>;
    activeRange?: [number, number] | null;
    durationRanges?: { labels: string[]; ranges: Array<[number, number]> } | null;
    foregroundSeconds?: number;
  }>;
};
export class UsageStore {
  protected db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS daily_activity (
        day TEXT NOT NULL, version_group TEXT NOT NULL, active_installation_days INTEGER NOT NULL,
        PRIMARY KEY(day, version_group));
      CREATE TABLE IF NOT EXISTS daily_duration (
        day TEXT NOT NULL, version_group TEXT NOT NULL, duration_bucket TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(day, version_group, duration_bucket));
      CREATE TABLE IF NOT EXISTS daily_snapshot (day TEXT PRIMARY KEY, view TEXT NOT NULL, body TEXT NOT NULL);`);
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS release_activity (
        day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, active_installation_days INTEGER NOT NULL,
        PRIMARY KEY(day,platform,app_version,release_channel));
      CREATE TABLE IF NOT EXISTS release_duration (
        day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, duration_bucket TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(day,platform,app_version,release_channel,duration_bucket));
      CREATE TABLE IF NOT EXISTS usage_receipt (receipt_hash TEXT PRIMARY KEY, day TEXT NOT NULL, payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reporting_window (day TEXT PRIMARY KEY, delay_days INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_reception (day TEXT NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,outcome));
      CREATE TABLE IF NOT EXISTS preview_activity (
        day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, active_installation_days INTEGER NOT NULL,
        PRIMARY KEY(day,platform,app_version,release_channel));
      CREATE TABLE IF NOT EXISTS preview_duration (
        day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, duration_bucket TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(day,platform,app_version,release_channel,duration_bucket));
      CREATE TABLE IF NOT EXISTS preview_snapshot (day TEXT NOT NULL, as_of TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(day,as_of));
      COMMIT;`);
  }
  accept(payload: DailyAggregate) {
    if (payload.schema_version === 5) throw new Error("Precise protocol requires the isolated precise store");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (payload.schema_version === 3 || payload.schema_version === 4) {
        const receiptHash = createHash("sha256")
          .update(payload.report_id.toLowerCase())
          .digest("hex");
        const payloadHash = createHash("sha256")
          .update(
            JSON.stringify([
              ...(payload.schema_version === 4 ? [4] : []),
              payload.day,
              payload.platform,
              payload.app_version,
              payload.release_channel,
              payload.active_installation_days,
              ...BUCKETS.map((bucket) => payload.duration_buckets[bucket]),
            ]),
          )
          .digest("hex");
        const prior = this.db
          .prepare("SELECT payload_hash FROM usage_receipt WHERE receipt_hash=?")
          .get(receiptHash);
        if (prior) {
          this.db.exec("COMMIT");
          return prior.payload_hash === payloadHash ? "duplicate" : "conflict";
        }
        if (this.snapshot(payload.day)) {
          this.db.exec("COMMIT");
          return "closed";
        }
        this.db
          .prepare("INSERT INTO usage_receipt VALUES (?,?,?)")
          .run(receiptHash, payload.day, payloadHash);
        this.db
          .prepare("INSERT INTO reporting_window VALUES (?,?) ON CONFLICT(day) DO NOTHING")
          .run(payload.day, USAGE_PUBLICATION_DELAY_DAYS);
      }
      if (payload.schema_version !== 1) {
        this.db
          .prepare(
            `INSERT INTO release_activity VALUES (?,?,?,?,1) ON CONFLICT(day,platform,app_version,release_channel) DO UPDATE SET active_installation_days=active_installation_days+1`,
          )
          .run(payload.day, payload.platform, payload.app_version, payload.release_channel);
        const statement = this.db.prepare(
          `INSERT INTO release_duration VALUES (?,?,?,?,?,?) ON CONFLICT(day,platform,app_version,release_channel,duration_bucket) DO UPDATE SET count=count+excluded.count`,
        );
        for (const bucket of BUCKETS)
          statement.run(
            payload.day,
            payload.platform,
            payload.app_version,
            payload.release_channel,
            bucket,
            payload.duration_buckets[bucket],
          );
        if (payload.schema_version === 4) {
          this.db
            .prepare(
              `INSERT INTO preview_activity VALUES (?,?,?,?,1) ON CONFLICT(day,platform,app_version,release_channel) DO UPDATE SET active_installation_days=active_installation_days+1`,
            )
            .run(payload.day, payload.platform, payload.app_version, payload.release_channel);
          const preview = this.db.prepare(
            `INSERT INTO preview_duration VALUES (?,?,?,?,?,?) ON CONFLICT(day,platform,app_version,release_channel,duration_bucket) DO UPDATE SET count=count+excluded.count`,
          );
          for (const bucket of BUCKETS)
            preview.run(
              payload.day,
              payload.platform,
              payload.app_version,
              payload.release_channel,
              bucket,
              payload.duration_buckets[bucket],
            );
        }
        this.db.exec("COMMIT");
        return "accepted";
      }
      this.db
        .prepare(`INSERT INTO daily_activity VALUES (?, ?, 1)
        ON CONFLICT(day,version_group) DO UPDATE SET active_installation_days=active_installation_days+1`)
        .run(payload.day, payload.version_group);
      const statement = this.db.prepare(`INSERT INTO daily_duration VALUES (?, ?, ?, ?)
        ON CONFLICT(day,version_group,duration_bucket) DO UPDATE SET count=count+excluded.count`);
      for (const bucket of BUCKETS)
        statement.run(payload.day, payload.version_group, bucket, payload.duration_buckets[bucket]);
      this.db.exec("COMMIT");
      return "accepted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  publish(day: string, today: string, view: DailySnapshot["view"]): DailySnapshot {
    const delay = Number(
      this.db.prepare("SELECT delay_days FROM reporting_window WHERE day=?").get(day)?.delay_days ??
        2,
    );
    if (dayStart(today) - dayStart(day) < delay * 86_400_000)
      throw new Error("Report window has not closed");
    const existing = this.snapshot(day);
    if (existing) {
      if (existing.view !== view) throw new Error("Snapshot view is immutable");
      return existing;
    }
    const activity = this.db
      .prepare("SELECT * FROM daily_activity WHERE day=? ORDER BY version_group")
      .all(day) as AggregateRow[];
    const durations = this.db
      .prepare("SELECT version_group,duration_bucket,count FROM daily_duration WHERE day=?")
      .all(day) as DurationRow[];
    type ReleaseActivity = {
      platform: UsageRelease["platform"];
      app_version: string;
      release_channel: UsageRelease["channel"];
      active_installation_days: number;
    };
    type ReleaseDuration = Omit<ReleaseActivity, "active_installation_days"> & {
      duration_bucket: string;
      count: number;
    };
    const releases = this.db
      .prepare(
        "SELECT * FROM release_activity WHERE day=? ORDER BY platform,app_version,release_channel",
      )
      .all(day) as ReleaseActivity[];
    if (releases.length && view !== "releases")
      throw Error("Release data requires the fixed release view");
    const releaseDurations = this.db
      .prepare("SELECT * FROM release_duration WHERE day=?")
      .all(day) as ReleaseDuration[];
    const entries =
      view === "all"
        ? [
            {
              version_group: "全部版本",
              active_installation_days: activity.reduce(
                (sum, row) => sum + row.active_installation_days,
                0,
              ),
            },
          ]
        : activity;
    const snapshot: DailySnapshot = {
      day,
      view,
      metric: "参与统计的活跃安装贡献",
      notice:
        "可能漏记或重复；不是精确人数、独立设备数或实际工作时长。空值表示样本不足；不提供跨日时长汇总。",
      groups:
        view === "releases"
          ? [
              ...releases.map((row) => ({
                version: row.app_version,
                platform: row.platform,
                channel: row.release_channel,
                activeInstallationDays:
                  row.active_installation_days >= 10 ? row.active_installation_days : null,
                duration:
                  row.active_installation_days < 10
                    ? null
                    : safeDurationDistribution(
                        BUCKETS.map((bucket) =>
                          releaseDurations
                            .filter(
                              (entry) =>
                                entry.platform === row.platform &&
                                entry.app_version === row.app_version &&
                                entry.release_channel === row.release_channel &&
                                entry.duration_bucket === bucket,
                            )
                            .reduce((sum, entry) => sum + entry.count, 0),
                        ),
                      ),
              })),
              ...activity.map((row) => ({
                version: `未知（版本组 ${row.version_group}）`,
                platform: "unknown" as const,
                channel: "unknown" as const,
                activeInstallationDays:
                  row.active_installation_days >= 10 ? row.active_installation_days : null,
                duration:
                  row.active_installation_days < 10
                    ? null
                    : safeDurationDistribution(
                        BUCKETS.map((bucket) =>
                          durations
                            .filter(
                              (entry) =>
                                entry.version_group === row.version_group &&
                                entry.duration_bucket === bucket,
                            )
                            .reduce((sum, entry) => sum + entry.count, 0),
                        ),
                      ),
              })),
            ]
          : entries.map((row) => ({
              version: row.version_group,
              activeInstallationDays:
                row.active_installation_days >= 10 ? row.active_installation_days : null,
              duration:
                row.active_installation_days < 10
                  ? null
                  : safeDurationDistribution(
                      BUCKETS.map((bucket) =>
                        durations
                          .filter(
                            (entry) =>
                              entry.duration_bucket === bucket &&
                              (view === "all" || entry.version_group === row.version_group),
                          )
                          .reduce((sum, entry) => sum + entry.count, 0),
                      ),
                    ),
            })),
    };
    this.db
      .prepare("INSERT INTO daily_snapshot VALUES (?,?,?)")
      .run(day, view, JSON.stringify(snapshot));
    return snapshot;
  }
  snapshot(day: string): DailySnapshot | null {
    const row = this.db.prepare("SELECT body FROM daily_snapshot WHERE day=?").get(day) as
      | { body: string }
      | undefined;
    if (!row) return null;
    const snapshot = JSON.parse(row.body) as DailySnapshot;
    // Apply the display floor to snapshots produced by earlier versions as well.
    for (const group of snapshot.groups) {
      if (group.activeInstallationDays === null || group.activeInstallationDays < 10) {
        group.activeInstallationDays = null;
        group.duration = null;
      }
    }
    return snapshot;
  }
  /** Publish only closed reporting windows; never expose mutable raw aggregates. */
  readySnapshots(today: string, view: DailySnapshot["view"]): DailySnapshot[] {
    const cutoff = shanghaiDay(dayStart(today) - 2 * 86_400_000);
    const rows = this.db
      .prepare(
        "SELECT day FROM daily_activity WHERE day<=? UNION SELECT day FROM release_activity WHERE day<=? UNION SELECT day FROM daily_snapshot WHERE day<=? ORDER BY day DESC",
      )
      .all(cutoff, cutoff, cutoff) as Array<{ day: string }>;
    return rows
      .filter(
        ({ day }) =>
          dayStart(today) - dayStart(day) >=
          Number(
            this.db.prepare("SELECT delay_days FROM reporting_window WHERE day=?").get(day)
              ?.delay_days ?? 2,
          ) *
            86_400_000,
      )
      .map(({ day }) => this.snapshot(day) ?? this.publish(day, today, view));
  }
  /** A provisional response contains ranges only, and is stable within one read day. */
  reports(today: string, view: DailySnapshot["view"]): DailySnapshot[] {
    const final = this.readySnapshots(today, view).map((row) => ({
      ...row,
      status: "final" as const,
    }));
    if (view !== "releases") return final;
    const days = this.db
      .prepare("SELECT DISTINCT day FROM preview_activity WHERE day<? AND day>? ORDER BY day DESC")
      .all(
        today,
        shanghaiDay(dayStart(today) - USAGE_PUBLICATION_DELAY_DAYS * 86_400_000),
      ) as Array<{ day: string }>;
    const range = (count: number): [number, number] =>
      count === 0 ? [0, 0] : [Math.floor(count / 10) * 10, Math.floor(count / 10) * 10 + 9];
    const previews = days
      .filter(({ day }) => !this.snapshot(day))
      .map(({ day }) => {
        const cached = this.db
          .prepare("SELECT body FROM preview_snapshot WHERE day=? AND as_of=?")
          .get(day, today);
        if (cached) return JSON.parse(String(cached.body)) as DailySnapshot;
        const rows = this.db
          .prepare(
            "SELECT * FROM preview_activity WHERE day=? ORDER BY platform,app_version,release_channel",
          )
          .all(day) as Array<{
          platform: UsageRelease["platform"];
          app_version: string;
          release_channel: UsageRelease["channel"];
          active_installation_days: number;
        }>;
        const report: DailySnapshot = {
          day,
          view: "releases",
          status: "provisional",
          asOf: today,
          finalizesOn: shanghaiDay(dayStart(day) + USAGE_PUBLICATION_DELAY_DAYS * 86_400_000),
          metric: "参与统计的活跃安装贡献",
          notice:
            "暂定区间；每日更新一次，仅包含同意次日展示的贡献，D+8固定。非人数，不作完全匿名保证。",
          groups: rows.map((row) => {
            const buckets = this.db
              .prepare(
                "SELECT duration_bucket,count FROM preview_duration WHERE day=? AND platform=? AND app_version=? AND release_channel=?",
              )
              .all(day, row.platform, row.app_version, row.release_channel) as Array<{
              duration_bucket: string;
              count: number;
            }>;
            const sums: [number, number] = [0, 0];
            for (const entry of buckets)
              sums[["m30_60", "ge_60m"].includes(entry.duration_bucket) ? 1 : 0] += entry.count;
            return {
              platform: row.platform,
              version: row.app_version,
              channel: row.release_channel,
              activeInstallationDays: null,
              duration: null,
              activeRange:
                row.active_installation_days >= 10 ? range(row.active_installation_days) : null,
              durationRanges:
                row.active_installation_days >= 10 &&
                sums.some((n) => n > 0) &&
                sums.every((n) => n === 0 || n >= 10)
                  ? { labels: ["不足30分钟", "30分钟及以上"], ranges: sums.map(range) }
                  : null,
            };
          }),
        };
        this.db
          .prepare("INSERT INTO preview_snapshot VALUES (?,?,?)")
          .run(day, today, JSON.stringify(report));
        return report;
      });
    return [...previews, ...final].sort((a, b) => b.day.localeCompare(a.day));
  }
  recordReception(day: string, outcome: string) {
    this.db
      .prepare(
        "INSERT INTO usage_reception VALUES (?,?,1) ON CONFLICT(day,outcome) DO UPDATE SET count=count+1",
      )
      .run(day, outcome);
  }
  receptionHealth(today: string) {
    const rows = this.db
      .prepare("SELECT day,outcome,count FROM usage_reception ORDER BY day DESC,outcome")
      .all() as Array<{ day: string; outcome: string; count: number }>;
    const pending = this.db
      .prepare(
        "SELECT DISTINCT w.day,w.delay_days,a.platform,a.app_version,a.release_channel FROM reporting_window w JOIN release_activity a ON a.day=w.day WHERE w.day NOT IN (SELECT day FROM daily_snapshot) ORDER BY w.day DESC",
      )
      .all() as Array<{
      day: string;
      delay_days: number;
      platform: string;
      app_version: string;
      release_channel: string;
    }>;
    return {
      lastReceivedDay:
        rows.find((row) => row.outcome === "accepted" || row.outcome === "duplicate")?.day ?? null,
      outcomes: rows.map((row) => ({ day: row.day, outcome: row.outcome, observed: true })),
      pending: pending
        .filter((row) => dayStart(today) - dayStart(row.day) < row.delay_days * 86_400_000)
        .map((row) => ({
          day: row.day,
          platform: row.platform,
          version: row.app_version,
          channel: row.release_channel,
          publishOn: shanghaiDay(dayStart(row.day) + row.delay_days * 86_400_000),
        })),
    };
  }
  prune(today: string, months: number) {
    // UTC calendar subtraction avoids host timezone and end-of-month overflow.
    const date = new Date(`${today}T00:00:00Z`);
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months + 1, 0));
    const lastDay = target.getUTCDate();
    const cutoff = shanghaiDay(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth() - months,
        Math.min(Number(today.slice(8)), lastDay),
      ) -
        8 * 3_600_000,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "daily_activity",
        "daily_duration",
        "daily_snapshot",
        "release_activity",
        "release_duration",
        "reporting_window",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
      for (const table of ["preview_activity", "preview_duration", "preview_snapshot"])
        this.db
          .prepare(`DELETE FROM ${table} WHERE day <= ?`)
          .run(shanghaiDay(dayStart(today) - USAGE_PUBLICATION_DELAY_DAYS * 86_400_000));
      this.db
        .prepare("DELETE FROM usage_receipt WHERE day < ?")
        .run(shanghaiDay(dayStart(today) - USAGE_RETRY_DAYS * 86_400_000));
      this.db
        .prepare("DELETE FROM usage_reception WHERE day < ?")
        .run(shanghaiDay(dayStart(today) - 30 * 86_400_000));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy) throw new Error("Retention checkpoint busy");
  }
  close() {
    this.db.close();
  }
}
