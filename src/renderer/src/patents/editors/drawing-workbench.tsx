import { ArrowDownUp } from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { AssetDescriptor, InlineNode, PageSettings } from "../../../../shared/document/model";
import type { FlowchartProjectDescriptor } from "../../../../shared/flowcharts/model";
import type { ImageOutputFormat } from "../../../../shared/ipc/contract";
import type {
  DrawingExplanationSync,
  UnlinkedDrawingExplanation,
} from "../../../../shared/patent/drawing-explanations";
import type { PatentFigure, PatentType } from "../../../../shared/patent/model";
import { shortcutTooltip } from "../../../../shared/settings/shortcuts";
import { MotionPresence } from "../../app/motion-presence";
import { useConfiguredShortcut, useShortcutAction } from "../../app/shortcut-dispatcher";
import { ImageSelectionFrame } from "../../editor/image/image-selection-frame";
import type { RotationDirection } from "../../editor/image/image-transform";
import { extractClipboardDataImages } from "../../editor/paste-sanitizer";
import { useObjectContextMenu } from "../../editor/ui/object-context-menu";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import type { OperationFeedback } from "../../shared/operation-feedback";
import {
  SPATIAL_MOTION_TIMING,
  spatialMotionTiming,
  synchronizePaintTimings,
} from "../../shared/spatial-motion";
import { SpatialPresence } from "../../shared/spatial-presence";
import { StandardDialog } from "../../shared/standard-dialog";
import { TransientFunctionRailSlot } from "../../shared/transient-function-rail-slot";
import { DocumentStructureRuler } from "../document-structure-ruler";
import { useOptionalPatentFunctionRail } from "../function-rail/function-rail-context";
import { PatentGlobalFunctionRail } from "../patent-global-function-rail";
import { AssetPreview } from "./asset-preview";
import { isSupportedDrawingImage, readDrawingImageFiles } from "./drawing-image-import";
import type {
  DrawingExplanationDrafts,
  DrawingExplanationRailEntry,
} from "./drawing-sync-controller";
import type { DrawingImageImport } from "./drawings-editor";

type DrawingRailPanel = "explanation" | "reference-marks";

type DrawingRailControls = {
  referenceMarksCollapsed: boolean;
  onToggleReferenceMarksCollapse(): void;
};

const DRAWING_RAIL_PANEL_STORAGE_KEY = "patent-workbench.drawing-rail-expanded-panel";

function readDrawingRailPanel(): DrawingRailPanel {
  try {
    const stored = window.localStorage.getItem(DRAWING_RAIL_PANEL_STORAGE_KEY);
    // 附图标记与附图说明必须且只能有一方打开；旧版本存储的 "none" 回退默认附图说明。
    if (stored === "explanation" || stored === "reference-marks") {
      return stored;
    }
  } catch {
    // 本地存储不可用时回退默认：附图说明展开。
  }
  return "explanation";
}

type DrawingWorkbenchProps = {
  shortcutsEnabled?: boolean;
  sessionId: string;
  patentType?: PatentType;
  zoomPercent?: number;
  page?: PageSettings;
  figures: PatentFigure[];
  assets?: readonly AssetDescriptor[];
  sync: DrawingExplanationSync;
  unlinked: readonly UnlinkedDrawingExplanation[];
  explanations?: readonly DrawingExplanationRailEntry[];
  savedDrafts?: DrawingExplanationDrafts;
  onDraftsChange?(drafts: DrawingExplanationDrafts): void;
  existingExplanationText?: string;
  toolbar?: ReactNode | ((controls: DrawingRailControls) => ReactNode);
  onPasteImages?(images: DrawingImageImport[]): void;
  onReorderFigures(figures: PatentFigure[]): void;
  onResizeFigure(figureId: string, widthMm: number): void;
  onRotateFigures?(figureIds: string[], direction: RotationDirection): void;
  onChange(
    changes: readonly {
      target: { figureId: string; figureNumber: number; paragraphId: string | null };
      content: InlineNode[];
    }[],
  ):
    | undefined
    | { ok: true }
    | { ok: false; message: string }
    | Promise<undefined | { ok: true } | { ok: false; message: string }>;
  onOperationFeedback?(feedback: OperationFeedback): void;
  onDeleteFigure(figureId: string): void;
  onDeleteFigures?(figureIds: string[]): void;

  flowchartProjects?: readonly FlowchartProjectDescriptor[];
  onOpenLinkedFlowchart?(projectId: string, figureId: string): void;
  onEditChemicalStructure?(figureId: string, assetId: string): void;
};

async function clipboardImages(data: DataTransfer): Promise<DrawingImageImport[]> {
  const files = Array.from(data.files ?? []).filter(isSupportedDrawingImage);
  if (files.length > 0) {
    return readDrawingImageFiles(files);
  }
  return extractClipboardDataImages(data.getData("text/html") ?? "").map((image) => ({
    originalName: image.originalName,
    declaredMediaType: image.mediaType,
    bytes: image.bytes,
  }));
}

function moveFigureTo(
  figures: PatentFigure[],
  draggedFigureId: string,
  targetIndex: number,
): PatentFigure[] {
  const sourceIndex = figures.findIndex((figure) => figure.figureId === draggedFigureId);
  if (sourceIndex < 0 || sourceIndex === targetIndex) return figures;
  const next = figures.slice();
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return figures;
  next.splice(targetIndex, 0, moved);
  return next;
}

function inlineText(content: readonly InlineNode[]): string {
  return content
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "hard-break") return "\n";
      if (node.type === "inline-formula") return node.source;
      return "";
    })
    .join("");
}

function explanationPrefixMatches(value: string, figureNumber: number): boolean {
  const prefix = new RegExp(`^(?:图|附图)\\s*${figureNumber}(?!\\d)`, "u");
  return prefix.test(value.trim());
}

