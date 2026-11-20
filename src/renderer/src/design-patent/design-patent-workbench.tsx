import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetDescriptor } from "../../../shared/document/model";
import {
  type DesignImageMode,
  renameDesignImage,
  reorderDesignImages,
  resetDesignImageMode,
  swapDesignImages,
} from "../../../shared/patent/design-image-modes";
import {
  type DesignPatent,
  type DesignPatentImageOperation,
  type DesignPatentPrimarySlot,
  isAssignedDesignView,
  MAX_DESIGN_IMAGE_SOURCE_EDGE_PX,
  MAX_DESIGN_IMAGE_SOURCE_PIXELS,
} from "../../../shared/patent/design-patent";
import { resolveDesignViewImage } from "../../../shared/patent/design-view-image";
import { setViewOmission } from "../../../shared/patent/design-view-omissions";
import type { CanonicalPatent } from "../../../shared/patent/model";
import type { PatentSession } from "../patents/patent-reducer";
import { confirmAppAction } from "../shared/app-dialog";
import { mergeDesignBriefEdit } from "./brief/design-brief-edit";
import { DesignBriefForm } from "./brief/design-brief-form";
import { CorrectionUnsavedDialog } from "./correction/correction-unsaved-dialog";
import {
  DesignImageCorrectionStep,
  type DesignImageCorrectionStepHandle,
} from "./correction/design-image-correction-step";
import { TemporaryFrameDialog } from "./correction/klecks-temporary-dialogs";
import type { SixViewResizeRequest } from "./design-six-view-resize";
import { getDesignWorkflowStatuses } from "./design-workflow";
import { DesignWorkspaceShell } from "./design-workspace-shell";
import { DESIGN_ASSIGNMENT_LABELS, suggestDesignAssignments } from "./import/design-assignment";
import { applyDesignViewAssignment } from "./import/design-assignment-save";
import { type DesignImportedAsset, importDroppedDesignFiles } from "./import/design-file-drop";
import { DesignImageModeDialog } from "./import/design-image-mode-dialog";
import { DesignImagePreviewDialog } from "./import/design-image-preview-dialog";
import { DesignImportStep } from "./import/design-import-step";
import { DesignMultiImageGrid } from "./import/design-multi-image-grid";
import { DesignExportReview } from "./review/design-export-review";
import { SixViewPreviewProvider } from "./six-view-preview";
import {
  type DesignPixelSize,
  resolveDesignViewPixelSize,
  useProcessedDesignSizes,
} from "./six-view-preview-context";

export type PreparedDesignExport = { previewRevision: number; revision: number };

type Props = {
  briefZoomPercent?: number;
  defaultExportFormat?: "docx" | "pdf" | undefined;
  folderNavigation?: { step: "images" | "brief" | "review" } | undefined;
  session: PatentSession;
  onUpdate(designPatent: DesignPatent, assets: AssetDescriptor[]): void;
  onAssignView?(viewId: string, kind: DesignPatentPrimarySlot | "unassigned"): Promise<void>;
  onRemoveView?(viewId: string): Promise<void>;
  onSwitchImageMode?(mode: DesignImageMode): Promise<void>;
  boardHistory?: {
    canUndo: boolean;
    canRedo: boolean;
    busy: boolean;
    undoResize?: boolean;
    redoResize?: boolean;
    step(redo: boolean): Promise<void>;
  };
  onResizeSixViews?(request: SixViewResizeRequest): Promise<number>;
  onPrepareExport?(
    previewRevision: number,
    signal: AbortSignal,
  ): Promise<PreparedDesignExport | null>;
  onExportCommitted?(patent: CanonicalPatent, savedAt: string): boolean;
  registerPatentLeaveGuard?(patentId: string, guard: () => Promise<boolean>): () => void;
  renderCorrection?(options: { onAddImages(): void; initialViewId: string | undefined }): ReactNode;
};

const ORTHOGRAPHIC_VIEW_SLOTS = ["front", "rear", "left", "right", "top", "bottom"] as const;

