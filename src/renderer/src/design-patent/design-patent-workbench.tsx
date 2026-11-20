import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetDescriptor } from "../../../shared/document/model";
import {
  type DesignPatent,
  type DesignPatentImageOperation,
  inspectDesignPatent,
  MAX_DESIGN_IMAGE_SOURCE_EDGE_PX,
  MAX_DESIGN_IMAGE_SOURCE_PIXELS,
  renderDesignPatentBriefLines,
} from "../../../shared/patent/design-patent";
import type { CanonicalPatent } from "../../../shared/patent/model";
import type { PatentSession } from "../patents/patent-reducer";
import { confirmAppAction } from "../shared/app-dialog";

type Props = {
  session: PatentSession;
  onUpdate(designPatent: DesignPatent, assets: AssetDescriptor[]): void;
  onPrepareExport?(): Promise<number | null>;
  onExportCommitted?(patent: CanonicalPatent, savedAt: string): boolean;
};

const VIEW_SLOTS = ["perspective", "front", "rear", "left", "right", "top", "bottom"] as const;
const ORTHOGRAPHIC_VIEW_SLOTS = ["front", "rear", "left", "right", "top", "bottom"] as const;
const SUPPLEMENTAL_VIEW_SLOTS = ["reference", "enlarged", "section", "other"] as const;
const VIEW_LABELS: Record<(typeof VIEW_SLOTS)[number], string> = {
  perspective: "立体图",
  front: "主视图",
  rear: "后视图",
  left: "左视图",
  right: "右视图",
  top: "俯视图",
  bottom: "仰视图",
};
const EXPRESSION_LABELS = {
  "line-drawing": "线稿",
  photo: "实物照片",
  "cad-render": "CAD 渲染图",
} as const;
const SUPPLEMENTAL_VIEW_LABELS = {
  reference: "参考图",
  enlarged: "局部放大图",
  section: "剖视图",
  other: "其他视图",
} as const;

