import { Settings2, ShieldCheck, X } from "lucide-react";

type DataSafetyGuideProps = {
  backupEnabled: boolean;
  snapshotEnabled: boolean;
  onOpenSettings(): void;
  onDismiss(): void;
};

type DataSafetyGuideOffer = {
  hasOpenPatent: boolean;
  dismissed: boolean;
  backupEnabled: boolean;
  snapshotEnabled: boolean;
  suppressedByHigherPriorityOverlay?: boolean;
};

export const DATA_SAFETY_GUIDE_SNOOZED_KEY = "patent-workbench:data-safety-guide-snoozed:v1";

export function shouldOfferDataSafetyGuide({
  hasOpenPatent,
  dismissed,
  backupEnabled,
  snapshotEnabled,
  suppressedByHigherPriorityOverlay = false,
}: DataSafetyGuideOffer): boolean {
  return (
    hasOpenPatent &&
    !dismissed &&
    !suppressedByHigherPriorityOverlay &&
    (!backupEnabled || !snapshotEnabled)
  );
}

export function DataSafetyGuide({
  backupEnabled,
  snapshotEnabled,
  onOpenSettings,
  onDismiss,
}: DataSafetyGuideProps) {
  const title =
    !backupEnabled && !snapshotEnabled
      ? "建议完善数据保护"
      : !backupEnabled
        ? "建议开启定时备份"
        : "建议开启快照";
  const message =
    !backupEnabled && !snapshotEnabled
      ? "快照和定时备份尚未开启。建议开启后再开始正式撰写。"
      : !backupEnabled
        ? "为了数据安全，建议开启定时备份。"
        : "定时备份功能已启用，请在备份文件列表确认已有可用备份。快照尚未开启，开启后可找回文档的历史版本。";
  const actionLabel =
    !backupEnabled && !snapshotEnabled ? "去设置" : !backupEnabled ? "设置定时备份" : "设置快照";

  return (
    <section role="status" aria-label="数据安全提示" className="data-safety-guide">
      <button
        type="button"
        className="data-safety-guide__close"
        aria-label="暂时关闭数据安全提示"
        title="稍后设置"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <div className="data-safety-guide__header">
        <span className="data-safety-guide__icon" aria-hidden="true">
          <ShieldCheck size={22} strokeWidth={1.7} />
        </span>
        <div>
          <span className="data-safety-guide__eyebrow">数据保护</span>
          <h2 className="data-safety-guide__title">{title}</h2>
        </div>
      </div>
      <p className="data-safety-guide__message">{message}</p>
      <div className="data-safety-guide__actions">
        <button type="button" className="data-safety-guide__secondary" onClick={onDismiss}>
          稍后设置
        </button>
        <button type="button" className="primary-button" onClick={onOpenSettings}>
          <Settings2 size={14} aria-hidden="true" />
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