// 功能栏内每项附图说明的硬上限：DOM maxLength 挡住输入，onChange 再截断兜底；
// 说明书里已存在的超长说明不主动破坏，仅不允许继续输入。
const EXPLANATION_MAX_LENGTH = 200;

function explanationDraftSource(
  entry: DrawingExplanationRailEntry,
  patentType: PatentType,
): string {
  if (entry.status === "editable") return inlineText(entry.paragraph.content);
  return `图${entry.figureNumber}为${patentType === "invention" ? "本发明" : "本实用新型"}的______示意图。`;
}

function DrawingExplanationDraftEditor({
  entry,
  label,
  value,
  onDraftChange,
  resizeInput,
}: {
  entry: DrawingExplanationRailEntry;
  label: string;
  value: string;
  onDraftChange(value: string): void;
  resizeInput(element: HTMLTextAreaElement | null): void;
}) {
  return (
    <textarea
      aria-label={`${label}附图说明`}
      placeholder={`请填写以“图${entry.figureNumber}”或“附图${entry.figureNumber}”开头的说明`}
      ref={resizeInput}
      value={value}
      maxLength={EXPLANATION_MAX_LENGTH}
      onChange={(event) => {
        onDraftChange(event.target.value.slice(0, EXPLANATION_MAX_LENGTH));
        resizeInput(event.currentTarget);
      }}
    />
  );
}

