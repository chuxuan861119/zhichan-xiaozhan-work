import { ArrowRight, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { PatentFigure } from "../../../shared/patent/model";
import { FlowchartImagePreview } from "../flowcharts/flowchart-image-preview";
import { AssetPreview } from "../patents/editors/asset-preview";
import { SpatialPresence } from "./spatial-presence";
import { StandardDialog } from "./standard-dialog";
import "../drawing-markup/drawing-replace-dialog.css";

export type ReplacementFigure = PatentFigure & { label?: string };
export type ReplacementPreview<T> = {
  url: string;
  value: T;
  note?: ReactNode;
  rotationDeg?: 0 | 90 | 180 | 270;
  outputWidthMm?: number | undefined;
  dispose?(): void;
};

export function FigureReplacementDialog<T>({
  open = true,
  sessionId,
  figures,
  defaultFigureId,
  sourceLabel,
  previewAlt,
  previewKey = "",
  widthNote = "保留原图宽度，新图方向以右侧预览为准。",
  controls,
  interactivePreview = true,
  onPreview,
  onConfirm,
  onCancel,
}: {
  open?: boolean;
  sessionId: string;
  figures: readonly ReplacementFigure[];
  defaultFigureId?: string | undefined;
  sourceLabel: string;
  previewAlt: string;
  previewKey?: string;
  widthNote?: string;
  controls?: ReactNode;
  interactivePreview?: boolean;
  onPreview(target: ReplacementFigure): Promise<ReplacementPreview<T>>;
  onConfirm(target: ReplacementFigure, preview: T): Promise<void>;
  onCancel(): void;
}) {
  const selectId = useId();
  const [figureId, setFigureId] = useState(
    figures.find((figure) => figure.figureId === defaultFigureId)?.figureId ??
      figures[0]?.figureId ??
      "",
  );
  const [preview, setPreview] = useState<{
    targetKey: string;
    rendered: ReplacementPreview<T>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [originalLoadedKey, setOriginalLoadedKey] = useState("");
  const [replacementLoadedKey, setReplacementLoadedKey] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const target = figures.find((figure) => figure.figureId === figureId);
  const targetKey = target ? JSON.stringify(target) : "";
  const requestKey = JSON.stringify([targetKey, previewKey, refresh]);
  const label = target?.label ?? (target ? `图 ${figures.indexOf(target) + 1}` : "附图");
  useEffect(() => {
    if (!open) return;
    void refresh;
    void previewKey;
    setPreview(null);
    setError("");
    if (!targetKey) {
      setLoading(false);
      return;
    }
    const selected: ReplacementFigure = JSON.parse(targetKey);
    let cancelled = false;
    let rendered: ReplacementPreview<T> | null = null;
    setLoading(true);
    void onPreviewRef
      .current(selected)
      .then((result) => {
        if (cancelled) {
          result.dispose?.();
          return;
        }
        rendered = result;
        setPreview({ targetKey: requestKey, rendered: result });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法生成成图预览。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      rendered?.dispose?.();
    };
  }, [open, targetKey, previewKey, refresh, requestKey]);
  const ready = Boolean(
    preview &&
      preview.targetKey === requestKey &&
      originalLoadedKey === targetKey &&
      replacementLoadedKey === requestKey,
  );
  async function confirm() {
    if (!ready || !preview || !target || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(target, preview.rendered.value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "替换失败，请重试。");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <StandardDialog
      open={open}
      title="替换说明书附图"
      subtitle="选择要替换的图号，对比后确认。图号、顺序和附图说明保持不变。"
      size="xl"
      portal
      movable
      className="figure-replace-dialog drawing-replace-dialog"
      bodyClassName="drawing-replace-body"
      onCancel={onCancel}
      closeDisabled={submitting}
      footer={
        <>
          <span className="drawing-replace-note">{widthNote}</span>
          <button type="button" disabled={submitting} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!ready || loading || submitting}
            onClick={() => void confirm()}
          >
            {submitting ? "正在替换…" : target ? `替换${label}` : "确认替换"}
          </button>
        </>
      }
    >
      <div className="drawing-replace-comparison">
        <section className="drawing-replace-pane" aria-label="现有附图">
          <header>
            <label htmlFor={selectId}>现有附图</label>
            <select
              id={selectId}
              aria-label="选择要替换的附图"
              value={figureId}
              disabled={submitting}
              onChange={(e) => setFigureId(e.target.value)}
            >
              {!target && <option value={figureId}>请选择附图</option>}
              {figures.map((figure, index) => (
                <option key={figure.figureId} value={figure.figureId}>
                  {figure.label ?? `图 ${index + 1}`}
                </option>
              ))}
            </select>
          </header>
          <div className="drawing-replace-stage drawing-replace-stage--interactive">
            {target ? (
              <AssetPreview
                key={`${sessionId}:${targetKey}:${open}`}
                sessionId={sessionId}
                assetId={target.assetId}
                alt={`现有${label}`}
                rotationDeg={target.rotationDeg ?? 0}
                outputWidthMm={target.widthMm}
                onLoad={() => setOriginalLoadedKey(targetKey)}
              />
            ) : (
              <span role="status">
                {figures.length ? "请选择要替换的附图" : "暂无可替换的附图，请先插入附图"}
              </span>
            )}
          </div>
        </section>
        <ArrowRight className="drawing-replace-arrow" size={22} aria-hidden="true" />
        <section className="drawing-replace-pane" aria-label="替换后预览">
          <header>
            <strong>{sourceLabel}</strong>
            <button
              type="button"
              aria-label="重新生成预览"
              title="重新生成预览"
              disabled={loading || submitting || !target}
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </header>
          <div
            className={`drawing-replace-stage${interactivePreview ? " drawing-replace-stage--interactive" : ""}`}
          >
            {interactivePreview ? (
              <FlowchartImagePreview
                key={requestKey}
                src={preview?.rendered.url ?? null}
                alt={previewAlt}
                fitOnLoad
                rotationDeg={preview?.rendered.rotationDeg ?? 0}
                outputWidthMm={preview?.rendered.outputWidthMm ?? target?.widthMm}
                busy={loading}
                message="暂无成图预览"
                onLoad={() => setReplacementLoadedKey(requestKey)}
                onError={() => {
                  setReplacementLoadedKey("");
                  setError("成图预览加载失败，请重新生成。");
                }}
              />
            ) : preview ? (
              <img
                key={requestKey}
                src={preview.rendered.url}
                alt={previewAlt}
                onLoad={() => setReplacementLoadedKey(requestKey)}
                onError={() => {
                  setReplacementLoadedKey("");
                  setError("成图预览加载失败，请重新生成。");
                }}
              />
            ) : (
              <span role="status">{loading ? "正在生成成图预览…" : "暂无成图预览"}</span>
            )}
          </div>
          {controls ? (
            <fieldset className="figure-replace-controls" disabled={submitting}>
              {controls}
            </fieldset>
          ) : null}
        </section>
      </div>
      <SpatialPresence>
        {error ? (
          <p className="drawing-replace-error" role="alert">
            {error}
          </p>
        ) : null}
      </SpatialPresence>
    </StandardDialog>
  );
}
