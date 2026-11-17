import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AppVersionSchema,
  AttemptSchema,
  BucketCountsSchema,
  bucketTotal,
  DAY_MS,
  type DailyAggregate,
  DailyAggregateSchema,
  DaySchema,
  dayStart,
  durationBucket,
  emptyBuckets,
  ReleaseChannelSchema,
  type RetryDailyAggregate,
  RetryPayloadSchema,
  shanghaiDay,
  USAGE_RETRY_DAYS,
  PRECISE_USAGE_NOTICE_VERSION,
  type UsageChoice,
  UsagePlatformSchema,
  type UsageState,
  usagePlatform,
  VersionGroupSchema,
} from "../../shared/usage-statistics/model.js";
import { type UsageConfig, usageConfigAvailable } from "./usage-statistics-config.js";

const LegacyCurrentSchema = z
  .object({
    day: DaySchema,
    version: VersionGroupSchema,
    buckets: BucketCountsSchema,
    openMs: z.number().finite().min(0).max(DAY_MS),
  })
  .strict()
  .refine((value) => bucketTotal(value.buckets) <= 1024);
const LegacyStoredSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    acceptedNotice: z.string().max(80).nullable(),
    highestDay: DaySchema.nullable(),
    current: LegacyCurrentSchema.nullable(),
    yesterday: z
      .object({ payload: DailyAggregateSchema, attempted: z.boolean() })
      .strict()
      .nullable(),
    lastAttempt: AttemptSchema.nullable(),
  })
  .strict();
const CurrentSchema = z
  .object({
    day: DaySchema,
    version: VersionGroupSchema,
    appVersion: AppVersionSchema,
    platform: UsagePlatformSchema,
    channel: ReleaseChannelSchema,
    buckets: BucketCountsSchema,
    openMs: z.number().finite().min(0).max(DAY_MS),
    foregroundMs: z.number().finite().min(0).max(DAY_MS).default(0),
  })
  .strict()
  .refine((value) => bucketTotal(value.buckets) <= 1024);
const PreviousStoredSchema = LegacyStoredSchema.extend({
  schemaVersion: z.literal(2),
  current: CurrentSchema.nullable(),
});
const StoredSchema = PreviousStoredSchema.omit({ yesterday: true }).extend({
  schemaVersion: z.literal(3),
  closedDays: z.array(DaySchema).max(32).default([]),
  pending: z
    .array(
      z
        .object({
          payload: RetryPayloadSchema,
          attempts: z.number().int().min(0).max(10000),
          nextAttemptAt: z.number().finite().min(0),
        })
        .strict(),
    )
    .max(USAGE_RETRY_DAYS),
});
type Stored = z.infer<typeof StoredSchema>;
type Stamp = { wall: number; mono: number };
type Options = {
  statePath: string;
  versionGroup: string;
  appVersion: string;
  platform: string;
  config: UsageConfig;
  allowed: boolean;
  sessionAllowed?: boolean;
  foreground(): boolean | Promise<boolean>;
  send(payload: DailyAggregate, signal: AbortSignal): Promise<number>;
  clock?: () => Stamp;
  write?: (value: string) => Promise<void>;
  jitterMs?: () => number;
  onChanged?: (state: UsageState) => void;
};
const initial = (): Stored => ({
  schemaVersion: 3,
  enabled: false,
  acceptedNotice: null,
  highestDay: null,
  current: null,
  pending: [],
  closedDays: [],
  lastAttempt: null,
});

