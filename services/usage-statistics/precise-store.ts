import { createHash } from "node:crypto";
import {
  BUCKETS, type DailyAggregate, dayStart, PRECISE_USAGE_NOTICE_VERSION, shanghaiDay,
  USAGE_PUBLICATION_DELAY_DAYS, type UsageRelease,
} from "../../src/shared/usage-statistics/model.js";
import { UsageStore, type DailySnapshot } from "./store.js";

type Activity = { day: string; platform: UsageRelease["platform"]; app_version: string; release_channel: UsageRelease["channel"]; count: number; foreground_seconds: number };

/** Only explicitly new-consent releases enter these tables; historical cohorts are never reclassified. */
export class PreciseUsageStore extends UsageStore {
  private readonly allowed: Set<string>;
  constructor(path: string, releases: readonly UsageRelease[] = []) {
    super(path);
    this.allowed = new Set(releases.map((r) => [r.platform, r.version, r.channel].join("|")));
    this.db.exec(`CREATE TABLE IF NOT EXISTS precise_activity (
      day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, count INTEGER NOT NULL, foreground_seconds INTEGER NOT NULL,
      PRIMARY KEY(day,platform,app_version,release_channel));
      CREATE TABLE IF NOT EXISTS precise_duration (
      day TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, release_channel TEXT NOT NULL, duration_bucket TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(day,platform,app_version,release_channel,duration_bucket));
      CREATE TABLE IF NOT EXISTS precise_snapshot (day TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    for (const release of releases) {
      const legacy = this.db.prepare("SELECT 1 FROM release_activity WHERE platform=? AND app_version=? AND release_channel=? LIMIT 1")
        .get(release.platform, release.version, release.channel);
      if (legacy) { this.close(); throw new Error("An existing legacy release cannot be relabeled precise"); }
    }
  }
  override accept(payload: DailyAggregate) {
    const key = payload.schema_version !== 1 ? [payload.platform, payload.app_version, payload.release_channel].join("|") : "";
    if (payload.schema_version !== 5) {
      if (this.allowed.has(key)) throw new Error("Precise release requires renewed consent");
      return super.accept(payload);
    }
    if (!this.allowed.has(key) || payload.notice_version !== PRECISE_USAGE_NOTICE_VERSION) throw new Error("Precise release not enabled");
    const receipt = createHash("sha256").update(payload.report_id.toLowerCase()).digest("hex");
    const hash = createHash("sha256").update(JSON.stringify([5, payload.notice_version, payload.day, key, payload.foreground_seconds, ...BUCKETS.map((b) => payload.duration_buckets[b])])).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT payload_hash FROM usage_receipt WHERE receipt_hash=?").get(receipt);
      if (prior) { this.db.exec("COMMIT"); return prior.payload_hash === hash ? "duplicate" as const : "conflict" as const; }
      if (this.db.prepare("SELECT 1 FROM precise_snapshot WHERE day=?").get(payload.day)) { this.db.exec("COMMIT"); return "closed" as const; }
      this.db.prepare("INSERT INTO usage_receipt VALUES (?,?,?)").run(receipt, payload.day, hash);
      this.db.prepare(`INSERT INTO precise_activity VALUES (?,?,?,?,1,?) ON CONFLICT(day,platform,app_version,release_channel) DO UPDATE SET count=count+1, foreground_seconds=foreground_seconds+excluded.foreground_seconds`)
        .run(payload.day, payload.platform, payload.app_version, payload.release_channel, payload.foreground_seconds);
      const insert = this.db.prepare(`INSERT INTO precise_duration VALUES (?,?,?,?,?,?) ON CONFLICT(day,platform,app_version,release_channel,duration_bucket) DO UPDATE SET count=count+excluded.count`);
      for (const bucket of BUCKETS) insert.run(payload.day, payload.platform, payload.app_version, payload.release_channel, bucket, payload.duration_buckets[bucket]);
      this.db.exec("COMMIT");
      return "accepted" as const;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  override reports(today: string, view: DailySnapshot["view"]): DailySnapshot[] {
    const old = super.reports(today, view);
    if (view !== "releases") return old;
    const days = this.db.prepare("SELECT DISTINCT day FROM precise_activity WHERE day<? ORDER BY day DESC").all(today) as Array<{ day: string }>;
    const current = days.map(({ day }): DailySnapshot => {
      const saved = this.db.prepare("SELECT body FROM precise_snapshot WHERE day=?").get(day);
      if (saved) return JSON.parse(String(saved.body)) as DailySnapshot;
      const finalizesOn = shanghaiDay(dayStart(day) + USAGE_PUBLICATION_DELAY_DAYS * 86_400_000);
      const provisional = today < finalizesOn;
      const rows = this.db.prepare("SELECT * FROM precise_activity WHERE day=? ORDER BY platform,app_version,release_channel").all(day) as Activity[];
      const snapshot: DailySnapshot = {
        day, view: "releases", status: provisional ? "provisional" : "final", asOf: today, finalizesOn,
        metric: "参与统计的活跃安装贡献", notice: "新告知下的管理员精确记录；非去重人数，允许7天补发，第8天固定。",
        groups: rows.map((r) => {
          const duration = this.db.prepare("SELECT duration_bucket,count FROM precise_duration WHERE day=? AND platform=? AND app_version=? AND release_channel=?")
            .all(day, r.platform, r.app_version, r.release_channel) as Array<{ duration_bucket: string; count: number }>;
          const counts = BUCKETS.map((bucket) => Number(duration.find((d) => d.duration_bucket === bucket)?.count || 0));
          const labels = ["不足1分钟", "1–5分钟", "5–15分钟", "15–30分钟", "30–60分钟", "60分钟及以上"];
          return { platform: r.platform, version: r.app_version, channel: r.release_channel,
            foregroundSeconds: Number(r.foreground_seconds),
            activeInstallationDays: provisional ? null : Number(r.count), duration: provisional ? null : { labels, counts },
            ...(provisional ? { activeRange: [Number(r.count), Number(r.count)] as [number, number], durationRanges: { labels, ranges: counts.map((n): [number, number] => [n, n]) } } : {}),
          };
        }),
      };
      if (!provisional) this.db.prepare("INSERT INTO precise_snapshot VALUES (?,?)").run(day, JSON.stringify(snapshot));
      return snapshot;
    });
    return [...old, ...current].sort((a, b) => b.day.localeCompare(a.day));
  }
  override prune(today: string, months: number) {
    super.prune(today, months);
    const date = new Date(`${today}T00:00:00Z`);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months + 1, 0)).getUTCDate();
    const cutoff = shanghaiDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, Math.min(Number(today.slice(8)), last)) - 8 * 3_600_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["precise_activity", "precise_duration", "precise_snapshot"]) this.db.prepare(`DELETE FROM ${table} WHERE day<?`).run(cutoff);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