function sameImageRecipe(
  left: readonly DesignPatentImageOperation[],
  right: readonly DesignPatentImageOperation[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const emptyDesignPreviews = { urls: {}, processedSizes: {} };
function useDesignPreviews(session: PatentSession) {
  const sessionId = session.sessionId;
  const sourceKey = JSON.stringify(
    (session.patent.designPatent?.views ?? []).map((view) => ({
      viewId: view.viewId,
      ...resolveDesignViewImage(view),
    })),
  );
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    sourceKey: string;
    urls: Record<string, string>;
    processedSizes: Record<string, DesignPixelSize>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    const sources = JSON.parse(sourceKey) as Array<{
      viewId: string;
      assetId: string;
      operations: DesignPatentImageOperation[];
    }>;
    const load = async () => {
      const urls: Record<string, string> = {},
        processedSizes: Record<string, DesignPixelSize> = {};
      await Promise.all(
        sources.map(async ({ viewId, assetId, operations }) => {
          try {
            const api = window.patentApi.assets;
            let bytes: Uint8Array;
            if (operations.length && typeof api.processDesignImage === "function") {
              const result = await api.processDesignImage({ sessionId, assetId, operations });
              if (!result.ok) return;
              bytes = result.value.bytes;
              processedSizes[viewId] = {
                widthPx: result.value.widthPx,
                heightPx: result.value.heightPx,
              };
            } else {
              const result = await api.getPreview(sessionId, assetId);
              if (!result.ok) return;
              bytes = result.value;
            }
            const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
            if (cancelled) URL.revokeObjectURL(url);
            else {
              createdUrls.push(url);
              urls[viewId] = url;
            }
          } catch {
            // One unavailable asset must not prevent every other preview from loading.
          }
        }),
      );
      if (!cancelled) setLoaded({ sessionId, sourceKey, urls, processedSizes });
    };
    void load();
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [sessionId, sourceKey]);
  // Do not pair new size metadata with the previous, revoked image version.
  return loaded?.sessionId === sessionId && loaded.sourceKey === sourceKey
    ? loaded
    : emptyDesignPreviews;
}

function DesignPatentWorkbenchContent({
  session,
  briefZoomPercent = 100,
  defaultExportFormat = "docx",
  onUpdate,
  onPrepareExport,
  onExportCommitted,
  onAssignView,
  onRemoveView,
  boardHistory,
  onSwitchImageMode,
  onResizeSixViews,
  activeTab,
  onNavigate,
  exportLockRef,
  previewUrls,
}: Props & {
  activeTab: "images" | "brief" | "checks";
  onNavigate(tab: "brief" | "checks" | "correction"): void;
  exportLockRef: MutableRefObject<boolean>;
  previewUrls: Record<string, string>;
}) {
  const processedSizes = useProcessedDesignSizes();
  const [formatOverride, setExportFormat] = useState<"docx" | "pdf">();
  const exportFormat = formatOverride ?? defaultExportFormat;
  const [zip, setZip] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<{
    outputDirectory: string;
    documentPath: string;
    imagePaths: string[];
    zipPath: string | null;
  } | null>(null);
  const [imageMessage, setImageMessage] = useState<string | null>(null);
  const [imageImportErrors, setImageImportErrors] = useState<
    Array<{ originalName: string; message: string }>
  >([]);
  const [importingImages, setImportingImages] = useState(false);
  const [importFrame, setImportFrame] = useState<{
    name: string;
    count: number;
    resolve(page: number | null): void;
  } | null>(null);
  const frameResolver = useRef<((page: number | null) => void) | null>(null);
  const [pendingImageMode, setPendingImageMode] = useState<DesignImageMode | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  const switchingRef = useRef(false);
  const [imagePreviewId, setImagePreviewId] = useState<string | null>(null);
  const importRequestRef = useRef(0);
  const importingImagesRef = useRef(false);
  const droppedFilesQueue = useRef<Array<readonly File[]>>([]);
  const activeSessionId = useRef<string | null>(session.sessionId);
  useEffect(() => {
    activeSessionId.current = session.sessionId;
    return () => {
      activeSessionId.current = null;
      importRequestRef.current++;
      frameResolver.current?.(null);
      frameResolver.current = null;
      droppedFilesQueue.current = [];
      importingImagesRef.current = false;
    };
  }, [session.sessionId]);
  const assigningRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = exportLockRef;
  const exportAbort = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Abort an in-flight export when its case session is replaced or unmounted.
  useEffect(() => () => exportAbort.current?.abort(), [session.sessionId]);
  const design = session.patent.designPatent;
  const designRef = useRef(design);
  const assetsRef = useRef(session.patent.assets);
  useEffect(() => {
    designRef.current = design;
    assetsRef.current = session.patent.assets;
  }, [design, session.patent.assets]);
  if (!design) return <main className="editor-workspace">外观设计数据不可用。</main>;
  const assignedViews = design.views.filter(isAssignedDesignView);
  const multiMode = design.imageMode === "multi-image";
  const switchMode = async (mode: DesignImageMode) => {
    if (switchingRef.current || importingImagesRef.current || exportingRef.current) return;
    switchingRef.current = true;
    setSwitchingMode(true);
    setImageMessage(null);
    try {
      if (onSwitchImageMode) await onSwitchImageMode(mode);
      else {
        const current = designRef.current;
        if (current) onUpdate(resetDesignImageMode(current, mode), assetsRef.current);
      }
      setPendingImageMode(null);
      setImagePreviewId(null);
    } catch (error) {
      setImageMessage(error instanceof Error ? error.message : "保存或切换失败，当前图片已保留。");
    } finally {
      switchingRef.current = false;
      setSwitchingMode(false);
    }
  };
  const requestMode = (mode: DesignImageMode) => {
    const current = designRef.current;
    if (
      !current ||
      (current.imageMode ?? "six-view") === mode ||
      importingImagesRef.current ||
      switchingRef.current ||
      boardHistory?.busy
    )
      return;
    if (current.views.length || current.brief.omissions.length) setPendingImageMode(mode);
    else void switchMode(mode);
  };
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
    if (reason !== null && current.views.some((view) => view.kind === viewKind)) {
      setImageMessage("该视图已有真实图片，请先将图片移回暂存区再设置省略。");
      return;
    }
    updateBrief({ omissions: setViewOmission(current, viewKind, reason).brief.omissions });
  };
  const updateDesign = (patch: Partial<DesignPatent>) => {
    const current = designRef.current;
    if (!current) return;
    commitDesign({ ...current, ...patch });
  };
  const removeView = async (viewId: string) => {
    const current = designRef.current;
    if (!current) return;
    const target = current.views.find((view) => view.viewId === viewId);
    if (!target) return;
    const isRepresentative = current.representativeViewId === viewId;
    const isDimensionReference = current.dimensionReferenceViewId === viewId;
    const roleWarning =
      isRepresentative || isDimensionReference
        ? `，且当前用作${
            isRepresentative && isDimensionReference
              ? "代表图和尺寸比例参考"
              : isRepresentative
                ? "代表图"
                : "尺寸比例参考"
          }，删除后相应选择将变为缺项`
        : "";
    const confirmed = await confirmAppAction(
      `删除“${target.label}”${roleWarning}？此操作会将图片移出本申请。`,
    );
    if (!confirmed) return;
    const latest = designRef.current;
    if (
      activeSessionId.current !== session.sessionId ||
      !latest?.views.some((view) => view.viewId === viewId && view.assetId === target.assetId) ||
      (latest.representativeViewId === viewId) !== isRepresentative ||
      (latest.dimensionReferenceViewId === viewId) !== isDimensionReference
    )
      return;
    if (onRemoveView) {
      void onRemoveView(viewId).catch((e) =>
        setImageMessage(e instanceof Error ? e.message : "图片保存或删除失败，请重试。"),
      );
      return;
    }
    updateDesign({
      views: latest.views.filter((view) => view.viewId !== viewId),
      representativeViewId:
        latest.representativeViewId === viewId ? null : latest.representativeViewId,
      dimensionReferenceViewId:
        latest.dimensionReferenceViewId === viewId ? null : latest.dimensionReferenceViewId,
    });
  };
  const assignView = async (viewId: string, kind: DesignPatentPrimarySlot | "unassigned") => {
    const current = designRef.current;
    if (!current || assigningRef.current || exportingRef.current) return;
    if (!onAssignView) {
      commitDesign(applyDesignViewAssignment(current, viewId, kind));
      return;
    }
    assigningRef.current = true;
    setImageMessage("正在保存图片编辑并更新分配…");
    try {
      await onAssignView(viewId, kind);
      setImageMessage(null);
    } catch (error) {
      setImageMessage(
        error instanceof Error ? error.message : "图片保存或分配更新失败，请检查后重试。",
      );
    } finally {
      assigningRef.current = false;
    }
  };
  const confirmAutoSuggestions = () => {
    const current = designRef.current;
    if (!current) return;
    commitDesign({
      ...current,
      views: current.views.map((view) =>
        view.assignmentStatus === "pending-auto"
          ? { ...view, assignmentStatus: "confirmed" as const, assignmentEvidence: null }
          : view,
      ),
    });
  };
  const exportBundle = async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    setExportSuccess(null);
    const operation = new AbortController();
    exportAbort.current = operation;
    try {
      const api = window.patentApi.exports;
      if (!api.chooseDesignPatentDestination)
        throw new Error("当前环境不支持选择外观设计导出位置。");
      const destination = await api.chooseDesignPatentDestination({
        sessionId: session.sessionId,
        patentId: session.patentId,
      });
      if (!destination.ok) throw new Error(destination.error.message);
      if (!destination.value || operation.signal.aborted) return;
      const prepared = onPrepareExport
        ? await onPrepareExport(session.localRevision, operation.signal)
        : { previewRevision: session.persistedRevision, revision: session.persistedRevision };
      if (!prepared || operation.signal.aborted) return;
      if (prepared.previewRevision !== session.localRevision) {
        setExportError("材料已更新，请确认当前预览后重试。");
        return;
      }
      const result = await api.designPatent({
        sessionId: session.sessionId,
        patentId: session.patentId,
        expectedRevision: prepared.revision,
        destinationToken: destination.value,
        format: exportFormat,
        // Existing export protocol: warnings do not block the export step.
        confirmWarnings: true,
        zip,
      });
      if (operation.signal.aborted) return;
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
        setExportSuccess({
          outputDirectory: result.value.outputDirectory,
          documentPath: result.value.documentPath,
          imagePaths: result.value.imagePaths,
          zipPath: result.value.zipPath,
        });
      }
    } catch (error) {
      if (!operation.signal.aborted)
        setExportError(error instanceof Error ? error.message : "导出失败，请重试。");
    } finally {
      exportAbort.current = null;
      exportingRef.current = false;
      setExporting(false);
    }
  };
  const importImages = async (files?: readonly File[]) => {
    if (switchingRef.current || pendingImageMode || exportingRef.current) return;
    if (importingImagesRef.current) {
      if (files?.length) droppedFilesQueue.current.push(files);
      return;
    }
    importingImagesRef.current = true;
    const requestId = ++importRequestRef.current;
    setImportingImages(true);
    setImageMessage(null);
    setImageImportErrors([]);
    try {
      let chosenFiles = files;
      if (!chosenFiles && window.patentApi.assets.chooseDesignFiles) {
        const selection = await window.patentApi.assets.chooseDesignFiles(session.sessionId);
        if (!selection.ok) throw selection.error;
        if (requestId !== importRequestRef.current) return;
        chosenFiles = selection.value.map(
          (file) => new File([Uint8Array.from(file.bytes)], file.name),
        );
      }
      const dropped = chosenFiles
        ? await importDroppedDesignFiles(chosenFiles, session.sessionId, window.patentApi.assets, {
            decoder: window.patentApi.imageEditor,
            selectPage: (name, count) =>
              new Promise((resolve) => {
                frameResolver.current = resolve;
                setImportFrame({ name, count, resolve });
              }),
          })
        : null;
      const result = dropped
        ? { ok: true as const, value: dropped.assets }
        : await window.patentApi.assets.chooseAndImportMany(session.sessionId);
      if (requestId !== importRequestRef.current) return;
      if (!result.ok) {
        setImageMessage(result.error.message);
        setImageImportErrors([]);
        return;
      }
      const importErrors: Array<{ originalName: string; message: string }> = dropped?.errors ?? [];
      if (result.value.length === 0) {
        setImageImportErrors(importErrors);
        if (importErrors.length)
          setImageMessage(`${importErrors.length} 个文件未导入；请查看逐项原因。`);
        return;
      }
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
      const accepted = supportedFormat
        .filter((asset) => !oversizedIds.has(asset.descriptor.assetId))
        .map((asset) => asset as DesignImportedAsset);
      const rejectedFormatCount = result.value.length - supportedFormat.length;
      for (const asset of oversized)
        importErrors.push({
          originalName: asset.descriptor.originalName,
          message: "图片尺寸超过 10000 像素边长或 4000 万总像素限制。",
        });
      for (const asset of result.value.filter((asset) => !supportedFormat.includes(asset)))
        importErrors.push({
          originalName: asset.descriptor.originalName,
          message: "仅支持 JPG、JPEG 或 PNG 图片。",
        });
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
        setImageImportErrors(importErrors);
        return;
      }
      const analyses = [];
      for (const asset of accepted) {
        const analysis = await window.patentApi.assets.processDesignImage({
          sessionId: session.sessionId,
          assetId: asset.descriptor.assetId,
          operations: [],
        });
        if (requestId !== importRequestRef.current) return;
        if (!analysis.ok) {
          importErrors.push({
            originalName: asset.descriptor.originalName,
            message: analysis.error.message,
          });
          continue;
        }
        analyses.push({
          asset,
          subjectBounds: analysis.value.subjectBounds,
          viewId: crypto.randomUUID(),
        });
      }
      if (analyses.length === 0) {
        setImageMessage(
          [
            importErrors.length > 0 ? `${importErrors.length} 张图片未导入；请查看逐项原因。` : "",
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
        setImageImportErrors(importErrors);
        return;
      }
      const current = designRef.current;
      if (!current) return;
      const occupied = new Set(
        current.views
          .filter((view) => view.kind in DESIGN_ASSIGNMENT_LABELS)
          .map((view) => view.kind as DesignPatentPrimarySlot),
      );
      const suggestions = new Map(
        suggestDesignAssignments(
          analyses.map(({ asset, viewId }) => ({
            id: viewId,
            originalName: asset.importedName ?? asset.descriptor.originalName,
          })),
          occupied,
        ).map((suggestion) => [suggestion.id, suggestion]),
      );
      const nextViews = [...current.views];
      for (const { asset, subjectBounds, viewId } of analyses) {
        const suggestion = suggestions.get(viewId);
        const multi = current.imageMode === "multi-image";
        const kind = multi
          ? "multi-image"
          : suggestion?.status === "suggested"
            ? suggestion.kind
            : "unassigned";
        nextViews.push({
          viewId,
          kind,
          label:
            kind === "multi-image"
              ? (asset.importedName ?? asset.descriptor.originalName)
                  .replace(/\.[^.]+$/u, "")
                  .trim()
                  .slice(0, 100) || `图片${nextViews.length + 1}`
              : kind === "unassigned"
                ? asset.descriptor.originalName
                : DESIGN_ASSIGNMENT_LABELS[kind],
          assetId: asset.descriptor.assetId,
          expression: current.primaryExpression ?? "line-drawing",
          subjectBounds,
          subjectBoundsSource: subjectBounds === null ? null : "automatic",
          subjectBoundsConfirmed: false,
          assignmentStatus:
            !multi && suggestion?.status === "suggested" ? "pending-auto" : "confirmed",
          assignmentEvidence:
            !multi && suggestion?.status === "suggested" ? suggestion.evidence : null,
          operations: [],
          ...(asset.editor ? { editor: asset.editor } : {}),
          note: null,
        });
      }
      const assets = [
        ...assetsRef.current,
        ...[
          ...new Map(
            analyses.flatMap(({ asset }) =>
              [asset.descriptor, ...(asset.projectAsset ? [asset.projectAsset] : [])].map(
                (descriptor) => [descriptor.assetId, descriptor] as const,
              ),
            ),
          ).values(),
        ].filter(
          (descriptor) =>
            !assetsRef.current.some((existing) => existing.assetId === descriptor.assetId),
        ),
      ];
      const dimensionReferenceViewId =
        current.imageMode === "multi-image"
          ? null
          : (current.dimensionReferenceViewId ??
            nextViews.find((view) => view.kind === "front")?.viewId ??
            nextViews.find((view) =>
              (ORTHOGRAPHIC_VIEW_SLOTS as readonly string[]).includes(view.kind),
            )?.viewId ??
            null);
      commitDesign(
        {
          ...current,
          primaryExpression: current.primaryExpression ?? "line-drawing",
          dimensionReferenceViewId,
          views: nextViews,
          brief: {
            ...current.brief,
            omissions: current.brief.omissions.filter(
              (item) => !nextViews.some((view) => view.kind === item.viewKind),
            ),
          },
        },
        assets,
      );
      const messages = [
        importErrors.length > 0 ? `${importErrors.length} 张图片未导入；其余图片已正常导入。` : "",
        oversized.length > 0
          ? `已忽略 ${oversized.length} 张超过 10000 像素边长或 4000 万总像素的图片。`
          : "",
        rejectedFormatCount > 0 ? `已忽略 ${rejectedFormatCount} 个非 JPG、JPEG 或 PNG 文件。` : "",
      ].filter(Boolean);
      setImageMessage(messages.length > 0 ? messages.join(" ") : null);
      setImageImportErrors(importErrors);
    } catch {
      if (requestId === importRequestRef.current)
        setImageMessage("图片导入失败，请检查文件后重试。");
    } finally {
      if (requestId === importRequestRef.current) {
        importingImagesRef.current = false;
        setImportingImages(false);
        const next = droppedFilesQueue.current.shift();
        if (next) void importImages(next);
      }
    }
  };
  const previewView = design.views.find((view) => view.viewId === imagePreviewId);
  const imagePreviewUrl = previewView ? previewUrls[previewView.viewId] : undefined;
  const previewSize = previewView
    ? resolveDesignViewPixelSize(
        previewView,
        session.patent.assets.find((asset) => asset.assetId === previewView.assetId),
        processedSizes,
      )
    : null;
  return (
    <div
      className="design-patent-workbench__content"
      onDragOverCapture={(event) => {
        if (Array.from(event.dataTransfer.types ?? []).includes("application/x-design-view-id"))
          return;
        if (activeTab !== "images" || !Array.from(event.dataTransfer.types ?? []).includes("Files"))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDropCapture={(event) => {
        if (Array.from(event.dataTransfer.types ?? []).includes("application/x-design-view-id"))
          return;
        if (activeTab !== "images" || !event.dataTransfer.files?.length) return;
        event.preventDefault();
        event.stopPropagation();
        void importImages(Array.from(event.dataTransfer.files));
      }}
    >
      {importFrame
        ? createPortal(
            <TemporaryFrameDialog
              name={importFrame.name}
              count={importFrame.count}
              onFinish={(page) => {
                importFrame.resolve(page);
                frameResolver.current = null;
                setImportFrame(null);
              }}
            />,
            document.body,
          )
        : null}
      {activeTab === "images" ? (
        <section className="design-patent-workbench__images" aria-label="图片整理工作区">
          <div className="design-image-mode-bar">
            <fieldset className="design-image-mode-bar__switch" aria-label="图片组织模式">
              <button
                type="button"
                aria-pressed={!multiMode}
                disabled={importingImages || switchingMode || !!boardHistory?.busy}
                onClick={() => requestMode("six-view")}
              >
                六视图模式
              </button>
              <button
                type="button"
                aria-pressed={multiMode}
                disabled={importingImages || switchingMode || !!boardHistory?.busy}
                onClick={() => requestMode("multi-image")}
              >
                多图模式
              </button>
            </fieldset>
            {multiMode ? <span>按顺序整理图片，可修改名称或拖动排序</span> : null}
            {boardHistory && (
              <fieldset
                aria-label="视图板历史"
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  gridColumn: "1 / -1",
                }}
              >
                <button
                  type="button"
                  disabled={boardHistory.busy || importingImages || !boardHistory.canUndo}
                  onClick={() =>
                    void boardHistory
                      .step(false)
                      .catch((e) =>
                        setImageMessage(e instanceof Error ? e.message : "撤销失败，请重试。"),
                      )
                  }
                >
                  {boardHistory.undoResize ? "撤销尺寸调整" : "撤销分配"}
                </button>
                <button
                  type="button"
                  disabled={boardHistory.busy || importingImages || !boardHistory.canRedo}
                  onClick={() =>
                    void boardHistory
                      .step(true)
                      .catch((e) =>
                        setImageMessage(e instanceof Error ? e.message : "重做失败，请重试。"),
                      )
                  }
                >
                  {boardHistory.redoResize ? "重做尺寸调整" : "重做分配"}
                </button>
              </fieldset>
            )}
          </div>
          {imageMessage && !pendingImageMode ? (
            <p className="design-patent-workbench__images-message" role="alert">
              {imageMessage}
            </p>
          ) : null}
          {imageImportErrors.length > 0 ? (
            <section
              className="design-patent-workbench__images-import-result"
              role="status"
              aria-label="导入结果"
            >
              <h3>导入结果</h3>
              <ul>
                {imageImportErrors.map((item) => (
                  <li key={`${item.originalName}-${item.message}`}>
                    <strong>{item.originalName}</strong>：{item.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {multiMode ? (
            <DesignMultiImageGrid
              design={design}
              assets={session.patent.assets}
              previewUrls={previewUrls}
              disabled={importingImages || switchingMode || !!boardHistory?.busy}
              onImport={() => void importImages()}
              onPreview={setImagePreviewId}
              onRemove={removeView}
              onRename={(id, name) => {
                if (designRef.current) commitDesign(renameDesignImage(designRef.current, id, name));
              }}
              onReorder={(id, before, swap) => {
                if (designRef.current)
                  commitDesign(
                    swap && before
                      ? swapDesignImages(designRef.current, id, before)
                      : reorderDesignImages(designRef.current, id, before),
                  );
              }}
            />
          ) : (
            <DesignImportStep
              design={design}
              assets={session.patent.assets}
              previewUrls={previewUrls}
              importing={importingImages || !!boardHistory?.busy}
              onResizeSixViews={onResizeSixViews}
              onCorrection={() => onNavigate("correction")}
              autoSuggested={Object.fromEntries(
                design.views
                  .filter(
                    (view) =>
                      view.kind !== "unassigned" &&
                      view.assignmentStatus === "pending-auto" &&
                      view.assignmentEvidence !== null,
                  )
                  .flatMap((view) => {
                    const evidence = view.assignmentEvidence;
                    if (evidence == null) return [];
                    return [
                      [
                        view.viewId,
                        {
                          kind: view.kind as DesignPatentPrimarySlot,
                          evidence,
                        },
                      ] as const,
                    ];
                  }),
              )}
              onConfirmAll={confirmAutoSuggestions}
              onImport={() => void importImages()}
              onAssign={assignView}
              onRemove={removeView}
              onOmission={updateOmission}
            />
          )}
          {pendingImageMode ? (
            <DesignImageModeDialog
              mode={pendingImageMode}
              count={design.views.length}
              busy={switchingMode}
              error={imageMessage}
              onCancel={() => setPendingImageMode(null)}
              onConfirm={() => void switchMode(pendingImageMode)}
            />
          ) : null}
        </section>
      ) : activeTab === "brief" ? (
        <DesignBriefForm
          design={design}
          productName={session.patent.name}
          previewUrls={previewUrls}
          zoomPercent={briefZoomPercent}
          onChange={(next) => {
            const current = designRef.current;
            if (current) commitDesign(mergeDesignBriefEdit(current, design, next));
          }}
          onPreviewImage={setImagePreviewId}
          onReview={() => onNavigate("checks")}
        />
      ) : null}
      {previewView && imagePreviewUrl ? (
        <DesignImagePreviewDialog
          key={previewView.viewId}
          label={previewView.label}
          resolution={
            previewSize ? `${previewSize.widthPx} × ${previewSize.heightPx} px` : "分辨率未知"
          }
          previewUrl={imagePreviewUrl}
          onClose={() => setImagePreviewId(null)}
        />
      ) : null}
      {activeTab === "checks" ? (
        <DesignExportReview
          patent={session.patent}
          previewUrls={previewUrls}
          format={exportFormat}
          zip={zip}
          busy={exporting}
          error={exportError}
          success={exportSuccess}
          onFormat={setExportFormat}
          onZip={setZip}
          onExport={() => void exportBundle()}
          onBrief={() => onNavigate("brief")}
        />
      ) : null}
    </div>
  );
}

export function DesignPatentWorkbench(props: Props) {
  const design = props.session.patent.designPatent;
  const { urls: previewUrls, processedSizes } = useDesignPreviews(props.session);
  const [activeStep, setActiveStep] = useState<"images" | "correction" | "brief" | "review">(
    props.folderNavigation?.step ?? "images",
  );
  const exportLockRef = useRef(false);
  const correctionRef = useRef<DesignImageCorrectionStepHandle>(null);
  const latestDesignRef = useRef(design);
  const [correctionDirty, setCorrectionDirty] = useState(false);
  const [pendingCorrectionStep, setPendingCorrectionStep] = useState<
    "images" | "correction" | "brief" | "review" | null
  >(null);
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);
  const [correctionSessionKey, setCorrectionSessionKey] = useState(0);
  const [boardError, setBoardError] = useState<string | null>(null);
  const handledFolderNavigation = useRef(props.folderNavigation);
  useEffect(() => {
    const request = props.folderNavigation;
    if (!request || handledFolderNavigation.current === request) return;
    if (props.boardHistory?.busy) return;
    handledFolderNavigation.current = request;
    if (activeStep === "correction" && correctionDirty) setPendingCorrectionStep(request.step);
    else setActiveStep(request.step);
  }, [props.folderNavigation, props.boardHistory?.busy, activeStep, correctionDirty]);
  useEffect(() => {
    const listener = (event: Event) => {
      const e = event as CustomEvent<{
        patentId: string;
        command: "undo" | "redo";
        handled: boolean;
      }>;
      if (e.detail.patentId !== props.session.patentId || activeStep === "correction") return;
      e.detail.handled = true;
      if (
        activeStep !== "images" ||
        !props.boardHistory ||
        props.boardHistory.busy ||
        exportLockRef.current
      )
        return;
      const redo = e.detail.command === "redo";
      if (redo ? !props.boardHistory.canRedo : !props.boardHistory.canUndo) return;
      void props.boardHistory
        .step(redo)
        .catch((err) =>
          setBoardError(err instanceof Error ? err.message : "视图板恢复失败，请重试。"),
        );
    };
    window.addEventListener("design-board-history", listener);
    return () => window.removeEventListener("design-board-history", listener);
  }, [props.session.patentId, props.boardHistory, activeStep]);
  const [pendingCorrectionClose, setPendingCorrectionClose] = useState(false);
  const closeResolver = useRef<((allow: boolean) => void) | null>(null);
  useEffect(() => {
    latestDesignRef.current = design;
  }, [design]);
  useEffect(
    () =>
      props.registerPatentLeaveGuard?.(props.session.patentId, async () => {
        if (!correctionDirty) return true;
        setPendingCorrectionClose(true);
        return new Promise((resolve) => {
          closeResolver.current = resolve;
        });
      }),
    [props.registerPatentLeaveGuard, props.session.patentId, correctionDirty],
  );
  if (!design) return <main className="editor-workspace">外观设计数据不可用。</main>;
  const statuses = getDesignWorkflowStatuses(design, props.session.patent.name);
  const navigateContent = (tab: "brief" | "checks" | "correction") => {
    setActiveStep(tab === "checks" ? "review" : tab);
  };
  const applyCorrection = (
    viewId: string,
    committed: readonly DesignPatentImageOperation[],
    draft: readonly DesignPatentImageOperation[],
  ) => {
    if (exportLockRef.current) {
      setCorrectionMessage("导出进行中，暂不能保存图片修改。");
      return false;
    }
    const latest = latestDesignRef.current;
    const current = latest?.views.find((view) => view.viewId === viewId);
    if (!latest || !current || !sameImageRecipe(current.operations, committed)) {
      setCorrectionMessage("图片已在其他位置更新，请重新加载后再应用修改。");
      return false;
    }
    props.onUpdate(
      {
        ...latest,
        views: latest.views.map((view) =>
          view.viewId === viewId
            ? {
                ...view,
                operations: [...draft],
                subjectBoundsSource: view.subjectBounds === null ? null : "automatic",
                subjectBoundsConfirmed: false,
              }
            : view,
        ),
      },
      props.session.patent.assets,
    );
    return true;
  };
  const loadCorrectionPreview = async (
    _viewId: string,
    assetId: string,
    operations: readonly DesignPatentImageOperation[],
  ) => {
    const bytes =
      operations.length === 0
        ? await window.patentApi.assets
            .getPreview(props.session.sessionId, assetId)
            .then((result) => (result.ok ? result.value : null))
        : await window.patentApi.assets
            .processDesignImage({
              sessionId: props.session.sessionId,
              assetId,
              operations: [...operations],
            })
            .then((result) => (result.ok ? result.value.bytes : null));
    return bytes;
  };
  const beforeStepChange = (nextStep: "images" | "correction" | "brief" | "review") => {
    if (props.boardHistory?.busy) return false;
    if (activeStep === "correction" && correctionDirty) {
      setPendingCorrectionStep(nextStep);
      return false;
    }
    return true;
  };
  return (
    <SixViewPreviewProvider
      design={design}
      assets={props.session.patent.assets}
      previewUrls={previewUrls}
      processedSizes={processedSizes}
    >
      {boardError && <p role="alert">{boardError}</p>}
      <DesignWorkspaceShell
        retainCorrection={!!props.renderCorrection}
        statuses={statuses}
        target={null}
        activeStep={activeStep}
        onStepChange={setActiveStep}
        onBeforeStepChange={beforeStepChange}
        bodies={{
          images: (
            <DesignPatentWorkbenchContent
              {...props}
              activeTab="images"
              onNavigate={navigateContent}
              exportLockRef={exportLockRef}
              previewUrls={previewUrls}
            />
          ),
          correction: props.renderCorrection ? (
            props.renderCorrection({
              onAddImages: () => setActiveStep("images"),
              initialViewId: undefined,
            })
          ) : (
            <>
              {correctionMessage ? <p role="alert">{correctionMessage}</p> : null}
              <DesignImageCorrectionStep
                key={correctionSessionKey}
                ref={correctionRef}
                design={design}
                thumbnailUrls={previewUrls}
                loadPreview={loadCorrectionPreview}
                onApply={applyCorrection}
                onDirtyChange={setCorrectionDirty}
              />
            </>
          ),
          brief: (
            <section className="design-workspace-shell__content" aria-labelledby="brief-heading">
              <h2
                id="brief-heading"
                className="design-workspace-shell__visually-hidden"
                tabIndex={-1}
              >
                简要说明
              </h2>
              <DesignPatentWorkbenchContent
                {...props}
                activeTab="brief"
                onNavigate={navigateContent}
                exportLockRef={exportLockRef}
                previewUrls={previewUrls}
              />
            </section>
          ),
          review: (
            <section className="design-workspace-shell__content" aria-labelledby="review-heading">
              <DesignPatentWorkbenchContent
                {...props}
                activeTab="checks"
                onNavigate={navigateContent}
                exportLockRef={exportLockRef}
                previewUrls={previewUrls}
              />
            </section>
          ),
        }}
      />
      {pendingCorrectionStep ? (
        <CorrectionUnsavedDialog
          onStay={() => setPendingCorrectionStep(null)}
          onDiscard={() => {
            correctionRef.current?.discard();
            setCorrectionSessionKey((value) => value + 1);
            setCorrectionDirty(false);
            setActiveStep(pendingCorrectionStep);
            setPendingCorrectionStep(null);
          }}
          onApply={() => {
            if (correctionRef.current?.apply()) {
              setCorrectionDirty(false);
              setActiveStep(pendingCorrectionStep);
              setPendingCorrectionStep(null);
            }
          }}
        />
      ) : null}
      {pendingCorrectionClose ? (
        <CorrectionUnsavedDialog
          onStay={() => {
            closeResolver.current?.(false);
            closeResolver.current = null;
            setPendingCorrectionClose(false);
          }}
          onDiscard={() => {
            correctionRef.current?.discard();
            closeResolver.current?.(true);
            closeResolver.current = null;
            setCorrectionDirty(false);
            setPendingCorrectionClose(false);
          }}
          onApply={() => {
            if (correctionRef.current?.apply()) {
              closeResolver.current?.(true);
              closeResolver.current = null;
              setCorrectionDirty(false);
              setPendingCorrectionClose(false);
            }
          }}
        />
      ) : null}
    </SixViewPreviewProvider>
  );
}
