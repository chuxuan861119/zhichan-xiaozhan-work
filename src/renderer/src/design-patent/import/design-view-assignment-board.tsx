import { type DragEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetDescriptor } from "../../../../shared/document/model";
import type {
  DesignPatent,
  DesignPatentPrimarySlot,
} from "../../../../shared/patent/design-patent";
import {
  OPPOSITE_DESIGN_VIEWS,
  ORTHOGRAPHIC_LABELS,
  type OrthographicKind,
  omissionMirror,
  resolveOmissionSource,
  type ViewOmission,
} from "../../../../shared/patent/design-view-omissions";
import {
  resolveDesignViewPixelSize,
  useProcessedDesignSizes,
  useSixViewPreview,
} from "../six-view-preview-context";
import { DESIGN_ASSIGNMENT_LABELS } from "./design-assignment";
export type OmissionHandler = (
  kind: OrthographicKind,
  reason: ViewOmission["reason"] | null,
) => void;

const perspectiveSlots: DesignPatentPrimarySlot[] = [
  "perspective",
  "perspective-2",
  "perspective-3",
];
const orthographicSlots: Array<{
  slot: DesignPatentPrimarySlot;
  position: "top" | "left" | "front" | "right" | "bottom" | "rear";
}> = [
  { slot: "top", position: "top" },
  { slot: "left", position: "left" },
  { slot: "front", position: "front" },
  { slot: "right", position: "right" },
  { slot: "bottom", position: "bottom" },
  { slot: "rear", position: "rear" },
];
const orthographicSlotNames = new Set<string>(orthographicSlots.map(({ slot }) => slot));
type Dimension = "length" | "width" | "height";
const dimensionLabels: Record<Dimension, string> = {
  length: "长度",
  width: "宽度",
  height: "高度",
};
const dimensionAxes: Partial<Record<DesignPatentPrimarySlot, readonly [Dimension, Dimension]>> = {
  front: ["length", "height"],
  rear: ["length", "height"],
  left: ["width", "height"],
  right: ["width", "height"],
  top: ["length", "width"],
  bottom: ["length", "width"],
};

