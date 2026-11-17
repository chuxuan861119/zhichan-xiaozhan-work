import type { DataTransferProgress as DataTransferProgressValue } from "../../../shared/data-transfer/model";
import { SpatialPresence } from "../shared/spatial-presence";

const PHASE_LABELS: Record<DataTransferProgressValue["phase"], string> = {
  idle: "准备开始",
  inspecting: "正在检查数据",
  "quiescing-writes": "正在等待编辑保存完成",
  checkpointing: "正在生成一致性副本",
  "collecting-data": "正在收集数据",
  compressing: "正在压缩数据",
  encrypting: "正在加密数据",
  "verifying-package": "正在验证完整数据包",
  "publishing-package": "正在保存已验证的数据包，请勿移动目标文件",
  "reading-header": "正在读取数据包信息",
  decrypting: "正在解密数据",
  "extracting-to-staging": "正在安全暂存数据",
  "validating-files": "正在验证文件",
  "validating-database": "正在验证数据库",
  "validating-domain-data": "正在验证专利数据",
  "preparing-local-data": "正在准备本地数据",
  "preview-ready": "验证完成，可以确认导入",
  "preparing-swap": "正在准备安全切换",
  swapping: "正在安全切换数据",
  "restart-pending": "正在重新启动",
  "post-start-validation": "正在完成启动后验证",
  completed: "迁移完成",
  cancelled: "迁移已取消",
  failed: "迁移未完成",
};

const CATEGORY_LABELS: Record<DataTransferProgressValue["currentCategory"], string> = {
  database: "数据库",
  assets: "附件与图片",
  settings: "可移植设置",
  verification: "完整性验证",
  switching: "安全切换",
};

type TransferProgressProps = Readonly<{
  progress: DataTransferProgressValue;
  onCancel?: () => void;
}>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} GB`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function TransferProgress({ progress, onCancel }: TransferProgressProps) {
  const totalBytes = progress.totalBytes;
  const hasKnownTotal = totalBytes !== null && totalBytes > 0;
  const percentage =
    totalBytes !== null && totalBytes > 0
      ? Math.min(100, Math.max(0, Math.floor((progress.completedBytes / totalBytes) * 100)))
      : null;
  const phaseLabel = PHASE_LABELS[progress.phase];

  const metaParts = [
    hasKnownTotal
      ? `已处理 ${formatBytes(progress.completedBytes)} / ${formatBytes(totalBytes)}`
      : `已处理 ${formatBytes(progress.completedBytes)}`,
    progress.remainingMs !== null ? `预计剩余 ${formatDuration(progress.remainingMs)}` : null,
    `已用时 ${formatDuration(progress.elapsedMs)}`,
  ].filter((part) => part !== null);

  return (
    <section className="data-transfer-progress" aria-label="迁移进度">
      <div className="data-transfer-progress__heading">
        <p aria-live="polite" aria-atomic="true">
          {phaseLabel}
        </p>
        <span className="data-transfer-progress__category">
          {CATEGORY_LABELS[progress.currentCategory]}
        </span>
      </div>
      {hasKnownTotal && percentage !== null ? (
        <div className="data-transfer-progress__meter">
          <progress
            className="data-transfer-progress__bar"
            value={progress.completedBytes}
            max={totalBytes ?? undefined}
            aria-label={`${phaseLabel} ${percentage}%`}
          />
          <strong>{percentage}%</strong>
        </div>
      ) : (
        <div className="data-transfer-progress__indeterminate" aria-hidden="true">
          <span />
        </div>
      )}
      <p className="data-transfer-progress__meta">{metaParts.join(" · ")}</p>
      <SpatialPresence>
        {progress.phase === "failed" ? (
          <p className="data-transfer-progress__failure" role="alert">
            迁移未完成。原数据保持不变，请根据提示重试。
          </p>
        ) : null}
      </SpatialPresence>
      {progress.cancellable && onCancel ? (
        <button type="button" className="data-transfer-progress__cancel" onClick={onCancel}>
          取消迁移
        </button>
      ) : null}
    </section>
  );
}
