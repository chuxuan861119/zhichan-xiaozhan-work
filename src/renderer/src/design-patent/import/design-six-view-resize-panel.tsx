import { useState } from "react";
import { MAX_DESIGN_IMAGE_SOURCE_EDGE_PX } from "../../../../shared/patent/design-patent";
import { ORTHOGRAPHIC_LABELS } from "../../../../shared/patent/design-view-omissions";
import {
  planSixViewResize,
  type SixViewResizeAxes,
  type SixViewResizeRequest,
  sixViewResizeDefaults,
} from "../design-six-view-resize";
import { useSixViewPreview } from "../six-view-preview-context";
import "./design-six-view-resize-panel.css";

const axes = { width: "宽度", height: "高度", depth: "深度" } as const;
const sides = ["width", "height", "depth"] as const;
const textSize = ({ width, height }: { width: number; height: number }) => `${width} × ${height}`;
const pixels = (text: string) => (/^[0-9]+$/.test(text) ? Number(text) : NaN);
const validAxis = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_DESIGN_IMAGE_SOURCE_EDGE_PX;

export function DesignSixViewResizePanel({
  disabled,
  onApply,
  onCorrection,
}: {
  disabled: boolean;
  onApply(request: SixViewResizeRequest): Promise<number>;
  onCorrection(): void;
}) {
  const preview = useSixViewPreview();
  const [draft, setDraft] = useState<Partial<Record<keyof SixViewResizeAxes, string>>>({});
  const [ratioBase, setRatioBase] = useState<SixViewResizeAxes | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const model = preview?.model;
  if (!model) return null;
  const images = model.faces.flatMap((face) => (face.image ? [face.image] : []));
  const defaults = sixViewResizeDefaults(images);
  const defaultValues = {
    width: defaults.width?.value,
    height: defaults.height?.value,
    depth: defaults.depth?.value,
  };
  const readValue = (axis: keyof SixViewResizeAxes) =>
    draft[axis] ?? String(defaultValues[axis] ?? "");
  const target = {
    width: pixels(readValue("width")),
    height: pixels(readValue("height")),
    depth: pixels(readValue("depth")),
  };
  const canLink = sides.every((axis) => validAxis(target[axis]));
  let request: SixViewResizeRequest | null = null;
  let invalid = "";
  if (sides.every((axis) => readValue(axis))) {
    try {
      request = { axes: target, items: planSixViewResize(images, target) };
    } catch (error) {
      invalid = (error as Error).message;
    }
  }
  const views = model.faces.map((face) => ({
    face,
    item: request?.items.find((candidate) => candidate.kind === face.kind),
  }));
  const changed = views.filter(({ item }) => item && item.change !== "same");
  const other = views.filter(({ item }) => !item || item.change === "same");
  const changing = request?.items.filter((item) => item.change !== "same").length ?? 0;
  const stretches = request?.items.filter((item) => item.change === "stretch").length ?? 0;
  const renderRow = ({ face, item }: (typeof views)[number]) => {
    const current = face.image;
    return (
      <div className="design-six-resize__row" key={face.kind}>
        <strong>{ORTHOGRAPHIC_LABELS[face.kind]}</strong>
        <span>
          {face.omitted
            ? "已省略"
            : !current
              ? "未分配"
              : item
                ? item.change === "same"
                  ? `${textSize(item.before)} · 不变`
                  : `${textSize(item.before)} → ${textSize(item.after)}`
                : current.width && current.height
                  ? `${current.width} × ${current.height}`
                  : "尺寸待加载"}
        </span>
        {item?.change === "stretch" && <small>会拉伸</small>}
      </div>
    );
  };
  return (
    <form
      className="design-six-resize"
      aria-label="六视图尺寸统一"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!request || !changing || busy || disabled) return;
        setBusy(true);
        setResult(null);
        try {
          const count = await onApply(request);
          setDraft({});
          setRatioBase((base) => (base ? request.axes : null));
          setResult({ error: false, text: `已调整 ${count} 张图片，可整批撤销。` });
        } catch (error) {
          setResult({
            error: true,
            text:
              error && typeof error === "object" && "message" in error
                ? String(error.message)
                : "尺寸调整失败，未提交本次修改。",
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="design-six-resize__header">
        <strong title="按整张图片的像素尺寸调整">
          目标尺寸 <small>px</small>
        </strong>
        <label className="design-six-resize__ratio">
          <input
            type="checkbox"
            checked={ratioBase !== null}
            disabled={disabled || busy || (!ratioBase && !canLink)}
            onChange={(event) => setRatioBase(event.currentTarget.checked ? target : null)}
          />
          等比缩放
        </label>
      </div>
      <div className="design-six-resize__axes">
        {sides.map((axis) => (
          <label key={axis}>
            <span>{axes[axis]}</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label={`目标${axes[axis]}（像素）`}
              title={
                draft[axis] !== undefined
                  ? "手动设置"
                  : defaults[axis]
                    ? `默认取自${ORTHOGRAPHIC_LABELS[defaults[axis].kind]}`
                    : "请填写像素尺寸"
              }
              value={readValue(axis)}
              disabled={disabled || busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const pixelValue = pixels(value);
                setDraft((current) => {
                  const next = { ...current, [axis]: value };
                  if (ratioBase && validAxis(pixelValue)) {
                    for (const other of sides) {
                      if (other !== axis)
                        next[other] = String(
                          Math.max(
                            1,
                            Math.round((pixelValue * ratioBase[other]) / ratioBase[axis]),
                          ),
                        );
                    }
                  }
                  return next;
                });
                setResult(null);
              }}
            />
          </label>
        ))}
      </div>
      <fieldset className="design-six-resize__rows" aria-label="尺寸变化预览">
        <div className="design-six-resize__header">
          <strong>调整预览</strong>
          <span className="design-six-resize__count">
            {changing > 0
              ? `${changing} 张待调整`
              : request?.items.length
                ? "无需调整"
                : !images.some((image) => !image.omitted)
                  ? "暂无可调整视图"
                  : null}
          </span>
        </div>
        {changed.map(renderRow)}
        {stretches ? (
          <p className="design-six-resize__warning">{stretches} 张会拉伸，可能改变外形。</p>
        ) : null}
        {other.length ? (
          <details className="design-six-resize__other">
            <summary>其他视图（{other.length}）</summary>
            <div>{other.map(renderRow)}</div>
          </details>
        ) : null}
      </fieldset>
      {invalid ? (
        <p className="design-six-resize__warning" role="status">
          {invalid}
        </p>
      ) : null}
      {result ? (
        <p
          className={result.error ? "design-six-resize__warning" : undefined}
          role={result.error ? "alert" : "status"}
        >
          {result.text}
        </p>
      ) : null}
      <div className="design-six-resize__actions">
        <button
          type="button"
          disabled={!Object.keys(draft).length || disabled || busy}
          onClick={() => {
            setDraft({});
            if (ratioBase) {
              const { width, height, depth } = defaultValues;
              setRatioBase(width && height && depth ? { width, height, depth } : null);
            }
            setResult(null);
          }}
        >
          恢复默认值
        </button>
        <button
          type="submit"
          className="design-six-resize__apply"
          disabled={!changing || disabled || busy}
        >
          {busy ? "正在调整…" : "应用到六视图"}
        </button>
      </div>
      <div className="design-six-resize__tip">
        有白边？
        <button
          type="button"
          className="design-six-resize__link"
          aria-label="到第 2 步修图"
          onClick={onCorrection}
          disabled={disabled || busy}
        >
          先修图
        </button>
      </div>
    </form>
  );
}