function sameImageRecipe(
  left: readonly DesignPatentImageOperation[],
  right: readonly DesignPatentImageOperation[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function DesignPatentWorkbench({
  session,
  onUpdate,
  onPrepareExport,
  onExportCommitted,
}: Props) {
  const [tab, setTab] = useState<"images" | "brief">("images");
  const [showChecks, setShowChecks] = useState(false);
  const [exportFormat, setExportFormat] = useState<"docx" | "pdf">("docx");
  const [confirmWarnings, setConfirmWarnings] = useState(false);
  const [zip, setZip] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [imageMessage, setImageMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const exportingRef = useRef(false);
  const design = session.patent.designPatent;
  const designRef = useRef(design);
  const assetsRef = useRef(session.patent.assets);
  useEffect(() => {
    designRef.current = design;
    assetsRef.current = session.patent.assets;
  }, [design, session.patent.assets]);
  const issues = useMemo(() => (design ? inspectDesignPatent(design) : []), [design]);
  const views = design?.views;
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    const load = async () => {
      const entries = await Promise.all(
        (views ?? []).map(async (view) => {
          const bytes =
            view.operations.length === 0
              ? await window.patentApi.assets
                  .getPreview(session.sessionId, view.assetId)
                  .then((result) => (result.ok ? result.value : null))
              : await window.patentApi.assets
                  .processDesignImage({
                    sessionId: session.sessionId,
                    assetId: view.assetId,
                    operations: view.operations,
                  })
                  .then((result) => (result.ok ? result.value.bytes : null));
          if (!bytes) return [view.viewId, ""] as const;
          const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
          createdUrls.push(url);
          return [view.viewId, url] as const;
        }),
      );
      if (!cancelled) setPreviewUrls(Object.fromEntries(entries));
    };
    void load();
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [session.sessionId, views]);
  if (!design) return <main className="editor-workspace">外观设计数据不可用。</main>;
  const commitDesign = (next: DesignPatent, assets = assetsRef.current) => {
    if (exportingRef.current) return;
    designRef.current = next;
    assetsRef.current = assets;
    onUpdate(next, assets);
  };
  const updateBrief = (patch: Partial<DesignPatent["brief"]>) => {
    const current = designRef.current;
    if (!current) return;
    commitDesign({ ...current, brief: { ...current.brief, ...patch } });
  };
  const updateOmission = (
    viewKind: (typeof ORTHOGRAPHIC_VIEW_SLOTS)[number],
    reason: DesignPatent["brief"]["omissions"][number]["reason"] | null,
  ) => {
    const current = designRef.current;
    if (!current) return;
    const remaining = current.brief.omissions.filter((item) => item.viewKind !== viewKind);
    updateBrief({
      omissions:
        reason === null
          ? remaining
          : [...remaining, { viewKind, reason, otherReason: reason === "other" ? "" : null }],
    });
  };
  const updateOmissionOtherReason = (
    viewKind: (typeof ORTHOGRAPHIC_VIEW_SLOTS)[number],
    otherReason: string,
  ) => {
    const current = designRef.current;
    if (!current) return;
    updateBrief({
      omissions: current.brief.omissions.map((item) =>
        item.viewKind === viewKind ? { ...item, otherReason } : item,
      ),
    });
  };
  const updateDesign = (patch: Partial<DesignPatent>) => {
    const current = designRef.current;
    if (!current) return;
    commitDesign({ ...current, ...patch });
  };
  const removeView = async (viewId: string) => {
    const current = designRef.current;
    if (!current) return;
    const isRepresentative = current.representativeViewId === viewId;
    const isDimensionReference = current.dimensionReferenceViewId === viewId;
    if (
      (isRepresentative || isDimensionReference) &&
      !(await confirmAppAction(
        `该图片当前用作${
          isRepresentative && isDimensionReference
            ? "代表图和尺寸比例参考"
            : isRepresentative
              ? "代表图"
              : "尺寸比例参考"
        }。移除后相应选择将变为缺项，确认移除吗？`,
      ))
    ) {
      return;
    }
    updateDesign({
      views: current.views.filter((view) => view.viewId !== viewId),
      representativeViewId:
        current.representativeViewId === viewId ? null : current.representativeViewId,
      dimensionReferenceViewId:
        current.dimensionReferenceViewId === viewId ? null : current.dimensionReferenceViewId,
    });
  };
  const moveView = (viewId: string, kind: (typeof VIEW_SLOTS)[number]) => {
    const current = designRef.current;
    if (!current) return;
    updateDesign({
      views: current.views.map((view) => {
        const movedView = current.views.find((candidate) => candidate.viewId === viewId);
        if (!movedView) return view;
        if (view.viewId === viewId) return { ...view, kind, label: VIEW_LABELS[kind] };
        if (view.kind === kind && (VIEW_SLOTS as readonly string[]).includes(movedView.kind)) {
          const previousKind = movedView.kind as (typeof VIEW_SLOTS)[number];
          return { ...view, kind: previousKind, label: VIEW_LABELS[previousKind] };
        }
        return view;
      }),
    });
  };
  const updateSupplementalViewKind = (
    viewId: string,
    kind: (typeof SUPPLEMENTAL_VIEW_SLOTS)[number],
  ) => {
    const current = designRef.current;
    if (!current) return;
    updateDesign({
      views: current.views.map((view) =>
        view.viewId === viewId ? { ...view, kind, label: SUPPLEMENTAL_VIEW_LABELS[kind] } : view,
      ),
    });
  };
  const updateViewExpression = (
    viewId: string,
    expression: DesignPatent["views"][number]["expression"],
  ) => {
    const current = designRef.current;
    if (!current) return;
    updateDesign({
      views: current.views.map((view) => (view.viewId === viewId ? { ...view, expression } : view)),
    });
  };
  const updateViewLabel = (viewId: string, label: string) => {
    const normalized = label.trim();
    if (!normalized) return;
    const current = designRef.current;
    if (!current) return;
    updateDesign({
      views: current.views.map((view) =>
        view.viewId === viewId ? { ...view, label: normalized } : view,
      ),
    });
  };
  const applyViewOperation = async (viewId: string, operation: DesignPatentImageOperation) => {
    const view = designRef.current?.views.find((candidate) => candidate.viewId === viewId);
    if (!view) return;
    const baseOperations = view.operations;
    const operations = [...baseOperations, operation];
    const processed = await window.patentApi.assets.processDesignImage({
      sessionId: session.sessionId,
      assetId: view.assetId,
      operations,
    });
    if (!processed.ok) {
      setImageMessage(processed.error.message);
      return;
    }
    const current = designRef.current;
    const currentView = current?.views.find((candidate) => candidate.viewId === viewId);
    if (
      !current ||
      !currentView ||
      currentView.assetId !== view.assetId ||
      !sameImageRecipe(currentView.operations, baseOperations)
    ) {
      setImageMessage("图片在处理期间已发生变化，本次结果未应用，请重试。");
      return;
    }
    setImageMessage(null);
    updateDesign({
      views: current.views.map((candidate) =>
        candidate.viewId === viewId
          ? { ...candidate, operations, subjectBounds: processed.value.subjectBounds }
          : candidate,
      ),
    });
  };
  const undoViewOperation = async (viewId: string) => {
    const view = designRef.current?.views.find((candidate) => candidate.viewId === viewId);
    if (!view || view.operations.length === 0) return;
    const baseOperations = view.operations;
    const operations = view.operations.slice(0, -1);
    const processed = await window.patentApi.assets.processDesignImage({
      sessionId: session.sessionId,
      assetId: view.assetId,
      operations,
    });
    if (!processed.ok) {
      setImageMessage(processed.error.message);
      return;
    }
    const current = designRef.current;
    const currentView = current?.views.find((candidate) => candidate.viewId === viewId);
    if (
      !current ||
      !currentView ||
      currentView.assetId !== view.assetId ||
      !sameImageRecipe(currentView.operations, baseOperations)
    ) {
      setImageMessage("图片在处理期间已发生变化，本次结果未应用，请重试。");
      return;
    }
    setImageMessage(null);
    updateDesign({
      views: current.views.map((candidate) =>
        candidate.viewId === viewId
          ? { ...candidate, operations, subjectBounds: processed.value.subjectBounds }
          : candidate,
      ),
    });
  };
  const exportBundle = async () => {
    if (issues.length > 0 && !confirmWarnings) return;
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    try {
      const expectedRevision = onPrepareExport
        ? await onPrepareExport()
        : session.persistedRevision;
      if (expectedRevision === null) return;
      const result = await window.patentApi.exports.designPatent({
        sessionId: session.sessionId,
        patentId: session.patentId,
        expectedRevision,
        format: exportFormat,
        confirmWarnings,
        zip,
      });
      if (!result.ok) {
        setExportError(result.error.message);
        return;
      }
      if (result.value) {
        if (onExportCommitted && !onExportCommitted(result.value.patent, result.value.savedAt)) {
          setExportError("导出历史同步失败，请重新打开专利后查看。");
          return;
        }
        designRef.current = result.value.patent.designPatent;
        setShowChecks(false);
      }
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  const importImages = async () => {
    const result = await window.patentApi.assets.chooseAndImportMany(session.sessionId);
    if (!result.ok) {
      setImageMessage(result.error.message);
      return;
    }
    if (result.value.length === 0) return;
    const supportedFormat = result.value.filter(
      (asset) =>
        asset.descriptor.mediaType === "image/jpeg" || asset.descriptor.mediaType === "image/png",
    );
    const oversized = supportedFormat.filter((asset) => {
      const width = asset.descriptor.widthPx ?? 0;
      const height = asset.descriptor.heightPx ?? 0;
      return (
        width <= 0 ||
        height <= 0 ||
        width > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
        height > MAX_DESIGN_IMAGE_SOURCE_EDGE_PX ||
        width * height > MAX_DESIGN_IMAGE_SOURCE_PIXELS
      );
    });
    const oversizedIds = new Set(oversized.map((asset) => asset.descriptor.assetId));
    const accepted = supportedFormat.filter((asset) => !oversizedIds.has(asset.descriptor.assetId));
    const rejectedFormatCount = result.value.length - supportedFormat.length;
    if (accepted.length === 0) {
      setImageMessage(
        [
          oversized.length > 0
            ? `已忽略 ${oversized.length} 张超过 10000 像素边长或 4000 万总像素的图片。`
            : "",
          rejectedFormatCount > 0
            ? `已忽略 ${rejectedFormatCount} 个非 JPG、JPEG 或 PNG 文件。`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    const analyses = [];
    let analysisFailed = false;
    for (const asset of accepted) {
      const analysis = await window.patentApi.assets.processDesignImage({
        sessionId: session.sessionId,
        assetId: asset.descriptor.assetId,
        operations: [],
      });
      if (!analysis.ok) analysisFailed = true;
      analyses.push({ asset, subjectBounds: analysis.ok ? analysis.value.subjectBounds : null });
    }
    const current = designRef.current;
    if (!current) return;
    const availableKinds = VIEW_SLOTS.filter(
      (kind) => !current.views.some((view) => view.kind === kind),
    );
    const nextViews = [...current.views];
    for (const [index, { asset, subjectBounds }] of analyses.entries()) {
      const kind = availableKinds[index] ?? "other";
      nextViews.push({
        viewId: crypto.randomUUID(),
        kind,
        label: VIEW_LABELS[kind as keyof typeof VIEW_LABELS] ?? "补充视图",
        assetId: asset.descriptor.assetId,
        expression: current.primaryExpression ?? "line-drawing",
        subjectBounds,
        operations: [],
        note: null,
      });
    }
    const assets = [
      ...assetsRef.current,
      ...accepted
        .map((asset) => asset.descriptor)
        .filter(
          (descriptor) =>
            !assetsRef.current.some((existing) => existing.assetId === descriptor.assetId),
        ),
    ];
    const dimensionReferenceViewId =
      current.dimensionReferenceViewId ??
      nextViews.find((view) => view.kind === "front")?.viewId ??
      nextViews.find((view) => (ORTHOGRAPHIC_VIEW_SLOTS as readonly string[]).includes(view.kind))
        ?.viewId ??
      null;
    commitDesign(
      {
        ...current,
        primaryExpression: current.primaryExpression ?? "line-drawing",
        dimensionReferenceViewId,
        views: nextViews,
      },
      assets,
    );
    const messages = [
      analysisFailed ? "部分图片无法识别产品主体，仍已导入；请检查图片后再导出。" : "",
      oversized.length > 0
        ? `已忽略 ${oversized.length} 张超过 10000 像素边长或 4000 万总像素的图片。`
        : "",
      rejectedFormatCount > 0 ? `已忽略 ${rejectedFormatCount} 个非 JPG、JPEG 或 PNG 文件。` : "",
    ].filter(Boolean);
    setImageMessage(messages.length > 0 ? messages.join(" ") : null);
  };
  const renderImageOperations = (view: DesignPatent["views"][number]) => (
    <div className="design-patent-workbench__operations">
      <button
        type="button"
        disabled={view.subjectBounds === null}
        onClick={() => {
          const bounds = view.subjectBounds;
          if (!bounds) return;
          void applyViewOperation(view.viewId, {
            kind: "trim",
            left: bounds.leftPx,
            top: bounds.topPx,
            width: bounds.widthPx,
            height: bounds.heightPx,
          });
        }}
      >
        裁剪空白边
      </button>
      <button
        type="button"
        onClick={() => void applyViewOperation(view.viewId, { kind: "rotate", degrees: 90 })}
      >
        顺时针旋转 90°
      </button>
      <button
        type="button"
        title="用于轻度水平透视或倾斜，可重复应用并随时撤销"
        onClick={() =>
          void applyViewOperation(view.viewId, { kind: "affine", xSkew: -0.06, ySkew: 0 })
        }
      >
        透视向左校正
      </button>
      <button
        type="button"
        title="用于轻度水平透视或倾斜，可重复应用并随时撤销"
        onClick={() =>
          void applyViewOperation(view.viewId, { kind: "affine", xSkew: 0.06, ySkew: 0 })
        }
      >
        透视向右校正
      </button>
      <button
        type="button"
        onClick={() =>
          void applyViewOperation(view.viewId, {
            kind: "canvas",
            width: 1600,
            height: 1600,
            fit: "contain",
          })
        }
      >
        统一画布
      </button>
      <button
        type="button"
        onClick={async () => {
          if (
            await confirmAppAction("单轴尺寸校准会拉伸产品比例，可能改变外观表达。确认仍要应用吗？")
          ) {
            void applyViewOperation(view.viewId, {
              kind: "canvas",
              width: 1600,
              height: 1600,
              fit: "fill",
            });
          }
        }}
      >
        单轴尺寸校准（高风险）
      </button>
      {view.operations.length > 0 ? (
        <button type="button" onClick={() => void undoViewOperation(view.viewId)}>
          撤销上一步
        </button>
      ) : null}
    </div>
  );

  return (
    <main className="design-patent-workbench" aria-label="外观设计工作台">
      <header className="design-patent-workbench__header">
        <div>
          <h1>{session.patent.name ?? "未命名外观设计"}</h1>
          <p>图片整理和简要说明均会自动保存；检查结果仅作申报前提示。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setShowChecks(true)}>
          检查并导出
        </button>
      </header>
      <div className="design-patent-workbench__tabs" role="tablist" aria-label="外观设计工作台">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "images"}
          onClick={() => setTab("images")}
        >
          图片或照片
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "brief"}
          onClick={() => setTab("brief")}
        >
          简要说明
        </button>
      </div>
      {tab === "images" ? (
        <section className="design-patent-workbench__images" aria-label="图片或照片">
          <p>导入 JPG、JPEG 或 PNG 后，将图片分配到对应视图；局部设计请导入已完成标记的图片。</p>
          <label>
            主表现方式
            <select
              value={design.primaryExpression ?? ""}
              onChange={(event) =>
                updateDesign({
                  primaryExpression: event.currentTarget.value
                    ? (event.currentTarget.value as DesignPatent["primaryExpression"])
                    : null,
                })
              }
            >
              <option value="">导入后选择</option>
              {Object.entries(EXPRESSION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void importImages()}>
            导入图片
          </button>
          {imageMessage ? <p role="alert">{imageMessage}</p> : null}
          <label>
            尺寸比例参考视图
            <select
              value={design.dimensionReferenceViewId ?? ""}
              onChange={(event) =>
                updateDesign({ dimensionReferenceViewId: event.currentTarget.value || null })
              }
            >
              <option value="">自动选择主视图或首个六视图</option>
              {design.views
                .filter((view) =>
                  (ORTHOGRAPHIC_VIEW_SLOTS as readonly string[]).includes(view.kind),
                )
                .map((view) => (
                  <option key={view.viewId} value={view.viewId}>
                    {view.label}
                  </option>
                ))}
            </select>
          </label>
          <div className="design-patent-workbench__view-grid">
            {VIEW_SLOTS.map((kind) => {
              const view = design.views.find((candidate) => candidate.kind === kind);
              return (
                <div className="design-patent-workbench__view-slot" key={kind}>
                  <strong>{VIEW_LABELS[kind]}</strong>
                  {view ? (
                    <>
                      {previewUrls[view.viewId] ? (
                        <img src={previewUrls[view.viewId]} alt={`${view.label}预览`} />
                      ) : null}
                      <span>{view.label}</span>
                      <label>
                        {view.label}名称
                        <input
                          defaultValue={view.label}
                          maxLength={100}
                          onBlur={(event) =>
                            updateViewLabel(view.viewId, event.currentTarget.value)
                          }
                        />
                      </label>
                      <label>
                        {view.label}表现方式
                        <select
                          value={view.expression}
                          onChange={(event) =>
                            updateViewExpression(
                              view.viewId,
                              event.currentTarget
                                .value as DesignPatent["views"][number]["expression"],
                            )
                          }
                        >
                          {Object.entries(EXPRESSION_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <select
                        aria-label={`${VIEW_LABELS[kind]}视图类型`}
                        value={view.kind}
                        onChange={(event) =>
                          moveView(
                            view.viewId,
                            event.currentTarget.value as (typeof VIEW_SLOTS)[number],
                          )
                        }
                      >
                        {VIEW_SLOTS.map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {VIEW_LABELS[candidate]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => updateDesign({ representativeViewId: view.viewId })}
                      >
                        {design.representativeViewId === view.viewId ? "已选代表图" : "设为代表图"}
                      </button>
                      <button type="button" onClick={() => void removeView(view.viewId)}>
                        移除
                      </button>
                      {renderImageOperations(view)}
                    </>
                  ) : (
                    <span>待分配图片</span>
                  )}
                </div>
              );
            })}
          </div>
          {design.views.some((view) => !(VIEW_SLOTS as readonly string[]).includes(view.kind)) ? (
            <section className="design-patent-workbench__supplemental" aria-label="补充视图">
              <h2>补充视图</h2>
              {design.views
                .filter((view) => !(VIEW_SLOTS as readonly string[]).includes(view.kind))
                .map((view) => (
                  <div className="design-patent-workbench__view-slot" key={view.viewId}>
                    <strong>
                      {SUPPLEMENTAL_VIEW_LABELS[
                        view.kind as keyof typeof SUPPLEMENTAL_VIEW_LABELS
                      ] ?? "补充视图"}
                    </strong>
                    {previewUrls[view.viewId] ? (
                      <img src={previewUrls[view.viewId]} alt={`${view.label}预览`} />
                    ) : null}
                    <span>{view.label}</span>
                    <label>
                      {view.label}名称
                      <input
                        defaultValue={view.label}
                        maxLength={100}
                        onBlur={(event) => updateViewLabel(view.viewId, event.currentTarget.value)}
                      />
                    </label>
                    <label>
                      {view.label}表现方式
                      <select
                        value={view.expression}
                        onChange={(event) =>
                          updateViewExpression(
                            view.viewId,
                            event.currentTarget
                              .value as DesignPatent["views"][number]["expression"],
                          )
                        }
                      >
                        {Object.entries(EXPRESSION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {view.label}视图类型
                      <select
                        value={view.kind}
                        onChange={(event) =>
                          updateSupplementalViewKind(
                            view.viewId,
                            event.currentTarget.value as (typeof SUPPLEMENTAL_VIEW_SLOTS)[number],
                          )
                        }
                      >
                        {SUPPLEMENTAL_VIEW_SLOTS.map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {SUPPLEMENTAL_VIEW_LABELS[candidate]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => updateDesign({ representativeViewId: view.viewId })}
                    >
                      {design.representativeViewId === view.viewId ? "已选代表图" : "设为代表图"}
                    </button>
                    <button type="button" onClick={() => void removeView(view.viewId)}>
                      移除
                    </button>
                    {renderImageOperations(view)}
                  </div>
                ))}
            </section>
          ) : null}
          <aside className="design-patent-workbench__hint">
            六视图检查以图片中产品主体的宽、高、深比例为依据；可先裁剪空白边、旋转/透视校正或进行尺寸校准，再由你确认应用。
          </aside>
        </section>
      ) : (
        <section className="design-patent-workbench__brief" aria-label="简要说明">
          <label>
            产品名称
            <input value={session.patent.name ?? ""} readOnly />
          </label>
          <label>
            设计范围
            <select
              value={design.subject}
              onChange={(event) =>
                updateDesign({
                  subject: event.currentTarget.value as DesignPatent["subject"],
                })
              }
            >
              <option value="whole-product">整体产品设计</option>
              <option value="partial-design">产品的局部设计</option>
            </select>
          </label>
          <label>
            最能表明设计要点的图片或照片（必填）
            <select
              value={design.representativeViewId ?? ""}
              onChange={(event) =>
                updateDesign({ representativeViewId: event.currentTarget.value || null })
              }
            >
              <option value="">请选择代表图</option>
              {design.views.map((view) => (
                <option key={view.viewId} value={view.viewId}>
                  {view.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            产品用途（必填）
            <textarea
              value={design.brief.productUse}
              onChange={(event) => updateBrief({ productUse: event.currentTarget.value })}
            />
          </label>
          {design.subject === "partial-design" ? (
            <label>
              局部设计保护部分及表示方式（条件必填）
              <textarea
                value={design.brief.partialDesignDescription}
                onChange={(event) =>
                  updateBrief({ partialDesignDescription: event.currentTarget.value })
                }
              />
            </label>
          ) : null}
          <fieldset>
            <legend>设计要点（必填）</legend>
            {(["shape", "pattern", "color"] as const).map((point) => (
              <label key={point}>
                <input
                  type="checkbox"
                  checked={design.brief.designPoints.includes(point)}
                  onChange={(event) =>
                    updateBrief({
                      designPoints: event.currentTarget.checked
                        ? [...design.brief.designPoints, point]
                        : design.brief.designPoints.filter((item) => item !== point),
                    })
                  }
                />
                {{ shape: "形状", pattern: "图案", color: "色彩" }[point]}
              </label>
            ))}
          </fieldset>
          <label>
            其他需要说明的内容（选填）
            <textarea
              value={design.brief.otherDescription}
              onChange={(event) => updateBrief({ otherDescription: event.currentTarget.value })}
            />
          </label>
          <label>
            色彩保护
            <input
              type="checkbox"
              checked={design.brief.colorProtectionRequested}
              onChange={(event) =>
                updateBrief({ colorProtectionRequested: event.currentTarget.checked })
              }
            />
            请求保护色彩
          </label>
          <label>
            连续变化的表面（选填）
            <select
              value={design.brief.continuousSurface ?? ""}
              onChange={(event) =>
                updateBrief({
                  continuousSurface: event.currentTarget.value
                    ? (event.currentTarget.value as NonNullable<
                        DesignPatent["brief"]["continuousSurface"]
                      >)
                    : null,
                })
              }
            >
              <option value="">无</option>
              <option value="up-down">上下连续</option>
              <option value="left-right">左右连续</option>
              <option value="all-sides">四周连续</option>
            </select>
          </label>
          <fieldset>
            <legend>视图省略说明（选填）</legend>
            {ORTHOGRAPHIC_VIEW_SLOTS.map((viewKind) => {
              const omission = design.brief.omissions.find((item) => item.viewKind === viewKind);
              return (
                <div key={viewKind}>
                  <label>
                    <input
                      type="checkbox"
                      checked={omission !== undefined}
                      onChange={(event) =>
                        updateOmission(
                          viewKind,
                          event.currentTarget.checked ? "same-or-symmetric" : null,
                        )
                      }
                    />
                    省略{VIEW_LABELS[viewKind]}
                  </label>
                  {omission ? (
                    <>
                      <select
                        aria-label={`${VIEW_LABELS[viewKind]}省略原因`}
                        value={omission.reason}
                        onChange={(event) =>
                          updateOmission(
                            viewKind,
                            event.currentTarget
                              .value as DesignPatent["brief"]["omissions"][number]["reason"],
                          )
                        }
                      >
                        <option value="same-or-symmetric">与主视图相同或对称</option>
                        <option value="rotationally-identical">旋转后与其他视图相同</option>
                        <option value="flat-or-thin">该方向无设计要点</option>
                        <option value="not-visible-during-use">使用时不容易看到</option>
                        <option value="other">其他原因</option>
                      </select>
                      {omission.reason === "other" ? (
                        <label>
                          {VIEW_LABELS[viewKind]}其他省略原因（条件必填）
                          <input
                            value={omission.otherReason ?? ""}
                            onChange={(event) =>
                              updateOmissionOtherReason(viewKind, event.currentTarget.value)
                            }
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={design.brief.elongatedObjectLengthOmitted}
              onChange={(event) =>
                updateBrief({ elongatedObjectLengthOmitted: event.currentTarget.checked })
              }
            />
            细长物品省略长度
          </label>
          <label>
            材料说明（选填）
            <textarea
              value={design.brief.materialDescription}
              onChange={(event) => updateBrief({ materialDescription: event.currentTarget.value })}
            />
          </label>
          <label>
            不属于保护范围的内部结构说明（选填）
            <textarea
              value={design.brief.excludedInteriorDescription}
              onChange={(event) =>
                updateBrief({ excludedInteriorDescription: event.currentTarget.value })
              }
            />
          </label>
          <section aria-label="简要说明实时预览">
            <h2>简要说明预览</h2>
            {renderDesignPatentBriefLines(session.patent.name, design).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        </section>
      )}
      {showChecks ? (
        <aside className="design-patent-workbench__checks" role="dialog" aria-label="导出前检查">
          <h2>导出前检查</h2>
          <p>以下为软件提示；可修改后重新检查，或确认风险后继续导出。</p>
          <ul>
            {issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
          <label>
            简要说明文档格式
            <select
              value={exportFormat}
              onChange={(event) => setExportFormat(event.currentTarget.value as "docx" | "pdf")}
            >
              <option value="docx">DOCX</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
          {issues.length > 0 ? (
            <label>
              <input
                type="checkbox"
                checked={confirmWarnings}
                onChange={(event) => setConfirmWarnings(event.currentTarget.checked)}
              />
              我已了解上述提示，确认继续导出
            </label>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={zip}
              onChange={(event) => setZip(event.currentTarget.checked)}
            />
            同时生成 ZIP 压缩包（选填）
          </label>
          {exportError ? <p role="alert">{exportError}</p> : null}
          <button
            type="button"
            disabled={exporting || (issues.length > 0 && !confirmWarnings)}
            onClick={() => void exportBundle()}
          >
            {exporting ? "正在导出…" : "选择位置并导出"}
          </button>
          <button type="button" onClick={() => setShowChecks(false)}>
            关闭
          </button>
        </aside>
      ) : null}
    </main>
  );
}
