import type { FullDataExportResult } from "../../../shared/data-transfer/model";
import type { AppError } from "../../../shared/ipc/result";
import { isHarmonyPlatform } from "../../../shared/platform";

type TransferResultProps =
  | Readonly<{
      outcome: "success";
      result: FullDataExportResult;
      onDone?: () => void;
    }>
  | Readonly<{
      outcome: "cancelled";
      onRetry?: () => void;
    }>
  | Readonly<{
      outcome: "failure";
      error: AppError;
      onRetry?: () => void;
    }>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} GB`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function TransferResult(props: TransferResultProps) {
  if (props.outcome === "success") {
    return (
      <section className="data-transfer-result data-transfer-result--success">
        <h3>完整数据包已生成</h3>
        <p className="data-transfer-result__verification">完整性验证通过</p>
        <dl className="data-transfer-result__details">
          <div>
            <dt>保存位置</dt>
            <dd>{props.result.displayPath}</dd>
          </div>
          <div>
            <dt>数据包大小</dt>
            <dd>{formatBytes(props.result.sizeBytes)}</dd>
          </div>
          <div>
            <dt>数据截止时间</dt>
            <dd>
              <time dateTime={props.result.cutoffAt}>{formatDateTime(props.result.cutoffAt)}</time>
            </dd>
          </div>
          <div>
            <dt>数据包格式</dt>
            <dd>格式版本 {props.result.packageFormatVersion}</dd>
          </div>
        </dl>
        <div className="data-transfer-result__summary">
          <p>请把数据包和密码分开保存，并在另一台电脑完成导入前保留原专利库。</p>
        </div>
        {props.onDone ? (
          <button type="button" className="primary-button" onClick={props.onDone}>
            完成
          </button>
        ) : null}
      </section>
    );
  }

  if (props.outcome === "cancelled") {
    return (
      <section className="data-transfer-result data-transfer-result--cancelled">
        <h3>已取消导出</h3>
        <div className="data-transfer-result__summary">
          <p>导出已停止。</p>
          <p>原专利库未改变、未生成正式数据包。</p>
          <p>如仍需迁移，可以重新选择保存位置后再试。</p>
        </div>
        {props.onRetry ? (
          <button type="button" onClick={props.onRetry}>
            返回重试
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="data-transfer-result data-transfer-result--failure">
      <h3>完整数据包未生成</h3>
      <div className="data-transfer-result__summary">
        <p>{props.error.message}</p>
        <p>原专利库未改变、未生成正式数据包。</p>
        {isHarmonyPlatform() ? (
          <p>目标位置可能保留未完成的新文件，请勿用于迁移；重新导出时请选择新的文件名。</p>
        ) : null}
        <p>{props.error.nextAction ?? "请检查保存位置后重试。"}</p>
      </div>
      {props.onRetry ? (
        <button type="button" onClick={props.onRetry}>
          返回重试
        </button>
      ) : null}
    </section>
  );
}