export function DesignViewAssignmentBoard({
  design,
  assets,
  autoSuggested = {},
  previewUrls = {},
  onPreview,
  onRemove,
  onAssign,
  onOmission,
}: {
  design: DesignPatent;
  assets: readonly AssetDescriptor[];
  autoSuggested?: Record<string, { kind: DesignPatentPrimarySlot; evidence: string }>;
  previewUrls?: Record<string, string>;
  onPreview(viewId: string): void;
  onRemove?(viewId: string): void;
  onAssign(viewId: string, target: DesignPatentPrimarySlot | "unassigned"): void;
  onOmission?: OmissionHandler | undefined;
}) {
  const preview = useSixViewPreview();
  const processedSizes = useProcessedDesignSizes();
  const [highlightedDimension, setHighlightedDimension] = useState<Dimension | null>(null);
  const [pendingOmission, setPendingOmission] = useState<{
    kind: OrthographicKind;
    opener: HTMLSelectElement;
  } | null>(null);
  const closeOmissionConfirmation = (confirmed: boolean) => {
    if (!pendingOmission) return;
    const { kind, opener } = pendingOmission;
    setPendingOmission(null);
    if (confirmed) onOmission?.(kind, "not-visible-during-use");
    queueMicrotask(() => {
      if (opener.isConnected) opener.focus();
    });
  };
  const board = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!preview?.selectedViewId) return;
    const selected = board.current?.querySelector<HTMLElement>('[data-model-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    selected?.focus({ preventScroll: true });
  }, [preview?.selectedViewId]);
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const frontView = design.views.find((view) => view.kind === "front");
  const displayAsset = (view: DesignPatent["views"][number]) =>
    resolveDesignViewPixelSize(view, assetById.get(view.assetId), processedSizes);
  const dimensionValues: Record<Dimension, Map<number, number>> = {
    length: new Map(),
    width: new Map(),
    height: new Map(),
  };
  for (const { slot } of orthographicSlots) {
    const view = design.views.find((item) => item.kind === slot);
    const asset = view ? displayAsset(view) : undefined;
    const axes = dimensionAxes[slot];
    if (asset && axes) {
      for (const [axis, value] of [
        [axes[0], asset.widthPx],
        [axes[1], asset.heightPx],
      ] as const) {
        dimensionValues[axis].set(value, (dimensionValues[axis].get(value) ?? 0) + 1);
      }
    }
  }
  const majorityValue = (dimension: Dimension) => {
    const values = dimensionValues[dimension];
    const total = [...values.values()].reduce((sum, count) => sum + count, 0);
    return [...values].find(([, count]) => count > total / 2)?.[0];
  };
  const renderDimension = (dimension: Dimension, value: number) => {
    const majority = majorityValue(dimension);
    const mismatch =
      dimensionValues[dimension].size > 1 && (majority === undefined || value !== majority);
    const description = `${dimensionLabels[dimension]} ${value} px${mismatch ? `，${dimensionLabels[dimension]}不一致` : ""}`;
    const highlighted = highlightedDimension === dimension;
    return (
      <button
        type="button"
        className={`design-import-step__dimension${mismatch ? " is-dimension-mismatch" : ""}${highlighted ? " is-dimension-highlighted" : ""}`}
        data-dimension={dimension}
        title={`${description}；点击高亮同类尺寸，再次点击取消`}
        aria-label={description}
        aria-pressed={highlighted}
        onClick={() => setHighlightedDimension(highlighted ? null : dimension)}
      >
        {value}
      </button>
    );
  };
  const frontAsset = frontView ? displayAsset(frontView) : undefined;
  const orthographicPreviewBaseWidth = frontAsset
    ? Math.max(
        frontAsset.widthPx,
        ...design.views
          .filter((view) => orthographicSlotNames.has(view.kind))
          .map((view) => displayAsset(view)?.widthPx ?? 0),
      )
    : null;
  const orthographicAssets = design.views
    .filter((view) => orthographicSlotNames.has(view.kind))
    .map(displayAsset)
    .filter((asset) => asset !== undefined);
  // A shared pixel scale preserves corresponding dimensions, but never grows with
  // the desktop width or lets a very tall source create a page-sized thumbnail.
  const orthographicScale = Math.min(
    1,
    280 / Math.max(1, ...orthographicAssets.map((asset) => asset.widthPx)),
    240 / Math.max(1, ...orthographicAssets.map((asset) => asset.heightPx)),
  );
  const dropped = (
    event: DragEvent<HTMLElement>,
    target: DesignPatentPrimarySlot | "unassigned",
  ) => {
    event.preventDefault();
    const viewId =
      event.dataTransfer.getData("application/x-design-view-id") ||
      event.dataTransfer.getData("text/plain");
    if (viewId) onAssign(viewId, target);
  };
  const originalName = (assetId: string, fallback: string) =>
    assetById.get(assetId)?.originalName ?? fallback;
  const renderSlot = (slot: DesignPatentPrimarySlot, position?: string) => {
    const view = design.views.find((item) => item.kind === slot);
    const omission = !view
      ? design.brief.omissions.find((item) => item.viewKind === slot)
      : undefined;
    const source = !view ? resolveOmissionSource(design, slot) : undefined;
    const kind = slot as OrthographicKind,
      opposite = OPPOSITE_DESIGN_VIEWS[kind];
    const canReference =
      !!opposite &&
      design.views.some((item) => item.kind === opposite) &&
      !design.brief.omissions.some((item) => item.viewKind === opposite);
    const mirrored = omission?.reason === "symmetric" ? omissionMirror(kind) : null;
    const asset = view ? displayAsset(view) : undefined;
    const normalizedWidth =
      orthographicSlotNames.has(slot) && asset && orthographicPreviewBaseWidth
        ? `${(asset.widthPx / orthographicPreviewBaseWidth) * 100}%`
        : undefined;
    const pendingSuggestion = view ? autoSuggested[view.viewId] : undefined;
    const previewScale =
      asset && orthographicSlotNames.has(slot)
        ? orthographicScale
        : asset
          ? Math.min(1, 280 / asset.widthPx, 240 / asset.heightPx)
          : 1;
    const label = DESIGN_ASSIGNMENT_LABELS[slot];
    const axes = dimensionAxes[slot];
    return (
      <article
        key={slot}
        className="design-import-step__slot"
        aria-label={`${label}：${view?.label ?? "待分配"}`}
        data-position={position}
        data-model-selected={!!view && view.viewId === preview?.selectedViewId}
        tabIndex={-1}
        draggable={Boolean(view)}
        onDragStart={
          view
            ? (event) => {
                event.dataTransfer.setData("application/x-design-view-id", view.viewId);
                event.dataTransfer.setData("text/plain", view.viewId);
              }
            : undefined
        }
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropped(event, slot)}
      >
        {view && previewUrls[view.viewId] ? (
          <button
            type="button"
            className="design-import-step__slot-preview"
            aria-label={`查看${label}大图`}
            onClick={() => onPreview(view.viewId)}
          >
            <img
              src={previewUrls[view.viewId]}
              alt={`${label}缩略图`}
              draggable={false}
              style={{
                width: normalizedWidth ?? "100%",
                maxWidth: asset ? `${asset.widthPx * previewScale}px` : "280px",
              }}
            />
          </button>
        ) : source && previewUrls[source.viewId] ? (
          <button
            type="button"
            className="design-import-step__slot-preview"
            aria-label={`查看${label}引用大图`}
            onClick={() => onPreview(source.viewId)}
          >
            <img
              src={previewUrls[source.viewId]}
              alt={`${label}省略预览`}
              draggable={false}
              style={{
                maxWidth: `${(displayAsset(source)?.widthPx ?? 280) * orthographicScale}px`,
                transform:
                  mirrored === "x" ? "scaleX(-1)" : mirrored === "y" ? "scaleY(-1)" : undefined,
              }}
            />
          </button>
        ) : (
          <div className="design-import-step__slot-preview is-empty">
            <span className="design-import-step__slot-empty">
              {omission
                ? ["same", "symmetric"].includes(omission.reason)
                  ? "引用失效"
                  : "已省略"
                : "尚未分配"}
            </span>
          </div>
        )}
        {view ? (
          <div className="design-import-step__slot-footer">
            <span
              className="design-import-step__slot-filename"
              title={originalName(view.assetId, view.label)}
            >
              {originalName(view.assetId, view.label)}
            </span>
            <small>
              {asset && axes ? (
                <>
                  {renderDimension(axes[0], asset.widthPx)} ×{" "}
                  {renderDimension(axes[1], asset.heightPx)} px
                </>
              ) : asset ? (
                `${asset.widthPx} × ${asset.heightPx} px`
              ) : (
                "分辨率未知"
              )}
            </small>
          </div>
        ) : !omission ? (
          <div className="design-import-step__slot-footer is-empty">
            <small>拖入图片</small>
          </div>
        ) : null}
        {!view && opposite && onOmission ? (
          <div className="design-import-step__omission-actions">
            <select
              className="design-import-step__omission-select"
              aria-label={`${label}省略方式`}
              value={omission?.reason ?? ""}
              onChange={(event) => {
                const reason = event.currentTarget.value as
                  | "same"
                  | "symmetric"
                  | "not-visible-during-use";
                if (reason === "not-visible-during-use") {
                  setPendingOmission({ kind, opener: event.currentTarget });
                  return;
                }
                onOmission(kind, reason || null);
              }}
            >
              <option value="" disabled={!omission}>
                {omission ? "取消省略" : "省略此视图"}
              </option>
              {omission &&
              !["same", "symmetric", "not-visible-during-use"].includes(omission.reason) ? (
                <option value={omission.reason} disabled>
                  历史省略设置（请核对）
                </option>
              ) : null}
              <option value="same" disabled={!canReference}>
                与{ORTHOGRAPHIC_LABELS[opposite]}相同
                {!canReference ? "（请先分配来源图）" : ""}
              </option>
              <option value="symmetric" disabled={!canReference}>
                与{ORTHOGRAPHIC_LABELS[opposite]}对称
                {!canReference ? "（请先分配来源图）" : ""}
              </option>
              <option value="not-visible-during-use">使用时不易见，省略</option>
            </select>
          </div>
        ) : null}
        {view && onRemove ? (
          <button
            type="button"
            className="design-import-step__delete design-import-step__delete--formula"
            aria-label={`删除${label}`}
            title={`删除${label}`}
            onClick={() => onRemove(view.viewId)}
          >
            ✕
          </button>
        ) : null}
        {pendingSuggestion && view ? (
          <button
            type="button"
            className="design-import-step__status"
            aria-label={`确认${label}自动匹配`}
            title="待确认分配，点击确认"
            onClick={() => onAssign(view.viewId, slot)}
          >
            {label}
          </button>
        ) : view ? (
          <em className="design-import-step__status is-confirmed" title="已分配">
            {label}
          </em>
        ) : (
          <em
            className={`design-import-step__status ${omission ? (source || omission.reason === "not-visible-during-use" ? "is-omitted" : "") : "is-empty"}`}
            title={omission ? "已声明省略" : "尚未分配"}
          >
            {label}
          </em>
        )}
      </article>
    );
  };

  return (
    <section ref={board} className="design-import-step__board" aria-label="视图板">
      <h2>视图板</h2>
      <p>将图片拖入对应视图；已占用的视图会与拖入图片交换，不会删除图片。</p>
      <div className="design-import-step__slot-groups">
        <fieldset className="design-import-step__slot-section">
          <legend>立体图</legend>
          <div className="design-import-step__perspective">
            {perspectiveSlots.map((slot) => renderSlot(slot))}
          </div>
        </fieldset>
        <fieldset className="design-import-step__slot-section">
          <legend>六视图展开布局</legend>
          <p className="design-import-step__dimension-key">
            <span>长度：绿色 · 宽度：蓝色 · 高度：紫色</span>
            <span>点击数值高亮同类尺寸；按整图像素比较，偏离多数一致值时标红。</span>
          </p>
          {(Object.keys(dimensionLabels) as Dimension[]).some(
            (dimension) => dimensionValues[dimension].size > 1,
          ) ? (
            <p className="design-import-step__dimension-warning" role="status">
              {(Object.keys(dimensionLabels) as Dimension[])
                .filter((dimension) => dimensionValues[dimension].size > 1)
                .map(
                  (dimension) =>
                    `${dimensionLabels[dimension]}不一致${majorityValue(dimension) === undefined ? "（无多数一致值）" : ""}`,
                )
                .join("、")}
            </p>
          ) : null}
          <div className="design-import-step__orthographic">
            {orthographicSlots.map(({ slot, position }) => renderSlot(slot, position))}
          </div>
        </fieldset>
      </div>
      {pendingOmission
        ? createPortal(
            <div className="dialog-backdrop">
              <section
                className="close-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="确认省略视图"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    closeOmissionConfirmation(false);
                  }
                }}
              >
                <h2>确认省略{ORTHOGRAPHIC_LABELS[pendingOmission.kind]}</h2>
                <p>
                  请确认该面在产品实际使用时不容易看到或者看不到。省略后将同步写入简要说明；仅没有设计要点并不是省略理由。
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    // biome-ignore lint/a11y/noAutofocus: Initial focus in this confirmation dialog goes to the non-destructive action.
                    autoFocus
                    onClick={() => closeOmissionConfirmation(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => closeOmissionConfirmation(true)}
                  >
                    确认省略
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
