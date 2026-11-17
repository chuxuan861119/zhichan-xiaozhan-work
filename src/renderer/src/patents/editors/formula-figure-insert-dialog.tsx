import { useId, useMemo, useRef, useState } from "react";
import type { FormulaDrawingReplacement } from "../../editor/formula-drawing-replacement";
import type { FormulaDrawingRequest } from "../../editor/formula-drawing-request";
import { FlowchartImagePreview } from "../../flowcharts/flowchart-image-preview";
import type { ReplacementPreview } from "../../shared/figure-replacement-dialog";
import { FigureReplacementDialog } from "../../shared/figure-replacement-dialog";
import { StandardDialog } from "../../shared/standard-dialog";

export type FormulaFigureOption = {
  figureId: string;
  assetId: string;
  label: string;
  widthMm?: number;
  rotationDeg?: 0 | 90 | 180 | 270 | undefined;
};
export type FormulaFigureTarget =
  | { kind: "new"; insertIndex: number }
  | { kind: "replace"; figureId: string; assetId: string };
type Props = {
  figureOptions: readonly FormulaFigureOption[];
  contentKind?: FormulaDrawingRequest["kind"];
  mode?: "insert" | "replace";
  sessionId?: string;
  previewUrl: string;
  previewWidthMm?(target: FormulaFigureTarget): number;
  onReplacementPreview?(widthMm: number): Promise<ReplacementPreview<FormulaDrawingReplacement>>;
  onConfirm(
    target: FormulaFigureTarget,
    replacement?: FormulaDrawingReplacement | undefined,
  ): void | Promise<void>;
  onCancel(): void;
};
export function FormulaFigureInsertDialog(props: Props) {
  const contentLabel =
    props.contentKind === "chemical-structure"
      ? "化学结构式"
      : props.contentKind === "chemical-equation"
        ? "化学方程式"
        : props.contentKind === "physics"
          ? "物理公式"
          : props.contentKind === "mathematical"
            ? "数学公式"
            : "公式";
  if (props.mode === "replace") {
    if (!props.sessionId) throw new Error("替换附图缺少原专利会话。");
    return (
      <FigureReplacementDialog
        sessionId={props.sessionId}
        figures={props.figureOptions.map((figure) => ({
          ...figure,
          widthMm: figure.widthMm ?? 165,
        }))}
        sourceLabel={contentLabel}
        previewAlt={`${contentLabel}成图预览`}
        interactivePreview
        previewKey={props.previewUrl}
        onPreview={async (figure) =>
          props.onReplacementPreview
            ? props.onReplacementPreview(figure.widthMm)
            : {
                url: props.previewUrl,
                value: undefined,
                note: "黑白成图，与实际替换内容一致",
              }
        }
        onConfirm={async (figure, replacement) => {
          const target: FormulaFigureTarget = {
            kind: "replace",
            figureId: figure.figureId,
            assetId: figure.assetId,
          };
          if (replacement) await props.onConfirm(target, replacement);
          else await props.onConfirm(target);
        }}
        onCancel={props.onCancel}
      />
    );
  }
  return <InsertDialog {...props} contentLabel={contentLabel} />;
}
function InsertDialog({
  figureOptions,
  previewUrl,
  previewWidthMm,
  onConfirm,
  onCancel,
  contentLabel,
}: Props & { contentLabel: string }) {
  const fieldId = useId();
  const [insertIndex, setInsertIndex] = useState(figureOptions.length);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const positions = useMemo(
    () => [
      ...figureOptions.map((figure, index) => ({ key: figure.figureId, index })),
      { key: "end", index: figureOptions.length },
    ],
    [figureOptions],
  );
  const target: FormulaFigureTarget = { kind: "new", insertIndex };
  async function confirm() {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(target);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `插入${contentLabel}附图失败，请重试。`);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <StandardDialog
      open
      title="插入到说明书附图"
      size="xl"
      portal
      movable
      onCancel={onCancel}
      closeDisabled={submitting}
      className="formula-figure-insert-dialog flowchart-dialog flowchart-export-dialog flowchart-export-dialog--patent"
      bodyClassName="flowchart-dialog-body"
      footer={
        <>
          <button type="button" disabled={submitting} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void confirm()}
          >
            {submitting ? "正在插入…" : `添加为图 ${insertIndex + 1}`}
          </button>
        </>
      }
    >
      <div className="flowchart-export-layout">
        <aside className="flowchart-export-options" aria-label="附图设置">
          <fieldset className="flowchart-export-section" disabled={submitting}>
            <legend>新附图</legend>
            <div className="flowchart-export-field">
              <label htmlFor={fieldId}>插入位置</label>
              <select
                id={fieldId}
                value={insertIndex}
                onChange={(e) => setInsertIndex(Number(e.target.value))}
              >
                {positions.map((position) => (
                  <option key={position.key} value={position.index}>
                    作为图 {position.index + 1}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>
          {error ? (
            <p className="flowchart-export-error" role="alert">
              {error}
            </p>
          ) : null}
        </aside>
        <section className="flowchart-export-preview" aria-label={`${contentLabel}附图预览`}>
          <FlowchartImagePreview
            src={previewUrl}
            outputWidthMm={previewWidthMm?.(target)}
            alt={`${contentLabel}附图预览`}
            title={
              <span>
                {contentLabel}预览 <small>黑白</small>
              </span>
            }
            busy={false}
            message={`暂时无法显示${contentLabel}附图预览`}
          />
        </section>
      </div>
    </StandardDialog>
  );
}