export class UsageStatisticsService {
  private stored = initial();
  private sessionAllowed: boolean;
  private error: string | null = null;
  private revoked = false;
  private stopped = false;
  private epoch = 0;
  private anchor: (Stamp & { active: boolean }) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private reportScheduledAt: number | null = null;
  private scheduledReportId: string | null = null;
  private controller: AbortController | undefined;
  private sending = false;
  private started = false;
  private lastPersisted: string | null = null;
  private readonly available: boolean;
  private sampling = false;
  private clockPaused = false;
  constructor(private readonly options: Options) {
    this.stored.enabled = options.platform === "win32";
    this.sessionAllowed = options.sessionAllowed ?? true;
    this.available =
      options.allowed && usageConfigAvailable(options.config, options.platform, options.appVersion);
    this.ready = this.initialize().catch(() =>
      this.fail("统计配置无法读取，统计已暂停。请关闭统计后重试保存，文档功能可正常使用。"),
    );
  }
  private clock(): Stamp {
    return this.options.clock?.() ?? { wall: Date.now(), mono: performance.now() };
  }
  private running(): boolean {
    return (
      this.available &&
      this.sessionAllowed &&
      this.stored.enabled &&
      !this.revoked &&
      !this.stopped &&
      !this.error &&
      this.stored.acceptedNotice === this.options.config.noticeVersion
    );
  }
  hasConsentHistory(): boolean {
    return this.stored.acceptedNotice !== null;
  }
  setSessionAllowed(allowed: boolean) {
    if (this.sessionAllowed === allowed) return;
    this.sessionAllowed = allowed;
    ++this.epoch;
    this.anchor = null;
    this.cancelReport();
    this.syncTickTimer();
    if (allowed && this.started && this.running()) void this.sampleForeground();
  }
  state(): UsageState {
    const accepted = this.stored.acceptedNotice === this.options.config.noticeVersion;
    const enabled = this.stored.enabled && !this.revoked;
    const status = this.error
      ? "error"
      : !enabled
        ? "disabled"
        : !accepted
          ? "pending"
          : !this.available
            ? "unconfigured"
            : this.clockPaused
              ? "clock-paused"
              : "participating";
    const message =
      this.error ??
      (!enabled
        ? "已关闭使用统计"
        : !this.available
          ? "统计服务尚未开放，目前不计时、不上报。"
          : !accepted
            ? "待确认统计告知，目前不计时、不上报。"
            : this.clockPaused
              ? "系统时间发生跳变，计时与上报已暂停，待发送日报保留。校正系统时间后自动恢复；必要时校正后重启软件。"
              : `已参与统计，仅累计前台可见使用时长。${this.stored.pending.length ? `有 ${this.stored.pending.length} 份日报等待在 7 天窗口内发送。` : ""}`);
    return {
      enabled,
      accepted,
      available: this.available,
      status,
      message,
      noticeVersion: this.options.config.noticeVersion,
      lastAttempt: structuredClone(this.stored.lastAttempt),
      pendingReports: this.stored.pending.length,
      disclosure: structuredClone(this.options.config.disclosure),
    };
  }
  private publish() {
    try {
      this.options.onChanged?.(this.state());
    } catch {
      this.error = "统计状态通知失败，统计已暂停。请从设置中重新读取。";
      this.anchor = null;
      this.syncTickTimer();
      this.cancelReport();
    }
  }
  private fail(message: string) {
    this.error = message;
    this.anchor = null;
    this.syncTickTimer();
    this.cancelReport();
    this.publish();
  }
  private async persist() {
    const value = `${JSON.stringify(this.stored)}\n`;
    if (value === this.lastPersisted) return;
    if (this.options.write) await this.options.write(value);
    else {
      await mkdir(dirname(this.options.statePath), { recursive: true });
      await writeFileAtomic(this.options.statePath, value, { encoding: "utf8", mode: 0o600 });
    }
    this.lastPersisted = value;
  }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(() => this.ready).then(task);
    this.queue = pending.catch(() =>
      this.fail("统计选项或计数未能保存，统计已暂停。关闭选项未保存时请重试；文档功能可正常使用。"),
    );
    return this.queue;
  }
  async read(): Promise<UsageState> {
    await this.ready;
    await this.queue;
    return this.state();
  }
  private async initialize() {
    try {
      const raw = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
        const old =
          raw.schemaVersion === 1 ? LegacyStoredSchema.parse(raw) : PreviousStoredSchema.parse(raw);
        this.stored = {
          schemaVersion: 3,
          enabled: old.enabled,
          highestDay: old.highestDay,
          lastAttempt: old.lastAttempt,
          acceptedNotice: null,
          current: null,
          pending: [],
          closedDays: [],
        };
      } else this.stored = StoredSchema.parse(raw);
      this.lastPersisted = raw.schemaVersion !== 3 ? null : `${JSON.stringify(this.stored)}\n`;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const today = shanghaiDay(this.clock().wall);
    // A bad future watermark must not disable statistics after the clock is corrected.
    // Keep actual sealed dates instead of treating every earlier day as already reported.
    this.stored.closedDays = [
      ...new Set([
        ...this.stored.closedDays,
        ...this.stored.pending.map((item) => item.payload.day),
        ...(this.stored.lastAttempt ? [this.stored.lastAttempt.day] : []),
      ]),
    ].slice(-32);
    if (this.stored.current && this.stored.current.day > today) this.stored.current = null;
    this.stored.highestDay = today;
    // Seal only the durable checkpoint. Never account for the gap between processes.
    this.seal();
    this.advance(shanghaiDay(this.clock().wall));
    await this.persist();
  }
  start() {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.ready.then(() => {
      this.syncTickTimer();
      if (this.running()) void this.sampleForeground();
    });
  }
  private syncTickTimer() {
    if (!this.started || !this.running()) {
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = undefined;
      return;
    }
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => void this.sampleForeground(), 30_000);
    this.tickTimer.unref?.();
  }
  private seal() {
    const current = this.stored.current;
    if (!current) return;
    const bucket = durationBucket(current.openMs);
    if (bucket && bucketTotal(current.buckets) < 1024) current.buckets[bucket]++;
    current.openMs = 0;
  }
  private advance(day: string) {
    const current = this.stored.current;
    if (current && current.day < day) {
      this.seal();
      this.stored.closedDays = [...new Set([...this.stored.closedDays, current.day])].slice(-32);
      const age = (dayStart(day) - dayStart(current.day)) / DAY_MS;
      if (
        age >= 1 &&
        age <= USAGE_RETRY_DAYS &&
        bucketTotal(current.buckets) > 0 &&
        !this.stored.pending.some((item) => item.payload.day === current.day)
      ) {
        this.stored.pending.push({
          attempts: 0,
          nextAttemptAt: 0,
          payload: {
            schema_version: 5,
            notice_version: PRECISE_USAGE_NOTICE_VERSION,
            foreground_seconds: Math.floor(current.foregroundMs / 1000),
            report_id: randomUUID(),
            day: current.day,
            platform: current.platform,
            app_version: current.appVersion,
            release_channel: current.channel,
            active_installation_days: 1,
            duration_buckets: { ...current.buckets },
          },
        });
      }
      this.stored.current = null;
    }
    this.stored.pending = this.stored.pending.filter((item) => {
      const age = (dayStart(day) - dayStart(item.payload.day)) / DAY_MS;
      return age <= USAGE_RETRY_DAYS;
    });
    if (!this.stored.highestDay || day > this.stored.highestDay) this.stored.highestDay = day;
  }
  private add(day: string, milliseconds: number) {
    const platform = usagePlatform(this.options.platform);
    if (!platform || milliseconds <= 0 || this.stored.closedDays.includes(day)) return;
    if (!this.stored.current)
      this.stored.current = {
        day,
        version: this.options.versionGroup,
        appVersion: this.options.appVersion,
        platform,
        channel: this.options.config.releaseChannel,
        buckets: emptyBuckets(),
        openMs: 0,
        foregroundMs: 0,
      };
    if (this.stored.current.day === day) {
      this.stored.current.openMs = Math.min(DAY_MS, this.stored.current.openMs + milliseconds);
      this.stored.current.foregroundMs = Math.min(DAY_MS, this.stored.current.foregroundMs + milliseconds);
    }
  }
  private account(stamp: Stamp, active: boolean, running: boolean) {
    const day = shanghaiDay(stamp.wall);
    const previous = this.anchor;
    if (previous && (previous.active || this.clockPaused)) {
      const elapsed = Math.max(0, stamp.mono - previous.mono);
      if (Math.abs(stamp.wall - previous.wall - elapsed) > 2_000) {
        this.anchor = { wall: previous.wall + elapsed, mono: stamp.mono, active: false };
        const changed = !this.clockPaused;
        this.clockPaused = true;
        this.cancelReport();
        if (changed) this.publish();
        return;
      }
    }
    if (this.clockPaused) {
      this.clockPaused = false;
      this.publish();
    }
    if (running && previous?.active) {
      const elapsed = stamp.mono - previous.mono;
      const wallElapsed = stamp.wall - previous.wall;
      if (
        elapsed >= 0 &&
        elapsed <= 45_000 &&
        wallElapsed >= 0 &&
        Math.abs(wallElapsed - elapsed) <= 2_000
      ) {
        const oldDay = shanghaiDay(previous.wall);
        if (oldDay !== day) {
          const before = Math.min(elapsed, Math.max(0, dayStart(day) - previous.wall));
          this.add(oldDay, before);
          this.advance(day);
          this.add(day, elapsed - before);
        } else this.add(day, elapsed);
      }
    }
    this.advance(day);
    this.anchor = { ...stamp, active: running && active && !this.stored.closedDays.includes(day) };
  }
  observe(active: boolean): Promise<void> {
    const stamp = this.clock();
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (this.stopped || epoch !== this.epoch || this.error) return;
      if (!this.running()) return;
      // Harmony observes lock/display via a native query rather than lock events.
      // Discard an interval with an unconfirmed endpoint instead of counting it.
      if (!active && ["openharmony", "ohos"].includes(this.options.platform)) this.anchor = null;
      this.account(stamp, active, true);
      await this.persist();
      this.scheduleReport();
    });
  }
  private async sampleForeground() {
    if (this.sampling || !this.running()) return;
    this.sampling = true;
    const epoch = this.epoch;
    try {
      let active = false;
      try {
        const value = this.options.foreground();
        active = typeof value === "boolean" ? value : await value;
      } catch {
        active = false;
      }
      if (epoch === this.epoch && this.running()) await this.observe(active);
    } finally {
      this.sampling = false;
    }
  }
  async choose(choice: UsageChoice): Promise<UsageState> {
    const epoch = ++this.epoch;
    // Withdrawal acts before queued writes, timers or network callbacks can complete.
    this.revoked = true;
    this.anchor = null;
    this.syncTickTimer();
    this.cancelReport();
    this.publish();
    await this.enqueue(async () => {
      if (this.stopped) return;
      if (choice.enabled) {
        if (
          this.error ||
          !this.available ||
          (choice.noticeVersion !== this.options.config.noticeVersion &&
            this.stored.acceptedNotice !== this.options.config.noticeVersion)
        )
          throw new Error("Statistics notice not confirmed");
        if (this.stored.acceptedNotice !== this.options.config.noticeVersion) {
          this.stored.current = null;
          this.stored.pending = [];
        }
        this.stored.acceptedNotice = this.options.config.noticeVersion;
      }
      this.stored.enabled = choice.enabled;
      if (!choice.enabled) {
        this.stored.current = null;
        this.stored.pending = [];
      }
      await this.persist();
      this.error = null;
      if (epoch === this.epoch) {
        this.revoked = !choice.enabled;
        this.syncTickTimer();
        this.anchor = { ...this.clock(), active: false };
        // A native asynchronous query must not block the persistence queue.
        const foreground = this.options.foreground();
        if (typeof foreground === "boolean") this.anchor.active = this.running() && foreground;
        else
          void foreground
            .then((active) => {
              if (epoch === this.epoch && this.running()) void this.observe(active);
            })
            .catch(() => undefined);
        this.scheduleReport();
      }
      this.publish();
    });
    return this.state();
  }
  private cancelReport() {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    this.reportScheduledAt = null;
    this.scheduledReportId = null;
    this.controller?.abort();
  }
  private scheduleReport() {
    const day = shanghaiDay(this.clock().wall);
    const candidate = this.stored.pending
      .filter((item) => item.payload.day < day)
      .toSorted((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
    if (!this.running() || this.clockPaused || !candidate || this.sending) return;
    const now = this.clock().wall;
    let due =
      Math.min(6 * 3_600_000, Math.max(0, candidate.nextAttemptAt - now)) +
      (this.options.jitterMs?.() ?? Math.floor(Math.random() * 30_001));
    if (this.reportTimer) {
      if (
        this.scheduledReportId === candidate.payload.report_id &&
        (this.reportScheduledAt === null || this.reportScheduledAt > now)
      )
        return;
      clearTimeout(this.reportTimer);
      if (this.reportScheduledAt !== null && this.reportScheduledAt <= now) due = 0;
    }
    this.reportScheduledAt = now + due;
    this.scheduledReportId = candidate.payload.report_id;
    const epoch = this.epoch;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      this.reportScheduledAt = null;
      this.scheduledReportId = null;
      void this.report(epoch);
    }, due);
    this.reportTimer.unref?.();
  }
  private async report(epoch: number) {
    this.sending = true;
    let payload: RetryDailyAggregate | undefined;
    await this.enqueue(async () => {
      if (epoch !== this.epoch || !this.running()) return;
      this.account(this.clock(), this.anchor?.active ?? false, true);
      if (this.clockPaused) return;
      this.advance(shanghaiDay(this.clock().wall));
      const candidate = this.stored.pending.find(
        (item) =>
          item.payload.day < shanghaiDay(this.clock().wall) &&
          item.nextAttemptAt <= this.clock().wall,
      );
      if (epoch !== this.epoch || !this.running() || !candidate) return;
      candidate.attempts++;
      candidate.nextAttemptAt =
        this.clock().wall +
        Math.min(6 * 3_600_000, 60_000 * 5 ** Math.min(candidate.attempts - 1, 4));
      this.stored.lastAttempt = { day: candidate.payload.day, result: "attempted" };
      await this.persist();
      if (this.running() && epoch === this.epoch) payload = structuredClone(candidate.payload);
      this.publish();
    });
    if (!payload || epoch !== this.epoch || !this.running()) {
      this.sending = false;
      this.scheduleReport();
      return;
    }
    const sentDay = payload.day;
    const reportId = payload.report_id;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let result: "received" | "rejected" | "unknown" = "unknown";
    try {
      const status = await this.options.send(payload, controller.signal);
      if (!controller.signal.aborted)
        result =
          status === 204
            ? "received"
            : status >= 400 && status < 500 && ![408, 425, 429].includes(status)
              ? "rejected"
              : "unknown";
    } catch {
      result = "unknown";
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
      this.sending = false;
    }
    await this.enqueue(async () => {
      if (epoch !== this.epoch || !this.running()) return;
      this.stored.lastAttempt = { day: sentDay, result };
      if (result === "received" || result === "rejected")
        this.stored.pending = this.stored.pending.filter(
          (item) => item.payload.report_id !== reportId,
        );
      await this.persist();
      this.publish();
      this.scheduleReport();
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    const stamp = this.clock();
    const wasRunning = this.running();
    this.stopped = true;
    ++this.epoch;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.cancelReport();
    const flush = this.enqueue(async () => {
      if (this.error) return;
      if (wasRunning) {
        this.account(stamp, false, true);
        this.seal();
      }
      await this.persist();
    });
    // Shutdown never waits for a network request or propagates a statistics error.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
