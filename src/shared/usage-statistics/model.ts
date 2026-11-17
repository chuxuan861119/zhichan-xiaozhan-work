import { z } from "zod";

export const USAGE_NOTICE_VERSION = "2026-10-28.5";
export const PRECISE_USAGE_NOTICE_VERSION = "2026-10-28.precise-v1";
export const USAGE_RETRY_DAYS = 7;
export const USAGE_PUBLICATION_DELAY_DAYS = USAGE_RETRY_DAYS + 1;
export const BUCKETS = ["lt_1m", "m1_5", "m5_15", "m15_30", "m30_60", "ge_60m"] as const;
export type DurationBucket = (typeof BUCKETS)[number];
export const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
export const DaySchema = z.iso.date();
export const VersionGroupSchema = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
export const AppVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
export const UsagePlatformSchema = z.enum(["windows", "macos", "harmonyos"]);
export const ReleaseChannelSchema = z.enum(["stable", "preview", "internal"]);
export const UsageReleaseSchema = z
  .object({
    platform: UsagePlatformSchema,
    version: AppVersionSchema,
    channel: ReleaseChannelSchema,
  })
  .strict();
export type UsageRelease = z.infer<typeof UsageReleaseSchema>;
export function usagePlatform(platform: string): UsageRelease["platform"] | null {
  return platform === "win32"
    ? "windows"
    : platform === "darwin"
      ? "macos"
      : ["openharmony", "ohos"].includes(platform)
        ? "harmonyos"
        : null;
}
export function sameUsageRelease(a: UsageRelease, b: UsageRelease): boolean {
  return a.platform === b.platform && a.version === b.version && a.channel === b.channel;
}
export const BucketCountsSchema = z
  .object({
    lt_1m: z.number().int().min(0).max(1024),
    m1_5: z.number().int().min(0).max(1024),
    m5_15: z.number().int().min(0).max(1024),
    m15_30: z.number().int().min(0).max(1024),
    m30_60: z.number().int().min(0).max(1024),
    ge_60m: z.number().int().min(0).max(1024),
  })
  .strict();
export type BucketCounts = z.infer<typeof BucketCountsSchema>;
export function emptyBuckets(): BucketCounts {
  return { lt_1m: 0, m1_5: 0, m5_15: 0, m15_30: 0, m30_60: 0, ge_60m: 0 };
}
export function bucketTotal(buckets: BucketCounts): number {
  return BUCKETS.reduce((sum, key) => sum + buckets[key], 0);
}
export function durationBucket(milliseconds: number): DurationBucket | null {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const limits = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];
  return BUCKETS[limits.findIndex((limit) => milliseconds < limit)] ?? "ge_60m";
}
export function shanghaiDay(wallTime: number): string {
  return new Date(wallTime + SHANGHAI_OFFSET).toISOString().slice(0, 10);
}
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}
export function previousDay(day: string): string {
  return shanghaiDay(dayStart(day) - DAY_MS);
}
export const LegacyDailyAggregateSchema = z
  .object({
    schema_version: z.literal(1),
    day: DaySchema,
    version_group: VersionGroupSchema,
    active_installation_days: z.literal(1),
    duration_buckets: BucketCountsSchema,
  })
  .strict();
export const ReleaseDailyAggregateSchema = z
  .object({
    schema_version: z.literal(2),
    day: DaySchema,
    platform: UsagePlatformSchema,
    app_version: AppVersionSchema,
    release_channel: ReleaseChannelSchema,
    active_installation_days: z.literal(1),
    duration_buckets: BucketCountsSchema,
  })
  .strict();
export const RetryDailyAggregateSchema = ReleaseDailyAggregateSchema.extend({
  schema_version: z.literal(3),
  report_id: z.uuid(),
}).strict();
export const PreviewDailyAggregateSchema = RetryDailyAggregateSchema.extend({
  schema_version: z.literal(4),
}).strict();
export const PreciseDailyAggregateSchema = RetryDailyAggregateSchema.extend({
  schema_version: z.literal(5),
  notice_version: z.literal(PRECISE_USAGE_NOTICE_VERSION),
  foreground_seconds: z.number().int().min(0).max(86400),
}).strict();
export const RetryPayloadSchema = z.union([RetryDailyAggregateSchema, PreviewDailyAggregateSchema, PreciseDailyAggregateSchema]);
export const DailyAggregateSchema = z
  .discriminatedUnion("schema_version", [
    LegacyDailyAggregateSchema,
    ReleaseDailyAggregateSchema,
    RetryDailyAggregateSchema,
    PreviewDailyAggregateSchema,
    PreciseDailyAggregateSchema,
  ])
  .refine((value) => {
    const total = bucketTotal(value.duration_buckets);
    if (total < 1 || total > 1024) return false;
    if (value.schema_version === 5) {
      const minimum = value.duration_buckets.m1_5 * 60 + value.duration_buckets.m5_15 * 300 + value.duration_buckets.m15_30 * 900 + value.duration_buckets.m30_60 * 1800 + value.duration_buckets.ge_60m * 3600;
      return value.foreground_seconds >= minimum;
    }
    return true;
  }, "Invalid session total");
export type DailyAggregate = z.infer<typeof DailyAggregateSchema>;
export type RetryDailyAggregate = z.infer<typeof RetryPayloadSchema>;
export const DisclosureSchema = z
  .object({
    operator: z.string().trim().max(200),
    contact: z.string().trim().max(300),
    recipient: z.string().trim().max(300),
    region: z.string().trim().max(200),
    retentionMonths: z.number().int().min(1).max(18),
    securityLogNotice: z.string().trim().max(2000),
  })
  .strict();
