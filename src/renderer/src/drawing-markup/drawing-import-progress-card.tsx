import { useEffect, useState } from "react";
import {
  DRAWING_IMPORT_PHASE_LABELS,
  type DrawingImportProgressEvent,
} from "../../../shared/drawing-markup/import-progress";
import { useReducedMotion } from "../shared/use-reduced-motion";

const countLabels: Partial<
  Record<DrawingImportProgressEvent["stage"]["phase"], readonly [string, string]>
> = {
  read: ["已读取图纸内部对象", "个"],
  draw: ["已处理图形", "个"],
  svg: ["已处理绘图指令", "条"],
  serialize: ["已整理预览分块", "个"],
  preview: ["已准备预览分块", "个"],
};

function duration(milliseconds: number) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}秒`
    : `${Math.floor(seconds / 60)}分${seconds % 60 ? `${seconds % 60}秒` : ""}`;
}
export function DrawingImportProgressCard({
  progress,
  message,
}: {
  progress: DrawingImportProgressEvent | null;
  message: string;
}) {
  const reducedMotion = useReducedMotion();
  const cancelling = message.startsWith("正在取消");
  const stage = progress?.stage;
  const countLabel = stage && countLabels[stage.phase];
  const measurable = stage?.total !== null && stage?.total !== undefined;
  return (
    <>
      <span
        className="drawing-import-progress__spinner"
        style={reducedMotion ? { animation: "none" } : undefined}
        aria-hidden="true"
      />
      <div className="drawing-import-progress__body">
        <p className="drawing-import-progress__title">
          {cancelling ? "正在取消导入" : "正在导入图纸"}
        </p>
        <p className="drawing-import-progress__detail">{message}</p>
        <p className="drawing-import-progress__stage" aria-live="polite">
          {cancelling
            ? "正在停止处理并释放临时资源"
            : `${DRAWING_IMPORT_PHASE_LABELS[stage?.phase ?? "prepare"]}${progress?.waitingForActivity ? " · 可继续等待或取消" : ""}`}
        </p>
        <div
          className="drawing-import-progress__bar"
          role="progressbar"
          aria-label="图纸导入预计进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={measurable ? progress?.overallPercent : undefined}
          aria-valuetext={
            measurable && progress ? `预计总体进度 ${progress.overallPercent}%` : "正在处理"
          }
        >
          <span style={{ width: `${progress?.overallPercent ?? 0}%` }} />
        </div>
        <p className="drawing-import-progress__detail drawing-import-progress__metric">
          {measurable && progress ? `预计总体进度 ${progress.overallPercent}% · ` : ""}
          已用{progress ? duration(progress.elapsedMs) : "0秒"}
        </p>
        <p
          className="drawing-import-progress__detail drawing-import-progress__metric"
          title={
            !cancelling && stage?.phase === "read"
              ? "图纸内部对象包括线条、文字、图层等数据，数量不代表文件数量。"
              : undefined
          }
        >
          {cancelling ? (
            "正在取消当前步骤"
          ) : countLabel && stage?.completed !== null && stage?.completed !== undefined ? (
            <>
              {countLabel[0]} {stage.completed.toLocaleString()}
              {stage.total ? ` / ${stage.total.toLocaleString()}` : ""} {countLabel[1]}
            </>
          ) : (
            "当前步骤处理中"
          )}
        </p>
      </div>
    </>
  );
}

export function DrawingImportProgressSurface({
  sessionId,
  operation,
  message,
}: {
  sessionId: string;
  operation: { id: string; cancelled: boolean } | null;
  message: string;
}) {
  const [progress, setProgress] = useState<DrawingImportProgressEvent | null>(null);
  useEffect(() => {
    setProgress(null);
    let active = true;
    const unsubscribe = window.patentApi.assets.onDrawingImportProgress?.((event) => {
      if (
        active &&
        event.sessionId === sessionId &&
        event.operationId === operation?.id &&
        !operation.cancelled
      )
        setProgress(event);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [sessionId, operation]);
  return <DrawingImportProgressCard progress={progress} message={message} />;
}
