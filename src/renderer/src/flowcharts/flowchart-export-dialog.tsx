import { RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FigureExportDialog } from "../shared/figure-export-dialog";
import { FigureReplacementDialog } from "../shared/figure-replacement-dialog";
import { SpatialPresence } from "../shared/spatial-presence";
import { FlowchartImagePreview } from "./flowchart-image-preview";

export type FlowchartFigureOption = {
  figureId: string;
  assetId: string;
  label: string;
  widthMm: number;
  rotationDeg?: 0 | 90 | 180 | 270 | undefined;
};
export type FlowchartExportTarget =
  | { kind: "new"; insertIndex: number }
  | { kind: "replace"; figureId: string; assetId: string };

type PreviewRequest = {
  scope: "page" | "selection";
  selectedCellIds: string[];
  borderMm: number;
  outputWidthMm?: number | undefined;
  target: FlowchartExportTarget;
};

type PreviewResult = {
  previewToken: string;
  previewUrl: string;
  warnings: string[];
  outputWidthMm?: number | undefined;
  rotationDeg?: 0 | 90 | 180 | 270;
};

type FlowchartExportDialogProps = {
  mode?: "insert" | "replace";
  sessionId?: string;
  figureOptions: readonly FlowchartFigureOption[];
  selectedCellIds: readonly string[];
  defaultReplaceFigureId?: string | undefined;
  onPreview(request: PreviewRequest): Promise<PreviewResult>;
  onConfirm(previewToken: string): Promise<void>;
  onCancel(): void;
};

export function FlowchartExportDialog(props: Readonly<FlowchartExportDialogProps>) {
  return props.mode === "replace" ? (
    <FlowchartReplacementDialog {...props} />
  ) : (
    <FlowchartInsertDialog {...props} />
  );
}