export function DrawingWorkbench({
  shortcutsEnabled = true,
  sessionId,
  patentType = "invention",
  zoomPercent = 100,
  page,
  figures,
  assets = [],
  sync,
  unlinked: _unlinked,
  explanations,
  savedDrafts,
  onDraftsChange,
  existingExplanationText,
  toolbar,
  onPasteImages = () => undefined,
  onReorderFigures,
  onResizeFigure,
  onRotateFigures = () => undefined,
  onChange,
  onOperationFeedback = () => undefined,
  onDeleteFigure,
  onDeleteFigures,

  onOpenLinkedFlowchart = () => undefined,
  onEditChemicalStructure,
}: DrawingWorkbenchProps) {
  const [draggedFigureId, setDraggedFigureId] = useState<string | null>(null);
  const [dropTargetFigureId, setDropTargetFigureId] = useState<string | null>(null);
  const [selectedFigureIds, setSelectedFigureIds] = useState<ReadonlySet<string>>(() => new Set());
  const contextRail = useOptionalPatentFunctionRail();
  const drawingMenu = useObjectContextMenu(`${sessionId}:drawings`, [
    { label: "图片设置", run: () => contextRail?.pin() },
    { label: "复制图片", disabled: selectedFigureIds.size === 0, run: () => copySelectedFigures() },
    {
      label: "删除图片",
      disabled: selectedFigureIds.size === 0,
      run: () =>
        (onDeleteFigures ?? ((ids: string[]) => ids.forEach(onDeleteFigure)))(
          Array.from(selectedFigureIds),
        ),
    },
  ]);
  const [selectionAnchorFigureId, setSelectionAnchorFigureId] = useState<string | null>(null);
  const selectedFigureId =
    selectedFigureIds.size === 1 ? (selectedFigureIds.values().next().value ?? null) : null;
  const [isSortMode, setIsSortMode] = useState(false);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [batchSaveFormat, setBatchSaveFormat] = useState<ImageOutputFormat>("png");
  const [imageFileOperation, setImageFileOperation] = useState<"copy" | "save" | null>(null);
  const [expandedPanel, setExpandedPanel] = useState<DrawingRailPanel>(readDrawingRailPanel);
  const explanationCollapsed = expandedPanel !== "explanation";
  const referenceMarksCollapsed = expandedPanel !== "reference-marks";
  // 附图标记与附图说明必须且只能有一方打开：点击已展开的面板时切换为另一面板，而非全部关闭。
  const toggleDrawingRailPanel = useCallback((panel: DrawingRailPanel) => {
    setExpandedPanel((current) =>
      current === panel ? (panel === "explanation" ? "reference-marks" : "explanation") : panel,
    );
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWING_RAIL_PANEL_STORAGE_KEY, expandedPanel);
    } catch {
      // 折叠偏好持久化失败不影响附图栏使用。
    }
  }, [expandedPanel]);
  const toggleSortMode = () => {
    captureFigurePositions();
    setIsSortMode((current) => !current);
  };
  const drawingSortShortcut = useConfiguredShortcut("toggle-drawing-sort");
  useShortcutAction("toggle-drawing-sort", shortcutsEnabled, () => {
    toggleSortMode();
    return true;
  });
  // 排序状态默认展开附图说明（按钮与快捷键进入排序时均生效；退出排序不改变当前面板）。
  useEffect(() => {
    if (isSortMode) setExpandedPanel("explanation");
  }, [isSortMode]);
  const figureScrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!isSortMode) return;
    const figures = figureScrollRef.current;
    if (!figures) return;
    figures.scrollTop = 0;
    const workspace = figures.closest<HTMLElement>(".editor-workspace");
    if (workspace) workspace.scrollTop = 0;
  }, [isSortMode]);
  const explanationRailRef = useRef<HTMLElement | null>(null);
  const pendingExplanationFigureRef = useRef<string | null>(null);
  const explanationScrollFrameRef = useRef<number | null>(null);
  const pendingNewFigureIdsRef = useRef(new Set<string>());
  const reorderPositionsRef = useRef<Map<string, DOMRect> | null>(null);
  const [figureAspectRatios, setFigureAspectRatios] = useState<Record<string, number>>({});
  const storedAspectRatios = useMemo(
    () => new Map(assets.map((asset) => [asset.assetId, asset.widthPx / asset.heightPx] as const)),
    [assets],
  );
  const [localDrafts, setLocalDrafts] = useState<DrawingExplanationDrafts>({});
  const explanationDrafts = savedDrafts ?? localDrafts;
  const setExplanationDrafts = (drafts: DrawingExplanationDrafts) => {
    if (!savedDrafts) setLocalDrafts(drafts);
    onDraftsChange?.(drafts);
  };
  const [confirmFill, setConfirmFill] = useState(false);
  const fillingRef = useRef(false);
  const cancelFillRef = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      if (explanationScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(explanationScrollFrameRef.current);
      }
    },
    [],
  );
  const explanationByFigureId = useMemo(() => {
    if (explanations) {
      return new Map(explanations.map((entry) => [entry.figureId, entry] as const));
    }
    const linked =
      sync.status === "active"
        ? new Map(sync.linked.map((item) => [item.figureId, item.paragraph] as const))
        : new Map<string, never>();
    return new Map(
      figures.map((figure, index) => {
        const paragraph = linked.get(figure.figureId);
        const entry: DrawingExplanationRailEntry = paragraph
          ? {
              figureId: figure.figureId,
              figureNumber: index + 1,
              status: "editable",
              paragraph,
            }
          : {
              figureId: figure.figureId,
              figureNumber: index + 1,
              status: "missing",
              paragraph: null,
              message: `说明书中缺少图${index + 1}的附图说明。`,
            };
        return [figure.figureId, entry] as const;
      }),
    );
  }, [explanations, figures, sync]);
  useEffect(() => {
    const next = { ...explanationDrafts };
    let changed = false;
    for (const entry of explanationByFigureId.values()) {
      if (next[entry.figureId]) continue;
      next[entry.figureId] = {
        figureNumber: entry.figureNumber,
        value: explanationDraftSource(entry, patentType),
      };
      changed = true;
    }
    if (changed) {
      if (!savedDrafts) setLocalDrafts(next);
      onDraftsChange?.(next);
    }
  }, [explanationByFigureId, explanationDrafts, onDraftsChange, patentType, savedDrafts]);
  const draftValueFor = (entry: DrawingExplanationRailEntry) => {
    const stored = explanationDrafts[entry.figureId];
    if (!stored) return explanationDraftSource(entry, patentType);
    return stored.figureNumber === entry.figureNumber
      ? stored.value
      : stored.value.replace(
          new RegExp(`^(\\s*(?:附图|图)\\s*)${stored.figureNumber}(?!\\d)`, "u"),
          `$1${entry.figureNumber}`,
        );
  };
  const explanationDraftItems = figures.flatMap((figure) => {
    const entry = explanationByFigureId.get(figure.figureId);
    if (!entry) return [];
    return [
      {
        entry,
        figureId: figure.figureId,
        value: draftValueFor(entry),
      },
    ];
  });
  const explanationActionsDisabled = explanationDraftItems.length === 0;
  const validateExplanationDrafts = () => {
    for (const item of explanationDraftItems) {
      const value = item.value.trim();
      if (!value) return `请先填写图${item.entry.figureNumber}的附图说明。`;
      if (!explanationPrefixMatches(value, item.entry.figureNumber)) {
        return `图${item.entry.figureNumber}的说明应以“图${item.entry.figureNumber}”或“附图${item.entry.figureNumber}”开头。`;
      }
    }
    return null;
  };
  const currentExplanationText =
    existingExplanationText ??
    [...explanationByFigureId.values()]
      .flatMap((entry) =>
        entry.status === "editable" ? [inlineText(entry.paragraph.content)] : [],
      )
      .join("\n");
  const fillAllDrawingExplanations = async (confirmed = false) => {
    if (fillingRef.current) return;
    const validationMessage = validateExplanationDrafts();
    if (validationMessage) {
      onOperationFeedback({ tone: "error", title: "无法填入", message: validationMessage });
      return;
    }
    if (!confirmed && currentExplanationText.trim()) {
      setConfirmFill(true);
      return;
    }
    setConfirmFill(false);
    fillingRef.current = true;
    try {
      const result = await onChange(
        explanationDraftItems.map(({ entry, value }) => ({
          target: {
            figureId: entry.figureId,
            figureNumber: entry.figureNumber,
            paragraphId: entry.status === "editable" ? entry.paragraph.id : null,
          },
          content:
            entry.status === "editable" &&
            value.trim() === inlineText(entry.paragraph.content).trim()
              ? structuredClone(entry.paragraph.content)
              : [{ type: "text" as const, text: value.trim(), marks: [] }],
        })),
      );
      if (result?.ok === false) {
        onOperationFeedback({ tone: "error", title: "无法填入", message: result.message });
        return;
      }
      onOperationFeedback({ tone: "success", title: "填入成功" });
    } catch {
      onOperationFeedback({
        tone: "error",
        title: "无法填入",
        message: "附图说明未能写入，请重试。",
      });
    } finally {
      fillingRef.current = false;
    }
  };
  const copyAllDrawingExplanations = async () => {
    const validationMessage = validateExplanationDrafts();
    if (validationMessage) {
      onOperationFeedback({ tone: "error", title: "无法复制", message: validationMessage });
      return;
    }
    const result = await window.patentApi.clipboard.writeText(
      explanationDraftItems
        .flatMap(({ value }) => value.trim().split(/\r?\n/u))
        .map((line) => (line.trim() ? `　　${line.trim()}` : ""))
        .join("\n"),
    );
    onOperationFeedback(
      result.ok
        ? { tone: "success", title: "复制成功", message: "附图说明已复制到剪贴板。" }
        : { tone: "error", title: "复制失败", message: "无法写入剪贴板，请重试。" },
    );
  };
  const figureOrderKey = figures.map((figure) => figure.figureId).join(",");
  const previousFigureIdsRef = useRef(new Set(figureOrderKey ? figureOrderKey.split(",") : []));
  const scrollPageToEnd = useCallback(() => {
    const pageScroller = figureScrollRef.current?.closest<HTMLElement>(".editor-workspace");
    if (!pageScroller) return;
    const prefersReducedMotion = isMotionReduced();
    if (typeof pageScroller.scrollTo === "function") {
      pageScroller.scrollTo({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        top: pageScroller.scrollHeight,
      });
      return;
    }
    pageScroller.scrollTop = pageScroller.scrollHeight;
  }, []);
  const handleNewFigurePreviewLoad = useCallback(
    (figureId: string) => {
      if (!pendingNewFigureIdsRef.current.delete(figureId)) return;
      scrollPageToEnd();
    },
    [scrollPageToEnd],
  );
  const resizeExplanationInput = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) {
      return;
    }

    element.style.height = "0px";
    const style = getComputedStyle(element);
    const minHeight = Number.parseFloat(style.getPropertyValue("--explanation-min-height")) || 72;
    const maxHeight =
      Number.parseFloat(style.getPropertyValue("--explanation-max-height")) || Infinity;
    element.style.height = `${Math.min(maxHeight, Math.max(minHeight, element.scrollHeight + 2))}px`;
  }, []);

  useEffect(() => {
    const previousFigureIds = previousFigureIdsRef.current;
    const currentFigureIds = new Set(figureOrderKey ? figureOrderKey.split(",") : []);
    previousFigureIdsRef.current = currentFigureIds;
    const newFigureIds = [...currentFigureIds].filter(
      (figureId) => !previousFigureIds.has(figureId),
    );
    if (newFigureIds.length === 0) return;
    newFigureIds.forEach((figureId) => {
      pendingNewFigureIdsRef.current.add(figureId);
    });
    const scrollToEnd = (node: HTMLDivElement | null) => {
      if (node) node.scrollTop = node.scrollHeight;
    };
    // 新图通过 IPC 异步加载，图片加载完成后容器高度才会撑到最终值。
    // 单帧滚动不够：多帧滚动覆盖渲染提交后一帧，再在图片加载窗口内持续滚动，
    // 直到连续两次观察到相同高度（图片已加载完、容器不再增长）为止。
    const scrollBothToEnd = () => {
      scrollToEnd(figureScrollRef.current);
      // 外层编辑区才是说明书附图的实际页面滚动容器；效果等同于按 End。
      scrollPageToEnd();
    };
    const frames: number[] = [];
    const settleFrames = new Set<number>();
    let lastScrollHeight = -1;
    let stableRounds = 0;
    let rounds = 0;
    const scheduleSettleCheck = () => {
      if (rounds >= 120) return; // 最长约 2 秒，避免无限轮询
      rounds += 1;
      const frame = requestAnimationFrame(() => {
        settleFrames.delete(frame);
        const node = figureScrollRef.current;
        const scrollHeight = node?.scrollHeight ?? 0;
        if (scrollHeight === lastScrollHeight) {
          stableRounds += 1;
          if (stableRounds >= 2) {
            // 高度连续两轮稳定，图片加载完成，滚动到位后停止。
            scrollBothToEnd();
            return;
          }
        } else {
          stableRounds = 0;
        }
        lastScrollHeight = scrollHeight;
        scrollBothToEnd();
        scheduleSettleCheck();
      });
      settleFrames.add(frame);
    };
    for (let index = 0; index < 6; index += 1) {
      frames.push(requestAnimationFrame(scrollBothToEnd));
    }
    scheduleSettleCheck();
    return () => {
      frames.forEach((frame) => {
        cancelAnimationFrame(frame);
      });
      settleFrames.forEach((frame) => {
        cancelAnimationFrame(frame);
      });
      settleFrames.clear();
    };
  }, [figureOrderKey, scrollPageToEnd]);

  useEffect(() => {
    const availableFigureIds = new Set(figures.map((figure) => figure.figureId));
    setSelectedFigureIds((current) => {
      const retained = [...current].filter((figureId) => availableFigureIds.has(figureId));
      return retained.length === current.size ? current : new Set(retained);
    });
    setSelectionAnchorFigureId((current) =>
      current && availableFigureIds.has(current) ? current : null,
    );
  }, [figures]);

  useEffect(() => {
    if (selectedFigureIds.size === 0) return;

    const clearSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedFigureIds(new Set());
        setSelectionAnchorFigureId(null);
      }
    };

    window.addEventListener("keydown", clearSelection);
    return () => window.removeEventListener("keydown", clearSelection);
  }, [selectedFigureIds]);

  const sortModeRef = useRef(isSortMode);
  const layoutAnimationsRef = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const modeChanged = sortModeRef.current !== isSortMode;
    sortModeRef.current = isSortMode;
    const previousPositions = reorderPositionsRef.current;
    reorderPositionsRef.current = null;
    if (
      !previousPositions ||
      document.documentElement.dataset.reducedMotion === "true" ||
      figureOrderKey.length === 0 ||
      isMotionReduced()
    ) {
      return;
    }

    const rows = figureScrollRef.current?.querySelectorAll<HTMLElement>("[data-figure-id]");
    const animations: Animation[] = [];
    layoutAnimationsRef.current = animations;
    let groupDuration = SPATIAL_MOTION_TIMING.duration;
    rows?.forEach((row) => {
      if (typeof row.animate !== "function") return;
      const figureId = row.dataset.figureId;
      const previous = figureId ? previousPositions.get(figureId) : undefined;
      if (!previous) return;
      const current = row.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      const frame = row.querySelector<HTMLElement>(".drawing-figure-frame");
      if (modeChanged && typeof frame?.animate === "function")
        animations.push(frame.animate([{ opacity: 0 }, { opacity: 1 }], SPATIAL_MOTION_TIMING));
      if (deltaX === 0 && deltaY === 0) return;
      const timing = spatialMotionTiming(Math.hypot(deltaX, deltaY));
      groupDuration = Math.max(groupDuration, timing.duration);
      animations.push(
        row.animate(
          [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: "translate(0, 0)" }],
          timing,
        ),
      );
    });
    synchronizePaintTimings(animations, groupDuration);
    return () => {
      for (const animation of animations) animation?.cancel?.();
    };
  }, [figureOrderKey, isSortMode]);

  const captureFigurePositions = () => {
    const positions = new Map<string, DOMRect>();
    const rows = figureScrollRef.current?.querySelectorAll<HTMLElement>("[data-figure-id]");
    rows?.forEach((row) => {
      const figureId = row.dataset.figureId;
      if (figureId) positions.set(figureId, row.getBoundingClientRect());
    });
    reorderPositionsRef.current = positions;
  };

  const pasteProps = {
    onPaste: (event: ClipboardEvent<HTMLElement>) => {
      const data = event.clipboardData;
      const hasImageFile = Array.from(data.files ?? []).some(isSupportedDrawingImage);
      const hasDataImage = /<img\b[^>]*\bsrc\s*=\s*["']?data:image\//iu.test(
        data.getData("text/html") ?? "",
      );
      if (!hasImageFile && !hasDataImage) return;
      event.preventDefault();
      void clipboardImages(data)
        .then((images) => {
          if (images.length > 0) onPasteImages(images);
        })
        .catch((error: unknown) =>
          onOperationFeedback({
            tone: "error",
            title: "无法导入图片",
            message: error instanceof Error ? error.message : "读取图片失败，请重试。",
          }),
        );
    },
  };

  const fileDragProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (draggedFigureId) return;
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
        setIsFileDragOver(true);
      }
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsFileDragOver(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (draggedFigureId) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setIsFileDragOver(false);
      void readDrawingImageFiles(files)
        .then((images) => {
          if (images.length > 0) onPasteImages(images);
        })
        .catch((error: unknown) =>
          onOperationFeedback({
            tone: "error",
            title: "无法导入图片",
            message: error instanceof Error ? error.message : "读取图片失败，请重试。",
          }),
        );
    },
  };

  // 双向定位：按稳定 figureId 关联。smooth 滚动到目标元素，并确保其完整可见。
  const scrollTargetIntoView = (
    target: Element | null,
    options: { block?: ScrollLogicalPosition } = {},
  ) => {
    if (!target || typeof target.scrollIntoView !== "function") return false;
    const prefersReducedMotion = isMotionReduced();
    target.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: options.block ?? "nearest",
    });
    return true;
  };

  const scrollExplanationToFigure = (figureId: string) => {
    // figureId 为 UUID（仅含 [0-9a-f-]），引号包裹的属性选择器安全，无需 CSS.escape。
    const target =
      explanationRailRef.current?.querySelector<HTMLElement>(`[data-figure-id="${figureId}"]`) ??
      null;
    const rail = target?.closest<HTMLElement>(".patent-global-function-rail") ?? null;
    if (!target || !rail) return false;
    if (explanationScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(explanationScrollFrameRef.current);
      explanationScrollFrameRef.current = null;
    }
    const railRect = rail.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const startScrollTop = rail.scrollTop;
    const targetScrollTop = Math.max(
      0,
      Math.min(
        rail.scrollHeight - rail.clientHeight,
        startScrollTop +
          targetRect.top -
          railRect.top -
          (rail.clientHeight - targetRect.height) / 2,
      ),
    );
    const scrollDistance = targetScrollTop - startScrollTop;
    const prefersReducedMotion = isMotionReduced();
    if (prefersReducedMotion || scrollDistance === 0) {
      rail.scrollTop = targetScrollTop;
      return true;
    }
    let startedAt: number | null = null;
    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = isMotionReduced() ? 1 : Math.min((timestamp - startedAt) / 280, 1);
      const easedProgress = 1 - (1 - progress) ** 3;
      rail.scrollTop = startScrollTop + scrollDistance * easedProgress;
      if (progress < 1) {
        explanationScrollFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        explanationScrollFrameRef.current = null;
      }
    };
    explanationScrollFrameRef.current = window.requestAnimationFrame(animate);
    return true;
  };

  useLayoutEffect(() => {
    const figureId = pendingExplanationFigureRef.current;
    if (figureId === null) return;
    pendingExplanationFigureRef.current = null;
    // Selecting an image can mount settings and replace the rail's child DOM.
    // Resolve and measure the current card only after that render has committed.
    scrollExplanationToFigure(figureId);
  });

  const scrollFigureToExplanation = (figureId: string) => {
    const container = figureScrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-figure-id="${figureId}"]`) ?? null;
    return scrollTargetIntoView(target, { block: "center" });
  };

  const selectFigure = (
    figureId: string,
    modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    const currentIndex = figures.findIndex((figure) => figure.figureId === figureId);
    const anchorIndex = selectionAnchorFigureId
      ? figures.findIndex((figure) => figure.figureId === selectionAnchorFigureId)
      : currentIndex;
    const rangeIds = figures
      .slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)
      .map((figure) => figure.figureId);
    if ((modifiers.ctrlKey || modifiers.metaKey) && modifiers.shiftKey) {
      setSelectedFigureIds((current) => new Set([...current, ...rangeIds]));
    } else if (modifiers.shiftKey) {
      setSelectedFigureIds(new Set(rangeIds));
    } else if (modifiers.ctrlKey || modifiers.metaKey) {
      setSelectedFigureIds((current) => {
        const next = new Set(current);
        if (next.has(figureId)) next.delete(figureId);
        else next.add(figureId);
        return next;
      });
      setSelectionAnchorFigureId(figureId);
    } else {
      setSelectedFigureIds(new Set([figureId]));
      setSelectionAnchorFigureId(figureId);
    }
    // 选中图片后，附图说明区平滑滚动到对应图号卡片。
    pendingExplanationFigureRef.current = figureId;
  };

  const activateFigureFromRuler = (figureId: string) => {
    // 从附图标尺点击跳转只滚动定位，不默认选中图片；选中状态由用户直接点击图片决定。
    scrollFigureToExplanation(figureId);
  };
  const orderedSelectedFigures = figures.filter((figure) => selectedFigureIds.has(figure.figureId));

  const copySelectedFigures = async () => {
    if (imageFileOperation !== null || orderedSelectedFigures.length === 0) return;
    setImageFileOperation("copy");
    try {
      const result = await window.patentApi.assets.copyImages({
        sessionId,
        images: orderedSelectedFigures.map((figure) => ({
          assetId: figure.assetId,
          rotationDeg: figure.rotationDeg ?? 0,
          label: `图${figures.indexOf(figure) + 1}`,
        })),
      });
      onOperationFeedback(
        result.ok
          ? {
              tone: "success",
              title: "复制成功",
              message:
                orderedSelectedFigures.length === 1
                  ? "图片已复制到剪贴板。"
                  : `已复制 ${orderedSelectedFigures.length} 张附图；粘贴到不支持富文本的应用时仅包含第一张。`,
            }
          : { tone: "error", title: "复制失败", message: result.error.message },
      );
    } catch {
      onOperationFeedback({
        tone: "error",
        title: "复制失败",
        message: "无法写入剪贴板，请重试。",
      });
    } finally {
      setImageFileOperation(null);
    }
  };
  const saveSelectedFigures = async () => {
    if (imageFileOperation !== null) return;
    const images = orderedSelectedFigures.map((figure) => ({
      assetId: figure.assetId,
      rotationDeg: figure.rotationDeg ?? 0,
      label: `图${figures.indexOf(figure) + 1}`,
    }));
    if (images.length === 0) return;
    setImageFileOperation("save");
    try {
      const result =
        images.length === 1
          ? await window.patentApi.assets.saveImage({
              sessionId,
              image: images[0] as (typeof images)[0],
            })
          : await window.patentApi.assets.saveImages({
              sessionId,
              images,
              format: batchSaveFormat,
            });
      if (!result.ok) {
        onOperationFeedback({ tone: "error", title: "另存失败", message: result.error.message });
      } else if (result.value) {
        onOperationFeedback({
          tone: "success",
          title: "另存成功",
          message: images.length === 1 ? "图片已保存。" : `已保存 ${result.value.length} 张附图。`,
        });
      }
    } catch {
      onOperationFeedback({
        tone: "error",
        title: "另存失败",
        message: "无法保存图片，请重试。",
      });
    } finally {
      setImageFileOperation(null);
    }
  };

  return (
    <fieldset
      className="drawing-workbench"
      aria-label="说明书附图工作台"
      {...pasteProps}
      onKeyDown={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof Element && target.closest('[contenteditable="true"]'))
        ) {
          return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
          if (figures.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          setSelectedFigureIds(new Set(figures.map((figure) => figure.figureId)));
          setSelectionAnchorFigureId(figures[0]?.figureId ?? null);
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "c" &&
          selectedFigureIds.size > 0
        ) {
          event.preventDefault();
          event.stopPropagation();
          void copySelectedFigures();
          return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && selectedFigureIds.size > 0) {
          event.preventDefault();
          event.stopPropagation();
          const figureIds = figures
            .map((figure) => figure.figureId)
            .filter((figureId) => selectedFigureIds.has(figureId));
          setSelectedFigureIds(new Set());
          setSelectionAnchorFigureId(null);
          (onDeleteFigures ?? ((ids: string[]) => ids.forEach(onDeleteFigure)))(figureIds);
        }
      }}
    >
      <div
        className="patent-page-with-rail drawing-workbench-body"
        data-structure-ruler="true"
        style={
          {
            "--patent-page-zoom": zoomPercent / 100,
            ...(page
              ? {
                  "--patent-book-page-width": `${page.widthMm}mm`,
                  "--patent-book-page-min-height": `${page.heightMm}mm`,
                  "--patent-page-margin-top": `${page.marginTopMm}mm`,
                  "--patent-page-margin-right": `${page.marginRightMm}mm`,
                  "--patent-page-margin-bottom": `${page.marginBottomMm}mm`,
                  "--patent-page-margin-left": `${page.marginLeftMm}mm`,
                }
              : {}),
          } as CSSProperties
        }
      >
        <SpatialPresence>
          {!isSortMode ? (
            <DocumentStructureRuler
              figures={figures}
              selectedFigureId={selectedFigureId}
              onActivateFigure={activateFigureFromRuler}
              measurementKey={zoomPercent}
            />
          ) : null}
        </SpatialPresence>
        <main
          className={`drawing-page patent-page-zoom-frame${isSortMode ? " is-sort-mode" : ""}${isFileDragOver ? " is-file-drag-over" : ""}`}
          aria-label="说明书附图页面"
          {...fileDragProps}
          onPointerDown={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-figure-id]")) return;
            setSelectedFigureIds(new Set());
            setSelectionAnchorFigureId(null);
          }}
        >
          <header className="patent-book-page-header">说明书附图</header>
          <div
            className={`drawing-pairs-scroll${isSortMode ? " is-sort-mode" : ""}`}
            data-testid="drawing-pairs-scroll"
            ref={figureScrollRef}
          >
            {figures.length === 0 ? (
              <p className="drawing-empty">
                还没有说明书附图，可在功能栏导入、直接粘贴或从桌面/文件夹拖入多张图片。
              </p>
            ) : null}
            {figures.map((figure, index) => {
              const label = `图${index + 1}`;
              const displayWidthMm = figure.widthMm;
              const selected = selectedFigureIds.has(figure.figureId);
              const originalAspectRatio =
                figureAspectRatios[figure.figureId] ?? storedAspectRatios.get(figure.assetId) ?? 1;
              const quarterTurned = figure.rotationDeg === 90 || figure.rotationDeg === 270;
              return (
                <article
                  className={`drawing-pair-row${draggedFigureId === figure.figureId ? " is-dragging" : ""}${dropTargetFigureId === figure.figureId && draggedFigureId !== figure.figureId ? " is-drop-target" : ""}`}
                  aria-label={label}
                  data-figure-id={figure.figureId}
                  key={figure.figureId}
                  draggable
                  onContextMenu={(event) => {
                    if (!selectedFigureIds.has(figure.figureId))
                      setSelectedFigureIds(new Set([figure.figureId]));
                    drawingMenu.open(event);
                  }}
                  onDoubleClick={() => {
                    if (figure.flowchartLink) {
                      onOpenLinkedFlowchart(figure.flowchartLink.projectId, figure.figureId);
                    } else if (
                      assets.find((asset) => asset.assetId === figure.assetId)?.kind ===
                      "chemical-preview"
                    ) {
                      onEditChemicalStructure?.(figure.figureId, figure.assetId);
                    }
                  }}
                  onDragStart={() => {
                    for (const animation of layoutAnimationsRef.current) animation?.cancel?.();
                    setDraggedFigureId(figure.figureId);
                    setDropTargetFigureId(null);
                  }}
                  onDragEnd={() => {
                    setDraggedFigureId(null);
                    setDropTargetFigureId(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (draggedFigureId && draggedFigureId !== figure.figureId) {
                      setDropTargetFigureId(figure.figureId);
                    }
                  }}
                  onDrop={() => {
                    if (!draggedFigureId) return;
                    const reorderedFigures = moveFigureTo(figures, draggedFigureId, index);
                    if (reorderedFigures !== figures) {
                      captureFigurePositions();
                      onReorderFigures(reorderedFigures);
                    }
                    setDraggedFigureId(null);
                    setDropTargetFigureId(null);
                  }}
                >
                  <figure
                    className={`drawing-figure-card ${selected ? "is-selected" : ""}`}
                    data-selected={selected ? "true" : "false"}
                  >
                    <SpatialPresence>
                      {isSortMode ? (
                        <button
                          type="button"
                          className="drawing-delete-button"
                          aria-label={`删除${label}`}
                          onClick={() => onDeleteFigure(figure.figureId)}
                        >
                          ×
                        </button>
                      ) : null}
                    </SpatialPresence>
                    <ImageSelectionFrame
                      className="drawing-figure-frame"
                      selected={selected && !isSortMode}
                      controls={selected && selectedFigureIds.size === 1 && !isSortMode}
                      widthMm={displayWidthMm}
                      aspectRatio={quarterTurned ? 1 / originalAspectRatio : originalAspectRatio}
                      imageLabel={label}
                      onResizeCommit={(widthMm) => onResizeFigure(figure.figureId, widthMm)}
                      onDelete={() => onDeleteFigure(figure.figureId)}
                    >
                      <AssetPreview
                        sessionId={sessionId}
                        assetId={figure.assetId}
                        alt={label}
                        rotationDeg={figure.rotationDeg ?? 0}
                        onLoad={(aspectRatio) => {
                          setFigureAspectRatios((current) => ({
                            ...current,
                            [figure.figureId]: aspectRatio,
                          }));
                          handleNewFigurePreviewLoad(figure.figureId);
                        }}
                      />
                      <button
                        type="button"
                        className="drawing-figure-select-target"
                        aria-label={`选择${label}`}
                        aria-pressed={selected}
                        onClick={(event) =>
                          selectFigure(figure.figureId, {
                            ctrlKey: event.ctrlKey,
                            metaKey: event.metaKey,
                            shiftKey: event.shiftKey,
                          })
                        }
                      />
                    </ImageSelectionFrame>
                    <figcaption>{label}</figcaption>
                  </figure>
                </article>
              );
            })}
          </div>
        </main>
        <PatentGlobalFunctionRail bookKind="description-drawings" title="说明书附图">
          <TransientFunctionRailSlot open={orderedSelectedFigures.length > 0}>
            {orderedSelectedFigures.length > 0 ? (
              <section
                className="drawing-image-actions function-rail-transient-panel"
                aria-label="附图图片设置"
              >
                <header>
                  <strong>图片设置</strong>
                  <span>已选择 {orderedSelectedFigures.length} 张</span>
                </header>
                <div>
                  {orderedSelectedFigures.length === 1 &&
                  assets.find((asset) => asset.assetId === orderedSelectedFigures[0]!.assetId)
                    ?.kind === "chemical-preview" &&
                  onEditChemicalStructure ? (
                    <button
                      type="button"
                      onClick={() =>
                        onEditChemicalStructure(
                          orderedSelectedFigures[0]!.figureId,
                          orderedSelectedFigures[0]!.assetId,
                        )
                      }
                    >
                      编辑结构式
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      onRotateFigures(
                        orderedSelectedFigures.map((figure) => figure.figureId),
                        "left",
                      )
                    }
                  >
                    左转90°
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onRotateFigures(
                        orderedSelectedFigures.map((figure) => figure.figureId),
                        "right",
                      )
                    }
                  >
                    右转90°
                  </button>
                  <button
                    type="button"
                    disabled={imageFileOperation !== null}
                    onClick={() => void copySelectedFigures()}
                  >
                    {imageFileOperation === "copy" ? "复制中…" : "复制"}
                  </button>
                  {orderedSelectedFigures.length > 1 ? (
                    <select
                      aria-label="批量另存格式"
                      disabled={imageFileOperation !== null}
                      value={batchSaveFormat}
                      onChange={(event) =>
                        setBatchSaveFormat(event.target.value as ImageOutputFormat)
                      }
                    >
                      <option value="png">PNG</option>
                      <option value="jpg">JPG</option>
                      <option value="tif">TIF</option>
                    </select>
                  ) : null}
                  <button
                    type="button"
                    disabled={imageFileOperation !== null}
                    title={orderedSelectedFigures.length === 1 ? "另存为图片" : "批量另存图片"}
                    onClick={() => void saveSelectedFigures()}
                  >
                    {imageFileOperation === "save" ? "保存中…" : "另存为"}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const ids = orderedSelectedFigures.map((figure) => figure.figureId);
                      setSelectedFigureIds(new Set());
                      setSelectionAnchorFigureId(null);
                      (onDeleteFigures ?? ((items: string[]) => items.forEach(onDeleteFigure)))(
                        ids,
                      );
                    }}
                  >
                    删除
                  </button>
                </div>
              </section>
            ) : null}
          </TransientFunctionRailSlot>
          <section className="drawing-rail-section compact-drawing-actions">
            <span className="compact-tool-actions__label">附图工具</span>
            <button
              type="button"
              className="drawing-sort-button"
              aria-pressed={isSortMode}
              title={shortcutTooltip({
                binding: "custom",
                label: isSortMode ? "完成排序" : "附图排序",
                shortcuts: drawingSortShortcut ? [drawingSortShortcut] : [],
                visibleLabel: true,
              })}
              onClick={toggleSortMode}
            >
              <ArrowDownUp aria-hidden="true" />
              {isSortMode ? "完成排序" : "附图排序"}
            </button>
            {typeof toolbar === "function"
              ? toolbar({
                  referenceMarksCollapsed,
                  onToggleReferenceMarksCollapse: () => toggleDrawingRailPanel("reference-marks"),
                })
              : toolbar}
          </section>
          <section
            className="drawing-explanation-rail"
            data-collapsed={explanationCollapsed}
            aria-label="附图说明栏"
            ref={explanationRailRef}
            onClick={() => {
              if (explanationCollapsed) toggleDrawingRailPanel("explanation");
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if ((event.key === "Enter" || event.key === " ") && explanationCollapsed) {
                event.preventDefault();
                toggleDrawingRailPanel("explanation");
              }
            }}
          >
            <header className="drawing-explanation-rail__header">
              <button
                type="button"
                className="drawing-explanation-rail__toggle"
                aria-label={explanationCollapsed ? "展开附图说明" : "折叠附图说明"}
                aria-expanded={!explanationCollapsed}
                aria-controls="drawing-explanation-cards"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleDrawingRailPanel("explanation");
                }}
              >
                <h2>附图说明</h2>
                <span aria-hidden="true" className="drawing-explanation-rail__toggle-caret" />
              </button>
            </header>
            <div
              id="drawing-explanation-cards"
              className="drawing-explanation-cards"
              hidden={explanationCollapsed}
              inert={explanationCollapsed || undefined}
              aria-hidden={explanationCollapsed || undefined}
            >
              <div className="drawing-explanation-rail__actions">
                <button
                  type="button"
                  className="drawing-explanation-rail__fill"
                  disabled={explanationActionsDisabled}
                  onClick={() => void fillAllDrawingExplanations()}
                >
                  填入说明书
                </button>
                <button
                  type="button"
                  className="drawing-explanation-rail__copy"
                  disabled={explanationActionsDisabled}
                  onClick={() => void copyAllDrawingExplanations()}
                >
                  复制
                </button>
              </div>
              {figures.map((figure, index) => {
                const label = `图${index + 1}`;
                const entry = explanationByFigureId.get(figure.figureId);
                const draftValue = entry ? draftValueFor(entry) : "";
                return (
                  <section
                    className="drawing-explanation-card"
                    aria-label={`${label}说明`}
                    data-figure-id={figure.figureId}
                    key={figure.figureId}
                    tabIndex={-1}
                    onClick={() => scrollFigureToExplanation(figure.figureId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        scrollFigureToExplanation(figure.figureId);
                      }
                    }}
                    onFocus={() => scrollFigureToExplanation(figure.figureId)}
                  >
                    <header>
                      <strong>{label}</strong>
                    </header>
                    {entry ? (
                      <DrawingExplanationDraftEditor
                        entry={entry}
                        key={`${entry.figureNumber}:${entry.status}`}
                        label={label}
                        value={draftValue}
                        onDraftChange={(value) => {
                          setExplanationDrafts({
                            ...explanationDrafts,
                            [figure.figureId]: { figureNumber: index + 1, value },
                          });
                        }}
                        resizeInput={resizeExplanationInput}
                      />
                    ) : (
                      <p className="drawing-explanation-card__status" role="status">
                        无法读取{label}的附图说明。
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </section>
        </PatentGlobalFunctionRail>
      </div>
      {drawingMenu.menu}
      {createPortal(
        <MotionPresence>
          {confirmFill ? (
            <StandardDialog
              open
              title="填入附图说明"
              subtitle="将替换说明书当前的附图说明"
              size="m"
              initialFocusRef={cancelFillRef}
              onCancel={() => setConfirmFill(false)}
              footer={
                <>
                  <button ref={cancelFillRef} type="button" onClick={() => setConfirmFill(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="standard-dialog__danger-button"
                    onClick={() => void fillAllDrawingExplanations(true)}
                  >
                    确认替换
                  </button>
                </>
              }
            >
              <div className="reference-mark-panel__fill-diff">
                <strong>当前内容</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{currentExplanationText}</p>
                <strong>将替换为</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {explanationDraftItems.map((item) => item.value.trim()).join("\n")}
                </p>
              </div>
            </StandardDialog>
          ) : null}
        </MotionPresence>,
        document.body,
      )}
    </fieldset>
  );
}