export type UsageDisclosure = z.infer<typeof DisclosureSchema>;
export const UsageChoiceSchema = z
  .object({
    enabled: z.boolean(),
    noticeVersion: z.string().max(80).optional(),
  })
  .strict();
export type UsageChoice = z.infer<typeof UsageChoiceSchema>;
export const AttemptSchema = z
  .object({
    day: DaySchema,
    result: z.enum(["attempted", "received", "rejected", "unknown"]),
  })
  .strict();
export const UsageStateSchema = z
  .object({
    enabled: z.boolean(),
    noticeVersion: z.string().max(80),
    accepted: z.boolean(),
    available: z.boolean(),
    status: z.enum([
      "pending",
      "disabled",
      "unconfigured",
      "participating",
      "clock-paused",
      "error",
    ]),
    message: z.string().max(500),
    lastAttempt: AttemptSchema.nullable(),
    pendingReports: z.number().int().min(0).max(USAGE_RETRY_DAYS).optional(),
    disclosure: DisclosureSchema,
  })
  .strict();
export type UsageState = z.infer<typeof UsageStateSchema>;

export const USAGE_TERMS = [
  "Windows 版首次使用默认开启使用统计，初始确认页不单独显示统计勾选项；确认包含本说明的软件使用协议及隐私政策后，且统计服务已开放时，软件才开始计时和上报。其他平台默认关闭，须主动确认统计告知后开启。您可在帮助 → 软件使用协议 → 使用统计中查看说明或关闭；已有关闭选择在重启与升级后保留，不会因协议确认而自动恢复。是否参与不影响本地编辑、保存、恢复、导出与打印。",
  "用途是了解参与统计的活跃贡献、累计前台使用时长和时长分布，不是精确人数或实际工作时长。主窗口可见、未最小化且位于前台时计时，阅读也计时；切到其他软件、隐藏、锁屏或休眠时暂停。人离开而窗口仍在前台时可能计入。",
  "软件只在本机累计前台时长，每次进程运行在一个北京时间自然日内累计的前台时长，在退出或跨日时转换为不足1分钟、1至不足5分钟、5至不足15分钟、15至不足30分钟、30至不足60分钟、60分钟及以上的区间次数；不是每人每日总时长。同一天分两次各用10分钟，记为5至不足15分钟2次。上报过去1至7个自然日的活跃贡献、区间次数、运行平台、公开完整软件版本与发行渠道，不发送操作系统精确版本或硬件配置。同日升级沿用该日首次计数的发行版本。本机保留最多32个已结算日期用于防止时间回拨后重复计数，不上报这些日期记录。待发日报按7天补发窗口保存；系统时间异常时暂停并保留待发数据，校正后恢复。断网、超时或服务繁忙时退避补发；同份日报重试沿用随机上报凭据，服务端幂等计入一次。本版本采用协议5，上报上一自然日累计前台时长（整秒），不发送逐次操作时间或精确起止时间：重新同意本告知后，次日起仅授权管理员可查看收到的活跃贡献数量和各运行时长档次数，包括不足10份的精确汇总；允许按版本及跨版本、跨日累计记录，不作去重人数解释。补发期间数量可能变化，第8天（D+8）生成固定日报。旧告知下的数据继续按原门槛和区间展示，不重新解释或改写旧日报。这些措施不构成完全匿名或差分隐私保证。超过补发窗口、关闭统计或状态存储故障仍可能漏记，不代表全部用户或精确人数。",
  "统计不发送专利文档、客户信息、文件名、路径、输入内容、截图或精确起止时间，不生成稳定账号、设备、安装或跨日会话标识。每份日报生成独立随机上报凭据，仅用于同份日报补发去重；服务端保存凭据及载荷的摘要，补发窗口关闭后例行删除。接收诊断只保留日期、结果类型和计数30天，诊断结果不对公众开放；授权管理员的协议5日报可显示少量记录，旧协议仍保留原保护规则；汇总业务数据最长保留18个月。最新一致性备份中的短期摘要会随每日备份替换，不提供长期历史副本。凭据不能证明不同真人或安装身份。连接会涉及来源IP与网络时间等必要安全信息，不能承诺全过程匿名。",
  "您可以选择关闭统计并继续，也可以随时在帮助 → 软件使用协议 → 使用统计中关闭。关闭立即停止计时并取消后续上报，未发送计数被丢弃，关闭选择在重启与升级后保留。已进入汇总的贡献没有个人标识，无法按个人定位删除。",
] as const;

export type SafeDistribution = { labels: string[]; counts: number[] } | null;
/** One complete hierarchy only; never publish a total alongside suppressed cells. */
export function safeDurationDistribution(counts: number[], threshold = 10): SafeDistribution {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = counts;
  const levels = [
    {
      labels: ["不足1分钟", "1–5分钟", "5–15分钟", "15–30分钟", "30–60分钟", "60分钟以上"],
      counts: [a, b, c, d, e, f],
    },
    { labels: ["不足5分钟", "5–30分钟", "30分钟以上"], counts: [a + b, c + d, e + f] },
    { labels: ["不足30分钟", "30分钟以上"], counts: [a + b + c + d, e + f] },
  ];
  return (
    levels.find(
      (level) =>
        level.counts.some((n) => n > 0) && level.counts.every((n) => n === 0 || n >= threshold),
    ) ?? null
  );
}
