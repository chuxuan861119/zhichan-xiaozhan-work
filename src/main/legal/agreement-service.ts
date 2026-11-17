import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  type AgreementAccept,
  AgreementAcceptSchema,
  type AgreementRecord,
  AgreementRecordSchema,
  type AgreementState,
  agreementDecision,
  type LegalPolicy,
} from "../../shared/legal/model.js";
import type { UsageStatisticsService } from "../usage-statistics/usage-statistics-service.js";

type Options = {
  statePath: string;
  appVersion: string;
  platform?: string;
  policy: LegalPolicy;
  usage?: Pick<
    UsageStatisticsService,
    "read" | "choose" | "setSessionAllowed" | "hasConsentHistory"
  >;
  bypass?: boolean;
  write?: (value: string) => Promise<void>;
};
export class AgreementService {
  private record: AgreementRecord | null = null;
  private loaded = false;
  private legacyConsent = false;
  private legacyHistory = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Options) {
    options.usage?.setSessionAllowed(false);
  }
  private async load() {
    if (this.loaded) return;
    try {
      this.record = AgreementRecordSchema.parse(
        JSON.parse(await readFile(this.options.statePath, "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error("无法读取协议确认记录，请重试；原记录未被覆盖。", { cause: error });
    }
    const usage = await this.options.usage?.read();
    this.legacyConsent = usage?.accepted ?? false;
    this.legacyHistory = this.options.usage?.hasConsentHistory() ?? false;
    this.loaded = true;
  }
  private async state(): Promise<AgreementState> {
    await this.load();
    const statistics = (await this.options.usage?.read()) ?? null;
    const decision = agreementDecision(
      this.record,
      this.options.appVersion,
      this.options.policy,
      statistics?.noticeVersion ?? null,
      this.record
        ? (this.options.usage?.hasConsentHistory() ?? this.legacyHistory)
        : this.legacyConsent,
    );
    if (
      this.options.platform === "win32" &&
      this.record &&
      statistics?.enabled &&
      (this.record.statisticsNoticeVersion !== statistics.noticeVersion ||
        (statistics.available && !statistics.accepted && statistics.status !== "error"))
    ) {
      decision.needsConfirmation = true;
      decision.reason = "policy-update";
    }
    if (this.options.bypass) {
      decision.needsConfirmation = false;
      decision.reason = "none";
    }
    if (this.options.platform === "win32") decision.showStatistics = false;
    return {
      appVersion: this.options.appVersion,
      policy: this.options.policy,
      ...decision,
      statistics,
    };
  }
  async read(): Promise<AgreementState> {
    await this.queue;
    const state = await this.state();
    this.options.usage?.setSessionAllowed(!state.needsConfirmation);
    return state;
  }
  accept(input: AgreementAccept): Promise<AgreementState> {
    const operation = this.queue.then(async (): Promise<AgreementState> => {
      const request = AgreementAcceptSchema.parse(input);
      const state = await this.state();
      if (
        request.appVersion !== state.appVersion ||
        request.termsVersion !== state.policy.termsVersion ||
        request.privacyVersion !== state.policy.privacyVersion
      )
        throw new Error("协议版本已变化，请重新阅读并确认。");
      if (!state.needsConfirmation) return state;
      const usage = this.options.usage;
      if (state.showStatistics && request.participate) {
        if (
          !usage ||
          !state.statistics?.available ||
          request.statisticsNoticeVersion !== state.statistics.noticeVersion
        )
          throw new Error("统计服务或告知尚未准备完成，请取消统计选择后继续。");
      }
      let statistics = state.statistics;
      if (
        this.options.platform === "win32" &&
        usage &&
        statistics?.enabled &&
        statistics.available &&
        !statistics.accepted &&
        statistics.status !== "error"
      ) {
        statistics = await usage.choose({ enabled: true, noticeVersion: statistics.noticeVersion });
        if (statistics.status === "error") throw new Error(statistics.message);
      }
      if (state.showStatistics && usage) {
        statistics = await usage.choose({
          enabled: request.participate === true,
          ...(request.participate ? { noticeVersion: request.statisticsNoticeVersion } : {}),
        });
        if (statistics.status === "error") throw new Error(statistics.message);
      }
      const record: AgreementRecord = {
        schemaVersion: 1,
        appVersion: state.appVersion,
        termsVersion: state.policy.termsVersion,
        privacyVersion: state.policy.privacyVersion,
        statisticsNoticeVersion: statistics?.noticeVersion ?? null,
        everStatisticsConsent: Boolean(
          this.record?.everStatisticsConsent ||
            (this.options.usage?.hasConsentHistory() ?? this.legacyHistory) ||
            (state.showStatistics && request.participate && statistics?.accepted),
        ),
      };
      const text = `${JSON.stringify(record)}\n`;
      if (this.options.write) await this.options.write(text);
      else {
        await mkdir(dirname(this.options.statePath), { recursive: true });
        await writeFileAtomic(this.options.statePath, text, { encoding: "utf8", mode: 0o600 });
      }
      this.record = record;
      usage?.setSessionAllowed(true);
      return { ...state, statistics, needsConfirmation: false, reason: "none" };
    });
    // Keep retries usable while returning failures to the IPC caller.
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