function FlowchartInsertDialog({
  figureOptions,
  selectedCellIds,
  onPreview,
  onConfirm,
  onCancel,
}: Readonly<FlowchartExportDialogProps>) {
  const scopeId = useId();
  const targetId = useId();
  const [scope, setScope] = useState<"page" | "selection">("page");
  const [insertIndex, setInsertIndex] = useState(figureOptions.length);
  const [borderMm, setBorderMm] = useState(2);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const previewRequestVersionRef = useRef(0);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);

  const insertPositions = useMemo(
    () => [
      ...figureOptions.map((figure, index) => ({ key: `before-${figure.figureId}`, index })),
      { key: "end", index: figureOptions.length },
    ],
    [figureOptions],
  );
  const target = useMemo<FlowchartExportTarget>(
    () => ({ kind: "new", insertIndex }),
    [insertIndex],
  );
  const confirmLabel = `添加为图 ${insertIndex + 1}`;

  const selectedCellIdsKey = selectedCellIds.join("\u0000");
  const selectedIdsForPreview = useMemo(
    () => (selectedCellIdsKey ? selectedCellIdsKey.split("\u0000") : []),
    [selectedCellIdsKey],
  );
  useEffect(() => {
    // The manual refresh button advances this value to deliberately re-run the effect.
    void refreshVersion;
    if (!target || borderMm < 0 || borderMm > 20) {
      setPreview(null);
      setBusy(false);
      return;
    }
    const requestVersion = previewRequestVersionRef.current + 1;
    previewRequestVersionRef.current = requestVersion;
    let cancelled = false;
    setPreview(null);
    setBusy(true);
    setError(null);
    void onPreviewRef
      .current({
        scope,
        selectedCellIds: scope === "selection" ? selectedIdsForPreview : [],
        borderMm,
        target,
      })
      .then((result) => {
        if (!cancelled && previewRequestVersionRef.current === requestVersion) setPreview(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled && previewRequestVersionRef.current === requestVersion) {
          setError(reason instanceof Error ? reason.message : "无法生成专利附图预览。");
        }
      })
      .finally(() => {
        if (!cancelled && previewRequestVersionRef.current === requestVersion) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [borderMm, refreshVersion, scope, selectedIdsForPreview, target]);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(preview.previewToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法导入说明书附图。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FigureExportDialog
      open
      title="插入到说明书附图"
      onCancel={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !preview}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
        </>
      }
      options={
        <>
          <fieldset className="flowchart-export-section">
            <legend>导出范围</legend>
            <div className="flowchart-export-choice-grid">
              <label className="flowchart-export-choice-card">
                <input
                  type="radio"
                  name={scopeId}
                  checked={scope === "page"}
                  onChange={() => setScope("page")}
                />
                <span>
                  <strong>当前页面</strong>
                </span>
              </label>
              <label
                className="flowchart-export-choice-card"
                title={selectedCellIds.length === 0 ? "请先在画布中选择对象" : undefined}
              >
                <input
                  type="radio"
                  name={scopeId}
                  aria-label="当前选取"
                  checked={scope === "selection"}
                  disabled={selectedCellIds.length === 0}
                  onChange={() => setScope("selection")}
                />
                <span>
                  <strong>当前选取</strong>
                </span>
              </label>
            </div>
          </fieldset>
          <fieldset className="flowchart-export-section">
            <legend>插入设置</legend>
            <div className="flowchart-export-settings-grid">
              <label className="flowchart-export-field" htmlFor={`${targetId}-figure`}>
                <span>插入位置</span>
                <select
                  id={`${targetId}-figure`}
                  value={insertIndex}
                  disabled={busy}
                  onChange={(event) => setInsertIndex(Number(event.target.value))}
                >
                  {insertPositions.map((position) => (
                    <option key={position.key} value={position.index}>
                      作为图 {position.index + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flowchart-export-field">
                <span>四周留白</span>
                <span className="flowchart-input-with-suffix">
                  <input
                    aria-label="四周留白（外边距）"
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={borderMm}
                    onChange={(event) => setBorderMm(Number(event.target.value))}
                  />
                  <span>mm</span>
                </span>
              </label>
            </div>
          </fieldset>
          <SpatialPresence>
            {error ? (
              <p className="flowchart-export-error" role="alert">
                {error}
              </p>
            ) : null}
          </SpatialPresence>
        </>
      }
    >
      <FlowchartImagePreview
        src={preview?.previewUrl ?? null}
        outputWidthMm={preview?.outputWidthMm}
        rotationDeg={preview?.rotationDeg}
        alt="最终黑白专利附图预览"
        fitOnLoad
        busy={busy && !preview}
        message="暂时无法显示黑白专利附图预览"
        title={
          <span>
            成图预览 <small>黑白</small>
          </span>
        }
        actions={
          <button
            type="button"
            className="flowchart-export-refresh"
            aria-label={busy ? "正在生成预览" : "刷新预览"}
            title="刷新预览"
            disabled={busy || !target || borderMm < 0 || borderMm > 20}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        }
      />
      {preview?.warnings.length ? (
        <div className="flowchart-export-preview__notes">
          {preview.warnings.map((warning) => (
            <p className="flowchart-warning" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </FigureExportDialog>
  );
}

function FlowchartReplacementDialog({
  sessionId,
  figureOptions,
  selectedCellIds,
  defaultReplaceFigureId,
  onPreview,
  onConfirm,
  onCancel,
}: Readonly<FlowchartExportDialogProps>) {
  const [scope, setScope] = useState<"page" | "selection">("page");
  const [borderMm, setBorderMm] = useState(2);
  const scopeId = useId();
  if (!sessionId) throw new Error("替换附图需要专利会话。");
  const validBorder = Number.isFinite(borderMm) && borderMm >= 0 && borderMm <= 20;
  return (
    <FigureReplacementDialog
      sessionId={sessionId}
      figures={figureOptions}
      defaultFigureId={defaultReplaceFigureId}
      sourceLabel="流程图"
      previewAlt="流程图成图预览"
      interactivePreview
      previewKey={JSON.stringify([scope, borderMm, selectedCellIds])}
      widthNote="参考原图宽度，超出页面时自动适配；新图方向以右侧预览为准。"
      controls={
        <>
          <label>
            <input
              type="radio"
              name={scopeId}
              checked={scope === "page"}
              onChange={() => setScope("page")}
            />
            当前页面
          </label>
          <label>
            <input
              type="radio"
              name={scopeId}
              aria-label="当前选取"
              checked={scope === "selection"}
              disabled={!selectedCellIds.length}
              onChange={() => setScope("selection")}
            />
            当前选取
          </label>
          <label>
            四周留白
            <input
              aria-label="四周留白（外边距）"
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={borderMm}
              onChange={(e) => setBorderMm(Number(e.target.value))}
            />
            mm
          </label>
        </>
      }
      onPreview={async (target) => {
        if (!validBorder) throw new Error("四周留白需在 0–20 mm 之间。");
        const result = await onPreview({
          scope,
          selectedCellIds: scope === "selection" ? [...selectedCellIds] : [],
          borderMm,
          outputWidthMm: target.widthMm,
          target: { kind: "replace", figureId: target.figureId, assetId: target.assetId },
        });
        return {
          url: result.previewUrl,
          value: result.previewToken,
          outputWidthMm: result.outputWidthMm,
          rotationDeg: result.rotationDeg ?? 0,
          note: result.warnings.length ? result.warnings.join("；") : "黑白成图预览",
        };
      }}
      onConfirm={async (_target, token) => onConfirm(token)}
      onCancel={onCancel}
    />
  );
}
