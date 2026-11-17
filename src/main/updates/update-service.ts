import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  compareVersions,
  parseVersion,
  StableVersionSchema,
  UpdateFeedSchema,
  type UpdateState,
} from "../../shared/updates/model.js";

export type UpdateConfig = {
  feedUrl: string;
  downloadOrigins: string[];
  channel?: "stable" | "preview";
};
const HistorySchema = z
  .object({
    lastCheckedAt: z.iso.datetime().nullable().default(null),
    skippedVersion: StableVersionSchema.nullable().default(null),
    postponedVersion: StableVersionSchema.nullable().default(null),
    remindAfter: z.number().finite().nonnegative().default(0),
  })
  .strict();
type Options = {
  currentVersion: string;
  platform: string;
  arch: string;
  statePath: string;
  config: UpdateConfig;
  readEnabled(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  unconfiguredMessage?: string;
  automaticAllowed: boolean;
  fetcher?: typeof fetch;
  startupDelayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  onChanged?(state: UpdateState): void;
};
const DAY = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 2 * 60 * 60 * 1000;
export class SoftwareUpdateService {
  private snapshot: UpdateState;
  private history = HistorySchema.parse({});
  private initialized: Promise<void>;
  private persistence = Promise.resolve();
  private enabled = true;
  private started = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private pending: Promise<UpdateState> | undefined;
  private manual = false;
  private epoch = 0;
  private notifiedVersion: string | null = null;
  constructor(private readonly options: Options) {
    this.snapshot = {
      currentVersion: options.currentVersion,
      channel: options.config.channel ?? "stable",
      status: "idle",
      release: null,
      lastCheckedAt: null,
      message: "尚未检查更新",
      notification: false,
      sourceHost: null,
    };
    this.initialized = readFile(options.statePath, "utf8")
      .then((value) => {
        this.history = HistorySchema.parse(JSON.parse(value));
        this.snapshot.lastCheckedAt = this.history.lastCheckedAt;
      })
      .catch(() => {});
  }
  state(): UpdateState {
    return structuredClone(this.snapshot);
  }
  async read(): Promise<UpdateState> {
    await this.initialized;
    return this.state();
  }
  private publish(patch: Partial<UpdateState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChanged?.(this.state());
  }
  start(enabled: boolean) {
    if (this.closed || this.started) return;
    this.started = true;
    this.enabled = enabled;
    this.schedule(true);
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.epoch++;
    this.enabled = enabled;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!enabled) {
      this.controller?.abort();
      this.publish({
        notification: false,
        ...(this.pending ? { status: "idle", release: null, message: "自动检测已关闭" } : {}),
      });
    } else if (this.started) this.schedule(true);
  }
  private schedule(initial = false, remainingMs?: number) {
    if (this.closed || !this.enabled || !this.options.automaticAllowed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const epoch = this.epoch;
        void this.automaticTick(initial)
          .catch(() => {})
          .finally(() => {
            if (epoch === this.epoch && !this.timer) this.schedule();
          });
      },
      remainingMs ??
        (initial
          ? (this.options.startupDelayMs ?? 10_000)
          : (this.options.intervalMs ?? CHECK_INTERVAL)),
    );
    this.timer.unref?.();
  }
  private async automaticTick(startup = false) {
    await this.initialized;
    const elapsed = this.history.lastCheckedAt
      ? Date.now() - Date.parse(this.history.lastCheckedAt)
      : Infinity;
    const interval = this.options.intervalMs ?? CHECK_INTERVAL;
    if (!startup && elapsed >= 0 && elapsed < interval) {
      this.schedule(false, interval - elapsed);
      return;
    }
    await this.check("automatic");
  }
  async check(reason: "manual" | "automatic" = "manual"): Promise<UpdateState> {
    await this.initialized;
    if (this.closed) return this.state();
    if (
      reason === "automatic" &&
      (!this.enabled || !this.options.automaticAllowed || !(await this.options.readEnabled()))
    )
      return this.state();
    if (this.closed || (reason === "automatic" && !this.enabled)) return this.state();
    if (this.pending) {
      if (reason === "manual") this.manual = true;
      return this.pending;
    }
    this.manual = reason === "manual";
    const operation = this.performCheck();
    this.pending = operation;
    try {
      return await operation;
    } finally {
      if (this.pending === operation) this.pending = undefined;
    }
  }
  private secureUrl(value: string, download = false): URL {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Invalid update URL");
    if (download && !this.options.config.downloadOrigins.includes(url.origin))
      throw new Error("Untrusted download origin");
    return url;
  }
  private async performCheck(): Promise<UpdateState> {
    const epoch = this.epoch;
    const config = this.options.config;
    if (!config.feedUrl || !config.downloadOrigins.length) {
      this.publish({
        status: "unconfigured",
        release: null,
        notification: false,
        message: this.options.unconfiguredMessage ?? "更新服务尚未开放，开放后可在此检查新版本。",
      });
      return this.state();
    }
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const url = this.secureUrl(config.feedUrl);
      this.publish({
        status: "checking",
        release: null,
        notification: false,
        message: "正在检查新版本…",
        sourceHost: url.hostname,
      });
      const response = await (this.options.fetcher ?? fetch)(url.href, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 262144)
        throw new Error("Invalid update response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262144) throw new Error("Update response too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const feed = UpdateFeedSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (feed.channel !== (config.channel ?? "stable")) throw new Error("Update channel mismatch");
      const releases = feed.releases.filter(
        (entry) => entry.platform === this.options.platform && entry.arch === this.options.arch,
      );
      for (const entry of releases) this.secureUrl(entry.downloadUrl, true);
      releases.sort((a, b) => compareVersions(b.version, a.version));
      if (controller.signal.aborted || this.closed || epoch !== this.epoch) return this.state();
      const newest = releases[0];
      const release =
        newest && compareVersions(newest.version, this.options.currentVersion) > 0 ? newest : null;
      const checkedAt = new Date().toISOString();
      await this.persist({ lastCheckedAt: checkedAt });
      if (controller.signal.aborted || this.closed || epoch !== this.epoch) return this.state();
      const notification = Boolean(
        release &&
          !this.manual &&
          this.enabled &&
          this.notifiedVersion !== release.version &&
          this.history.skippedVersion !== release.version &&
          !(
            this.history.postponedVersion === release.version &&
            this.history.remindAfter > Date.now()
          ),
      );
      if (notification) this.notifiedVersion = release?.version ?? null;
      this.publish({
        status: !newest ? "unavailable" : release ? "available" : "latest",
        release,
        lastCheckedAt: checkedAt,
        notification,
        message: !newest
          ? "暂未发布适用于当前系统和架构的版本。"
          : release
            ? `发现新版本 ${release.version}`
            : config.channel === "preview"
              ? "当前已是最新预览版本"
              : parseVersion(this.options.currentVersion)?.pre.length
                ? "暂无可升级的稳定版本"
                : "当前已是最新稳定版本",
      });
    } catch {
      if (!this.closed && epoch === this.epoch)
        this.publish({
          status: "error",
          release: null,
          notification: false,
          message: "暂时无法检查更新，请检查网络后重试。编辑和保存不受影响。",
        });
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
    }
    return this.state();
  }
  private persist(patch: Partial<typeof this.history>): Promise<void> {
    const operation = this.persistence
      .catch(() => {})
      .then(async () => {
        const nextHistory = { ...this.history, ...patch };
        await mkdir(dirname(this.options.statePath), { recursive: true });
        await writeFileAtomic(this.options.statePath, JSON.stringify(nextHistory, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        this.history = nextHistory;
      });
    this.persistence = operation;
    return operation;
  }
  async dismiss(version: string, action: "later" | "skip"): Promise<UpdateState> {
    await this.initialized;
    if (this.snapshot.release?.version !== version) throw new Error("Update no longer available");
    const patch =
      action === "skip"
        ? { skippedVersion: version }
        : { postponedVersion: version, remindAfter: Date.now() + DAY };
    this.publish({ notification: false });
    try {
      await this.persist(patch);
    } catch (error) {
      this.publish({ message: "提醒已关闭，但未能保存提醒偏好。请检查本机存储后重试。" });
      throw error;
    }
    return this.state();
  }
  async openDownload(version: string): Promise<void> {
    const release = this.snapshot.release;
    if (this.closed || this.snapshot.status !== "available" || release?.version !== version)
      throw new Error("Update no longer available");
    await this.options.openExternal(this.secureUrl(release.downloadUrl, true).href);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.pending;
    await this.persistence.catch(() => {});
  }
}
