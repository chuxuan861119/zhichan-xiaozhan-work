import { useId, useLayoutEffect, useRef, useState } from "react";
import type { AssetDescriptor } from "../../../../shared/document/model";
import type {
  DesignPatent,
  DesignPatentPrimarySlot,
} from "../../../../shared/patent/design-patent";
import { isHeldForOmittedView, resolvedOrthographicOmissions } from "../design-omission-status";
import type { SixViewResizeRequest } from "../design-six-view-resize";
import { SixViewPreview } from "../six-view-preview";
import { useSixViewPreview } from "../six-view-preview-context";
import { DESIGN_ASSIGNMENT_LABELS, suggestDesignAssignments } from "./design-assignment";
import { DesignAssignmentInspector } from "./design-assignment-inspector";
import { DESIGN_IMPORT_FORMAT_LABEL } from "./design-file-drop";
import { DesignImagePreviewDialog } from "./design-image-preview-dialog";
import { DesignSixViewResizePanel } from "./design-six-view-resize-panel";
import { DesignViewAssignmentBoard } from "./design-view-assignment-board";

const inspectorTabs = [
  { id: "model", label: "三维预览" },
  { id: "size", label: "尺寸统一" },
] as const;

export function DesignImportStep({
  design,
  assets,
  autoSuggested = {},
  previewUrls = {},
  importing = false,
  onConfirmAll,
  onImport,
  onAssign,
  onRemove,
  onOmission,
  onResizeSixViews,
  onCorrection,
}: {
  design: DesignPatent;
  assets: readonly AssetDescriptor[];
  autoSuggested?: Record<string, { kind: DesignPatentPrimarySlot; evidence: string }>;
  previewUrls?: Record<string, string>;
  importing?: boolean;
  onConfirmAll?(): void;
  onImport(): void;
  onAssign(viewId: string, target: DesignPatentPrimarySlot | "unassigned"): void;
  onRemove?(viewId: string): void;
  onOmission?: import("./design-view-assignment-board").OmissionHandler;
  onResizeSixViews?: ((request: SixViewResizeRequest) => Promise<number>) | undefined;
  onCorrection?: (() => void) | undefined;
}) {
  const [previewViewId, setPreviewViewId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"model" | "size">("model");
  const preview = useSixViewPreview();
  const inspectorId = useId();
  const inspector = useRef<HTMLElement>(null);
  const showSizes = !!(onResizeSixViews && onCorrection);
  const occupied = new Set(
    design.views
      .filter((view) => view.kind !== "unassigned")
      .map((view) => view.kind as DesignPatentPrimarySlot),
  );
  const held = design.views.filter((view) => !(view.kind in DESIGN_ASSIGNMENT_LABELS));
  const omitted = resolvedOrthographicOmissions(design);
  const retainedCount = held.filter((view) => isHeldForOmittedView(view, omitted)).length;
  const awaitingCount = held.length - retainedCount;
  const holding = useRef<HTMLElement>(null);
  const isHoldingEmpty = held.length === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening or closing the preview replaces the measured layout and requires fresh observers.
  useLayoutEffect(() => {
    const element = holding.current;
    if (!element) return;
    const scrollport = element.closest<HTMLElement>(".design-workspace-shell__main");
    let frame = 0;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const parent = scrollport?.getBoundingClientRect();
      const bottom = Math.min(window.innerHeight, parent?.bottom ?? window.innerHeight);
      const top = Math.max(bounds.top, parent?.top ?? 0);
      element.style.setProperty("--design-holding-height", `${Math.max(260, bottom - top - 12)}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    if (inspector.current) observer?.observe(inspector.current);
    if (scrollport) observer?.observe(scrollport);
    scrollport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      scrollport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      element.style.removeProperty("--design-holding-height");
    };
  }, [preview !== null]);
  const assetFor = (view: DesignPatent["views"][number]) =>
    assets.find((asset) => asset.assetId === view.assetId);
  const sourceName = (view: DesignPatent["views"][number]) =>
    assetFor(view)?.originalName ?? view.label;
  const resolution = (view: DesignPatent["views"][number]) => {
    const asset = view.editor?.applied ?? assetFor(view);
    return asset ? `${asset.widthPx} × ${asset.heightPx} px` : "分辨率未知";
  };
  const suggestions = suggestDesignAssignments(
    held.map((view) => ({ id: view.viewId, originalName: sourceName(view) })),
    occupied,
  );
  const previewView = design.views.find((view) => view.viewId === previewViewId) ?? null;
  const previewUrl = previewView ? previewUrls[previewView.viewId] : undefined;
  const openPreview = (viewId: string) => {
    if (previewUrls[viewId]) setPreviewViewId(viewId);
  };

  return (
    <div className="design-import-step">
      <section className="design-import-step__source" aria-label="导入素材">
        <div>
          <h2>图片素材</h2>
          <p>
            已导入 {design.views.length} 张；支持 {DESIGN_IMPORT_FORMAT_LABEL}
            。可将文件夹中的图片拖入本页，支持多张、多次追加。
          </p>
        </div>
        <div className="design-import-step__source-actions">
          {Object.keys(autoSuggested).length > 0 ? (
            <button type="button" onClick={onConfirmAll}>
              确认全部自动匹配
            </button>
          ) : null}
          <button type="button" onClick={onImport} disabled={importing}>
            {importing ? "正在导入…" : "导入图片"}
          </button>
        </div>
      </section>
      <DesignViewAssignmentBoard
        design={design}
        assets={assets}
        autoSuggested={autoSuggested}
        previewUrls={previewUrls}
        onPreview={openPreview}
        onAssign={onAssign}
        onOmission={onOmission}
        {...(onRemove ? { onRemove } : {})}
      />
      <aside className="design-import-step__rail">
        {preview ? (
          <section
            ref={inspector}
            className="design-import-step__view-inspector"
            aria-labelledby={`${inspectorId}-heading`}
            data-six-view-layer-stack
          >
            <header className="design-import-step__view-inspector-header">
              <h2 id={`${inspectorId}-heading`}>视图核对</h2>
              {showSizes ? (
                <div role="tablist" aria-label="视图核对方式">
                  {inspectorTabs.map(({ id, label }) => (
                    <button
                      key={id}
                      id={`${inspectorId}-${id}-tab`}
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === id}
                      aria-controls={`${inspectorId}-${id}-panel`}
                      tabIndex={inspectorTab === id ? 0 : -1}
                      onClick={() => setInspectorTab(id)}
                      onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                        event.preventDefault();
                        const next =
                          event.key === "Home"
                            ? "model"
                            : event.key === "End"
                              ? "size"
                              : id === "model"
                                ? "size"
                                : "model";
                        setInspectorTab(next);
                        document.getElementById(`${inspectorId}-${next}-tab`)?.focus();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </header>
            <div
              className="design-import-step__inspector-model"
              id={`${inspectorId}-model-panel`}
              {...(showSizes && {
                role: "tabpanel",
                "aria-labelledby": `${inspectorId}-model-tab`,
              })}
              hidden={showSizes && inspectorTab !== "model"}
            >
              <SixViewPreview fitToInspector />
            </div>
            {onResizeSixViews && onCorrection ? (
              <div
                id={`${inspectorId}-size-panel`}
                role="tabpanel"
                aria-labelledby={`${inspectorId}-size-tab`}
                hidden={inspectorTab !== "size"}
              >
                <DesignSixViewResizePanel
                  disabled={importing}
                  onApply={onResizeSixViews}
                  onCorrection={onCorrection}
                />
              </div>
            ) : null}
          </section>
        ) : null}
        <section
          className="design-import-step__holding"
          ref={holding}
          data-empty={isHoldingEmpty}
          aria-label="图片暂存区"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const viewId =
              event.dataTransfer.getData("application/x-design-view-id") ||
              event.dataTransfer.getData("text/plain");
            if (viewId) onAssign(viewId, "unassigned");
          }}
        >
          <header>
            <div>
              <div className="design-import-step__holding-heading">
                <h2>图片暂存区</h2>
                <p className="design-import-step__holding-hint">拖动图片到对应视图</p>
              </div>
              <p>
                {awaitingCount > 0 ? `${awaitingCount} 张待分配图片` : "暂无待分配图片"}
                {retainedCount > 0 ? ` · ${retainedCount} 张对应视图已省略` : ""}
              </p>
            </div>
          </header>
          {held.length > 0 ? (
            <div className="design-import-step__holding-list">
              {held.map((view) => {
                const retained = isHeldForOmittedView(view, omitted);
                const suggestion = retained
                  ? undefined
                  : suggestions.find((item) => item.id === view.viewId);
                return (
                  <fieldset
                    key={view.viewId}
                    aria-label={`暂存图片：${view.label}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-design-view-id", view.viewId);
                      event.dataTransfer.setData("text/plain", view.viewId);
                    }}
                  >
                    <legend className="design-workspace-shell__visually-hidden">
                      {view.label}
                    </legend>
                    <div className="design-import-step__holding-image">
                      {previewUrls[view.viewId] ? (
                        <button
                          type="button"
                          aria-label={`查看${view.label}大图`}
                          onClick={() => openPreview(view.viewId)}
                        >
                          <img
                            src={previewUrls[view.viewId]}
                            alt={`${view.label}缩略图`}
                            draggable={false}
                          />
                        </button>
                      ) : null}
                      {onRemove ? (
                        <button
                          type="button"
                          className="design-import-step__delete design-import-step__delete--formula"
                          aria-label={`删除${view.label}`}
                          title={`删除${view.label}`}
                          onClick={() => onRemove(view.viewId)}
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                    <strong className="design-import-step__holding-filename">
                      {sourceName(view)}
                    </strong>
                    <div className="design-import-step__holding-footer">
                      <span>
                        {retained
                          ? "对应视图已省略"
                          : suggestion?.status === "suggested"
                            ? DESIGN_ASSIGNMENT_LABELS[suggestion.kind]
                            : "待分配"}
                      </span>
                      <small>{resolution(view)}</small>
                    </div>
                    {view.assignmentStatus === "pending-auto" && view.assignmentEvidence ? (
                      <p className="design-import-step__suggestion">自动匹配待确认</p>
                    ) : (
                      <DesignAssignmentInspector
                        suggestion={suggestion?.status === "suggested" ? undefined : suggestion}
                      />
                    )}
                  </fieldset>
                );
              })}
            </div>
          ) : (
            <div className="design-import-step__holding-empty">
              <span>将图片拖到此处暂存</span>
            </div>
          )}
        </section>
      </aside>
      {previewView && previewUrl ? (
        <DesignImagePreviewDialog
          key={previewView.viewId}
          label={previewView.label}
          resolution={resolution(previewView)}
          previewUrl={previewUrl}
          onClose={() => setPreviewViewId(null)}
        />
      ) : null}
    </div>
  );
}
