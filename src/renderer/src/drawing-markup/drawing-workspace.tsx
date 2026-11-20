import { hasVisibleElement } from "../shared/focusable-elements";
import { detailSourceInScope } from "../../../shared/drawing-markup/cad-mutation";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  ClipboardPaste,
  Copy,
  Download,
  ImagePlus,
  LassoSelect,
  ListOrdered,
  LocateFixed,
  Maximize,
  Minus,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Redo2,
  RotateCw,
  RotateCcw,
  Replace,
  Settings2,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  X,
  ZoomIn,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type Ref,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { AssetDescriptor } from "../../../shared/document/model";
import { insertedFigureWidthMm } from "../../../shared/patent/figure-insertion-size";
import {
  type LabelArrangementBounds,
  alignSelectedAnnotations,
  snapLabelToAnnotations,
} from "../../../shared/drawing-markup/annotation-alignment";
import {
  selectAnnotationIds,
  translateAnnotation,
} from "../../../shared/drawing-markup/annotation-selection";
import {
  baseFragments,
  deleteBase,
  extractBase,
  scalePoint,
  translateFragments,
  translatePolygon,
} from "../../../shared/drawing-markup/base-fragments";
import { rectangleSelection } from "../../../shared/drawing-markup/crossing-selection";
import { imagePdfPage, isImageDrawing, rotateImageSelection } from "../../../shared/drawing-markup/image-editing";
import {
  detailTitleAnnotation,
  moveDetailParts,
  selectedDetailParts,
  translateDetailCopy,
} from "../../../shared/drawing-markup/detail-selection";
import {
  incrementLabel,
  moveAnnotation,
  nextDrawingLabel,
  resizeRectangle,
  restoreDrawingHistory,
} from "../../../shared/drawing-markup/editing";
import { bounds, clippedAnnotations, pointInside } from "../../../shared/drawing-markup/geometry";
import {
  CAD_IMPORT_LIMIT_MESSAGE,
  MAX_CAD_IMPORT_BYTES,
} from "../../../shared/drawing-markup/import-limits";
import { leaderPoints, placeLabel } from "../../../shared/drawing-markup/label-layout";
import { locateRegionView } from "../../../shared/drawing-markup/locate-region";
import { LabelPlacementPreview, type LabelPlacementPreviewHandle } from "./label-placement-preview";
import { LabelDragPreview, type LabelDragPreviewHandle } from "./label-drag-preview";
import {
  type DrawingAnnotation,
  type DrawingBaseFragment,
  type DrawingPoint,
  type DrawingProject,
  DrawingProjectSchema,
  type DrawingRegion,
} from "../../../shared/drawing-markup/model";
import {
  annotationOutputStyle,
  defaultDrawingOutput,
  drawingAnnotationScale,
  drawingLeaderWidth,
  drawingOutput,
  storedAnnotationLineWidth,
  wholeDrawingAnnotationScale,
} from "../../../shared/drawing-markup/output-settings";
import {
  createDrawingGestureValidator,
  drawingEditEqual,
  parseDrawingEdit,
} from "../../../shared/drawing-markup/performance";
import { drawingProjectEdits } from "../../../shared/drawing-markup/project-edits";
import { savedDrawingRegions } from "../../../shared/drawing-markup/regions";
import {
  DRAWING_TILES_MEDIA_TYPE,
  DrawingTileIndexSchema,
} from "../../../shared/drawing-markup/tiles";
import { randomUuid } from "../../../shared/id";
import type { PatentFigure } from "../../../shared/patent/model";
import {
  ignoreApplicationKeyEvent,
  isHarmonyPlatform,
  isMacPlatform,
  platformEditorShortcut,
  platformShortcut,
} from "../../../shared/platform";
import { DEFAULT_DRAWING_ANNOTATION_STYLE } from "../../../shared/settings/model";
import { shortcutMatchesInput } from "../../../shared/settings/shortcuts";
import { useApplicationCloseParticipant } from "../app/application-close-coordinator";
import { MotionPresence } from "../app/motion-presence";
import { useConfiguredShortcut } from "../app/shortcut-dispatcher";
import { PatentFunctionRailScope } from "../patents/function-rail/function-rail-context";
import { usePatents } from "../patents/patent-context";
import { PatentGlobalFunctionRail } from "../patents/patent-global-function-rail";
import type { PatentSession } from "../patents/patent-reducer";
import { confirmAppAction, promptAppText } from "../shared/app-dialog";
import { canvasWheelPans, wheelPixels } from "../shared/canvas-wheel";
import { type OperationFeedback, OperationFeedbackOverlay } from "../shared/operation-feedback";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";
import { FigureExportDialog } from "../shared/figure-export-dialog";
import { DrawingAnnotationView } from "./annotation-view";
import { cadLabelLineweight } from "../../../shared/drawing-markup/cad-label-style";
import { CadFunctionTabs } from "./cad-function-tabs";
import { CadReferenceMarkPanel, cadNumberSelection } from "./cad-reference-mark-panel";
import { CadLabelKeywordPrompt, type CadLabelKeywordPromptHandle } from "./cad-label-keyword-prompt";
import { planRegisterReferenceMark } from "../../../shared/patent/reference-mark-registration";
import { cadFigureSelection } from "./cad-figure-selection";
import { DraftText, type DraftTextHandle } from "./draft-text";
import { DrawingExportSettingsDialog } from "./drawing-export-settings-dialog";
import { DrawingFigureCard } from "./drawing-figure-card";
import { DrawingHistory } from "./drawing-history";
import { DrawingImportProgressSurface } from "./drawing-import-progress-card";
import { drawingFitBounds, drawingPaperBounds } from "./drawing-paper";
import { cadFigureBounds, loadRasterInkBounds, rasterFigureBounds } from "./drawing-occupancy";
import { DrawingProjectRow } from "./drawing-project-row";
import { DrawingReplaceDialog, type DrawingReplacementPreview } from "./drawing-replace-dialog";
import { planDrawingReplacement } from "./drawing-replacement";
import { createAnnotationLayoutCache, createDrawingSidebarCache } from "./drawing-scene-cache";
import { minimumDrawingViewWidth } from "./drawing-zoom";
import { FragmentedDrawingPreview } from "./fragmented-drawing-preview";
import { OutputNumber } from "./output-number";
import { CadNumberInput, CadRatioInput, formatCadNumber } from "./cad-number-input";
import { PanPreviewSurface, type PanPreviewSurfaceHandle } from "./pan-preview-surface";
import { imageUrl, pdfPreview, renderDrawing } from "./render";
import type { TiledDrawingSource } from "./tiled-drawing-preview";
import { usePointerFrame } from "./use-pointer-frame";
import { useRangePreview } from "./use-range-preview";
import { VectorDrawingPreview } from "./vector-drawing-preview";
import "./drawing-workspace.css";
import { FlowchartImagePreview } from "../flowcharts/flowchart-image-preview";

import type { CadPatentObject } from "../../../shared/drawing-markup/cad-objects";
import { cadSemanticKey, cadSemanticKeyMatches } from "../../../shared/drawing-markup/cad-semantic-key";
import { nativeCadLabelHandleSet, selectedNativeCadLabelIds } from "../../../shared/drawing-markup/cad-native-label";
import { CadAnnotationSync, cadAnnotationEdit, cadMetadataEdit, cadSemanticEdit } from "./cad-annotation-sync";
import { cadSynchronizationSourceIds } from "../../../shared/drawing-markup/cad-unified";
import {
  createDetailView,
  detailMarkerAnnotation,
  moveDetail,
  nextDetailLabel,
  parseDetailRatio,
  resizeDetail,
} from "../../../shared/drawing-markup/detail-view";
import type { DrawingDetailView } from "../../../shared/drawing-markup/model";
import { CadBackgroundSave } from "./cad-background-save";
import {
  type CadDetailGesture,
  CadDetailGestureLayer,
  compileCadDetailScene,
  type Path as CadGlyphPath,
  visibleNativeLabelIds,
} from "./cad-detail-gesture";
import { CadDraftCheckpoints } from "./cad-draft-checkpoints";
import {
  type CadEditingHandle,
  CadEditingPanel,
  type CadSelection,
  CadSelectionOverlay,
} from "./cad-editing-panel";
import type { CadClipboard } from "./cad-clipboard-state";
import { CadGesturePreview, type CadPreviewHandle } from "./cad-gesture-preview";
import { CadOverlayPreview } from "./cad-overlay-preview";
import { CadSceneSurface } from "./cad-affine-surface";
import { assertCadPreviewFrame, cadPreviewFrameMatches } from "./cad-preview-frame";
import { CadPendingDrawings, type PendingCadDrawingsHandle } from "./cad-pending-drawings";
import { CadcraftClient, type CadScene, type CadCheckpoint as CadCommandCheckpoint, ensureCadcraftClient } from "./cadcraft-client";
import { DetailViewImage, DetailViewMarks } from "./detail-view-layer";
import { DetailPointerPreview, detailAtPointer, type DetailPointerHandle } from "./detail-pointer-preview";
import { DrawingGuidance } from "./drawing-guidance";
import { drawingPreviewSource } from "./drawing-preview-source";
import {
  panViewByScreenDelta,
  useSmoothDrawingView,
  wheelZoomFactor,
} from "./use-smooth-drawing-view";

type Tool = "select" | "label" | "lasso" | "detail" | "annotations";
/**
 * 标号模型仍要求自带线宽字段；引出线已改为固定 0.3 mm 自适应（见 output-settings），
 * 这个值只在模型必须填数时使用，不再由用户设置。
 */
const LEGACY_ANNOTATION_LINE_WIDTH = DEFAULT_DRAWING_ANNOTATION_STYLE.lineWidth;
const tools: { id: Tool; label: string; icon: typeof MousePointer2 }[] = [
  { id: "select", label: "选择 / 移动", icon: MousePointer2 },
  { id: "label", label: "标号", icon: ListOrdered },
  { id: "detail", label: "局部放大", icon: ZoomIn },
  { id: "lasso", label: "圈选对象", icon: LassoSelect },
  { id: "annotations", label: "框选编号", icon: SquareDashedMousePointer },
];
const uid = randomUuid;
const list = (points: DrawingPoint[]) => points.map((p) => `${p.x},${p.y}`).join(" ");
const mergeAssets = (a: AssetDescriptor[], b: AssetDescriptor[]) => [
  ...new Map([...a, ...b].map((v) => [v.assetId, v])).values(),
];
type Drag = {
  annotationSet?: Set<string>;
  labelReferences?: DrawingAnnotation[];
  baseTransfer?: { remaining: DrawingBaseFragment[]; selected: DrawingBaseFragment[] };
  detailParts?: Map<string, Set<string>>;
  validate?: (project: DrawingProject) => boolean;
  start: DrawingPoint;
  mode:
    | "pan"
    | "label"
    | "region"
    | "region-move"
    | "content"
    | "content-resize"
    | "annotation"
    | "range"
    | "detail";
  detailId?: string;
  detailPart?: string;
  handle?: string;
  transferId?: string;
  pointerId: number;
  button: number;
  screenStart: DrawingPoint;
  screenInverse: DOMMatrix;
  unitsPerPixel?: number;
  moved?: boolean;
  secondClick?: boolean;
  labelStartedAt?: number;
  before: DrawingProject;
  annotationId?: string;
  annotationIds?: string[];
  annotationsOnly?: boolean;
  translateWhole?: boolean;
  crossing?: boolean;
  crossingAnnotationIds?: string[];
  pointIndex?: number;
  points: DrawingPoint[];
  view: { x: number; y: number; width: number; height: number };
};

export type DrawingWorkspaceHandle = {
  flush(): Promise<boolean>;
  suspend(): Promise<boolean>;
  requestClose(): Promise<boolean>;
  importFiles(files: File[]): Promise<void>;
};
export function DrawingWorkspace({
  session,
  active,
  runtimeEnabled = true,
  openProjectRequest,
  ref,
}: {
  session: PatentSession;
  active: boolean;
  runtimeEnabled?: boolean;
  openProjectRequest?: { projectId: string; key: number } | undefined;
  ref?: Ref<DrawingWorkspaceHandle>;
}) {
  const patents = usePatents();
  const numericFieldId = useId();
  const importBatch = useRef(false);
  const cancelBatch = useRef(false);
  const [batchImporting, setBatchImporting] = useState(false);
  const [cadInstructionTarget, setCadInstructionTarget] = useState<HTMLDivElement | null>(null);
  const [cadSettingsTarget, setCadSettingsTarget] = useState<HTMLDivElement | null>(null);
  const insertShortcut = useConfiguredShortcut("insert-marked-drawing");
  const delivering = useRef(false);
  const [insertFeedback, setInsertFeedback] = useState<OperationFeedback | null>(null);
  const [projects, setProjects] = useState(() =>
    session.patent.drawingProjects.map((p) => {
      const regions = savedDrawingRegions(p.regions);
      return regions.length === p.regions.length ? p : { ...p, regions };
    }),
  );
  const [activeId, setActiveId] = useState(projects[0]?.projectId ?? "");
  const openFolderProject = useRef<(id: string) => Promise<void>>(async () => undefined);
  const folderProjectRequestHandled = useRef<number | null>(null);
  useEffect(() => {
    if (
      !active ||
      !openProjectRequest ||
      folderProjectRequestHandled.current === openProjectRequest.key ||
      !projects.some((p) => p.projectId === openProjectRequest.projectId)
    ) return;
    folderProjectRequestHandled.current = openProjectRequest.key;
    void openFolderProject.current(openProjectRequest.projectId);
  }, [active, openProjectRequest, projects]);
  const current = projects.find((p) => p.projectId === activeId);
  const [tool, setTool] = useState<Tool>("select"),
    [selected, setSelectedId] = useState(""),
    [regionId, setRegionId] = useState("");
  const [detailSelection, setDetailSelection] = useState<{ id: string; part: string } | null>(null);
  const selectedDetail = current?.detailViews?.find((d) => d.id === detailSelection?.id);
  const [detailLabel, setDetailLabel] = useState("A");
  const [detailRatio, setDetailRatio] = useState("2:1");
  const toolActivationEpoch = useRef(0);
  const lastDrawingTool = useRef<{ projectId: string; tool: Tool } | null>(null);
  const [defaultDetailRatio, setDefaultDetailRatio] = useState(2);
  const [defaultRatioDraft, setDefaultRatioDraft] = useState("2:1");
  const [savingDetailDefaults, setSavingDetailDefaults] = useState(false);
  const [detailDraft, setDetailDraft] = useState<{
    stage: "radius" | "leader" | "place";
    marker?: DrawingPoint;
    source: DrawingPoint;
    cursor: DrawingPoint;
    radius: number;
  } | null>(null);
  const [detailPaste, setDetailPaste] = useState<DrawingDetailView | null>(null);
  const detailMarksPointer = useRef<DetailPointerHandle>(null);
  const detailImagePointer = useRef<DetailPointerHandle>(null);
  const copiedDetail = useRef<DrawingDetailView | null>(null);
  const detailInput = useRef<DraftTextHandle>(null);
  const detailRatioInput = useRef<DraftTextHandle>(null);
  const [locatedRegionId, setLocatedRegionId] = useState("");
  const pendingLocation = useRef<(DrawingRegion & { projectId: string }) | null>(null);
  const [label, setLabel] = useState(nextDrawingLabel(current)),
    [fontSize, setFontSize] = useState(DEFAULT_DRAWING_ANNOTATION_STYLE.fontSize);
  const [activeDraggedLabelId, setActiveDraggedLabelId] = useState("");
  const labelDragPreviewRef = useRef<LabelDragPreviewHandle>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [savingStyle, setSavingStyle] = useState(false);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [autoAdjustLabelSize, setAutoAdjustLabelSize] = useState(true);
  const [autoLabelScale, setAutoLabelScale] = useState(1);
  const savedAutoLabelScale = useRef(1);
  const [savingExportSettings, setSavingExportSettings] = useState(false);
  const [rangeSelection, setRangeSelection] = useState(false);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const crossSelection = useRef<Map<string, string[]> | null>(null);
  const deletingCrossSelection = useRef(false);
  const copiedBase = useRef<{
    projectId: string;
    fragments: DrawingBaseFragment[];
    details: DrawingDetailView[];
    region: DrawingRegion;
  } | null>(null);
  const copiedAnnotations = useRef<DrawingAnnotation[]>([]);
  const [hasCopiedAnnotations, setHasCopiedAnnotations] = useState(false);
  const lastCanvasPointer = useRef<DrawingPoint | null>(null);
  const [pastePreview, setPastePreview] = useState<{
    annotations: DrawingAnnotation[];
    details?: DrawingDetailView[];
    fragments?: DrawingBaseFragment[];
    region?: DrawingRegion;
    anchor: DrawingPoint;
    screenPoint: DrawingPoint;
  } | null>(null);
  const nextLabelInput = useRef<HTMLInputElement>(null);
  const nextDetailInput = useRef<HTMLInputElement>(null);
  const [labelFocusTick, setLabelFocusTick] = useState(0);
  const [keywordPrompt, setKeywordPrompt] = useState<{ projectId: string; annotationId: string } | null>(null);
  const keywordPromptRef = useRef<CadLabelKeywordPromptHandle>(null);
  const [hasPlacedLabel, setHasPlacedLabel] = useState(false);
  function setSelected(id: string) {
    crossSelection.current = null;
    setDetailSelection(null);
    setBatchIds([]);
    setSelectedId(id);
    setRangeSelection(false);
  }
  const sizeGesture = useRef<DrawingProject | null>(null);
  const finishSizeRef = useRef(() => {});
  const rangePreview = useRangePreview();
  const draft = { length: rangePreview.active ? 1 : 0 };
  const secondaryPanMenu = useRef(false);
  const canvasWheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const [spacePan, setSpacePan] = useState(false);
  const [inlineId, setInlineId] = useState("");
  const annotationInput = useRef<DraftTextHandle>(null);
  const inlineInput = useRef<DraftTextHandle>(null);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const histories = useRef(new DrawingHistory()).current;
  const cadEditor = useRef<CadEditingHandle>(null);
  const cadClipboard = useRef<CadClipboard | null>(null);
  const cadPreview = useRef<CadPreviewHandle>(null);
  const cadPendingPreview = useRef<PendingCadDrawingsHandle>(null);
  const [cadSaving, setCadSaving] = useState(false);
  const [checkpointSaving, setCheckpointSaving] = useState(false);
  const [annotationSyncing, setAnnotationSyncing] = useState(false);
  const [annotationError, setAnnotationError] = useState(false);
  const [checkpointError, setCheckpointError] = useState(false);
  const [cadDrawingActive, setCadDrawingActive] = useState(false);
  const [placedDetail, setPlacedDetail] = useState<{
    projectId: string;
    detail: DrawingDetailView;
  } | null>(null);
  const [cadToolActive, setCadToolActive] = useState(false);
  const [cadObjectCursor, setCadObjectCursor] = useState(false);
  const cadPointer = useRef<{
    pointerId: number;
    start: DrawingPoint;
    screen: DrawingPoint;
    pressedAt: number;
    aperture: number;
    window: boolean;
    dragConfirmed?: boolean;
    grip: boolean;
    pointOnDown: boolean;
    dragToFinish: boolean;
    trimPath?: DrawingPoint[];
    directMove?: boolean;
    selectionDrag?: boolean;
  } | null>(null);
  const cadOrthogonal = useRef(false);
  const imageDrawing = isImageDrawing(current);
  const [imageRotation, setImageRotation] = useState(90);
  const cadVector = !!current?.cad?.unified &&
    (current.sourceKind === "dwg" || current.sourceKind === "dxf");
  const infiniteCad = !imageDrawing && !!current?.cad?.unified;
  const [cadSelection, setCadSelection] = useState<CadSelection>(null);
  const cadSelectionLatest = useRef<CadSelection>(cadSelection);
  cadSelectionLatest.current = cadSelection;
  // Images/PDFs always use pixel-region and annotation gestures, including
  // historical projects that still carry an editable CAD compatibility overlay.
  const cadEditing = !imageDrawing && !!current?.cad?.unified &&
    (tool === "select" || (tool === "lasso" && cadVector)) &&
    (cadVector || !!cadSelection?.handles.length);
  const [cadTextEditing, setCadTextEditing] = useState<string[]>([]);
  const [cadWorkingScene, setCadWorkingScene] = useState<{
    projectId: string;
    sequence: number;
    scene: CadScene;
    objects: CadPatentObject[];
    before: DrawingProject;
  } | null>(null);
  useEffect(() => {
    setCadWorkingScene((working) => (working?.projectId === activeId ? working : null));
  }, [activeId]);
  const [detailGesture, setDetailGesture] = useState<CadDetailGesture | null>(null);
  const publishingCadCandidate = useRef(false);
  // A temporary detail transform belongs to the native scene it was compiled from.
  // Never let it suppress selection or paint over a newer CAD checkpoint.
  const liveDetailGesture =
    detailGesture?.before.projectId === current?.projectId &&
    detailGesture?.before.cad?.assetId === current?.cad?.assetId
      ? detailGesture
      : null;
  function previewCadDetail(project: DrawingProject, detailId: string) {
    if (
      !project.cad?.unified ||
      !cadSelection ||
      cadSelection.checkpointId !== project.cad.assetId ||
      !project.cad.objects?.some((o) => o.id === detailId && o.body !== undefined)
    )
      return false;
    setDetailGesture({
      before: project,
      detailId,
      compiled: compileCadDetailScene(
        cadSelection.scene,
        cadSelection.objects ?? project.cad.objects,
      ),
    });
    return true;
  }
  const draftCheckpoints = useRef<CadDraftCheckpoints | null>(null);
  const liveCheckpoint = current?.cad
    ? draftCheckpoints.current?.get(current.cad.assetId)
    : undefined;
  const checkpointScene =
    cadSelection?.checkpointId === current?.cad?.assetId
      ? cadSelection?.scene
      : liveCheckpoint?.scene;
  const liveWorkingScene =
    cadWorkingScene?.projectId === current?.projectId ? cadWorkingScene : null;
  const cadSelectedLabelIds = useMemo(
    () => current?.cad && cadSelection &&
      (!cadSelection.checkpointId || cadSelection.checkpointId === current.cad.assetId)
      ? selectedNativeCadLabelIds(current, cadSelection.handles) : new Set<string>(),
    [current, cadSelection],
  );
  const liveScene =
    (cadTextEditing.length && (liveWorkingScene?.scene ?? checkpointScene) && current?.cad ? {
      before:current, detailId:"",
      compiled:compileCadDetailScene({...((liveWorkingScene?.scene ?? checkpointScene)!),primitives:(liveWorkingScene?.scene ?? checkpointScene)!.primitives.filter(p=>!cadTextEditing.includes(p.handle))},liveWorkingScene?.objects ?? current.cad.objects ?? []),
    } : null) ??
    liveDetailGesture ??
    (liveWorkingScene && current?.cad
      ? {
          before: liveWorkingScene.before,
          detailId: "",
          compiled: compileCadDetailScene(liveWorkingScene.scene, liveWorkingScene.objects),
        }
      : null) ??
    (liveCheckpoint && current?.cad && checkpointScene
      ? {
          before: liveCheckpoint.project,
          detailId: selectedDetail?.id ?? "",
          compiled: compileCadDetailScene(
            checkpointScene,
            cadSelection?.checkpointId === current.cad.assetId
              ? (cadSelection.objects ?? current.cad.objects ?? [])
              : (current.cad.objects ?? []),
          ),
        }
      : null);
  const [cadInside, setCadInside] = useState<string>();
  const projectViews = useRef(new Map<string, typeof view>());
  const [placement, setPlacement] = useState<{ start: DrawingPoint; end: DrawingPoint } | null>(
    null,
  );
  const labelPreviewRef = useRef<LabelPlacementPreviewHandle>(null);
  const {
    view,
    getView,
    setView,
    panBy,
    zoom: animateZoom,
    stop: stopZoom,
  } = useSmoothDrawingView({
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
  });
  useEffect(() => {
    if (!active || !activeId) stopZoom();
    return stopZoom;
  }, [active, activeId, stopZoom]);
  const [paintedView, setPaintedView] = useState(view);
  const [liveViewport, setLiveViewport] = useState(false);
  const livePaintedView = useRef(view);
  const [vectorReady, setVectorReady] = useState(false);
  const fixedBase =
    current?.sourceKind === "dwg" || current?.sourceKind === "dxf" || current?.sourceKind === "pdf";
  // Translation can reuse the painted frame immediately; zoom waits for matching strokes.
  const displayView =
    fixedBase &&
    !liveScene &&
    !liveViewport &&
    (view.width !== paintedView.width || view.height !== paintedView.height)
      ? paintedView
      : view;
  const displayZoom = current ? (current.width * 1.08) / displayView.width : 1;
  const [loadedBase, setBase] = useState<{
    projectId: string;
    assetId: string;
    url: string;
    bytes: Uint8Array;
    mediaType: string;
    width: number;
    height: number;
    mapping?: NonNullable<DrawingProject["cad"]>["mapping"];
    tiled?: TiledDrawingSource;
  } | null>(null);
  // Effects clear a previous source after rendering. Never decode that source
  // using the next project's format; retain frames only within the same project.
  const base = loadedBase?.projectId === current?.projectId ? loadedBase : null;
  const [rasterFigure, setRasterFigure] = useState<{
    key: string;
    bounds: LabelArrangementBounds | null;
  } | null>(null);
  const rasterScan = useRef<{ key: string; promise: Promise<LabelArrangementBounds | null> } | null>(null);
  useEffect(() => {
    if (!current || !base || !["image", "pdf"].includes(current.sourceKind) || current.baseAssetId !== base.assetId) return;
    const key = `${current.projectId}:${base.url}`;
    let cancelled = false;
    if (rasterScan.current?.key !== key)
      rasterScan.current = { key, promise: loadRasterInkBounds(base.url, current.width, current.height) };
    void rasterScan.current.promise
      .then((bounds) => { if (!cancelled) setRasterFigure({ key, bounds }); })
      .catch(() => { if (!cancelled) setRasterFigure({ key, bounds: null }); });
    return () => { cancelled = true; };
  }, [current, base]);
  const previewBase = useMemo(
    () =>
      base
        ? {
            source: drawingPreviewSource(base.bytes),
            url: base.url,
            tiled: base.tiled,
          }
        : null,
    [base],
  );
  const retainedBase = useRef<{
    projectId: string;
    url: string;
    sourceKey: string;
    mediaType: string;
  } | null>(null);
  useEffect(
    () => () => {
      if (retainedBase.current) URL.revokeObjectURL(retainedBase.current.url);
      retainedBase.current = null;
    },
    [],
  );
  const replacementSource = useRef<{
    project: DrawingProject;
    region: DrawingRegion;
    base: NonNullable<typeof base>;
    sessionId: string;
    dpi: 300 | 600;
    autoAdjustLabelSize: boolean;
    autoLabelScale: number;
  } | null>(null);
  const [operationBusy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const blockingBusy = operationBusy || sourceLoading || batchImporting || savingExportSettings;
  const busy = blockingBusy;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-select even when repeat numbering keeps the value unchanged.
  useEffect(() => {
    if (active && tool === "label" && !selected && !busy &&
      !(document.activeElement instanceof Element && document.activeElement.closest("[data-cad-keyword-prompt]"))) {
      nextLabelInput.current?.focus({ preventScroll: true });
      nextLabelInput.current?.select();
    }
  }, [active, tool, selected, busy, labelFocusTick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-select the next letter after each completed placement.
  useEffect(() => {
    if (active && tool === "detail" && !busy) {
      nextDetailInput.current?.focus({ preventScroll: true });
      nextDetailInput.current?.select();
    }
  }, [active, tool, busy, labelFocusTick]);
  useEffect(() => {
    let cancelled = false;
    void window.patentApi.settings
      .read()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error.message);
        const ratio = result.value.drawingDetailDefaultRatio ?? 2;
        setDefaultDetailRatio(ratio);
        setDefaultRatioDraft(`${ratio}:1`);
        setDetailRatio(`${ratio}:1`);
        setFontSize(result.value.drawingAnnotationDefaults.fontSize);
        setAutoAdjustLabelSize(result.value.drawingAutoAdjustLabelSize ?? true);
        setAutoLabelScale(result.value.drawingAutoLabelScale ?? 1);
        savedAutoLabelScale.current = result.value.drawingAutoLabelScale ?? 1;
      })
      .catch((error) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "读取默认样式失败。");
      })
      .finally(() => {
        if (!cancelled) setStyleReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const importOperation = useRef<{ id: string; cancelled: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    bytes: Uint8Array;
    width: number;
    height: number;
    widthMm: number;
    pageKey: string;
    revision: number;
    regionId: string;
  } | null>(null);
  const previewTarget = useRef<ReturnType<typeof liveRenderTarget> | null>(null);
  const [page, setPage] = useState(1),
    [pdfPages, setPdfPages] = useState(1);
  const fileRef = useRef<HTMLInputElement>(null),
    svgRef = useRef<SVGSVGElement>(null),
    sceneRef = useRef<HTMLDivElement>(null),
    panPreview = useRef<PanPreviewSurfaceHandle>(null),
    livePanTargets = useRef<SVGSVGElement | null>(null),
    drag = useRef<Drag | null>(null);
  const attachCanvas = useCallback((canvas: SVGSVGElement | null) => {
    svgRef.current = canvas;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => canvasWheelHandler.current(event);
    // React wheel listeners are passive; consume native gestures before page scrolling.
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", wheel);
      if (svgRef.current === canvas) svgRef.current = null;
    };
  }, []);
  const history = histories.forProject(activeId);
  const [historyTick, setHistoryTick] = useState(0);
  const state = useRef({ projects, current, session, busy, active, regionId });
  state.current = { projects, current, session, busy: blockingBusy, active, regionId };
  function acknowledgeCadPaint(projectId: string, checkpointId: string) {
    // Sibling layout effects can paint a frame while React is reinstalling the
    // editor/pending-layer handles. Wait for that commit, not an arbitrary timer,
    // then synchronously remove duplicate strokes before the browser paints.
    queueMicrotask(() => {
      if (state.current.current?.projectId !== projectId) return;
      flushSync(() => {
        cadEditor.current?.painted(checkpointId);
        const project = state.current.current;
        setDetailGesture((pending) =>
          pending?.before.projectId === projectId && pending.checkpointId === checkpointId
            ? null
            : pending,
        );
        if (project?.cad?.assetId === checkpointId)
          setPlacedDetail((pending) =>
            pending?.projectId === projectId &&
            project.cad?.objects?.some((o) => o.id === pending.detail.id && o.body !== undefined)
              ? null
              : pending,
          );
      });
    });
  }
  const sidebarCache = useRef(createDrawingSidebarCache()).current;
  const sidebar = sidebarCache(projects, session.patent.figures);
  const listedRegions = sidebar.regions;
  const locatedRegion = listedRegions.find(
    (r) => r.projectId === activeId && r.id === locatedRegionId,
  );
  const cadFigure = useMemo(
    () => cadVector && current?.cad && cadSelection &&
      (!cadSelection.checkpointId || cadSelection.checkpointId === current.cad.assetId)
      ? cadFigureSelection(current, cadSelection) : null,
    [current, cadSelection, cadVector],
  );
  const region = cadVector
    ? cadFigure?.region
    : current?.regions.find((r) => r.id === regionId && !r.figureId && !r.bodyNodeId),
    annotation = current?.annotations.find((a) => a.id === selected);
  const rawMarks = useMemo(
    () => [
      ...(current?.annotations ?? []),
      ...(current?.detailViews ?? []).filter((d) => !d.markerHidden).map(detailMarkerAnnotation),
    ],
    [current?.annotations, current?.detailViews],
  );
  const batchIdSet = useMemo(() => new Set(batchIds), [batchIds]);
  const rangeAnnotations = batchIds.length
    ? rawMarks.filter((a) => batchIdSet.has(a.id))
    : rangeSelection && region
      ? rawMarks.filter((a) => pointInside(a, region.points))
      : [];
  const pendingSelection =
    drag.current?.mode === "range" && rangePreview.active ? rangePreview.ids : undefined;
  const selectedIds = new Set(
    pendingSelection ?? (annotation ? [annotation.id] : rangeAnnotations.map((a) => a.id)),
  );
  const alignableCount = current?.annotations.filter((a) => selectedIds.has(a.id)).length ?? 0;
  const selectedSize =
    selectedDetail?.fontSize ?? annotation?.fontSize ?? rangeAnnotations[0]?.fontSize ?? fontSize;
  const output = useMemo(() => (region ? drawingOutput(region) : defaultDrawingOutput()), [region]);
  const { widthMm, dpi } = output;
  const drawingWidth = current?.width;
  // 有取图范围时按范围换算，还没框选时按整张图纸：引出线线宽因此一直是 0.3 mm 的样子。
  const annotationScale = useMemo(
    () =>
      region && !cadVector
        ? drawingAnnotationScale(region.points, region.output)
        : drawingWidth !== undefined
          ? wholeDrawingAnnotationScale(drawingWidth, output)
          : null,
    [region, cadVector, drawingWidth, output],
  );
  const placementStyle = annotationOutputStyle(
    { fontSize, lineWidth: LEGACY_ANNOTATION_LINE_WIDTH },
    annotationScale,
  );
  const glyphCache = useRef(new Map<string, CadGlyphPath[]>()).current;
  const glyphPending = useRef(new Map<string, Promise<CadGlyphPath[]>>()).current;
  const glyphKey = label.trim();
  const [loadedGlyph, setLoadedGlyph] = useState<{ key: string; paths: CadGlyphPath[] } | null>(null);
  useEffect(() => {
    if (!current?.cad?.unified || !label.trim()) return;
    const cached = glyphCache.get(glyphKey);
    if (cached) {
      setLoadedGlyph((previous) => previous?.key === glyphKey && previous.paths === cached
        ? previous : { key: glyphKey, paths: cached });
      return;
    }
    let pending = glyphPending.get(glyphKey);
    if (!pending) {
      const request = cadEditor.current?.labelGlyph(label.trim(), 1);
      if (!request) return;
      pending = request.then((scene) => {
        const paths = compileCadDetailScene(scene, []).flatMap((run) => run.paths)
          .filter((path) => path.fill !== "none" || path.stroke !== "none");
        if (paths.length) {
          if (glyphCache.size >= 32) glyphCache.delete(glyphCache.keys().next().value!);
          glyphCache.set(glyphKey, paths);
        }
        return paths;
      }).finally(() => { glyphPending.delete(glyphKey); });
      glyphPending.set(glyphKey, pending);
    }
    let cancelled = false;
    void pending.then((paths) => {
      if (!cancelled && paths.length) setLoadedGlyph({ key: glyphKey, paths });
    }).catch(() => { /* Keep the SVG fallback if the CAD font is unavailable. */ });
    return () => { cancelled = true; };
  }, [current?.cad?.unified, cadSelection?.scene, glyphKey, glyphCache, glyphPending, label]);
  const viewportBox = svgRef.current?.getBoundingClientRect();
  const unitsPerPixel =
    viewportBox?.width && viewportBox.height
      ? Math.max(displayView.width / viewportBox.width, displayView.height / viewportBox.height)
      : displayView.width / 1000;
  const shadeWidth = Math.max(displayView.width, (viewportBox?.width ?? 0) * unitsPerPixel);
  const shadeHeight = Math.max(displayView.height, (viewportBox?.height ?? 0) * unitsPerPixel);
  const shadeLeft = displayView.x + (displayView.width - shadeWidth) / 2;
  const shadeTop = displayView.y + (displayView.height - shadeHeight) / 2;
  const pendingDetail =
    current && detailDraft && detailDraft.stage !== "radius"
      ? {
          ...createDetailView(
            current,
            detailDraft.source,
            detailDraft.radius,
            detailDraft.cursor,
            detailLabel.trim() || "A",
            parseDetailRatio(detailRatio) ?? defaultDetailRatio,
            fontSize,
            LEGACY_ANNOTATION_LINE_WIDTH,
            "pending-detail",
          ),
          marker: detailDraft.marker ?? detailMarkerPosition(detailDraft.cursor),
        }
      : null;
  const candidateDetail = detailDraft?.stage === "place" ? pendingDetail : detailPaste;
  const ghostDetail = pendingDetail ?? detailPaste;
  const placedPreview =
    placedDetail && placedDetail.projectId === current?.projectId ? placedDetail.detail : null;
  const displayedDetails = [
    ...(current?.detailViews ?? []),
    ...(placedPreview && !current?.detailViews?.some((d) => d.id === placedPreview.id)
      ? [placedPreview]
      : []),
  ];
  const pastePosition =
    pastePreview && viewportBox
      ? {
          x: shadeLeft + (pastePreview.screenPoint.x - viewportBox.left) * unitsPerPixel,
          y: shadeTop + (pastePreview.screenPoint.y - viewportBox.top) * unitsPerPixel,
        }
      : null;
  const pastedAnnotations =
    pastePreview && pastePosition
      ? pastePreview.annotations.map((a) => {
          const moved = translateAnnotation(
            a,
            pastePosition.x - pastePreview.anchor.x,
            pastePosition.y - pastePreview.anchor.y,
          );
          const styled = { ...moved, ...annotationOutputStyle(moved, annotationScale) };
          return { ...styled, points: leaderPoints(styled) };
        })
      : [];
  const layoutCache = useRef(createAnnotationLayoutCache()).current;
  const shownAnnotations = useMemo(
    () => current?.annotations.map((a) => layoutCache(a, annotationScale)) ?? [],
    [current?.annotations, annotationScale, layoutCache],
  );
  const promptedAnnotation = active && tool === "label" && !imageDrawing && keywordPrompt &&
    keywordPrompt.projectId === current?.projectId
    ? shownAnnotations.find(mark => mark.id === keywordPrompt.annotationId)
    : undefined;
  const batchMarks = useMemo(
    () => [
      ...shownAnnotations,
      ...(current?.detailViews ?? []).filter((d) => !d.markerHidden).map(detailMarkerAnnotation),
    ],
    [shownAnnotations, current?.detailViews],
  );
  const rangeMarks = useMemo(
    () => [
      ...batchMarks,
      ...(current?.detailViews ?? []).filter((d) => !d.titleHidden).map(detailTitleAnnotation),
    ],
    [batchMarks, current?.detailViews],
  );
  const pastedDetails =
    pastePreview && pastePosition
      ? (pastePreview.details ?? []).map((d) =>
          translateDetailCopy(
            d,
            pastePosition.x - pastePreview.anchor.x,
            pastePosition.y - pastePreview.anchor.y,
          ),
        )
      : [];
  function preferences(patch: Pick<DrawingProject, "nextLabel" | "repeatLabel">) {
    if (!current) return;
    persist(projects.map((p) => (p.projectId === current.projectId ? { ...p, ...patch } : p)));
  }
  function rebaseProjectView(projectId: string, dx: number, dy: number) {
    const active = state.current.current?.projectId === projectId;
    const camera = active ? getView() : projectViews.current.get(projectId);
    if (!camera) return;
    const next = { ...camera, x: camera.x + dx, y: camera.y + dy };
    projectViews.current.set(projectId, next);
    if (active) setView(next);
  }
  function focusArea(points: DrawingPoint[]) {
    try {
      const b = bounds(points);
      setView({
        x: b.x - b.width * 0.1,
        y: b.y - b.height * 0.1,
        width: b.width * 1.2,
        height: b.height * 1.2,
      });
    } catch {
      /* Degenerate in-progress ranges cannot be fitted. */
    }
  }
  function zoomView(factor: number) {
    if (!current || busy || drag.current) return;
    if (previewMode) return;
    animateZoom(
      factor,
      { x: 0.5, y: 0.5 },
      minimumDrawingViewWidth(current.width, displayView),
      current.width * 20,
    );
  }
  function status(error: unknown) {
    setFailure(error instanceof Error ? error.message : "操作失败，请重试。");
  }
  const persistedProjects = useRef(session.patent.drawingProjects);
  const durableProjects = useRef(session.patent.drawingProjects);
  const saveQueue = useRef<CadBackgroundSave | null>(null);
  const checkpointWriter = useRef<CadcraftClient | null>(null);
  async function materializeCheckpoint(checkpoint: CadCommandCheckpoint) {
    checkpointWriter.current = ensureCadcraftClient(checkpointWriter.current);
    return checkpointWriter.current.request<Uint8Array>("materialize", checkpoint);
  }
  function checkpoints() {
    draftCheckpoints.current ??= new CadDraftCheckpoints(async (project, bytes) => {
      const result = await window.patentApi.assets.prepareCad({
        sessionId: session.sessionId,
        operationId: uid(),
        originalName: "CAD编辑工作稿.dxf",
        format: "dxf",
        preserveFrame: true,
        bytes: Uint8Array.from(bytes),
        frame: { mapping: project.cad!.mapping, width: project.width, height: project.height },
      });
      if (!result.ok) throw new Error(result.error.message);
      assertCadPreviewFrame({ ...project, cad: project.cad! }, result.value);
      return {
        cad: result.value.cad,
        assets: result.value.assets.map((a) => a.descriptor),
        previewId: result.value.assets.at(-1)!.descriptor.assetId,
      };
    }, materializeCheckpoint);
    return draftCheckpoints.current;
  }
  function backgroundSaves() {
    saveQueue.current ??= new CadBackgroundSave(
      (pending) => {
        setCheckpointSaving(pending);
        if (!pending) {
          setCheckpointError(false);
          setFailure((message) =>
            message.startsWith("图纸尚未保存，编辑内容已保留。") ? "" : message,
          );
        }
      },
      (error) => {
        setCheckpointError(true);
        setFailure(`图纸尚未保存，编辑内容已保留。请重试保存后关闭。${error.message}`);
      },
    );
    return saveQueue.current;
  }
  const paintedNativeLabelIds = current && liveScene
    ? visibleNativeLabelIds(current, liveScene) : new Set<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Acknowledge this immutable live checkpoint once, independently of subsequent selections/gestures.
  useEffect(() => {
    if (!liveCheckpoint || !current?.cad) return;
    const id = current.cad.assetId;
    const frame = requestAnimationFrame(() => acknowledgeCadPaint(current.projectId, id));
    return () => cancelAnimationFrame(frame);
  }, [liveCheckpoint, current?.projectId, current?.cad?.assetId]);
  const savedProjectCache = useRef(new WeakMap<DrawingProject, DrawingProject>()).current;
  function persist(
    next: DrawingProject[],
    assets = state.current.session.patent.assets,
    figures = state.current.session.patent.figures,
    historyLabel?: string,
    preserveReplacementWidths = false,
    naturalSizeFigureIds: readonly string[] = [],
  ) {
    const pendingAnnotations = annotationSync.current?.latest;
    if (pendingAnnotations) {
      const candidate = next.find(p => p.projectId === pendingAnnotations.projectId);
      if (candidate && cadAnnotationEdit(pendingAnnotations, candidate)) {
        state.current.projects = next;
        setProjects(next);
        annotationSync.current!.enqueue(candidate);
        return;
      }
    }
    const dirty = next.filter((project) => {
      const before = persistedProjects.current.find((p) => p.projectId === project.projectId);
      return (
        project.cad?.unified &&
        before?.cad?.assetId === project.cad.assetId &&
        (!drawingEditEqual(before.annotations, project.annotations) ||
          !drawingEditEqual(before.detailViews, project.detailViews) ||
          !drawingEditEqual(before.baseFragments, project.baseFragments))
      );
    });
    if (dirty.length && !cadTransaction.current) {
      void synchronizeBatch(
        next,
        dirty,
        assets,
        figures,
        historyLabel,
        preserveReplacementWidths,
        naturalSizeFigureIds,
      ).catch(status);
      return;
    }
    state.current.projects = next;
    setProjects(next);
    const saved = next.map((project) => {
      const cached = savedProjectCache.get(project);
      if (cached) return cached;
      const regions = savedDrawingRegions(project.regions);
      const result = regions.length === project.regions.length ? project : { ...project, regions };
      savedProjectCache.set(project, result);
      return result;
    });
    const abstractFigureId = state.current.session.patent.abstractDrawingFigureId;
    const publish = (ready: DrawingProject[], readyAssets: typeof assets) => {
      const edits = drawingProjectEdits(durableProjects.current, ready);
      patents.updatePatentFigures(
        session.patentId,
        figures,
        abstractFigureId,
        readyAssets,
        historyLabel ? { ownerBookKind: "description-drawings", label: historyLabel } : undefined,
        ready,
        edits,
        preserveReplacementWidths,
        naturalSizeFigureIds,
      );
      durableProjects.current = ready;
    };
    if (
      saveQueue.current?.pending ||
      saved.some((p) => p.cad && checkpoints().get(p.cad.assetId))
    ) {
      const queue = backgroundSaves();
      // Figure insertion/replacement is a separate document operation, not an
      // obsolete drawing snapshot. Keep it as a queue barrier.
      const save = async () => {
        const resolved = [];
        for (const project of saved) resolved.push(await checkpoints().resolve(project));
        publish(
          resolved.map((r) => r.project),
          mergeAssets(
            mergeAssets(state.current.session.patent.assets, assets),
            resolved.flatMap((r) => r.assets),
          ),
        );
      };
      if (historyLabel || preserveReplacementWidths || naturalSizeFigureIds.length) queue.enqueue(save);
      else queue.enqueueLatest(save, figures);
    } else publish(saved, assets);
    persistedProjects.current = saved;
    setPreview(null);
    setPreviewMode(false);
  }
  const cadTransaction = useRef(false);
  const cadSynchronization = useRef<Promise<unknown> | null>(null);
  type AnnotationResult = { bytes?: Uint8Array; checkpoint?: CadCommandCheckpoint; objects: CadPatentObject[]; scene: CadScene };
  function compiledData(result: AnnotationResult) {
    const data = result.checkpoint ?? result.bytes;
    if (!data) throw new Error("CAD 同步未返回可恢复快照。");
    return data;
  }
  const annotationSync = useRef<CadAnnotationSync<DrawingProject, AnnotationResult> | null>(null);
  function annotationChanges() {
    annotationSync.current ??= new CadAnnotationSync(
      async project => {
        // Native edits are flushed before entering the label tool. Later label
        // gestures only replace this draft; they never mutate the loaded CAD.
        if (cadSynchronization.current) await cadSynchronization.current;
        cadTransaction.current = true;
        try {
          const before = persistedProjects.current.find(p => p.projectId === project.projectId);
          const sources = await Promise.all(cadSynchronizationSourceIds(project).map(async id =>
            [id, await readCadDraft(id)] as const));
          const result = await compositionClient().request<AnnotationResult>("synchronize", project, sources, before);
          // A checkpoint must not replace a live drag's transient coordinates.
          while (drag.current || sizeGesture.current)
            await new Promise(resolve => setTimeout(resolve, 16));
          return result;
        } finally { cadTransaction.current = false; }
      },
      (project, compiled) => {
        const before = persistedProjects.current.find(p => p.projectId === project.projectId);
        const next = parseDrawingEdit(checkpoints().stage(project, compiledData(compiled), compiled.scene, compiled.objects, cadAnnotationEdit(before, project)));
        const dx = (project.cad!.mapping.originX - next.cad!.mapping.originX) * next.cad!.mapping.scale;
        const dy = (next.cad!.mapping.originY - project.cad!.mapping.originY) * next.cad!.mapping.scale;
        if (dx || dy) rebaseProjectView(project.projectId, dx, dy);
        // The staged native scene already includes the detail edit. Retire the
        // old transform in the same render, even while disk persistence runs.
        setDetailGesture((pending) =>
          pending?.before.projectId === project.projectId ? null : pending,
        );
        persist(state.current.projects.map(p => p.projectId === project.projectId ? next : p));
        setFailure(message => message.startsWith("图纸修改尚未保存，") ? "" : message);
      },
      pending => { setAnnotationSyncing(pending); if (!pending) setAnnotationError(false); },
      error => {
        setAnnotationError(true);
        setFailure(`图纸修改尚未保存，编辑内容已保留，请重试保存。${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return annotationSync.current;
  }
  const unifiedClient = useRef<CadcraftClient | null>(null);
  const [cadRetry, setCadRetry] = useState<{ projectId: string; key: string } | null>(null);
  const [cadRetryTick, setCadRetryTick] = useState(0);
  useEffect(
    () => () => {
      unifiedClient.current?.close();
      checkpointWriter.current?.close();
      unifiedClient.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!runtimeEnabled) {
      unifiedClient.current?.close();
      checkpointWriter.current?.close();
      unifiedClient.current = null;
      checkpointWriter.current = null;
    }
  }, [runtimeEnabled]);
  function compositionClient() {
    unifiedClient.current = ensureCadcraftClient(unifiedClient.current);
    return unifiedClient.current;
  }
  async function synchronizeBatch(
    next: DrawingProject[],
    dirty: DrawingProject[],
    assets: typeof session.patent.assets,
    figures: typeof session.patent.figures,
    historyLabel?: string,
    preserveReplacementWidths = false,
    naturalSizeFigureIds: readonly string[] = [],
  ) {
    cadTransaction.current = true;
    setBusy(true);
    const baseline = state.current.projects;
    try {
      const client = compositionClient();
      const updated = new Map<string, DrawingProject>();
      for (const project of dirty) {
        const before = persistedProjects.current.find((p) => p.projectId === project.projectId);
        const ids = cadSynchronizationSourceIds(project);
        const sources = await Promise.all(
          [...ids].map(async (id) => [id, await readCadDraft(id)] as const),
        );
        const compiled = await client.request<AnnotationResult>("synchronize", project, sources, before);
        const ready = parseDrawingEdit(
          checkpoints().stage(project, compiledData(compiled), compiled.scene, compiled.objects),
        );
        updated.set(project.projectId, ready);
      }
      if (state.current.projects !== baseline)
        throw new Error("图纸已发生变化，本次批量操作未覆盖新内容。");
      persist(
        next.map((p) => updated.get(p.projectId) ?? p),
        assets,
        figures,
        historyLabel,
        preserveReplacementWidths,
        naturalSizeFigureIds,
      );
    } finally {
      cadTransaction.current = false;
      setBusy(false);
    }
  }
  function commit(project: DrawingProject, record = true) {
    const saved = persistedProjects.current.find((p) => p.projectId === project.projectId);
    const previousDraft = annotationSync.current?.latest ?? saved;
    if (cadSemanticEdit(previousDraft, project)) {
      if (record && drawingEditEqual(previousDraft, project)) return;
      const next = parseDrawingEdit({ ...project, revision: (previousDraft?.revision ?? 0) + 1 });
      if (record && previousDraft) {
        histories.record(previousDraft);
        setHistoryTick(value => value + 1);
      }
      if (annotationSync.current?.pending || !cadMetadataEdit(previousDraft, next)) {
        state.current.projects = state.current.projects.map(p => p.projectId === next.projectId ? next : p);
        setProjects(state.current.projects);
        setPreview(null);
        setPreviewMode(false);
        annotationChanges().enqueue(next);
      } else {
        persist(state.current.projects.map(p => p.projectId === next.projectId ? next : p));
      }
      return;
    }
    if (!record && project.cad?.unified && saved?.cad?.assetId !== project.cad.assetId) {
      // Undo/redo may replace a checkpoint before its decoded image paints.
      // That abandoned image will never acknowledge the live resize preview.
      setDetailGesture(null);
      const restored = parseDrawingEdit({
        ...project,
        revision: (saved?.revision ?? project.revision) + 1,
      });
      setCadWorkingScene(null);
      setCadSelection(null);
      cadPreview.current?.update(null);
      cadPendingPreview.current?.painted(Number.POSITIVE_INFINITY);
      persist(
        state.current.projects.map((p) => (p.projectId === project.projectId ? restored : p)),
      );
      return;
    }
    if (project.cad) {
      if (cadTransaction.current) {
        setFailure("正在保存图纸，请稍候。");
        return;
      }
      // The last pointer sample may still be a batched React update. Publish
      // that exact candidate before the transaction captures its identity;
      // otherwise its own final frame is mistaken for a concurrent edit.
      publishingCadCandidate.current = true;
      try {
        flushSync(() =>
          setProjects(
            state.current.projects.map((p) => (p.projectId === project.projectId ? project : p)),
          ),
        );
      } finally {
        publishingCadCandidate.current = false;
      }
      cadSynchronization.current = synchronizeProject(project, record)
        .catch((error) => {
          setPlacedDetail(null);
          setDetailGesture(null);
          status(error);
        })
        .finally(() => {
          cadSynchronization.current = null;
        });
      return;
    }
    const previous = state.current.projects.find((p) => p.projectId === project.projectId);
    if (record && previous && drawingEditEqual(previous, project)) return;
    const next = parseDrawingEdit({
      ...project,
      revision: (previous?.revision ?? 0) + 1,
    });
    if (record && previous) {
      histories.record(previous);
      setHistoryTick((v) => v + 1);
    }
    persist(state.current.projects.map((p) => (p.projectId === next.projectId ? next : p)));
  }
  async function synchronizeProject(
    project: DrawingProject,
    record = true,
    bytes?: Uint8Array | CadCommandCheckpoint,
    prepared?: (checkpointId: string) => void,
    nativeEdit = false,
    background = false,
  ) {
    if (!project?.cad) throw new Error("当前图纸不是可编辑 CAD。");
    if (cadTransaction.current) throw new Error("正在保存图纸，请稍候。");
    cadTransaction.current = true;
    if (!background) setBusy(true);
    const before =
      persistedProjects.current.find((p) => p.projectId === project.projectId) ?? project;
    const candidateAtStart = state.current.projects.find((p) => p.projectId === project.projectId);
    try {
      const client = compositionClient();
      const ids = cadSynchronizationSourceIds(project);
      const sources = await Promise.all(
        [...ids].map(
          async (id) =>
            [id, id === project.cad!.assetId && bytes ? bytes : await readCadDraft(id)] as const,
        ),
      );
      const compiled = await client.request<AnnotationResult>("synchronize", project, sources, before, nativeEdit);
      const latestProject = state.current.projects.find(
        (item) => item.projectId === project.projectId,
      );
      if (latestProject !== candidateAtStart && !(latestProject && cadMetadataEdit(candidateAtStart, latestProject))) {
        throw new Error("图纸已发生变化，本次编辑未覆盖新内容，请重试。");
      }
      if (latestProject && latestProject !== candidateAtStart) {
        project = { ...project, regions: latestProject.regions, name: latestProject.name,
          warnings: latestProject.warnings, nextLabel: latestProject.nextLabel, repeatLabel: latestProject.repeatLabel };
      }
      const next = parseDrawingEdit(
        checkpoints().stage(project, compiledData(compiled), compiled.scene, compiled.objects),
      );
      const dx =
        (project.cad!.mapping.originX - next.cad!.mapping.originX) * next.cad!.mapping.scale;
      const dy =
        (next.cad!.mapping.originY - project.cad!.mapping.originY) * next.cad!.mapping.scale;
      if (dx || dy) rebaseProjectView(project.projectId, dx, dy);
      if (record && !drawingEditEqual(before, next)) {
        histories.record(before);
        setHistoryTick((value) => value + 1);
      }
      prepared?.(next.cad!.assetId);
      setDetailGesture(null);
      persist(
        state.current.projects.map((item) => (item.projectId === project.projectId ? next : item)),
        state.current.session.patent.assets,
        undefined,
        nativeEdit ? "修改图形" : "修改专利图纸",
      );
      return {...compiled, bytes: compiledData(compiled)};
    } catch (error) {
      // Transient pointer previews are not a saved revision. Restore the complete saved scene.
      if (
        state.current.projects.find((p) => p.projectId === project.projectId) === candidateAtStart
      ) {
        state.current.projects = state.current.projects.map((p) =>
          p.projectId === before.projectId ? before : p,
        );
        setProjects(state.current.projects);
      }
      throw error;
    } finally {
      cadTransaction.current = false;
      if (!background) setBusy(false);
    }
  }
  async function commitCad(
    bytes: Uint8Array | CadCommandCheckpoint,
    prepared: (checkpointId: string) => void,
    metadata?: DrawingProject,
    background = false,
  ) {
    const project = metadata ?? state.current.projects.find((item) => item.projectId === activeId);
    if (!project?.cad) throw new Error("当前图纸不是可编辑 CAD。");
    return synchronizeProject(project, true, bytes, prepared, true, background);
  }
  async function readCadDetail(assetId: string) {
    const draft = draftCheckpoints.current?.get(assetId);
    const bytes = await draftCheckpoints.current?.readBytes(assetId);
    if (bytes) return bytes;
    const result = await window.patentApi.assets.readDrawingSource(
      session.sessionId,
      draft?.prepared?.cad.assetId ?? assetId,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  function commitNativeCad(data: Uint8Array | CadCommandCheckpoint, scene: CadScene, metadata?: DrawingProject) {
    const before = state.current.projects.find(p => p.projectId === activeId);
    if (!before?.cad) throw new Error("当前图纸不是可编辑 CAD。");
    const project = metadata ? {...before, annotations: metadata.annotations, detailViews: metadata.detailViews,
      cad: {...before.cad, objects: metadata.cad?.objects}} : before;
    const objects = project.cad!.objects ?? [];
    const next = parseDrawingEdit(checkpoints().stage(project, data, scene, objects, true));
    histories.record(before);
    setHistoryTick(value => value + 1);
    persist(state.current.projects.map(p => p.projectId === before.projectId ? next : p));
    return {checkpointId: next.cad!.assetId, objects, scene};
  }
  async function readCadDraft(assetId: string) {
    const draft = draftCheckpoints.current?.get(assetId);
    // Also enforce this at the consumer boundary for session stores retained by
    // Fast Refresh: never replay a saved revision instead of its durable asset.
    return (!draft?.prepared ? draft?.checkpoint : undefined) ?? readCadDetail(assetId);
  }
  // Convert old work drafts atomically before exposing native editing. The source/checkpoint assets remain recoverable.
  const unifiedAttempts = useRef(new Set<string>());
  async function initializeBackgroundCad(project: DrawingProject) {
    if (cadTransaction.current) return;
    cadTransaction.current = true;
    setBusy(true);
    let blank: CadcraftClient | undefined;
    try {
      blank = new CadcraftClient();
      const bytes = await blank.request<Uint8Array>("export");
      const operationId = uid();
      const result = await window.patentApi.assets.prepareCad({
        sessionId: session.sessionId,
        operationId,
        originalName: "图纸编辑工作稿.dxf",
        format: "dxf",
        bytes: Uint8Array.from(bytes),
        frame: {
          mapping: { originX: 0, originY: project.height, scale: 1 },
          width: project.width,
          height: project.height,
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      const cad = {
        ...result.value.cad,
        overlayAssetId: result.value.assets.at(-1)!.descriptor.assetId,
        backgroundSize: [project.width, project.height] as [number, number],
      };
      const initialized = parseDrawingEdit({
        ...project,
        cad,
        baseFragments: project.baseFragments ?? baseFragments(project),
        detailViews: project.detailViews?.map((d) => ({
          ...d,
          cadSource: {
            ...cad,
            baseAssetId: project.baseAssetId,
            width: project.width,
            height: project.height,
          },
        })),
        revision: project.revision + 1,
      });
      if (state.current.projects.find((p) => p.projectId === project.projectId) !== project) {
        await window.patentApi.assets.discardImports({
          sessionId: session.sessionId,
          operationId,
          assetIds: result.value.assets.map((a) => a.descriptor.assetId),
        });
        throw new Error("图纸已发生变化，请重新打开图纸工具。");
      }
      persist(
        state.current.projects.map((p) => (p.projectId === project.projectId ? initialized : p)),
        mergeAssets(
          state.current.session.patent.assets,
          result.value.assets.map((a) => a.descriptor),
        ),
      );
    } finally {
      blank?.close();
      cadTransaction.current = false;
      setBusy(false);
    }
  }
  const reconcileDrawing = useRef({ initializeBackgroundCad, synchronizeProject, status });
  reconcileDrawing.current = { initializeBackgroundCad, synchronizeProject, status };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retries must rerun reconciliation even when the project and busy state are unchanged.
  useEffect(() => {
    if (
      !runtimeEnabled ||
      !current ||
      !base ||
      busy ||
      cadTransaction.current ||
      publishingCadCandidate.current ||
      annotationSync.current?.pending ||
      drag.current ||
      sizeGesture.current ||
      cadPointer.current
    )
      return;
    if (!current.cad) {
      // Raster/PDF projects use their original annotation model. Only existing
      // overlays retain the compatibility synchronizer; never create a new one.
      if (isImageDrawing(current)) return;
      if (typeof Worker === "undefined" || typeof window.patentApi.assets.prepareCad !== "function")
        return;
      const key = `background:${current.projectId}`;
      if (unifiedAttempts.current.has(key)) return;
      unifiedAttempts.current.add(key);
      const initialization = reconcileDrawing.current
        .initializeBackgroundCad(current)
        .then(() => setCadRetry(null))
        .catch((error) => {
          reconcileDrawing.current.status(error);
          setCadRetry({ projectId: current.projectId, key });
        }).finally(() => {
          if (cadSynchronization.current === initialization) cadSynchronization.current = null;
        });
      cadSynchronization.current = initialization;
      return;
    }
    const key = cadSemanticKey(current);
    if (current.cad.unified && cadSemanticKeyMatches(current)) return;
    const attempt = `${current.cad.assetId}:${key}`;
    if (unifiedAttempts.current.has(attempt)) return;
    unifiedAttempts.current.add(attempt);
    const reconciliation = reconcileDrawing.current
      .synchronizeProject(current, false)
      .then(() => setCadRetry(null))
      .catch((error) => {
        reconcileDrawing.current.status(error);
        setCadRetry({ projectId: current.projectId, key: attempt });
      }).finally(() => {
        if (cadSynchronization.current === reconciliation) cadSynchronization.current = null;
      });
    cadSynchronization.current = reconciliation;
  }, [current, base, busy, cadRetryTick, runtimeEnabled]);
  const cadExportPending = useRef(false);
  async function exportEditableCad(format: "dxf" | "dwg", projectId = current?.projectId) {
    if (busy || !projectId || cadExportPending.current) return;
    cadExportPending.current = true;
    let client: CadcraftClient | undefined;
    let exporting = false;
    try {
      if (!(await guard())) return;
      const source = state.current.projects.find((p) => p.projectId === projectId);
      if (!source?.cad) return;
      const project = structuredClone(source);
      client = new CadcraftClient();
      exporting = true;
      setBusy(true);
      const ids = new Set([
        project.cad!.assetId,
        ...(project.detailViews ?? []).flatMap((detail) =>
          detail.cadSource ? [detail.cadSource.assetId] : [],
        ),
      ]);
      const sources = await Promise.all(
        [...ids].map(async (id) => [id, await readCadDetail(id)] as const),
      );
      const compiled = await client.request<{ bytes: Uint8Array; warnings: string[] }>(
        "compose",
        project,
        sources,
      );
      const result = await window.patentApi.assets.exportCad({
        sessionId: session.sessionId,
        format,
        name: project.name,
        bytes: Uint8Array.from(compiled.bytes),
      });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value)
        setMessage(`已导出 ${format.toUpperCase()} 图纸。${compiled.warnings.join(" ")}`);
    } catch (error) {
      status(error);
    } finally {
      client?.close();
      if (exporting) setBusy(false);
      cadExportPending.current = false;
    }
  }
  async function createCad() {
    if (busy) return;
    const client = new CadcraftClient();
    setBusy(true);
    try {
      const bytes = await client.request<Uint8Array>("export");
      await importFile(
        new File([Uint8Array.from(bytes)], "新图纸.dxf"),
        state.current.session.patent.assets,
        "新图纸",
      );
    } catch (error) {
      status(error);
    } finally {
      client.close();
      setBusy(false);
    }
  }
  const historyOperations = useRef<Promise<void> | null>(null);
  function undoRedo(direction: "undo" | "redo") {
    const id=state.current.current?.projectId;
    if(!id)return Promise.resolve();
    // Image/legacy annotation history has no asynchronous native flush. Keep
    // its immediate keyboard feedback; only pending native history needs FIFO.
    if(!cadEditor.current && !historyOperations.current)return performUndoRedo(direction,id).catch(status);
    const operation=historyOperations.current
      ? historyOperations.current.then(()=>performUndoRedo(direction,id))
      : performUndoRedo(direction,id);
    const settled=operation.catch(status);
    historyOperations.current=settled;
    void settled.then(()=>{if(historyOperations.current===settled)historyOperations.current=null;});
    return settled;
  }
  async function performUndoRedo(direction: "undo" | "redo", activeId: string) {
    if (cadSynchronization.current) await cadSynchronization.current;
    if(state.current.current?.projectId !== activeId)return;
    finishSizeRef.current();
    if (drag.current) cancelGesture();
    if (annotationSync.current && !(await annotationSync.current.flush())) return;
    if (cadEditor.current && !(await cadEditor.current.flush())) return;
    if(state.current.current?.projectId !== activeId)return;
    const current=state.current.projects.find(p=>p.projectId===activeId);
    if(direction === "redo" && !histories.peek(activeId,direction).entry)return;
    const lineUndo =
      direction === "undo" &&
      !!histories.peek(activeId, direction).entry &&
      cadEditor.current?.prepareLineUndo(false);
    if (direction === "undo" && cadEditing && !lineUndo && cadEditor.current?.cancelDraft()) {
      cancelGesture();
      return;
    }
    setLabelFocusTick((v) => v + 1);
    if (placement || pastePreview || detailDraft || detailPaste) {
      cancelGesture();
      if(direction === "undo") return;
    }
    const { entry: previous, blockedProjectIds } = histories.peek(activeId, direction);
    if (!previous || !current) return;
    if (blockedProjectIds.length) {
      const names = state.current.projects
        .filter((p) => blockedProjectIds.includes(p.projectId))
        .map((p) => `“${p.name}”`)
        .join("、");
      setFailure(
        `请先${direction === "undo" ? "撤销" : "重做"}${names}中后续的编辑，再${direction === "undo" ? "撤销" : "重做"}这批标号删除。`,
      );
      return;
    }
    if (lineUndo) cadEditor.current?.prepareLineUndo();
    if (direction === "redo") cadEditor.current?.prepareLineRedo();
    if ("annotationBatch" in previous) {
      const restoredProjects = state.current.projects.map((project) => {
        const batch = previous.annotationBatch.find(
          (entry) => entry.projectId === project.projectId,
        );
        if (!batch) return project;
        const annotations = [...project.annotations];
        if (direction === "undo") {
          for (const mark of batch.marks) {
            if (!annotations.some((annotation) => annotation.id === mark.annotation.id))
              annotations.splice(
                Math.min(mark.index, annotations.length),
                0,
                structuredClone(mark.annotation),
              );
          }
        } else {
          const ids = new Set(batch.marks.map((mark) => mark.annotation.id));
          return {
            ...project,
            annotations: annotations.filter((annotation) => !ids.has(annotation.id)),
            revision: project.revision + 1,
          };
        }
        return { ...project, annotations, revision: project.revision + 1 };
      });
      if (restoredProjects.some((project) => !DrawingProjectSchema.safeParse(project).success)) {
        setFailure("图纸标号数量已达上限，无法恢复这批标号。");
        return;
      }
      histories.move(activeId, direction, current);
      persist(restoredProjects);
      setFailure("");
      setSelected("");
      setHistoryTick((value) => value + 1);
      svgRef.current?.focus({ preventScroll: true });
      return;
    }
    const restored = restoreDrawingHistory(previous, current);
    histories.move(activeId, direction, current);
    commit(restored, false);
    setFailure("");
    setLabel(nextDrawingLabel(restored));
    setSelected("");
    // Selection controls can unmount after undo; keep the next shortcut in this workspace.
    svgRef.current?.focus({ preventScroll: true });
    setHistoryTick((v) => v + 1);
  }
  async function finishHistoryOperations() {
    // Include history requests accepted while an earlier checkpoint was finishing.
    for(let pending=historyOperations.current;pending;) {
      await pending;
      if(pending===historyOperations.current)break;
      pending=historyOperations.current;
    }
  }
  const guard = useCallback(async (preserveDraft = false) => {
    if(historyOperations.current) await finishHistoryOperations();
    if (drag.current) return false;
    finishSizeRef.current();
    if (annotationSync.current && !(await annotationSync.current.flush())) return false;
    if (cadEditor.current && !(await cadEditor.current.flush(preserveDraft))) return false;
    if (cadSynchronization.current) await cadSynchronization.current;
    if (state.current.busy || importBatch.current || drag.current) return false;
    finishSizeRef.current();
    inlineInput.current?.flush();
    annotationInput.current?.flush();
    detailInput.current?.flush();
    detailRatioInput.current?.flush();
    if (annotationSync.current && !(await annotationSync.current.flush())) return false;
    if (cadSynchronization.current) await cadSynchronization.current;
    if (saveQueue.current && !(await saveQueue.current.flush())) return false;
    return !state.current.busy;
  }, []);
  useApplicationCloseParticipant(`drawing-markup:${session.patentId}`, guard, "editor");
  async function flush(preserveDraft = false) {
    if (!(await guard(preserveDraft))) return false;
    if (await patents.preparePatentSnapshot(session.patentId)) return true;
    setFailure("工作稿尚未保存成功，请重试保存后关闭。");
    return false;
  }
  useImperativeHandle(ref, () => ({ flush, suspend: () => flush(true), requestClose: flush, importFiles }));
  const viewActions = useRef({ cancelGesture, activate });
  openFolderProject.current = async (id) => {
    try {
      await selectProject(id);
    } catch (error) {
      status(error);
    }
  };
  viewActions.current = { cancelGesture, activate };
  useEffect(() => {
    if (active) {
      if (svgRef.current?.dataset.tool !== "label") svgRef.current?.focus({ preventScroll: true });
    } else {
      if (drag.current || cadPointer.current) viewActions.current.cancelGesture();
      setSpacePan(false);
    }
  }, [active]);
  useEffect(() => {
    if (preview) return () => URL.revokeObjectURL(preview.url);
    return undefined;
  }, [preview]);
  const sourceKey = current
    ? JSON.stringify({
        projectId: current.projectId,
        editableCad: Boolean(current.cad),
        baseAssetId: current.baseAssetId,
        sourceKind: current.sourceKind,
        pageNumber: current.pageNumber,
        width: current.width,
        height: current.height,
        mapping: current.cad?.mapping,
      })
    : null;
  const baseMediaType = session.patent.assets.find(
    (a) => a.assetId === current?.baseAssetId,
  )?.mediaType;
  const sessionId = session.sessionId;
  useEffect(() => {
    if (!sourceKey || !baseMediaType) {
      setBase(null);
      if (retainedBase.current) URL.revokeObjectURL(retainedBase.current.url);
      retainedBase.current = null;
      return;
    }
    // Native strokes are already displayed by the live layer. Keep the stable
    // source image while the command/save queue is active, then refresh once.
    if (cadDrawingActive || cadSaving) return;
    // Finishing a stroke/save is not a new source. Retain its bytes, URL and
    // decoded preview rather than re-reading and repainting the same asset.
    if (
      retainedBase.current?.sourceKey === sourceKey &&
      retainedBase.current.mediaType === baseMediaType
    )
      return;
    const project = JSON.parse(sourceKey) as Pick<
      DrawingProject,
      "projectId" | "baseAssetId" | "sourceKind" | "pageNumber" | "width" | "height"
    > & { editableCad: boolean; mapping?: NonNullable<DrawingProject["cad"]>["mapping"] };
    let cancelled = false,
      url = "";
    if (!project.editableCad || retainedBase.current?.projectId !== project.projectId) {
      setBase(null);
      if (retainedBase.current) URL.revokeObjectURL(retainedBase.current.url);
      retainedBase.current = null;
    }
    const refresh = project.editableCad && retainedBase.current?.projectId === project.projectId;
    let repairingFrame = false;
    if (!refresh) setSourceLoading(true);
    setFailure("");
    void (async () => {
      const result = await window.patentApi.assets.readDrawingSource(
        sessionId,
        project.baseAssetId,
      );
      if (!result.ok) throw new Error(result.error.message);
      const bytes = result.value;
      const candidate = state.current.projects.find(p => p.projectId === project.projectId);
      if (baseMediaType === "image/svg+xml" && candidate?.cad?.unified &&
        !candidate.cad.overlayAssetId && candidate.baseAssetId === project.baseAssetId &&
        !checkpoints().get(candidate.cad.assetId) &&
        !cadPreviewFrameMatches(bytes, { ...candidate, cad: candidate.cad })) {
        // Older saves expanded the SVG frame but retained the original project
        // coordinates. Rebuild only the derived preview; preserve native bytes,
        // selection identity, annotations, frozen detail sources and history.
        repairingFrame = true;
        setSourceLoading(true);
        setBase(null);
        const native = await window.patentApi.assets.readDrawingSource(sessionId, candidate.cad.assetId);
        if (!native.ok) throw new Error(native.error.message);
        const repaired = await window.patentApi.assets.prepareCad({
          sessionId, operationId: uid(), originalName: "CAD底图坐标修复.dxf", format: "dxf",
          bytes: Uint8Array.from(native.value), preserveFrame: true,
          frame: { mapping: candidate.cad.mapping, width: candidate.width, height: candidate.height },
        });
        if (!repaired.ok) throw new Error(repaired.error.message);
        assertCadPreviewFrame({ ...candidate, cad: candidate.cad }, repaired.value);
        const previewAsset = repaired.value.assets.at(-1)!;
        const previewBytes = await window.patentApi.assets.readDrawingSource(sessionId, previewAsset.descriptor.assetId);
        if (!previewBytes.ok) throw new Error(previewBytes.error.message);
        if (!cadPreviewFrameMatches(previewBytes.value, { ...candidate, cad: candidate.cad }))
          throw new Error("CAD 底图坐标修复校验失败，原图纸未修改。");
        if (cancelled || state.current.projects.find(p => p.projectId === project.projectId) !== candidate) return;
        const next = { ...candidate, baseAssetId: previewAsset.descriptor.assetId, revision: candidate.revision + 1 };
        if (cadSemanticKeyMatches(candidate)) next.cad = { ...candidate.cad, semanticKey: cadSemanticKey(next) };
        persist(state.current.projects.map(p => p === candidate ? next : p),
          mergeAssets(state.current.session.patent.assets, [previewAsset.descriptor]));
        return;
      }
      let tiled: TiledDrawingSource | undefined;
      if (baseMediaType === DRAWING_TILES_MEDIA_TYPE) {
        const index = DrawingTileIndexSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        const overview = await window.patentApi.assets.getPreview(sessionId, project.baseAssetId);
        if (!overview.ok) throw new Error(overview.error.message);
        url = imageUrl(overview.value, "image/png");
        tiled = { sessionId, assetId: project.baseAssetId, index, overviewUrl: url };
      } else if (project.sourceKind === "pdf") {
        const preview = await pdfPreview(bytes, project.pageNumber);
        if (!cancelled) setPdfPages(preview.totalPages);
        url = imageUrl(preview.bytes, "image/png");
      } else url = imageUrl(bytes, baseMediaType);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      const previous = retainedBase.current;
      retainedBase.current = {
        projectId: project.projectId,
        url,
        sourceKey,
        mediaType: baseMediaType,
      };
      setBase({
        projectId: project.projectId,
        assetId: project.baseAssetId,
        url,
        bytes,
        mediaType: baseMediaType,
        width: project.width,
        height: project.height,
        ...(project.mapping ? { mapping: project.mapping } : {}),
        ...(tiled ? { tiled } : {}),
      });
      if (previous) requestAnimationFrame(() => URL.revokeObjectURL(previous.url));
      // CAD checkpoints replace the preview, not the user's camera. Restore a
      // saved view only when opening a source, never after each drawing edit.
      if (!project.editableCad || previous?.projectId !== project.projectId) {
        setView(
          projectViews.current.get(project.projectId) ?? {
            x: -project.width * 0.04,
            y: -project.height * 0.04,
            width: project.width * 1.08,
            height: project.height * 1.08,
          },
        );
      }
      const target = pendingLocation.current;
      const viewport = svgRef.current?.getBoundingClientRect();
      if (target?.projectId === project.projectId && viewport) {
        setView((view) => locateRegionView(view, viewport, target.points, !imageDrawing));
        pendingLocation.current = null;
      }
      setPage(project.pageNumber);
    })()
      .catch((e) => {
        if (!cancelled) setFailure(e instanceof Error ? e.message : "图纸加载失败。");
      })
      .finally(() => {
        if (!cancelled && (!refresh || repairingFrame)) setSourceLoading(false);
      });
    return () => {
      cancelled = true;
      // A replacement source/command can cancel this effect after its bitmap
      // became visible. Release only this loader's state, never another edit's
      // busy flag, or the canvas and protected close can remain blocked forever.
      setSourceLoading(false);
      // The displayed URL belongs to retainedBase until a replacement is ready.
      if (url && retainedBase.current?.url !== url) URL.revokeObjectURL(url);
    };
  }, [sourceKey, baseMediaType, sessionId, setView, cadDrawingActive, cadSaving, imageDrawing]);
  function activate(id: string) {
    if (id === activeId) return;
    toolActivationEpoch.current++;
    setPlacedDetail(null);
    setCadDrawingActive(false);
    pendingLocation.current = null;
    setDetailDraft(null);
    setDetailPaste(null);
    copiedDetail.current = null;
    setLocatedRegionId("");
    setPastePreview(null);
    projectViews.current.set(activeId, displayView);
    setActiveId(id);
    setCadInside(undefined);
    setCadSelection(null);
    setDetailGesture(null);
    setLabel(nextDrawingLabel(state.current.projects.find((p) => p.projectId === id)));
    const retainedSelection = crossSelection.current;
    setSelected("");
    crossSelection.current = retainedSelection;
    setBatchIds(retainedSelection?.get(id) ?? []);
    setInlineId("");
    setRegionId("");
    rangePreview.clear();
    setPlacement(null);
    setPreview(null);
    setPreviewMode(false);
    setSpacePan(false);
    setHistoryTick((v) => v + 1);
    setTool("select");
  }
  async function selectProject(id: string) {
    if(historyOperations.current) await finishHistoryOperations();
    cancelGesture();
    finishSizeRef.current();
    if (annotationSync.current && !(await annotationSync.current.flush())) return;
    // Finish accepted geometry before disposing its worker. Disk writes belong
    // to the workspace queue and continue across source switches.
    if (cadEditor.current && !(await cadEditor.current.flush())) return;
    if (cadSynchronization.current) await cadSynchronization.current;
    activate(id);
  }
  async function renameProject(id: string) {
    const project = state.current.projects.find((p) => p.projectId === id);
    if (!project || !(await guard())) return;
    const input = await promptAppText("图纸名称", project.name);
    if (input === null) return;
    const name = input.trim();
    if (!name || name.length > 200) {
      setFailure("图纸名称应为 1～200 个字符。");
      return;
    }
    const latest = state.current.projects.find((p) => p.projectId === id);
    if (!latest || latest.name === name) return;
    if (id === activeId) commit({ ...latest, name });
    else {
      histories.record(latest);
      setHistoryTick((v) => v + 1);
      persist(
        state.current.projects.map((p) =>
          p.projectId === id ? { ...p, name, revision: p.revision + 1 } : p,
        ),
      );
    }
    setFailure("");
  }
  async function deleteProject(id: string) {
    const project = state.current.projects.find((p) => p.projectId === id);
    if (!project || !(await guard())) return;
    if (
      !(await confirmAppAction(`删除图纸“${project.name}”及其标号？已插入说明书附图的图片会保留。`))
    )
      return;
    const remaining = state.current.projects.filter((p) => p.projectId !== id);
    if (remaining.length === state.current.projects.length) return;
    if (id === activeId) {
      cancelGesture();
      activate(remaining[0]?.projectId ?? "");
    }
    histories.deleteProject(id);
    projectViews.current.delete(id);
    if (copiedBase.current?.projectId === id) {
      copiedBase.current = null;
      setHasCopiedAnnotations(copiedAnnotations.current.length > 0);
    }
    persist(remaining);
    setFailure("");
  }
  async function importFile(
    file: File,
    previousAssets: AssetDescriptor[],
    position: string,
  ): Promise<AssetDescriptor[] | null> {
    setBusy(true);
    setFailure("");
    setMessage(`正在导入 ${position}：${file.name}`);
    const operationId = uid();
    const operation = { id: operationId, cancelled: false };
    importOperation.current = operation;
    setImporting(true);
    let stagedAssets: string[] = [];
    try {
      if (/\.(dwg|dxf)$/iu.test(file.name)) {
        const format = /\.dwg$/iu.test(file.name) ? "dwg" : "dxf";
        if (file.size > MAX_CAD_IMPORT_BYTES[format]) throw new Error(CAD_IMPORT_LIMIT_MESSAGE);
      } else if (file.size > 50 * 1024 * 1024) {
        throw new Error("图纸文件不能超过 50 MiB。");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
      const pdf = isPdf ? await pdfPreview(bytes, 1) : null;
      if (operation.cancelled) return null;
      const cadFormat = /\.dxf$/iu.test(file.name)
        ? "dxf"
        : /\.dwg$/iu.test(file.name)
          ? "dwg"
          : null;
      const prepared = cadFormat
        ? await window.patentApi.assets.prepareCad({
            sessionId: session.sessionId,
            originalName: file.name,
            operationId,
            bytes,
            format: cadFormat,
          })
        : null;
      if (prepared && !prepared.ok) throw new Error(prepared.error.message);
      const result = prepared?.ok
        ? {
            ok: true as const,
            value: { ...prepared.value, sourceKind: cadFormat!, warnings: [] as string[] },
          }
        : await window.patentApi.assets.importDrawing({
            sessionId: session.sessionId,
            originalName: file.name,
            declaredMediaType: file.type || null,
            operationId,
            bytes,
            ...(pdf ? { preview: Uint8Array.from(pdf.bytes) } : {}),
          });
      if (!result.ok) throw new Error(result.error.message);
      const assets = result.value.assets.map((a) => a.descriptor),
        source = assets[0]!,
        background = assets.at(-1)!;
      stagedAssets = [...new Set(assets.map((a) => a.assetId))];
      if (operation.cancelled) return null;
      const project = DrawingProjectSchema.parse({
        projectId: uid(),
        name: file.name.slice(0, 200),
        sourceAssetId: source.assetId,
        baseAssetId: background.assetId,
        ...(prepared?.ok ? { cad: prepared.value.cad } : {}),
        sourceKind: result.value.sourceKind,
        pageNumber: 1,
        width: prepared?.ok ? prepared.value.width : (pdf?.width ?? background.widthPx),
        height: prepared?.ok ? prepared.value.height : (pdf?.height ?? background.heightPx),
        annotations: [],
        baseFragments: undefined,
        detailViews: undefined,
        regions: [],
        warnings: result.value.warnings,
        revision: 0,
      });
      const allAssets = mergeAssets(
        mergeAssets(previousAssets, state.current.session.patent.assets),
        assets,
      );
      persist([...state.current.projects, project], allAssets);
      stagedAssets = [];
      activate(project.projectId);
      setMessage(isImageDrawing(project)
        ? "图纸已导入。可添加标号、局部放大，框选或圈选后预览、插入附图。"
        : "图纸已导入。选中线条、图形和标号后即可预览或插入附图。");
      return allAssets;
    } catch (e) {
      if (!operation.cancelled) status(e);
      return null;
    } finally {
      try {
        if (stagedAssets.length) {
          const discarded = await window.patentApi.assets.discardImports({
            sessionId: session.sessionId,
            operationId,
            assetIds: stagedAssets,
          });
          if (!discarded.ok) setFailure(discarded.error.message);
        }
      } catch (error) {
        status(error);
      } finally {
        if (operation.cancelled) setMessage("已取消导入，原工作稿保持不变。");
        importOperation.current = null;
        setImporting(false);
        setBusy(false);
      }
    }
  }
  async function importFiles(files: File[]) {
    if(historyOperations.current) await finishHistoryOperations();
    if (drag.current) {
      setFailure("当前操作尚未完成，请稍后重新拖入图纸。");
      return;
    }
    finishSizeRef.current();
    if (annotationSync.current && !(await annotationSync.current.flush())) return;
    if (cadEditor.current && !(await cadEditor.current.flush())) return;
    if (importBatch.current || state.current.busy || drag.current) {
      setFailure("当前操作尚未完成，请稍后重新拖入图纸。");
      return;
    }
    importBatch.current = true;
    setBatchImporting(true);
    cancelBatch.current = false;
    try {
      let assets = state.current.session.patent.assets;
      for (const [index, file] of files.entries()) {
        if (cancelBatch.current) break;
        const imported = await importFile(file, assets, `${index + 1}/${files.length}`);
        if (!imported) break;
        assets = imported;
        if (!(await patents.preparePatentSnapshot(session.patentId))) {
          setFailure("工作稿保存失败，已停止后续导入。请先重试保存。");
          break;
        }
      }
    } finally {
      importBatch.current = false;
      setBatchImporting(false);
    }
  }
  async function cancelImport() {
    cancelBatch.current = true;
    const operation = importOperation.current;
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    setMessage("正在取消导入…");
    try {
      const result = await window.patentApi.assets.cancelDrawingImport({
        sessionId: session.sessionId,
        operationId: operation.id,
      });
      if (!result.ok) status(new Error(result.error.message));
    } catch (error) {
      status(error);
    }
  }
  async function addPdfPage() {
    if (!current || !base || busy) return;
    if (!(await guard())) return;
    setBusy(true);
    setFailure("");
    try {
      if (!Number.isInteger(page) || page < 1 || page > pdfPages) throw new Error("页码无效。");
      const existing = projects.find(
        (p) => p.sourceAssetId === current.sourceAssetId && p.pageNumber === page,
      );
      if (existing) {
        activate(existing.projectId);
        return;
      }
      const pdfBytes = current.sourceAssetId === base.assetId
        ? base.bytes : await readCadDetail(current.sourceAssetId);
      const p = await pdfPreview(pdfBytes, page);
      const project = imagePdfPage(current, page, p.width, p.height, uid());
      persist([...projects, project]);
      activate(project.projectId);
    } catch (e) {
      status(e);
    } finally {
      setBusy(false);
    }
  }
  function point(e: { clientX: number; clientY: number }, inverse?: DOMMatrix): DrawingPoint {
    const matrix = inverse ?? svgRef.current?.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  }
  canvasWheelHandler.current = (event) => {
    const canvas = svgRef.current;
    if (!active || !current || !canvas) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || drag.current) return;
    cadEditor.current?.leave();
    // CAD's ordinary vertical wheel zooms across platforms; preserve two-axis scrolling.
    if (canvasWheelPans(event) && event.deltaX !== 0) {
      const matrix = canvas.getScreenCTM();
      if (!matrix) return;
      panBy(
        matrix.inverse(),
        -wheelPixels(event.deltaX, event.deltaMode, canvas.clientWidth),
        -wheelPixels(event.deltaY, event.deltaMode, canvas.clientHeight),
      );
      return;
    }
    const p = point(event);
    animateZoom(
      wheelZoomFactor(
        event.deltaY,
        event.deltaMode,
        canvas.clientHeight,
        event.ctrlKey || event.metaKey,
      ),
      {
        x: (p.x - displayView.x) / displayView.width,
        y: (p.y - displayView.y) / displayView.height,
      },
      minimumDrawingViewWidth(current.width, displayView),
      current.width * 20,
    );
  };
  const prepareLivePan = useCallback(() => {
    const canvas = svgRef.current;
    if (!canvas) return;
    livePanTargets.current = canvas;
    panPreview.current?.begin();
  }, []);
  const applyLivePan = useCallback(
    (
      screenX: number,
      screenY: number,
      screenInverse: Pick<DOMMatrixReadOnly, "a" | "b" | "c" | "d">,
    ) => {
      const targets = livePanTargets.current;
      if (!targets) return;
      // Translate the outer SVG as a compositor layer. Transforming its inner
      // groups invalidates and repaints every non-scaling CAD stroke per sample.
      targets.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;
      const gesture = drag.current;
      if (gesture)
        panPreview.current?.move(
          panViewByScreenDelta(gesture.view, screenInverse, screenX, screenY),
          screenX,
          screenY,
        );
    },
    [],
  );
  const clearLivePan = useCallback(() => {
    const targets = livePanTargets.current;
    if (!targets) return;
    flushSync(() => panPreview.current?.finish());
    targets.style.transform = "";
    livePanTargets.current = null;
  }, []);
  function down(e: ReactPointerEvent<SVGSVGElement>) {
    const secondaryPan = (isMacPlatform() || isHarmonyPlatform()) && e.button === 2;
    if (e.button === 2 && current?.cad?.unified && !secondaryPan) {
      // Keep a text draft alive until contextmenu chooses one command action.
      e.preventDefault();
      return;
    }
    const semantic = (e.target as Element).closest<SVGElement>(
      "[data-annotation], [data-detail], [data-detail-part], [data-region-handle], [data-region-move]",
    );
    const directSemantic =
      !imageDrawing &&
      e.button === 0 &&
      tool === "select" &&
      !!semantic &&
      (!cadInside || (!!current &&
        (semantic?.dataset.detailPart === "source" || semantic?.dataset.detailPart === "marker") &&
        detailSourceInScope(current, semantic.closest<SVGElement>("[data-detail]")?.dataset.detail ?? "", cadInside))) &&
      !!cadEditor.current?.canWindow() &&
      !cadEditor.current?.isCommandPicking();
    if (directSemantic && current?.cad && semantic && semantic.dataset.detailPart !== "title") {
      const annotation = semantic.closest<SVGElement>("[data-annotation]")?.dataset.annotation;
      // Use the same click target before and after selection adds label grips.
      // Otherwise the second captured click targets the canvas while the first
      // targets the text, so Chromium never dispatches the label double-click.
      if (annotation) e.currentTarget.setPointerCapture(e.pointerId);
      const detail = semantic.closest<SVGElement>("[data-detail]")?.dataset.detail;
      const object = current.cad.objects?.find((o) => o.id === (annotation ?? detail));
      const source =
        semantic.dataset.detailPart === "source" || semantic.dataset.detailPart === "marker";
      const members = object
        ? object.kind === "label"
          ? (object.label ?? [])
          : source
            ? (object.source ?? [])
            : [...(object.body ?? []), ...(object.frame ?? [])]
        : [];
      const selectedHandles = new Set(cadSelection?.handles);
      if (
        members.length &&
        members.every((h) => selectedHandles.has(h)) &&
        selectedHandles.size > members.length &&
        !e.shiftKey &&
        !(e.target as Element).closest("[data-point-index]") &&
        e.button === 0 &&
        !busy &&
        !spacePan &&
        cadEditor.current?.beginMove(point(e), unitsPerPixel * 7)
      ) {
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        cadPointer.current = {
          pointerId: e.pointerId,
          start: point(e),
          screen: { x: e.clientX, y: e.clientY },
          pressedAt: e.timeStamp,
          aperture: unitsPerPixel * 7,
          window: false,
          grip: false,
          pointOnDown: true,
          dragToFinish: true,
          directMove: true,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      // A semantic multi-selection must also reach the native clipboard. Picking
      // its first label for a drag must not replace that set with one object.
      if (object)
        cadEditor.current?.selectHandles(
          object.kind === "label"
            ? annotation && selectedIds.has(annotation) && selectedIds.size > 1 && !e.shiftKey
              ? (current.cad.objects ?? [])
                  .filter(o => o.kind === "label" && selectedIds.has(o.id))
                  .flatMap(o => o.label ?? [])
              : (object.label ?? [])
            : source
              ? (object.source ?? [])
              : [...(object.body ?? []), ...(object.frame ?? [])],
          e.shiftKey,
        );
      if (
        object?.kind === "detail" &&
        source &&
        (e.target as Element).tagName.toLowerCase() === "circle" &&
        !e.shiftKey &&
        e.button === 0 &&
        !busy &&
        !spacePan &&
        cadEditor.current?.beginMove(point(e), unitsPerPixel * 7)
      ) {
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        cadPointer.current = {
          pointerId: e.pointerId,
          start: point(e),
          screen: { x: e.clientX, y: e.clientY },
          pressedAt: e.timeStamp,
          aperture: unitsPerPixel * 7,
          window: false,
          grip: false,
          pointOnDown: true,
          dragToFinish: true,
          directMove: true,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (
      cadEditing &&
      tool === "select" &&
      current?.cad?.unified &&
      !directSemantic &&
      !e.ctrlKey &&
      !e.metaKey &&
      !blockingBusy &&
      !spacePan &&
      e.button === 0
    ) {
      if ((e.target as Element).closest("input, textarea")) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      stopZoom();
      const grip = cadEditor.current?.beginGrip(point(e), unitsPerPixel * 7) ?? false;
      const selectionDrag = !grip && !e.shiftKey &&
        (cadEditor.current?.canDragSelection(point(e), unitsPerPixel * 7) ?? false);
      const window = !selectionDrag && (cadEditor.current?.canWindow() ?? false);
      const trimStroke = cadEditor.current?.canTrimStroke?.() ?? false;
      const dragToFinish =
        !window && !grip && !trimStroke && !selectionDrag
          ? (cadEditor.current?.pointDown(point(e), unitsPerPixel * 7, e.shiftKey, e.shiftKey) ??
            false)
          : false;
      cadPointer.current = {
        pointerId: e.pointerId,
        start: point(e),
        screen: { x: e.clientX, y: e.clientY },
        pressedAt: e.timeStamp,
        aperture: unitsPerPixel * 7,
        window,
        grip,
        pointOnDown: !window && !grip && !trimStroke && !selectionDrag,
        dragToFinish,
        selectionDrag,
        ...(trimStroke ? {trimPath: [point(e)]} : {}),
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    pointerFrame.cancel();
    gesturePreview.current = null;
    if ((e.target as Element).closest("input, textarea")) return;
    if (
      !current ||
      busy ||
      !base ||
      drag.current ||
      (e.button !== 0 && e.button !== 1 && !secondaryPan)
    )
      return;
    secondaryPanMenu.current = secondaryPan;
    stopZoom();
    if (
      fixedBase &&
      !liveScene &&
      (!vectorReady || view !== (liveViewport ? livePaintedView.current : paintedView)) &&
      e.button === 0
    )
      return;
    if (e.button === 0 && !spacePan) setLocatedRegionId("");
    e.preventDefault();
    // A stationary secondary click must finish the draft before focus changes.
    if (!secondaryPan) {
      if (tool === "label" && !e.ctrlKey && !e.metaKey) {
        nextLabelInput.current?.focus({ preventScroll: true });
      } else if (tool === "detail" && !e.ctrlKey && !e.metaKey) {
        nextDetailInput.current?.focus({ preventScroll: true });
        nextDetailInput.current?.select();
      } else e.currentTarget.focus({ preventScroll: true });
    }
    const gestureProject =
      state.current.projects.find((p) => p.projectId === current.projectId) ?? current;
    if (tool === "label" && e.button === 0 && !spacePan && !e.ctrlKey && !e.metaKey &&
      keywordPromptRef.current?.finish() === false) return;
    setFailure("");
    const rawPoint = point(e);
    const p =
      current.cad?.unified &&
      e.button === 0 &&
      !spacePan &&
      !e.ctrlKey &&
      !e.metaKey &&
      (tool === "label" || tool === "detail")
        ? (cadEditor.current?.assistPoint(rawPoint, unitsPerPixel * 7, false) ?? rawPoint)
        : rawPoint;
    lastCanvasPointer.current = { x: e.clientX, y: e.clientY };
    if (
      (tool === "detail" || detailPaste) &&
      e.button === 0 &&
      !spacePan &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      if (detailPaste) {
        const pasted = {
          ...moveDetail(detailPaste, p.x - detailPaste.center.x, p.y - detailPaste.center.y),
          id: uid(),
        };
        commit({ ...current, detailViews: [...(current.detailViews ?? []), pasted] });
        setDetailPaste(null);
        setDetailSelection({ id: pasted.id, part: "content" });
        return;
      }
      if (!parseDetailRatio(detailRatio) || !detailLabel.trim()) {
        setFailure("请填写字母和有效比例，例如 2:1（倍率 0.1～100）。");
        return;
      }
      if ((current.detailViews?.length ?? 0) >= 100) {
        setFailure("每张工作稿最多添加 100 个局部放大图。");
        return;
      }
      if (!detailDraft) setDetailDraft({ stage: "radius", source: p, cursor: p, radius: 0 });
      else if (detailDraft.stage === "radius") {
        const radius = Math.hypot(p.x - detailDraft.source.x, p.y - detailDraft.source.y);
        if (radius > 100000) {
          setFailure("取图范围过大，请缩小取图圆。");
          return;
        }
        if (radius < unitsPerPixel * 4) {
          setFailure("取图圆太小，请向外移动鼠标后再次点击。");
          return;
        }
        setDetailDraft({ ...detailDraft, stage: "leader", radius, cursor: p });
      } else if (detailDraft.stage === "leader") {
        setDetailDraft({
          ...detailDraft,
          stage: "place",
          marker: detailMarkerPosition(p),
          cursor: p,
        });
      } else {
        if (current.detailViews?.some((d) => d.label === detailLabel.trim())) {
          setFailure("该字母已被使用，请修改局部放大标记。");
          return;
        }
        const detail = createDetailView(
          current,
          detailDraft.source,
          detailDraft.radius,
          p,
          detailLabel.trim(),
          parseDetailRatio(detailRatio)!,
          fontSize,
          LEGACY_ANNOTATION_LINE_WIDTH,
          uid(),
        );
        detail.marker = detailDraft.marker!;
        const next = { ...current, detailViews: [...(current.detailViews ?? []), detail] };
        if (!DrawingProjectSchema.safeParse(next).success) {
          setFailure("局部放大范围已达上限，请减小倍率或取图范围。");
          return;
        }
        commit(next);
        if (current.cad?.unified) setPlacedDetail({ projectId: current.projectId, detail });
        setLabelFocusTick((tick) => tick + 1);
        setDetailDraft(null);
        setDetailLabel(
          nextDetailLabel(
            detail.label,
            (current.detailViews ?? []).map((d) => d.label),
          ),
        );
        setDetailRatio(`${defaultDetailRatio}:1`);
        setSelected("");
        setDetailSelection(null);
      }
      return;
    }
    if (pastePreview && e.button === 0 && !spacePan) {
      if (current.annotations.length + pastePreview.annotations.length > 5000) {
        setFailure("标号数量已达上限，无法粘贴。");
        setPastePreview(null);
        return;
      }
      const copies = pastePreview.annotations.map((a) => ({
        ...translateAnnotation(a, p.x - pastePreview.anchor.x, p.y - pastePreview.anchor.y),
        id: uid(),
      }));
      const dx = p.x - pastePreview.anchor.x,
        dy = p.y - pastePreview.anchor.y;
      const pastedRegion = pastePreview.region
        ? {
            ...pastePreview.region,
            id: uid(),
            points: translatePolygon(pastePreview.region.points, dx, dy),
          }
        : undefined;
      const next = {
        ...current,
        annotations: [...current.annotations, ...copies],
        ...(pastePreview.details?.length
          ? {
              detailViews: [
                ...(current.detailViews ?? []),
                ...pastePreview.details.map((d) => translateDetailCopy(d, dx, dy)),
              ],
            }
          : {}),
        ...(pastePreview.fragments
          ? {
              baseFragments: [
                ...baseFragments(current),
                ...translateFragments(pastePreview.fragments, dx, dy, uid()),
              ],
            }
          : {}),
        ...(pastedRegion
          ? { regions: [...savedDrawingRegions(current.regions), pastedRegion] }
          : {}),
      };
      const parsed = DrawingProjectSchema.safeParse(next);
      if (!parsed.success) {
        setFailure("图纸编辑数量或范围已达上限，无法粘贴。");
        return;
      }
      commit(next);
      crossSelection.current = null;
      setPastePreview(null);
      setSelectedId("");
      setRangeSelection(Boolean(pastedRegion));
      if (pastedRegion) setRegionId(pastedRegion.id);
      setBatchIds(pastedRegion ? [] : copies.map((a) => a.id));
      return;
    }
    const target = e.target as SVGElement;
    let anno = target.closest<SVGElement>("[data-annotation]")?.dataset.annotation;
    const detailTarget = target.closest<SVGElement>("[data-detail]")?.dataset.detail;
    const detailPart =
      target.closest<SVGElement>("[data-detail-part]")?.dataset.detailPart ?? "content";
    if (
      detailTarget &&
      detailPart === "marker" &&
      batchIds.includes(`detail-marker:${detailTarget}`)
    )
      anno = `detail-marker:${detailTarget}`;
    if (
      detailTarget &&
      !anno &&
      (detailPart === "marker" || !(rangeSelection && region && pointInside(p, region.points))) &&
      tool === "select" &&
      e.button === 0 &&
      !spacePan &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      if (
        detailSelection?.id !== detailTarget ||
        (detailPart !== "resize" && detailSelection.part !== detailPart)
      ) {
        if (detailPart === "title") cadEditor.current?.selectHandles([]);
        setSelected("");
        setRegionId("");
        setDetailSelection({ id: detailTarget, part: detailPart });
        return;
      }
      drag.current = {
        start: p,
        mode: "detail",
        detailId: detailTarget,
        detailPart,
        pointerId: e.pointerId,
        button: e.button,
        screenStart: { x: e.clientX, y: e.clientY },
        screenInverse: e.currentTarget.getScreenCTM()!.inverse(),
        unitsPerPixel,
        before: gestureProject,
        points: [p],
        view: { ...displayView },
      };
      if (detailPart === "resize" || detailPart === "content")
        previewCadDetail(gestureProject, detailTarget);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const pointIndex =
      target.dataset.pointIndex === undefined ? undefined : Number(target.dataset.pointIndex);
    const regionPoint =
      target.dataset.regionPoint === undefined ? undefined : Number(target.dataset.regionPoint);
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && tool === "select" && rangeSelection && anno) {
      setRegionId("");
      setSelected(anno);
      return;
    }
    const mode =
      e.button === 1 || secondaryPan || (e.button === 0 && spacePan)
        ? "pan"
        : e.ctrlKey || e.metaKey || tool === "annotations"
          ? "range"
          : tool === "label"
            ? "label"
            : tool === "lasso"
              ? "range"
              : target.dataset.regionMove !== undefined
                ? "region-move"
                : target.dataset.regionHandle !== undefined
                  ? rangeSelection && target.dataset.regionHandle === "ne"
                    ? "content-resize"
                    : "region"
                  : regionPoint !== undefined
                    ? "region"
                    : rangeSelection && region && pointInside(p, region.points)
                      ? "content"
                      : anno
                        ? "annotation"
                        : "range";
    if (mode === "annotation" && anno && anno !== selected && !batchIds.includes(anno)) {
      setSelected(anno);
      return;
    }
    if (mode === "label") {
      if (!label.trim()) return;
      setSelected("");
      setPlacement({ start: placement?.start ?? p, end: p });
    } else if (mode === "range") {
      crossSelection.current = null;
      if (!(e.ctrlKey || e.metaKey)) {
        setSelected("");
        setRegionId("");
        setPreview(null);
        rangePreview.clear();
        if (!(cadVector && tool === "lasso")) setProjects(
          state.current.projects.map((v) =>
            v.projectId === current.projectId
              ? { ...v, regions: savedDrawingRegions(v.regions) }
              : v,
          ),
        );
      }
    } else if (anno && mode !== "pan" && mode !== "content" && !batchIds.includes(anno)) {
      setSelected(anno);
    }
    drag.current = {
      start: p,
      mode,
      pointerId: e.pointerId,
      button: e.button,
      screenStart: { x: e.clientX, y: e.clientY },
      screenInverse: e.currentTarget.getScreenCTM()!.inverse(),
      unitsPerPixel,
      ...(mode === "label"
        ? { secondClick: Boolean(placement), labelStartedAt: performance.now() }
        : {}),
      before: gestureProject,
      ...(mode === "content" || mode === "content-resize"
        ? { transferId: uid(), annotationIds: [...selectedIds] }
        : {}),
      annotationsOnly: mode === "range" && (e.ctrlKey || e.metaKey || tool === "annotations"),
      ...(mode === "annotation" && anno && batchIds.includes(anno)
        ? { annotationIds: [...batchIds] }
        : {}),
      points: [mode === "label" ? (placement?.start ?? p) : p],
      view: { ...(mode === "pan" ? getView() : displayView) },
      ...(anno
        ? { annotationId: anno, translateWhole: target.tagName.toLowerCase() === "polyline" }
        : {}),
      ...(target.dataset.regionHandle ? { handle: target.dataset.regionHandle } : {}),
      ...(pointIndex !== undefined
        ? { pointIndex }
        : regionPoint !== undefined
          ? { pointIndex: regionPoint }
          : {}),
    };
    if (mode === "pan") {
      cadEditor.current?.leave();
      prepareLivePan();
    }
    e.currentTarget.dataset.panning = String(mode === "pan");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  const gesturePreview = useRef<DrawingProject | null>(null);
  const pointerFrame = usePointerFrame(processMove);
  function move(e: ReactPointerEvent<SVGSVGElement>) {
    cadOrthogonal.current = e.shiftKey;
    const cad = cadPointer.current;
    // Selected-object dragging has a distance threshold, not a hold timer.
    // Delay activation (not feedback) so a stationary click keeps normal selection semantics.
    if (cad?.selectionDrag && !cad.directMove && cad.pointerId === e.pointerId &&
        (e.buttons & 1) !== 0 &&
        Math.hypot(e.clientX - cad.screen.x, e.clientY - cad.screen.y) > 4) {
      let started = false;
      // pointermove is a continuous React event: publish the new handler before
      // the first animation frame (or a quick release) can still see select mode.
      // Only activation is synchronous; subsequent samples stay frame-coalesced.
      flushSync(() => { started = cadEditor.current?.beginMove(cad.start, cad.aperture) ?? false; });
      if (started) {
        cad.directMove = true;
        cad.dragToFinish = true;
        cad.pointOnDown = true;
      }
    }
    if (cad?.trimPath && cad.pointerId === e.pointerId && (e.buttons & 1) !== 0 && Math.hypot(e.clientX - cad.screen.x, e.clientY - cad.screen.y) > 6) {
      cad.dragConfirmed = true;
      const p = point(e), last = cad.trimPath.at(-1)!;
      if (Math.hypot(p.x-last.x,p.y-last.y) > cad.aperture / 3 && cad.trimPath.length < 9999) cad.trimPath.push(p);
    }
    // Release coordinates can move before the next pointer sample arrives.
    // Only an observed move after a deliberate hold starts a drag window or
    // a tool's drag-to-second-point gesture. A click must never add a second point.
    // Use event time (not handler time) so a busy frame cannot turn a quick click
    // into a drag. Distance is in CSS screen pixels, independent of CAD zoom.
    if (
      cad &&
      (cad.window || (cad.dragToFinish && !cad.directMove)) &&
      cad.pointerId === e.pointerId &&
      (e.buttons & 1) !== 0 &&
      e.timeStamp - cad.pressedAt >= 120 &&
      Math.hypot(e.clientX - cad.screen.x, e.clientY - cad.screen.y) > 6
    )
      cad.dragConfirmed = true;
    const d = drag.current;
    if (d && d.pointerId !== e.pointerId) return;
    if (d?.mode === "pan" || d?.mode === "range") {
      processMove(e);
      return;
    }
    pointerFrame.schedule({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY });
  }
  function processMove(
    e: Pick<ReactPointerEvent<SVGSVGElement>, "pointerId" | "clientX" | "clientY">,
  ) {
    lastCanvasPointer.current = { x: e.clientX, y: e.clientY };
    if (pastePreview) setPastePreview({ ...pastePreview, screenPoint: lastCanvasPointer.current });
    const d = drag.current;
    if (!current || blockingBusy) return;
    if (!d) {
      const rawCursor = point(e);
      const cursor =
        current.cad?.unified && !cadEditing && !spacePan && (tool === "label" || tool === "detail")
          ? (cadEditor.current?.assistPoint(rawCursor, unitsPerPixel * 7, true) ?? rawCursor)
          : rawCursor;
      if (cadEditing) {
        const active = cadPointer.current;
        if (active?.trimPath && active.dragConfirmed)
          cadEditor.current?.trimStroke(active.trimPath, active.aperture, cadOrthogonal.current, true);
        else if (active?.window && active.dragConfirmed)
          cadEditor.current?.window(active.start, cursor, false, active.aperture, true);
        else cadEditor.current?.hover(cursor, unitsPerPixel * 7, cadOrthogonal.current);
        return;
      }
      if (detailDraft) {
        detailMarksPointer.current?.update(cursor);
        detailImagePointer.current?.update(cursor);
      }
      if (detailPaste) {
        const dx = cursor.x - detailPaste.center.x,
          dy = cursor.y - detailPaste.center.y;
        setDetailPaste({
          ...moveDetail(detailPaste, dx, dy),
          title: { x: detailPaste.title.x + dx, y: detailPaste.title.y + dy },
        });
      }
      if (tool === "label") {
        labelPreviewRef.current?.update(cursor);
      }
      return;
    }
    if (d.pointerId !== e.pointerId) return;
    if (d.mode === "pan") {
      const sx = e.clientX - d.screenStart.x,
        sy = e.clientY - d.screenStart.y;
      // Keep the live gesture on the already-painted scene. Updating React's
      // view on every move redraws CAD fragments and detail layers before the
      // next pointer sample can be painted.
      applyLivePan(sx, sy, d.screenInverse);
      return;
    }
    // Selection panels can still be moving when the next drag starts. Keep
    // object coordinates tied to the captured canvas transform for this gesture.
    const objectDrag = d.mode === "detail" || d.mode === "annotation";
    const p = point(e, objectDrag ? d.screenInverse : undefined),
      dx = p.x - d.start.x,
      dy = p.y - d.start.y;
    if (d.mode === "label") {
      // Use screen pixels so zoom does not change click-jitter tolerance.
      d.moved ||= Math.hypot(e.clientX - d.screenStart.x, e.clientY - d.screenStart.y) >= 15;
      const assisted = current.cad?.unified
        ? (cadEditor.current?.assistPoint(p, unitsPerPixel * 7, true) ?? p)
        : p;
      labelPreviewRef.current?.update(assisted);
      return;
    }
    if (d.mode === "range") {
      d.moved ||= Math.hypot(e.clientX - d.screenStart.x, e.clientY - d.screenStart.y) >= 4;
      if (!d.moved) return;
      if (tool !== "lasso") {
        const selection = rectangleSelection(d.start, p, []);
        d.points = selection.points;
        d.crossing = selection.crossing;
      } else if (
        d.points.length < 4900 &&
        Math.hypot(p.x - (d.points.at(-1) ?? d.start).x, p.y - (d.points.at(-1) ?? d.start).y) >
          view.width / 800
      )
        d.points.push(p);
      rangePreview.update(d.points, Boolean(d.crossing), () => {
        d.crossingAnnotationIds = d.annotationsOnly
          ? selectAnnotationIds(batchMarks, d.points, tool === "lasso" || Boolean(d.crossing))
          : tool !== "lasso"
            ? rectangleSelection(d.start, p, rangeMarks).annotationIds
            : [];
        return d.crossingAnnotationIds;
      });
      return;
    }
    const startingDrag = !d.moved;
    d.moved ||= Math.hypot(e.clientX - d.screenStart.x, e.clientY - d.screenStart.y) >= 4;
    if (!d.moved) return;
    // Keep the text node mounted for stationary clicks and double-clicks.
    // Switch to the isolated drag layer only once the pointer actually moves.
    if (startingDrag && d.mode === "annotation" && d.annotationId && !d.annotationIds)
      flushSync(() => setActiveDraggedLabelId(d.annotationId!));
    // Each gesture starts from its saved snapshot. Keep untouched drawings and
    // arrays shared; copying the entire project on every pointer sample scales
    // with every fragment and detail instead of only the object being moved.
    const edited = { ...d.before };
    d.annotationSet ??= new Set(d.annotationIds);
    const selectedAnnotationIds = d.annotationSet;
    if (d.mode === "detail") {
      edited.detailViews = edited.detailViews?.map((detail) => {
        if (detail.id !== d.detailId) return detail;
        if (d.detailPart === "resize")
          return resizeDetail(
            detail,
            Math.max(
              0.1,
              Math.min(
                100,
                Math.hypot(p.x - detail.center.x, p.y - detail.center.y) / detail.radius,
              ),
            ),
          );
        if (d.detailPart === "marker") {
          const placed = placeLabel(
            detail.source,
            p,
            detail.label,
            detail.fontSize,
            d.unitsPerPixel ?? unitsPerPixel,
          );
          return { ...detail, marker: { x: placed.x, y: placed.y } };
        }
        if (d.detailPart === "title") {
          const part = d.detailPart;
          return { ...detail, [part]: { x: detail[part].x + dx, y: detail[part].y + dy } };
        }
        const moved = moveDetail(detail, dx, dy);
        return current.cad?.unified
          ? { ...moved, title: { x: detail.title.x + dx, y: detail.title.y + dy } }
          : moved;
      });
    } else if (d.mode === "content-resize") {
      const selection = d.before.regions.find((r) => r.id === regionId);
      if (!selection) return;
      const b = bounds(selection.points);
      const anchor = { x: b.x, y: b.y + b.height };
      const vx = b.width,
        vy = -b.height;
      const factor = Math.max(
        0.01,
        Math.min(100, ((p.x - anchor.x) * vx + (p.y - anchor.y) * vy) / (vx * vx + vy * vy)),
      );
      const transform = (q: DrawingPoint) => scalePoint(q, anchor, factor);
      d.baseTransfer ??= {
        remaining: deleteBase(d.before, selection.points),
        selected: extractBase(d.before, selection.points),
      };
      edited.baseFragments = [
        ...d.baseTransfer.remaining,
        ...d.baseTransfer.selected.map((f, i) => ({
          ...f,
          id: `${d.transferId!}-${i}`,
          offset: transform(f.offset),
          scale: (f.scale ?? 1) * factor,
        })),
      ];
      edited.annotations = edited.annotations.map((a) =>
        selectedAnnotationIds.has(a.id)
          ? {
              ...a,
              ...transform(a),
              points: a.points.map(transform),
              fontSize: a.fontSize * factor,
              lineWidth: a.lineWidth * factor,
            }
          : a,
      );
      d.detailParts ??= new Map(
        (d.before.detailViews ?? []).map((detail) => [
          detail.id,
          selectedDetailParts(detail, selection.points),
        ]),
      );
      edited.detailViews = edited.detailViews?.map((detail) => {
        const ids = d.detailParts!.get(detail.id)!;
        const source = ids.has(`detail-source:${detail.id}`);
        const content = ids.has(`detail-content:${detail.id}`);
        const marker = ids.has(`detail-marker:${detail.id}`);
        const title = ids.has(`detail-title:${detail.id}`);
        return {
          ...detail,
          ...(source
            ? {
                source: transform(detail.source),
                radius: detail.radius * factor,
                fragments: detail.fragments.map((f) => ({
                  ...f,
                  offset: transform(f.offset),
                  scale: (f.scale ?? 1) * factor,
                })),
              }
            : {}),
          ratio: (detail.ratio * (content ? factor : 1)) / (source ? factor : 1),
          ...(content ? { center: transform(detail.center) } : {}),
          ...(marker ? { marker: transform(detail.marker) } : {}),
          ...(title ? { title: transform(detail.title) } : {}),
          ...(marker || title
            ? { fontSize: detail.fontSize * factor, lineWidth: detail.lineWidth * factor }
            : {}),
        };
      });
      edited.regions = edited.regions.map((r) =>
        r.id === regionId
          ? {
              ...r,
              points: r.points.map(transform),
              output: { ...drawingOutput(r), mode: "drawing" },
            }
          : r,
      );
      d.validate ??= createDrawingGestureValidator(d.before);
      if (!d.validate(edited)) return;
    } else if (d.mode === "content") {
      const selection = d.before.regions.find((r) => r.id === regionId);
      if (!selection) return;
      d.baseTransfer ??= {
        remaining: deleteBase(d.before, selection.points),
        selected: extractBase(d.before, selection.points),
      };
      edited.baseFragments = [
        ...d.baseTransfer.remaining,
        ...translateFragments(d.baseTransfer.selected, dx, dy, d.transferId!),
      ];
      d.detailParts ??= new Map(
        (d.before.detailViews ?? []).map((detail) => [
          detail.id,
          selectedDetailParts(detail, selection.points),
        ]),
      );
      edited.detailViews = edited.detailViews?.map((detail) =>
        moveDetailParts(detail, d.detailParts!.get(detail.id)!, dx, dy),
      );
      edited.annotations = edited.annotations.map((a) =>
        selectedAnnotationIds.has(a.id) ? translateAnnotation(a, dx, dy) : a,
      );
      edited.regions = edited.regions.map((r) =>
        r.id === regionId ? { ...r, points: translatePolygon(r.points, dx, dy) } : r,
      );
      d.validate ??= createDrawingGestureValidator(d.before);
      if (!d.validate(edited)) {
        setFailure("图纸编辑数量或范围已达上限。");
        return;
      }
    } else if (d.mode === "annotation") {
      if (d.annotationIds) {
        edited.detailViews = edited.detailViews?.map((detail) =>
          moveDetailParts(detail, selectedAnnotationIds, dx, dy),
        );
        edited.annotations = edited.annotations.map((a) =>
          selectedAnnotationIds.has(a.id) ? translateAnnotation(a, dx, dy) : a,
        );
      } else {
        edited.annotations = d.before.annotations.map((a) =>
          a.id === d.annotationId ? { ...a, points: [...a.points] } : a,
        );
        const a = edited.annotations.find((a) => a.id === d.annotationId)!;
        if (d.translateWhole) {
          const placed = placeLabel(
            a.points[0] ?? a,
            p,
            a.text,
            a.fontSize,
            d.unitsPerPixel ?? unitsPerPixel,
          );
          Object.assign(a, translateAnnotation(a, placed.x - a.x, placed.y - a.y));
        } else if (d.pointIndex !== undefined && d.pointIndex !== a.points.length - 1)
          a.points[d.pointIndex] = p;
        else {
          const placed = placeLabel(
            a.points[0] ?? a,
            p,
            a.text,
            a.fontSize,
            d.unitsPerPixel ?? unitsPerPixel,
          );
          Object.assign(a, moveAnnotation(a, placed.x - a.x, placed.y - a.y));
        }
        if (d.translateWhole || d.pointIndex === undefined || d.pointIndex === a.points.length - 1) {
          const aligned = snapLabelToAnnotations(
            a,
            d.labelReferences ??= d.before.annotations.filter((reference) => reference.id !== a.id),
            (d.unitsPerPixel ?? unitsPerPixel) * 8,
          );
          Object.assign(a, aligned.label);
          labelDragPreviewRef.current?.update(a, aligned.guides);
        } else {
          labelDragPreviewRef.current?.update(a, []);
        }
      }
    } else {
      edited.regions = d.before.regions.map((r) =>
        r.id === regionId ? { ...r, points: [...r.points] } : r,
      );
      const r = edited.regions.find((r) => r.id === regionId);
      if (!r) return;
      if (d.mode === "region-move") r.points = r.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      else if (d.handle) r.points = resizeRectangle(r.points, d.handle, p);
      else r.points[d.pointIndex!] = p;
    }
    gesturePreview.current = edited;
    if (d.mode === "annotation" && !d.annotationIds) return;
    setProjects(projects.map((v) => (v.projectId === edited.projectId ? edited : v)));
  }
  function up(e: ReactPointerEvent<SVGSVGElement>, releasedButton = e.button) {
    const cad = cadPointer.current;
    if (cad && cad.pointerId === e.pointerId && releasedButton === 0) {
      cadPointer.current = null;
      pointerFrame.cancel();
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      if (blockingBusy || !cadEditing) return;
      const end = point(e);
      const moved = Math.hypot(e.clientX - cad.screen.x, e.clientY - cad.screen.y) > 4;
      if (cad.selectionDrag) {
        if (cad.directMove) {
          if (moved) cadEditor.current?.endMove(end, cad.aperture, e.shiftKey);
          else cadEditor.current?.cancel();
        } else cadEditor.current?.click(cad.start, e.shiftKey, cad.aperture, e.shiftKey);
        return;
      }
      if (cadEditor.current?.pointUp(end,cad.aperture,moved)) return;
      if (cad.trimPath) {
        if (cad.dragConfirmed && moved) cadEditor.current?.trimStroke([...cad.trimPath, end], cad.aperture, e.shiftKey, false);
        else cadEditor.current?.click(cad.start, e.shiftKey, cad.aperture, e.shiftKey);
        return;
      }
      if (cad.grip && !moved) return;
      if (cad.pointOnDown) {
        if (cad.dragToFinish && moved && (cad.directMove || cad.dragConfirmed)) {
          if (cad.directMove) cadEditor.current?.endMove(end, cad.aperture, e.shiftKey);
          else cadEditor.current?.click(end, e.shiftKey, cad.aperture, e.shiftKey);
        }
        else if (cad.directMove) cadEditor.current?.finish();
        return;
      }
      if (cad.window && cad.dragConfirmed && moved)
        cadEditor.current?.window(cad.start, end, e.shiftKey, cad.aperture, false);
      else
        cadEditor.current?.click(
          cad.window ? cad.start : end,
          e.shiftKey,
          cad.aperture,
          e.shiftKey,
        );
      return;
    }
    const d = drag.current;
    if (!d || !current || d.pointerId !== e.pointerId || d.button !== releasedButton) return;
    if (!["pan", "range", "label"].includes(d.mode))
      pointerFrame.flush({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY });
    else pointerFrame.cancel();
    const finalProject = gesturePreview.current ?? current;
    gesturePreview.current = null;
    if (d.mode === "pan") {
      const screenX = e.clientX - d.screenStart.x;
      const screenY = e.clientY - d.screenStart.y;
      const nextView = panViewByScreenDelta(d.view, d.screenInverse, screenX, screenY);
      drag.current = null;
      if (Math.hypot(screenX, screenY) < 1) clearLivePan();
      else {
        // Commit the SVG camera and remove its temporary scene translation in
        // one event. The preview image keeps its compositor translation until
        // React publishes the matching camera, so release never jumps back.
        e.currentTarget.setAttribute(
          "viewBox",
          `${nextView.x} ${nextView.y} ${nextView.width} ${nextView.height}`,
        );
        e.currentTarget.style.transform = "";
        livePanTargets.current = null;
        startTransition(() => {
          setView(nextView);
          panPreview.current?.settle(nextView);
        });
      }
    }
    drag.current = null;
    e.currentTarget.dataset.panning = "false";
    setActiveDraggedLabelId("");
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (
      d.mode === "pan" &&
      d.button === 2 &&
      Math.hypot(e.clientX - d.screenStart.x, e.clientY - d.screenStart.y) < 3
    ) {
      // Secondary-button dragging pans; a stationary click follows command state.
      canvasContextAction();
    }
    if (d.mode === "label") {
      if (current.annotations.length >= 5000) {
        setPlacement(null);
        setFailure("标号数量已达上限，无法继续添加。");
        return;
      }
      const rawEnd = point(e);
      const end = current.cad?.unified
        ? (cadEditor.current?.assistPoint(rawEnd, unitsPerPixel * 7, false) ?? rawEnd)
        : rawEnd;
      if (
        d.secondClick ||
        (performance.now() - (d.labelStartedAt ?? performance.now()) >= 200 &&
          (d.moved || Math.hypot(e.clientX - d.screenStart.x, e.clientY - d.screenStart.y) >= 15))
      ) {
        const a = makeLabel(d.points[0]!, end);
        const next = current.repeatLabel ? a.text : incrementLabel(a.text);
        commit({ ...current, annotations: [...current.annotations, a], nextLabel: next });
        const number = Number(a.text);
        const patent = patents.getReferenceMarkPatentSnapshot?.(session.patentId) ?? state.current.session.patent;
        if (!imageDrawing && /^\d+$/u.test(a.text) && Number.isSafeInteger(number) && number > 0 &&
          !patent.referenceMarks.some(mark => mark.number === number)) {
          setKeywordPrompt({ projectId: current.projectId, annotationId: a.id });
        }
        setSelected("");
        setLabel(next);
        setHasPlacedLabel(true);
        setLabelFocusTick((v) => v + 1);
        setPlacement(null);
      } else setPlacement({ start: d.points[0]!, end });
    } else if (d.mode === "range") {
      if (!d.moved) {
        if (tool === "lasso" && cadVector) {
          cadEditor.current?.click(point(e), e.shiftKey, unitsPerPixel * 7, e.shiftKey);
          setTool("select");
        } else if (!imageDrawing && !cadVector && tool === "select" && current?.cad?.unified &&
          !d.annotationsOnly) {
          cadEditor.current?.click(point(e), e.shiftKey, unitsPerPixel * 7, e.shiftKey);
        }
        rangePreview.clear();
        return;
      }
      if (tool === "lasso" && cadVector) {
        // A quick drag may yield only one move sample. Treat that as a window
        // selection instead of sending a degenerate two-point polygon.
        const polygon = d.points.length < 3
          ? rectangleSelection(d.start, point(e), []).points
          : d.points;
        cadEditor.current?.selectPolygon(polygon, e.shiftKey);
        setTool("select");
        rangePreview.clear();
        return;
      }
      if (d.annotationsOnly) {
        if (tool !== "lasso") d.points = rectangleSelection(d.start, point(e), []).points;
        setSelectedId("");
        setDetailSelection(null);
        setRangeSelection(false);
        setBatchIds(
          selectAnnotationIds(batchMarks, d.points, tool === "lasso" || Boolean(d.crossing)),
        );
        setTool("select");
        rangePreview.clear();
        return;
      }
      try {
        if (tool !== "lasso") d.points = rectangleSelection(d.start, point(e), rangeMarks).points;
        bounds(d.points);
        const id = uid();
        const next: DrawingRegion = {
          output: defaultDrawingOutput(),
          id,
          name: "临时取图",
          kind: tool === "lasso" ? "lasso" : "rectangle",
          points: d.points,
        };
        commit({
          ...current,
          regions: current.regions.some((r) => r.id === id)
            ? current.regions.map((r) => (r.id === id ? next : r))
            : [...savedDrawingRegions(current.regions), next],
        });
        setRegionId(id);
        setSelectedId("");
        setRangeSelection(true);
        setTool("select");
      } catch (e) {
        status(e);
      }
      rangePreview.clear();
    } else if (d.mode !== "pan" && d.moved && !drawingEditEqual(finalProject, d.before)) {
      histories.record(d.before);
      commit(finalProject, false);
      setHistoryTick((v) => v + 1);
    } else if (d.mode === "detail") setDetailGesture(null);
  }
  function detailMarkerPosition(pointer: DrawingPoint): DrawingPoint {
    const placed = placeLabel(
      detailDraft?.source ?? pointer,
      pointer,
      detailLabel.trim(),
      fontSize,
      unitsPerPixel,
    );
    return { x: placed.x, y: placed.y };
  }
  function makeLabel(start: DrawingPoint, end: DrawingPoint): DrawingAnnotation {
    const placed = snapLabelToAnnotations(
      placeLabel(start, end, label.trim(), placementStyle.fontSize, unitsPerPixel),
      current?.annotations ?? [],
      unitsPerPixel * 8,
    ).label;
    return {
      ...placed,
      id: uid(),
      text: label.trim(),
      fontSize,
      lineWidth: storedAnnotationLineWidth(annotationScale),
    };
  }
  function canvasContextAction() {
    if (busy) return;
    const placementPending = Boolean(detailPaste || pastePreview);
    cancelGesture();
    if (cadEditing && !placementPending) {
      if (!cadEditor.current?.rightClick()) return;
    } else setTool("select");
    svgRef.current?.focus({ preventScroll: true });
  }
  // A dismissed control can leave focus on body. Keep Escape available without
  // taking keyboard input away from another editor, a menu, or a modal dialog.
  useEffect(() => {
    if (!active || !cadEditing) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || event.defaultPrevented ||
        ignoreApplicationKeyEvent(event) || event.target !== document.body ||
        hasVisibleElement('[role="dialog"][aria-modal="true"], [role="menu"]')
      ) return;
      event.preventDefault();
      cadEditor.current?.cancel();
      cancelGesture();
      svgRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  function cancelGesture(dismissKeyword = true) {
    if (dismissKeyword) setKeywordPrompt(null);
    toolActivationEpoch.current++;
    const cad = cadPointer.current;
    cadPointer.current = null;
    cadPreview.current?.update(null);
    if (cad && svgRef.current?.hasPointerCapture(cad.pointerId))
      svgRef.current.releasePointerCapture(cad.pointerId);
    pointerFrame.cancel();
    gesturePreview.current = null;
    setDetailDraft(null);
    setDetailPaste(null);
    setLocatedRegionId("");
    setPastePreview(null);
    const d = drag.current;
    drag.current = null;
    clearLivePan();
    if (svgRef.current) svgRef.current.dataset.panning = "false";
    setActiveDraggedLabelId("");
    if (d) {
      setDetailGesture(null);
      if (
        !(d.mode === "annotation" && !d.annotationIds) &&
        ["detail", "annotation", "region", "region-move", "content-resize", "content"].includes(d.mode)
      )
        setProjects(projects.map((p) => (p.projectId === d.before.projectId ? d.before : p)));
      if (svgRef.current?.hasPointerCapture(d.pointerId))
        svgRef.current.releasePointerCapture(d.pointerId);
    }
    setPlacement(null);
    rangePreview.clear();
  }
  function registerReferenceMark(entry: { number: number; keyword: string }) {
    const patent = patents.getReferenceMarkPatentSnapshot?.(session.patentId) ?? state.current.session.patent;
    const result = planRegisterReferenceMark(patent, entry);
    if (!result.ok) return { ok: false, message: result.message };
    return patents.applyReferenceMarkPlan(session.patentId, "description-drawings", result.plan)
      ? { ok: true, message: result.plan.message }
      : { ok: false, message: "当前专利状态已变化，请重试。" };
  }
  function locatePublishedRegion(target: DrawingRegion & { projectId: string }) {
    if (busy) return;
    cancelGesture();
    setSelected("");
    setInlineId("");
    setRegionId("");
    setPreview(null);
    setPreviewMode(false);
    setTool("select");
    if (target.projectId !== activeId) {
      activate(target.projectId);
      pendingLocation.current = target;
      setLocatedRegionId(target.id);
      return;
    }
    setLocatedRegionId(target.id);
    const viewport = svgRef.current?.getBoundingClientRect();
    if (viewport) setView((v) => locateRegionView(v, viewport, target.points, !imageDrawing));
  }
  function updateDetail(patch: Partial<DrawingDetailView>): boolean {
    const project = state.current.projects.find((p) => p.projectId === activeId);
    const detail = project?.detailViews?.find((d) => d.id === selectedDetail?.id);
    if (!project || !detail) return false;
    if (
      patch.label &&
      project.detailViews?.some((d) => d.id !== detail.id && d.label === patch.label)
    ) {
      setFailure("该字母已被使用。");
      return false;
    }
    const next = {
      ...project,
      detailViews: project.detailViews?.map((d) =>
        d.id === detail.id
          ? { ...(patch.ratio === undefined ? d : resizeDetail(d, patch.ratio)), ...patch }
          : d,
      ),
    };
    if (patch.ratio !== undefined && patch.ratio !== detail.ratio)
      previewCadDetail(project, detail.id);
    commit(next);
    setFailure("");
    return true;
  }
  function deleteDetail() {
    if (!current || !selectedDetail) return;
    commit({
      ...current,
      detailViews:
        detailSelection?.part === "title" || detailSelection?.part === "marker"
          ? current.detailViews?.map((d) =>
              d.id === selectedDetail.id
                ? { ...d, ...(detailSelection.part === "title" ? { titleHidden: true } : { markerHidden: true }) }
                : d,
            )
          : current.detailViews?.filter((d) => d.id !== selectedDetail.id),
    });
    setDetailSelection(null);
  }
  function changeAnnotation(patch: Partial<DrawingAnnotation>) {
    if (current && annotation)
      commit({
        ...current,
        annotations: current.annotations.map((a) =>
          a.id === annotation.id ? { ...a, ...patch } : a,
        ),
      });
  }
  function alignBatch(axis: "horizontal" | "vertical") {
    if (!current || busy || alignableCount < 2 || crossSelection.current) return;
    const cadFigure = current.cad?.unified
      ? (() => {
          const scene = liveWorkingScene?.scene ?? checkpointScene;
          if (!scene || scene.partial) return null;
          const labels = new Set((liveWorkingScene?.objects ?? cadSelection?.objects ?? current.cad.objects ?? [])
            .filter((object) => object.kind === "label").flatMap((object) => object.label ?? []));
          return cadFigureBounds(scene, current.cad.mapping, labels);
        })()
      : null;
    const imageFigure = rasterFigure?.key === `${current.projectId}:${base?.url}`
      ? rasterFigureBounds(current, rasterFigure.bounds) : null;
    const figure = cadFigure && imageFigure
      ? { left: Math.min(cadFigure.left, imageFigure.left), top: Math.min(cadFigure.top, imageFigure.top),
          right: Math.max(cadFigure.right, imageFigure.right), bottom: Math.max(cadFigure.bottom, imageFigure.bottom) }
      : cadFigure ?? imageFigure;
    if (!figure) {
      setFailure(rasterFigure?.key === `${current.projectId}:${base?.url}`
        ? "图纸中未识别到可见图形，无法安全整理标号。"
        : "图形范围尚未准备好，无法安全整理标号；请等待图纸加载完成后重试。");
      return;
    }
    const aligned = alignSelectedAnnotations(current.annotations, selectedIds, axis, current.cad?.unified
      ? { left: displayView.x, top: displayView.y, right: displayView.x + displayView.width, bottom: displayView.y + displayView.height }
      : { left: 0, top: 0, right: current.width, bottom: current.height }, { figure });
    if (!aligned) {
      setFailure(
        `当前范围无法等距排列：空间不足，或引线会交叉、标号会重叠。请调整标号位置或字号后重试。`,
      );
      return;
    }
    if (aligned === current.annotations) return;
    commit({ ...current, annotations: [...aligned] });
    setFailure("");
    setMessage(`已将 ${alignableCount} 个标号${axis === "horizontal" ? "水平" : "竖向"}等距排列。`);
  }
  async function refreshDetailFromSource() {
    if (!current?.cad?.unified || !selectedDetail || busy) return;
    if (
      !(await confirmAppAction(
        "用当前来源图形更新此详图？这会替换详图内部的单独修改，可通过撤销恢复。",
      ))
    )
      return;
    const detail = createDetailView(
      current,
      selectedDetail.source,
      selectedDetail.radius,
      selectedDetail.center,
      selectedDetail.label,
      selectedDetail.ratio,
      selectedDetail.fontSize,
      selectedDetail.lineWidth,
      selectedDetail.id,
    );
    const updated = {
      ...detail,
      title: selectedDetail.title,
      marker: selectedDetail.marker,
      markerHidden: selectedDetail.markerHidden,
      titleHidden: selectedDetail.titleHidden,
    };
    commit({
      ...current,
      detailViews: current.detailViews?.map((d) => (d.id === detail.id ? updated : d)),
      cad: {
        ...current.cad,
        objects: current.cad.objects?.map((o) => {
          if (o.id !== detail.id) return o;
          const { body: _body, ...rest } = o;
          return rest;
        }),
      },
    });
  }
  function changeSize(value: number) {
    if (selectedDetail && current) {
      const next = {
        ...current,
        detailViews: current.detailViews?.map((d) =>
          d.id === selectedDetail.id ? { ...d, fontSize: value } : d,
        ),
      };
      if (sizeGesture.current)
        setProjects(projects.map((p) => (p.projectId === next.projectId ? next : p)));
      else commit(next);
      return;
    }
    const project = state.current.projects.find((p) => p.projectId === activeId);
    if (!project) return;
    if (!selectedIds.size && (!region || output.mode === "drawing")) setFontSize(value);
    const next =
      region && output.mode === "uniform"
        ? {
            ...project,
            regions: project.regions.map((r) =>
              r.id === region.id ? { ...r, output: { ...output, labelHeightMm: value } } : r,
            ),
          }
        : selectedIds.size
          ? {
              ...project,
              detailViews: project.detailViews?.map((d) =>
                selectedIds.has(`detail-marker:${d.id}`) ? { ...d, fontSize: value } : d,
              ),
              annotations: project.annotations.map((a) =>
                selectedIds.has(a.id) ? { ...a, fontSize: value } : a,
              ),
            }
          : null;
    if (!next) return;
    if (sizeGesture.current)
      setProjects(projects.map((p) => (p.projectId === next.projectId ? next : p)));
    else commit(next);
  }
  function finishSize() {
    const before = sizeGesture.current;
    sizeGesture.current = null;
    const latest = state.current.projects.find((p) => p.projectId === before?.projectId);
    if (before && latest && !drawingEditEqual(before, latest)) {
      histories.record(before);
      commit(latest, false);
      setHistoryTick((v) => v + 1);
    }
  }
  finishSizeRef.current = finishSize;
  async function changeAutoAdjustLabelSize(enabled: boolean) {
    if (busy || !styleReady) return;
    setSavingExportSettings(true);
    setFailure("");
    try {
      const result = await window.patentApi.settings.update({
        drawingAutoAdjustLabelSize: enabled,
      });
      if (!result.ok) throw new Error(result.error.message);
      setAutoAdjustLabelSize(result.value.drawingAutoAdjustLabelSize);
      setPreview(null);
      setPreviewMode(false);
    } catch (error) {
      status(error);
    } finally {
      setSavingExportSettings(false);
    }
  }
  async function saveAutoLabelScale() {
    if (savingExportSettings || savedAutoLabelScale.current === autoLabelScale) return;
    setSavingExportSettings(true);
    setFailure("");
    try {
      const result = await window.patentApi.settings.update({
        drawingAutoLabelScale: autoLabelScale,
      });
      if (!result.ok) throw new Error(result.error.message);
      savedAutoLabelScale.current = autoLabelScale;
      setPreview(null);
      setPreviewMode(false);
    } catch (error) {
      setAutoLabelScale(savedAutoLabelScale.current);
      status(error);
    } finally {
      setSavingExportSettings(false);
    }
  }
  function liveRenderTarget(requestedProject: DrawingProject, requestedRegion: DrawingRegion) {
    const latest = state.current.current;
    if (!latest || latest.projectId !== requestedProject.projectId ||
      latest.baseAssetId !== base?.assetId)
      throw new Error("图纸已切换，请重新选择后预览。");
    if (requestedRegion.cadHandles) {
      const selection = cadSelectionLatest.current;
      if (!latest.cad || !selection ||
        (selection.checkpointId && selection.checkpointId !== latest.cad.assetId))
        throw new Error("CAD选区已发生变化，请重新选择后预览。");
      const fresh = cadFigureSelection(latest, selection)?.region;
      if (!fresh || JSON.stringify(fresh.cadHandles) !== JSON.stringify(requestedRegion.cadHandles))
        throw new Error("CAD选区已发生变化，请重新选择后预览。");
      return { project: latest, region: fresh, sceneRevision: selection.scene.revision };
    }
    const fresh = latest.regions.find((item) => item.id === requestedRegion.id &&
      !item.figureId && !item.bodyNodeId);
    if (!fresh || state.current.regionId !== requestedRegion.id)
      throw new Error("取图范围已发生变化，请重新选择后预览。");
    return { project: latest, region: fresh, sceneRevision: undefined };
  }
  function verifyRenderTarget(target: ReturnType<typeof liveRenderTarget>, requireSelection = true) {
    if (!requireSelection && target.region.cadHandles) {
      const latest = state.current.current;
      const scene = cadSelectionLatest.current?.scene;
      if (!latest || latest.projectId !== target.project.projectId ||
        latest.baseAssetId !== base?.assetId || latest.revision !== target.project.revision ||
        latest.cad?.assetId !== target.project.cad?.assetId ||
        (scene && scene.revision !== target.sceneRevision))
        throw new Error("图纸已发生变化，请重新预览或插入。");
      return;
    }
    const latest = liveRenderTarget(target.project, target.region);
    if (latest.project.revision !== target.project.revision ||
      latest.project.cad?.assetId !== target.project.cad?.assetId ||
      latest.sceneRevision !== target.sceneRevision ||
      JSON.stringify(latest.region.points) !== JSON.stringify(target.region.points))
      throw new Error("图纸或选区已发生变化，请重新预览或插入。");
  }
  function clearOutputSelection(target: ReturnType<typeof liveRenderTarget>) {
    if (!target.region.cadHandles || state.current.current?.projectId !== target.project.projectId) return;
    cadEditor.current?.selectHandles([]);
    setSelected("");
    setBatchIds([]);
    setDetailSelection(null);
    setRangeSelection(false);
    crossSelection.current = null;
    rangePreview.clear();
  }
  async function makePreview() {
    if (!current || !region || !base || busy || !styleReady) return;
    if (!(await guard())) return;
    // Keep keyboard recovery available when the initiating toolbar button becomes disabled.
    svgRef.current?.focus({ preventScroll: true });
    setBusy(true);
    setFailure("");
    try {
      const target = liveRenderTarget(current, region);
      const targetOutput = drawingOutput(target.region);
      const drawingPage = session.patent.books.find((book) => book.kind === "description-drawings")!
        .document.page;
      const pageKey = JSON.stringify(drawingPage);
      const source = await preparedRenderSource(target.project, base, autoAdjustLabelSize, target.region);
      const rendered = await renderDrawing(
        source.project,
        target.region,
        source.bytes,
        source.mediaType,
        targetOutput.widthMm,
        targetOutput.dpi,
        {
          autoAdjustLabelSize,
          nativeLabelsRemoved: source.nativeLabelsRemoved,
          labelFreeCadOverlay: source.labelFreeCadOverlay,
          autoLabelScale,
          tiled: base.tiled,
          readCadDetail,
          fitToPage: drawingPage,
        },
      );
      verifyRenderTarget(target);
      previewTarget.current = target;
      setPreview({
        ...rendered,
        pageKey,
        url: imageUrl(rendered.bytes, "image/jpeg"),
        revision: target.project.revision,
        regionId: target.region.id,
      });
      setPreviewMode(true);
      clearOutputSelection(target);
      setMessage("请检查取图范围和标号，再导出或插入。");
    } catch (e) {
      status(e);
    } finally {
      setBusy(false);
    }
  }
  function openReplacement() {
    if (!current || !region || !base || busy || !styleReady) return;
    replacementSource.current = {
      project: structuredClone(current),
      region: structuredClone(region),
      base,
      sessionId: session.sessionId,
      dpi,
      autoAdjustLabelSize,
      autoLabelScale,
    };
    setFailure("");
    setReplaceOpen(true);
  }
  function validateReplacementSource() {
    const source = replacementSource.current;
    const latest =
      source && state.current.projects.find((p) => p.projectId === source.project.projectId);
    const latestRegion = latest?.regions.find((r) => r.id === source?.region.id);
    if (
      !source ||
      !state.current.active ||
      state.current.session.sessionId !== source.sessionId ||
      state.current.current?.projectId !== source.project.projectId ||
      (source.region.cadHandles
        ? !latest || !cadSelectionLatest.current ||
          JSON.stringify(cadFigureSelection(latest, cadSelectionLatest.current)?.region.cadHandles) !==
            JSON.stringify(source.region.cadHandles)
        : state.current.regionId !== source.region.id) ||
      latest?.revision !== source.project.revision ||
      (!source.region.cadHandles && JSON.stringify(latestRegion) !== JSON.stringify(source.region))
    )
      throw new Error("CAD选区已发生变化，请关闭弹窗后重新选择。");
    return source;
  }
  async function makeReplacementPreview(width: number): Promise<DrawingReplacementPreview> {
    const source = validateReplacementSource();
    const drawingPage = state.current.session.patent.books.find((book) => book.kind === "description-drawings")!
      .document.page;
    const ready = await preparedRenderSource(source.project, source.base, source.autoAdjustLabelSize, source.region);
    const rendered = await renderDrawing(
      ready.project,
      source.region,
      ready.bytes,
      ready.mediaType,
      width,
      source.dpi,
      {
        autoAdjustLabelSize: source.autoAdjustLabelSize,
        nativeLabelsRemoved: ready.nativeLabelsRemoved,
        labelFreeCadOverlay: ready.labelFreeCadOverlay,
        autoLabelScale: source.autoLabelScale,
        tiled: source.base.tiled,
        readCadDetail,
        fitToPage: drawingPage,
      },
    );
    return {
      ...rendered,
      widthMm: Math.min(rendered.widthMm, insertedFigureWidthMm(drawingPage,
        { widthPx: rendered.width, heightPx: rendered.height })),
    };
  }
  async function preparedRenderSource(
    project: DrawingProject,
    source: NonNullable<typeof base>,
    autoAdjust = false,
    selectedRegion?: DrawingRegion,
  ): Promise<{ project: DrawingProject; bytes: Uint8Array; mediaType: string;
    nativeLabelsRemoved: boolean; labelFreeCadOverlay?: Uint8Array }> {
    if (saveQueue.current && !(await saveQueue.current.flush()))
      throw new Error("图纸尚未保存成功，请重试。");
    const ready = (await checkpoints().resolve(project)).project;
    if (selectedRegion?.cadHandles?.length && ready.cad) {
      const selected = new Set(selectedRegion.cadHandles);
      const selectedLabels = (ready.cad.objects ?? []).filter((object) =>
        object.kind === "label" && object.label?.some((handle) => selected.has(handle)));
      const labelIds = new Set(selectedLabels.map((object) => object.id));
      if (selectedLabels.some((object) =>
        !object.label?.every((handle) => selected.has(handle)) ||
        !ready.annotations.some((annotation) => annotation.id === object.id)))
        throw new Error("CAD 标号绑定已变化，请重新选择后取图。");
      const labelHandles = selectedLabels.flatMap((object) => object.label ?? []);
      const svg = await compositionClient().request<string>(
        "renderLabelFree", ready, await readCadDetail(ready.cad.assetId),
        labelHandles, selectedRegion.cadHandles,
      );
      return {
        project: {
          ...ready,
          sourceKind: "dxf",
          annotations: ready.annotations.filter((annotation) => labelIds.has(annotation.id)),
          detailViews: [],
          baseFragments: undefined,
          cad: { ...ready.cad, overlayAssetId: undefined, backgroundSize: undefined },
        },
        bytes: new TextEncoder().encode(svg),
        mediaType: "image/svg+xml",
        nativeLabelsRemoved: true,
      };
    }
    const original = {
      project: ready,
      bytes:
        ready.baseAssetId === source.assetId
          ? source.bytes
          : await readCadDetail(ready.baseAssetId),
      mediaType: ready.baseAssetId === source.assetId ? source.mediaType : "image/svg+xml",
    };
    if (!autoAdjust || !ready.cad) return { ...original, nativeLabelsRemoved: false };
    const handles = [...nativeCadLabelHandleSet(ready)];
    if (!handles.length) return { ...original, nativeLabelsRemoved: false };
    const svg = await compositionClient().request<string>(
      "renderLabelFree", ready, await readCadDetail(ready.cad.assetId), handles,
    );
    const labelFree = new TextEncoder().encode(svg);
    return ready.cad.overlayAssetId
      ? { ...original, nativeLabelsRemoved: true, labelFreeCadOverlay: labelFree }
      : { ...original, bytes: labelFree, mediaType: "image/svg+xml", nativeLabelsRemoved: true };
  }
  async function deliver(
    mode: "save" | "insert" | "replace",
    direct = false,
    replacement?: { target: PatentFigure; preview: DrawingReplacementPreview },
  ) {
    const outputRegion = direct ? region : previewTarget.current?.region;
    if (replacement) {
      validateReplacementSource();
      planDrawingReplacement(state.current.session.patent.figures, replacement.target, "preview");
    }
    if (
      !current ||
      !outputRegion ||
      !base ||
      busy ||
      !styleReady ||
      delivering.current ||
      (mode !== "save" && !session.patent.drawingBooksEnabled) ||
      (!direct &&
        (!preview || preview.revision !== current.revision || preview.regionId !== outputRegion.id))
    ) {
      if (replacement) throw new Error("当前图纸尚未就绪，请关闭弹窗后重试。");
      return;
    }
    // Claim the operation before the asynchronous save/flush guard. Two rapid
    // clicks must not both pass the idle check and publish duplicate figures.
    delivering.current = true;
    let stagedId: string | undefined;
    const operationId = uid();
    try {
      if (!(await guard())) return;
      const target = direct ? liveRenderTarget(current, outputRegion) : previewTarget.current!;
      const verifyTarget = () => verifyRenderTarget(target, direct);
      verifyTarget();
      if (!direct && (preview?.revision !== target.project.revision ||
        preview.regionId !== target.region.id))
        throw new Error("图纸已发生变化，请重新预览后插入。");
      if (direct && !replacement) svgRef.current?.focus({ preventScroll: true });
      setBusy(true);
      setFailure("");
      setInsertFeedback(null);
      const drawingPage = session.patent.books.find((book) => book.kind === "description-drawings")!
        .document.page;
      const pageKey = direct ? JSON.stringify(drawingPage) : preview!.pageKey;
      const requireCurrentPage = () => {
        if (mode !== "insert") return;
        const latestPage = state.current.session.patent.books.find(
          (book) => book.kind === "description-drawings",
        )!.document.page;
        if (pageKey !== JSON.stringify(latestPage))
          throw new Error("附图页面设置已变化，请重新预览或插入。");
      };
      let rendered = replacement?.preview ?? preview;
      if (direct && !replacement) {
        const targetOutput = drawingOutput(target.region);
        const source = await preparedRenderSource(target.project, base, autoAdjustLabelSize, target.region);
        rendered = await renderDrawing(
          source.project,
          target.region,
          source.bytes,
          source.mediaType,
          targetOutput.widthMm,
          targetOutput.dpi,
          {
            autoAdjustLabelSize,
            nativeLabelsRemoved: source.nativeLabelsRemoved,
            labelFreeCadOverlay: source.labelFreeCadOverlay,
            autoLabelScale,
            tiled: base.tiled,
            readCadDetail,
            fitToPage: drawingPage,
          },
        );
      }
      if (!rendered) return;
      verifyTarget();
      requireCurrentPage();
      const importedBatch = await window.patentApi.assets.importMany({
        sessionId: session.sessionId,
        operationId,
        images: [
          {
            originalName: "图纸.jpg",
            declaredMediaType: "image/jpeg",
            bytes: Uint8Array.from(rendered.bytes),
          },
        ],
      });
      if (!importedBatch.ok) throw new Error(importedBatch.error.message);
      const imported = { ok: true as const, value: importedBatch.value[0]! };
      stagedId = imported.value.descriptor.assetId;
      if (mode === "save") {
        verifyTarget();
        const result = await window.patentApi.assets.saveImage({
          sessionId: session.sessionId,
          format: "jpg",
          image: {
            assetId: stagedId,
            rotationDeg: 0,
            label: "图纸",
          },
        });
        if (!result.ok) throw new Error(result.error.message);
        setMessage(result.value ? "图片已导出。" : "已取消导出。");
      } else {
        verifyTarget();
        const patent = state.current.session.patent;
        if (!patent.drawingBooksEnabled) throw new Error("请先启用说明书附图。");
        requireCurrentPage();
        if (replacement) validateReplacementSource();
        const figure = replacement
          ? { ...replacement.target, assetId: stagedId }
          : { figureId: uid(), assetId: stagedId, widthMm: rendered.widthMm };
        const figures = replacement
          ? planDrawingReplacement(patent.figures, replacement.target, stagedId).map((item) =>
              item.figureId === replacement.target.figureId
                ? { ...item, widthMm: Math.min(item.widthMm, rendered.widthMm) }
                : item)
          : [...patent.figures, figure];
        const publishedRegion = {
          ...target.region,
          id: target.region.cadHandles ? uid() : target.region.id,
          name: `图${figures.findIndex((f) => f.figureId === figure.figureId) + 1}`,
          bodyNodeId: undefined,
          bodyAssetId: undefined,
          figureId: figure.figureId,
        };
        const nextProjects = state.current.projects.map((project) => {
          const regions = project.regions.map((r) => {
            if (project.projectId === target.project.projectId && !target.region.cadHandles && r.id === target.region.id)
              return publishedRegion;
            return replacement && r.figureId === figure.figureId
              ? { ...r, figureId: undefined }
              : r;
          });
          if (project.projectId === target.project.projectId && target.region.cadHandles)
            regions.push(publishedRegion);
          return regions.some((r, index) => r !== project.regions[index])
            ? { ...project, regions, revision: project.revision + (replacement || target.region.cadHandles ? 1 : 0) }
            : project;
        });
        persist(
          nextProjects,
          mergeAssets(patent.assets, [imported.value.descriptor]),
          figures,
          replacement ? "替换图纸附图" : "插入图纸附图",
          Boolean(replacement),
          replacement ? [] : [figure.figureId],
        );
        stagedId = undefined;
        setRegionId("");
        setRangeSelection(false);
        setHistoryTick((v) => v + 1);
        if (replacement) setReplaceOpen(false);
        if (!(await patents.preparePatentSnapshot(session.patentId)))
          throw new Error(
            replacement
              ? "附图已替换到待保存内容，但保存失败，请重试保存。"
              : "附图已加入待保存内容，但保存失败，请重试保存。",
          );
        clearOutputSelection(target);
        setPreviewMode(false);
        setMessage(replacement ? "已替换说明书附图。" : "已插入说明书附图。");
        setInsertFeedback({
          tone: "success",
          title: `已${replacement ? "替换" : "插入"}附图（${publishedRegion.name}）`,
        });
      }
    } catch (e) {
      status(e);
      if (replacement) throw e;
    } finally {
      try {
        if (stagedId) {
          const discarded = await window.patentApi.assets.discardImports({
            sessionId: session.sessionId,
            operationId,
            assetIds: [stagedId],
          });
          if (!discarded.ok) setFailure(discarded.error.message);
        }
      } catch (error) {
        status(error);
      } finally {
        delivering.current = false;
        setBusy(false);
      }
    }
  }
  function copySelection() {
    copiedDetail.current = null;
    if (!current || (!selectedIds.size && !(rangeSelection && region))) return false;
    copiedBase.current =
      rangeSelection && region
        ? structuredClone({
            projectId: current.projectId,
            fragments: extractBase(current, region.points),
            details: (current.detailViews ?? [])
              .filter((d) => selectedDetailParts(d, region.points).has(`detail-content:${d.id}`))
              .map((d) => ({
                ...d,
                markerHidden:
                  Boolean(d.markerHidden) ||
                  !selectedDetailParts(d, region.points).has(`detail-marker:${d.id}`),
              })),
            region,
          })
        : null;
    copiedAnnotations.current = structuredClone(
      rawMarks.filter(
        (a) =>
          selectedIds.has(a.id) &&
          !copiedBase.current?.details.some((d) => a.id === `detail-marker:${d.id}`),
      ),
    );
    setHasCopiedAnnotations(true);
    setMessage(
      copiedBase.current
        ? `已复制选区内的底图和标号，可按 ${platformShortcut("Ctrl+V")} 放置。`
        : `已复制 ${copiedAnnotations.current.length} 个标号，可按 ${platformShortcut("Ctrl+V")} 粘贴。`,
    );
    return true;
  }
  function pasteSelection() {
    if (!current || (!copiedAnnotations.current.length && !copiedBase.current)) return;
    if (copiedBase.current && copiedBase.current.projectId !== current.projectId) {
      setFailure("底图选区请在原图纸工作稿内粘贴；跨图纸可使用仅标号复制。");
      return;
    }
    if (current.annotations.length + copiedAnnotations.current.length > 5000) {
      setFailure("标号数量已达上限，无法粘贴。");
      return;
    }
    cancelGesture();
    setSelected("");
    const annotations = structuredClone(copiedAnnotations.current);
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const a of annotations)
      for (const p of [a, ...a.points]) {
        left = Math.min(left, p.x);
        right = Math.max(right, p.x);
        top = Math.min(top, p.y);
        bottom = Math.max(bottom, p.y);
      }
    if (copiedBase.current) {
      const selection = bounds(copiedBase.current.region.points);
      left = selection.x;
      top = selection.y;
      right = left + selection.width;
      bottom = top + selection.height;
    }
    const box = svgRef.current?.getBoundingClientRect();
    setPastePreview({
      ...(copiedBase.current
        ? {
            fragments: structuredClone(copiedBase.current.fragments),
            details: (() => {
              const occupied = (current.detailViews ?? []).map((d) => d.label);
              return copiedBase.current!.details.map((d) => {
                const label = nextDetailLabel(d.label, occupied);
                occupied.push(label);
                return { ...structuredClone(d), id: uid(), label };
              });
            })(),
            region: structuredClone(copiedBase.current.region),
          }
        : {}),
      annotations,
      anchor: { x: (left + right) / 2, y: (top + bottom) / 2 },
      screenPoint: lastCanvasPointer.current ?? {
        x: (box?.left ?? 0) + (box?.width ?? 0) / 2,
        y: (box?.top ?? 0) + (box?.height ?? 0) / 2,
      },
    });
    setTool("select");
    svgRef.current?.focus({ preventScroll: true });
  }
  async function deleteSelection() {
    const selection = crossSelection.current;
    if (selection) {
      if (deletingCrossSelection.current || busy) return;
      deletingCrossSelection.current = true;
      try {
        const annotationBatch = state.current.projects.flatMap((project) => {
          const ids = new Set(selection.get(project.projectId) ?? []);
          const marks = project.annotations.flatMap((annotation, index) =>
            ids.has(annotation.id) ? [{ annotation: structuredClone(annotation), index }] : [],
          );
          return marks.length ? [{ projectId: project.projectId, marks }] : [];
        });
        const count = annotationBatch.reduce((total, batch) => total + batch.marks.length, 0);
        if (!count) return;
        if (
          !(await confirmAppAction(
            `删除 ${annotationBatch.length} 张图纸中的 ${count} 个选中标号？可撤销恢复。`,
          ))
        )
          return;
        // Never include labels created after the user selected this batch.
        if (crossSelection.current !== selection || state.current.busy) return;
        if (!(await guard()) || crossSelection.current !== selection) return;
        histories.recordBatch({ ownerProjectId: activeId, annotationBatch });
        persist(
          state.current.projects.map((project) => {
            const ids = new Set(selection.get(project.projectId) ?? []);
            return ids.size
              ? {
                  ...project,
                  annotations: project.annotations.filter((annotation) => !ids.has(annotation.id)),
                  revision: project.revision + 1,
                }
              : project;
          }),
        );
        setSelected("");
        setHistoryTick((value) => value + 1);
        svgRef.current?.focus({ preventScroll: true });
      } finally {
        deletingCrossSelection.current = false;
      }
      return;
    }
    if (!current || (!selectedIds.size && !(rangeSelection && region))) return;
    const crop = rangeSelection ? region : null;
    commit({
      ...current,
      ...(crop
        ? {
            baseFragments: deleteBase(current, crop.points),
            regions: current.regions.filter((r) => r.id !== crop.id),
          }
        : {}),
      annotations: current.annotations.filter((a) => !selectedIds.has(a.id)),
      detailViews: current.detailViews
        ?.filter((d) => !crop || !selectedDetailParts(d, crop.points).has(`detail-content:${d.id}`))
        .map((d) => (selectedIds.has(`detail-marker:${d.id}`) ? { ...d, markerHidden: true } : d)),
    });
    setSelected("");
    svgRef.current?.focus({ preventScroll: true });
  }
  function renderDetailControls() {
    return (
      <SpatialCollapse open={Boolean(tool === "detail" || selectedDetail)}>
        {tool === "detail" || selectedDetail ? (
          <div
            className={
              current?.cad || imageDrawing
                ? "cad-detail-controls cad-tool-settings function-rail-transient-panel"
                : "drawing-annotation-properties"
            }
            inert={busy}
          >
            <h3>{selectedDetail ? "编辑局部放大" : "局部放大"}</h3>
            <label htmlFor="detail-label">
              字母标记
              {selectedDetail ? (
                <DraftText
                  key={selectedDetail.id}
                  id="detail-label"
                  ref={detailInput}
                  label="局部放大字母"
                  value={selectedDetail.label}
                  onCommit={(label) => updateDetail({ label })}
                />
              ) : (
                <input
                  id="detail-label"
                  aria-label="局部放大字母"
                  ref={nextDetailInput}
                  value={detailLabel}
                  maxLength={100}
                  onChange={(e) => setDetailLabel(e.target.value)}
                />
              )}
            </label>
            <label htmlFor="detail-ratio">
              比例
              {selectedDetail ? (
                <DraftText
                  key={`ratio-${selectedDetail.id}`}
                  id="detail-ratio"
                  ref={detailRatioInput}
                  label="局部放大比例"
                  value={`${formatCadNumber(selectedDetail.ratio)}:1`}
                  onCommit={(value) => {
                    const ratio = parseDetailRatio(value);
                    if (ratio === null) {
                      setFailure("请输入有效比例，例如 2:1（倍率 0.1～100）。");
                      return false;
                    }
                    return updateDetail({ ratio });
                  }}
                />
              ) : (
                <CadRatioInput
                  id="detail-ratio"
                  aria-label="局部放大比例"
                  value={detailRatio}
                  onChange={(e) => setDetailRatio(e.target.value)}
                />
              )}
            </label>
            <div className="drawing-detail-scale">
              <small title="比例相对于底图；不表示 CAD 原始工程比例。">相对底图</small>
              {selectedDetail && (
                <fieldset className="drawing-detail-stepper" aria-label="局部图缩放">
                  <button
                    type="button"
                    className="drawing-icon-button"
                    aria-label="缩小局部图"
                    title="缩小局部图"
                    onClick={() =>
                      updateDetail({ ratio: Math.max(0.1, selectedDetail.ratio / 1.25) })
                    }
                  >
                    <Minus size={17} />
                  </button>
                  <button
                    type="button"
                    className="drawing-icon-button"
                    aria-label="放大局部图"
                    title="放大局部图"
                    onClick={() =>
                      updateDetail({ ratio: Math.min(100, selectedDetail.ratio * 1.25) })
                    }
                  >
                    <Plus size={17} />
                  </button>
                </fieldset>
              )}
            </div>
            {selectedDetail && current?.cad?.unified && !imageDrawing && (
              <div className="drawing-detail-actions">
                <button
                  type="button"
                  onClick={() => {
                    setDetailSelection(null);
                    cadEditor.current?.editDetail(selectedDetail.id);
                  }}
                >
                  编辑图形
                </button>
                <button type="button" onClick={() => void refreshDetailFromSource()}>
                  从来源更新
                </button>
                {(detailSelection?.part === "title" || detailSelection?.part === "marker") && (
                  <button type="button" aria-label="删除局部放大标记" disabled={busy} onClick={deleteDetail}>
                    <Trash2 size={17} /> 删除标记
                  </button>
                )}
              </div>
            )}
            {imageDrawing && selectedDetail && detailSelection?.part === "title" && (
              <button type="button" aria-label="删除局部放大标记" disabled={busy} onClick={deleteDetail}>
                <Trash2 size={17} /> 删除标记
              </button>
            )}
            <details className="spatial-disclosure drawing-detail-settings">
              <summary aria-label="局部放大设置" title="局部放大设置">
                <Settings2 size={17} />
                {(current?.cad || imageDrawing) && <span>默认放大比例</span>}
              </summary>
              <div className="drawing-style-popover">
                <label htmlFor={`${numericFieldId}-detail-default`}>
                  默认放大比例
                  <CadRatioInput
                    id={`${numericFieldId}-detail-default`}
                    aria-label="默认放大比例"
                    value={defaultRatioDraft}
                    onChange={(e) => setDefaultRatioDraft(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={savingDetailDefaults || !styleReady}
                  onClick={async () => {
                    const ratio = parseDetailRatio(defaultRatioDraft);
                    if (ratio === null) {
                      setFailure("请输入有效比例，例如 2:1（倍率 0.1～100）。");
                      return;
                    }
                    setSavingDetailDefaults(true);
                    try {
                      const result = await window.patentApi.settings.update({
                        drawingDetailDefaultRatio: ratio,
                      });
                      if (!result.ok) throw new Error(result.error.message);
                      setDefaultDetailRatio(ratio);
                      if (!detailDraft) setDetailRatio(`${ratio}:1`);
                      setMessage("默认放大比例已保存。");
                    } catch (error) {
                      status(error);
                    } finally {
                      setSavingDetailDefaults(false);
                    }
                  }}
                >
                  {savingDetailDefaults ? "正在保存…" : "保存为默认"}
                </button>
              </div>
            </details>
          </div>
        ) : null}
      </SpatialCollapse>
    );
  }
  async function activateDrawingTool(id: Tool) {
    const epoch = ++toolActivationEpoch.current;
    const sourceId = current?.projectId;
    if ((id === "label" || id === "detail") && tool !== id && cadEditor.current) {
      finishSizeRef.current();
      if (id === "detail" && annotationSync.current && !(await annotationSync.current.flush())) return;
      if (!(await cadEditor.current.flush())) return;
      if (
        epoch !== toolActivationEpoch.current ||
        !state.current.active ||
        state.current.current?.projectId !== sourceId
      )
        return;
    }
    if (!(current?.cad?.unified && (id === "select" || id === "lasso") &&
      (tool === "select" || tool === "lasso") && cadEditor.current?.canWindow?.() &&
      !cadEditor.current?.isCommandPicking?.())) cadEditor.current?.cancel();
    const nextTool = (id === "label" || id === "detail") && tool === id ? "select" : id;
    if (nextTool !== "select" && current?.cad?.unified)
      lastDrawingTool.current = { projectId: current.projectId, tool: nextTool };
    setLocatedRegionId("");
    setRegionId("");
    setBatchIds([]);
    setSelected("");
    setPreviewMode(false);
    setPastePreview(null);
    setDetailDraft(null);
    setDetailPaste(null);
    setDetailSelection(null);
    if (id === "detail" && current?.detailViews?.some((d) => d.label === detailLabel))
      setDetailLabel(
        nextDetailLabel(
          detailLabel,
          current.detailViews.map((d) => d.label),
        ),
      );
    setHasPlacedLabel(false);
    if (id === "detail" && tool !== "detail") setDetailRatio(`${defaultDetailRatio}:1`);
    setTool(nextTool);
    rangePreview.clear();
    setPlacement(null);
    if (id !== "select") setSelected("");
  }
  function renderToolButton(t: (typeof tools)[number], inCadRail = false) {
    return (
      <button
        type="button"
        key={t.id}
        className={inCadRail ? undefined : "drawing-tool-button"}
        data-drawing-tool={t.id}
        aria-label={t.id === "lasso" && !cadVector ? "圈选取图" : t.label}
        title={inCadRail ? undefined : t.id === "lasso" && !cadVector ? "圈选取图" : t.label}
        disabled={
          !styleReady ||
          !base ||
          busy ||
          (t.id === "detail" && !!cadInside) ||
          (fixedBase && !vectorReady && t.id !== "select")
        }
        data-cad-save-locked={
          cadSaving &&
          !blockingBusy &&
          styleReady &&
          !!base &&
          (!fixedBase || vectorReady || t.id === "select")
        }
        aria-pressed={tool === t.id}
        onClick={() => void activateDrawingTool(t.id)}
      >
        {t.id === "label" ? (
          <svg width="24" height="24" viewBox="0 0 28 24" fill="none" aria-hidden="true">
            <path
              d="M2 21 9 12M15 21 22 12M8 4l2-2v7M7.5 9h5M19.5 4c0-3 5-3 5 0 0 2-5 3-5 5h5.5"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <t.icon size={17} aria-hidden="true" />
        )}
        <span>{t.id === "select" ? "选择 / 框选" : t.id === "lasso" ? "圈选" : t.label}</span>
      </button>
    );
  }
  const paperCache = useRef(new WeakMap<object, DrawingPoint[]>()).current;
  const paper = useMemo(
    () => (current ? drawingPaperBounds(current, paperCache) : null),
    [current, paperCache],
  );
  const sourceFragments = current?.baseFragments;
  const sourceWidth = current?.width;
  const sourceHeight = current?.height;
  const previewFragments = useMemo(
    () =>
      sourceFragments ??
      (sourceWidth !== undefined && sourceHeight !== undefined
        ? baseFragments({ width: sourceWidth, height: sourceHeight })
        : []),
    [sourceFragments, sourceWidth, sourceHeight],
  );
  const clippedMarks = useMemo(
    () => {
      if (!region) return [];
      const selectedLabels = cadVector
        ? new Set(cadFigure?.project.annotations.map((annotation) => annotation.id))
        : null;
      return rangeMarks.filter((annotation) =>
        (!selectedLabels || selectedLabels.has(annotation.id)) &&
        clippedAnnotations([annotation], region.points).length > 0);
    },
    [rangeMarks, region, cadVector, cadFigure],
  );
  const clippedIds = useMemo(() => new Set(clippedMarks.map((a) => a.id)), [clippedMarks]);
  const clipped = clippedMarks.map((a) => a.text);
  function annotationColor(id: string) {
    const isClipped = clippedIds.has(id);
    // Crop membership must not hide incomplete labels; direct editing still highlights in blue.
    if ((selectedIds.has(id) || cadSelectedLabelIds.has(id)) && (!rangeSelection || pendingSelection || !isClipped))
      return "#007AFF";
    return isClipped ? "#e00000" : "black";
  }
  // The CAD rail defaults to pinned; remember the user's explicit choice across openings.
  function selectReferenceNumber(number: number) {
    if (busy) return;
    finishSizeRef.current();
    inlineInput.current?.flush();
    annotationInput.current?.flush();
    cancelGesture();
    setSelected("");
    setInlineId("");
    setRegionId("");
    setPreview(null);
    setPreviewMode(false);
    pendingLocation.current = null;
    setTool("select");
    const selection = cadNumberSelection(state.current.projects, number);
    const count = [...selection.values()].reduce((total, ids) => total + ids.length, 0);
    crossSelection.current = count ? selection : null;
    setBatchIds(selection.get(activeId) ?? []);
    setMessage(
      count
        ? `已选中全部图纸中 ${count} 个标号 ${number}，切换图纸后保留选区。`
        : `全部图纸中没有标号 ${number}。`,
    );
    svgRef.current?.focus({ preventScroll: true });
  }
  const referenceNumberHandler = useRef(selectReferenceNumber);
  referenceNumberHandler.current = selectReferenceNumber;
  const onSelectReferenceNumber = useCallback(
    (number: number) => referenceNumberHandler.current(number),
    [],
  );
  const railTopBoundaryRef = useRef<HTMLDivElement>(null);
  const referenceMarkRail = (
    <PatentFunctionRailScope
      scopeKey="drawing-markup"
      initialSpace="constrained"
      initialUserIntent="pinned"
      userIntentStorageKey="patent-workbench:cad-function-rail:user-intent:v1"
      externalToolIds={current && (tool === "detail" || selectedDetail) ? ["cad-detail"] : []}
    >
      <CadFunctionTabs
        cadAvailable={!!current}
        toolsLabel={imageDrawing ? "图片工具" : "CAD工具"}
        requestTools={tool === "detail" || !!selectedDetail}
        requestKey={tool === "detail" ? toolActivationEpoch.current : (selectedDetail?.id ?? 0)}
        renderRail={(header, panels) => (
          <PatentGlobalFunctionRail
            bookKind="description-drawings"
            title="图纸工具"
            draggableWhenPinned
            dragTopBoundaryRef={railTopBoundaryRef}
            headerContent={header}
            onCollapse={() => {
              if (tool === "detail" || selectedDetail) {
                cancelGesture();
                setDetailSelection(null);
                setTool("select");
              }
            }}
          >
            <div className="patent-book-tools" data-function-rail-owner="drawing-markup">
              {panels}
            </div>
          </PatentGlobalFunctionRail>
        )}
        tools={
          <>
            {imageDrawing && (
              <div className="drawing-image-tools">
                {renderDetailControls()}
                <div className="drawing-image-tools__grid">
                  {tools.filter(t => t.id !== "label").map(t => renderToolButton(t))}
                </div>
                <p className="drawing-image-tools__hint">框选或圈选后，拖动选区移动内容，拖动边角缩放。</p>
                <fieldset className="drawing-image-tools__rotation" disabled={busy || !rangeSelection || !region}>
                  <legend>旋转选区</legend>
                  <label>角度
                    <CadNumberInput aria-label="图片旋转角度" min={-360} max={360} value={imageRotation}
                      onChange={e => setImageRotation(Number(e.target.value))} />
                  </label>
                  <div>
                    {([-1, 1] as const).map(direction => (
                      <button key={direction} type="button" onClick={() => {
                        if (!current || !region) return;
                        try { commit(rotateImageSelection(current, region, direction * imageRotation, uid())); }
                        catch (error) { status(error); }
                      }}>
                        {direction === -1 ? <RotateCcw size={17} /> : <RotateCw size={17} />}
                        {direction === -1 ? "向左旋转" : "向右旋转"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
            {current?.cad && (
              <CadEditingPanel
                compatibilityOnly={imageDrawing}
                runtimeEnabled={runtimeEnabled}
                key={current.projectId}
                ref={cadEditor}
                clipboard={cadClipboard}
                instructionTarget={cadInstructionTarget}
                settingsTarget={cadSettingsTarget}
                getCanvas={() => svgRef.current}
                project={current}
                sessionId={session.sessionId}
                retryGeneration={cadRetryTick}
                enabled={cadEditing}
                disabled={blockingBusy || annotationSyncing || !current.cad.unified}
                onToolChosen={() => {
                  lastDrawingTool.current = null;
                }}
                onRepeatTool={() => {
                  const last = lastDrawingTool.current;
                  if (
                    !last ||
                    last.projectId !== current.projectId ||
                    (last.tool === "detail" && cadInside)
                  )
                    return false;
                  void activateDrawingTool(last.tool);
                  return true;
                }}
                detailTool={{
                  button: renderToolButton(tools.find((t) => t.id === "detail")!, true),
                  active: tool === "detail",
                  controlsOpen: tool === "detail" || !!selectedDetail,
                  hint:
                    detailDraft?.stage === "radius"
                      ? "移动鼠标确定圆的大小，再点击确认。"
                      : detailDraft?.stage === "leader"
                        ? "放置原图字母标记及引线，点击确认。"
                        : detailDraft?.stage === "place" || detailPaste
                          ? "移动鼠标放置局部放大图，点击确认；Esc / 右键取消。"
                          : "点击取图圆心；Esc / 右键取消。",
                  controls: renderDetailControls(),
                  close: () => {
                    cancelGesture();
                    setDetailSelection(null);
                    setTool("select");
                  },
                }}
                onEnabled={() => {
                  cancelGesture();
                  setTool("select");
                }}
                onSelection={(selection) => {
                  cadSelectionLatest.current = selection;
                  setCadSelection(selection);
                  if (!selection) setCadWorkingScene(null);
                  // The legacy overlay supplies rendering/checkpoint metadata only.
                  // Its reloads must not own the image editor's label/detail selection.
                  if (imageDrawing) return;
                  // A late checkpoint hydration must not clear a newer cross-drawing
                  // selection while its deletion confirmation is open.
                  if(selection?.passive && (crossSelection.current || inlineId || regionId || tool !== "select")) return;
                  const ids = new Set(selection?.handles);
                  const bindings = selection?.objects ?? current.cad?.objects ?? [];
                  const labels = bindings
                    .filter((o) => o.kind === "label" && o.label?.some((h) => ids.has(h)))
                    .map((o) => o.id);
                  crossSelection.current = null;
                  setRangeSelection(false);
                  setBatchIds(labels.length > 1 ? labels : []);
                  setSelectedId(labels.length === 1 ? labels[0]! : "");
                  const detail = bindings.find(
                    (o) =>
                      o.kind === "detail" &&
                      [...(o.body ?? []), ...(o.frame ?? []), ...(o.source ?? [])].some((h) =>
                        ids.has(h),
                      ),
                  );
                  if (!cadInside || (detail && ids.size > 0 &&
                    [...ids].every(h => detail.source?.includes(h))))
                    setDetailSelection(
                      detail
                        ? {
                            id: detail.id,
                            part: [...(detail.body ?? []), ...(detail.frame ?? [])].some((h) =>
                              ids.has(h),
                            )
                              ? "content"
                              : "marker",
                          }
                        : null,
                    );
                  else setDetailSelection(null);
                }}
                onInside={setCadInside}
                onTextEditing={setCadTextEditing}
                onPreview={(preview) => cadPreview.current?.update(preview)}
                onBusy={setBusy}
                onSaving={setCadSaving}
                onWorkingScene={(scene, objects, sequence, projectId, command) => {
                  const project = state.current.current;
                  if (project?.projectId !== projectId) return;
                  setCadWorkingScene((working) => {
                    const liveEdit = ["grip.move", "trim", "extend", "explode", "bridge.text", "bridge.gear", "bridge.spring", "bridge.chain", "bridge.corner"].includes(command);
                    if (!working && !liveEdit) return null;
                    if (working && working.projectId !== projectId && !liveEdit)
                      return working;
                    if (working && working.projectId === projectId && working.sequence > sequence)
                      return working;
                    return { projectId, sequence, scene, objects, before: project };
                  });
                }}
                onDrawingActive={setCadDrawingActive}
                onUndoSegment={() => {
                  void undoRedo("undo");
                }}
                onToolActive={setCadToolActive}
                onObjectCursor={setCadObjectCursor}
                onPendingDrawing={(drawing) => {
                  cadPendingPreview.current?.append(drawing);
                  if (drawing.lineAnchor) cadPreview.current?.advanceLine(drawing.lineAnchor);
                }}
                onPaintedDrawing={(sequence) => {
                  cadPendingPreview.current?.painted(sequence);
                  setCadWorkingScene((working) =>
                    working && working.sequence <= sequence ? null : working,
                  );
                }}
                onError={setFailure}
                onLoadError={() => {
                  if (!current.cad) return;
                  setCadRetry({
                    projectId: current.projectId,
                    key: `${current.cad.assetId}:${cadSemanticKey(current)}`,
                  });
                }}
                onCommit={commitCad}
                onNativeCommit={commitNativeCad}
                readCheckpoint={readCadDraft}
                checkpointScene={(id) => draftCheckpoints.current?.get(id)?.scene}
              />
            )}
            {current?.cad && !current.cad.overlayAssetId && (
              <div className="cad-entity-tools">
                <button type="button" disabled={busy} onClick={() => void exportEditableCad("dwg")}>
                  导出 DWG
                </button>
                <button type="button" disabled={busy} onClick={() => void exportEditableCad("dxf")}>
                  导出 DXF
                </button>
              </div>
            )}
          </>
        }
        referenceMarks={
          <CadReferenceMarkPanel
            referenceMarks={session.patent.referenceMarks}
            present={sidebar.numbers}
            busy={busy}
            onAddReferenceMark={registerReferenceMark}
            onSelectNumber={onSelectReferenceNumber}
          />
        }
      />
    </PatentFunctionRailScope>
  );
  return (
    <section
      aria-label="CAD标号"
      className="drawing-workspace"
      data-shortcut-input
      data-cad-pending={cadSaving || checkpointSaving || annotationSyncing}
      onBlur={() => {
        requestAnimationFrame(() => {
          if (state.current.active && document.activeElement === document.body &&
            !hasVisibleElement('[role="dialog"][aria-modal="true"], [role="menu"]')) {
            svgRef.current?.focus({ preventScroll: true });
          }
        });
      }}
      onKeyDown={(event) => {
        // The function rail is a portal outside drawing-workspace-content.
        // Let its inputs and popups handle Escape before this fallback runs.
        if (!active || !cadEditing || event.key !== "Escape" ||
          event.defaultPrevented || ignoreApplicationKeyEvent(event.nativeEvent) ||
          (event.target as Element).closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"],[aria-haspopup]') ||
          hasVisibleElement('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        cadEditor.current?.cancel();
        cancelGesture();
        svgRef.current?.focus({ preventScroll: true });
      }}
      onClick={(event) => {
        const target = event.target as Element;
        // Tool actions return keyboard ownership to the canvas. Editable fields,
        // popup triggers and dialogs retain their own input/focus lifecycle.
        if (
          target.closest(".patent-global-function-rail") &&
          target.closest("button,summary,input[type='checkbox'],input[type='radio']") &&
          !target.closest("[aria-haspopup], [role='dialog']") &&
          !hasVisibleElement("[role='dialog'][aria-modal='true']")
        ) {
          svgRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      <section
        className={`drawing-workspace-content ${sourcesOpen ? "" : "is-sources-collapsed"}`}
        aria-label="图纸编辑工作区"
        tabIndex={-1}
        onContextMenu={(e) => {
          if (
            (e.target as Element).closest(
              "input,textarea,select,button,[contenteditable='true'],.drawing-sources,.drawing-header,.patent-global-function-rail",
            )
          )
            return;
          if (secondaryPanMenu.current) {
            e.preventDefault();
            return;
          }
          if ((cadEditing || tool !== "select" || detailPaste || pastePreview) && !busy) {
            e.preventDefault();
            canvasContextAction();
          }
        }}
        onKeyDown={(e) => {
          if (ignoreApplicationKeyEvent(e.nativeEvent)) return;
          if (
            detailSelection?.part === "title" &&
            selectedDetail &&
            !busy &&
            !e.nativeEvent.isComposing &&
            !e.repeat &&
            !(e.target as Element).closest("input,textarea,select,[contenteditable='true']") &&
            (e.key === "Delete" || e.key === "Backspace")
          ) {
            e.preventDefault();
            e.stopPropagation();
            deleteDetail();
            return;
          }
          if (
            e.key === "Tab" &&
            e.target === svgRef.current &&
            !blockingBusy &&
            cadEditor.current?.cycleSnap()
          ) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (cadEditing && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cadEditor.current?.cancel();
            cancelGesture();
            svgRef.current?.focus({ preventScroll: true });
            return;
          }
          if (
            cadEditing &&
            !blockingBusy &&
            !e.repeat &&
            !e.nativeEvent.isComposing &&
            !(e.target as Element).closest(
              "input,textarea,select,button,[contenteditable='true']",
            ) &&
            e.key.toLowerCase() === "c" &&
            !e.ctrlKey &&
            !e.metaKey &&
            cadEditor.current?.closeLine()
          ) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (
            cadEditing &&
            current?.cad?.unified &&
            !busy &&
            !crossSelection.current &&
            !rangeSelection &&
            (e.ctrlKey || e.metaKey) &&
            !["INPUT", "TEXTAREA"].includes((e.target as Element).tagName)
          ) {
            const key = e.key.toLowerCase();
            if (["a", "c", "x"].includes(key)) {
              e.preventDefault();
              if (key === "a") cadEditor.current?.selectAll();
              else cadEditor.current?.copySelected(key === "x");
              return;
            }
            if (key === "v" && cadEditor.current?.pasteSelected()) {
              e.preventDefault();
              return;
            }
          }
          if (
            cadEditing &&
            !blockingBusy &&
            !crossSelection.current &&
            !rangeSelection &&
            !e.nativeEvent.isComposing &&
            !e.repeat &&
            !(e.target as Element).closest(
              "input,textarea,select,button,[contenteditable='true']",
            ) &&
            (e.key === "Enter" ||
              e.key === " " ||
              e.key === "Delete" ||
              e.key === "Backspace")
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Enter" || e.key === " ") cadEditor.current?.finish();
            else cadEditor.current?.erase();
            return;
          }
          e.stopPropagation();
          if (
            active &&
            !e.nativeEvent.isComposing &&
            !e.repeat &&
            insertShortcut &&
            shortcutMatchesInput(insertShortcut, e) &&
            !(e.target as Element).closest("input, textarea, select, [contenteditable='true']")
          ) {
            e.preventDefault();
            if (!drag.current && !placement && !pastePreview && !detailDraft && !detailPaste)
              void deliver("insert", true);
            return;
          }
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            e.currentTarget
              .querySelectorAll<HTMLDetailsElement>(".drawing-annotation-properties details[open]")
              .forEach((details) => {
                details.open = false;
              });
            finishSize();
            if (pastePreview) {
              cancelGesture();
              svgRef.current?.focus({ preventScroll: true });
              return;
            }
            if (previewMode) {
              setPreviewMode(false);
              return;
            }
            setPreview(null);
            const pending = Boolean(placement || draft.length || drag.current);
            cancelGesture();
            if (!pending || tool !== "label") {
              setTool("select");
              svgRef.current?.focus({ preventScroll: true });
            }
            setSelected("");
            setRegionId("");
            setProjects((ps) => ps.map((p) => ({ ...p, regions: savedDrawingRegions(p.regions) })));
            return;
          }
          if (busy && e.target instanceof Element && e.target.closest("[data-drawing-cancel]"))
            return;
          if ((cadSaving || cadSynchronization.current) && (e.ctrlKey || e.metaKey)) {
            const key = e.key.toLowerCase();
            if (["s", "z", "y"].includes(key)) {
              e.preventDefault();
              if (key === "s") void flush();
              else void undoRedo(key === "y" || e.shiftKey ? "redo" : "undo");
              return;
            }
          }
          if (busy || (drag.current && drag.current.mode !== "label")) {
            e.preventDefault();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void flush();
            return;
          }
          if (
            e.target instanceof HTMLInputElement &&
            e.target.type === "range" &&
            (e.ctrlKey || e.metaKey) &&
            ["z", "y"].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            finishSize();
            undoRedo(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
            return;
          }
          if (
            e.target === nextLabelInput.current &&
            (e.ctrlKey || e.metaKey) &&
            ["z", "y"].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            undoRedo(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
            return;
          }
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
            return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && crossSelection.current) {
            e.preventDefault();
            setFailure("跨图纸标号请在单张图纸中剪切。");
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            cancelGesture();
            setSelected("");
            setRegionId("");
            setBatchIds(batchMarks.map((mark) => mark.id));
            return;
          }
          if (selectedDetail && (e.key === "Delete" || e.key === "Backspace")) {
            e.preventDefault();
            deleteDetail();
            return;
          }
          if (
            (e.ctrlKey || e.metaKey) &&
            ["c", "x"].includes(e.key.toLowerCase()) &&
            selectedDetail
          ) {
            e.preventDefault();
            copiedBase.current = null;
            copiedAnnotations.current = [];
            copiedDetail.current = structuredClone(selectedDetail);
            setMessage(`局部放大图已复制，按 ${platformShortcut("Ctrl+V")} 放置副本。`);
            if (e.key.toLowerCase() === "x") deleteDetail();
            return;
          }
          if (
            (e.ctrlKey || e.metaKey) &&
            e.key.toLowerCase() === "v" &&
            copiedDetail.current &&
            current
          ) {
            e.preventDefault();
            if ((current.detailViews?.length ?? 0) >= 100) {
              setFailure("局部放大图数量已达上限。");
              return;
            }
            const copy = { ...structuredClone(copiedDetail.current), id: uid() };
            copy.label = nextDetailLabel(
              copy.label,
              (current.detailViews ?? []).map((d) => d.label),
            );
            cancelGesture();
            setDetailPaste(copy);
            setTool("select");
            return;
          }
          if ((e.ctrlKey || e.metaKey) && ["c", "v", "x"].includes(e.key.toLowerCase())) {
            e.preventDefault();
            if (e.key.toLowerCase() === "v") pasteSelection();
            else if (copySelection() && e.key.toLowerCase() === "x") void deleteSelection();
            return;
          }

          if (e.code === "Space" && e.target === svgRef.current) {
            e.preventDefault();
            setSpacePan(true);
            return;
          }
          if (
            selectedIds.size > 0 &&
            current &&
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            const step =
              ((e.shiftKey ? 10 : 1) * displayView.width) / (svgRef.current?.clientWidth || 1000);
            commit({
              ...current,
              detailViews: current.detailViews?.map((d) =>
                moveDetailParts(
                  d,
                  selectedIds,
                  e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
                  e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
                ),
              ),
              annotations: current.annotations.map((a) =>
                selectedIds.has(a.id)
                  ? (batchIds.length ? translateAnnotation : moveAnnotation)(
                      a,
                      e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
                      e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
                    )
                  : a,
              ),
            });
            return;
          }
          if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
            e.preventDefault();
            undoRedo(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
          }
          if (
            (e.key === "Delete" || e.key === "Backspace") &&
            (crossSelection.current || selectedIds.size || (rangeSelection && region)) &&
            current
          ) {
            e.preventDefault();
            deleteSelection();
          }
        }}
        onKeyUp={(e) => {
          if (e.code === "Space") setSpacePan(false);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setSpacePan(false);
        }}
      >
        <aside className="drawing-sources" inert={busy}>
          <div className="drawing-source-header">
            {sourcesOpen && <h3>图纸</h3>}
            <button
              type="button"
              className="drawing-icon-button"
              aria-label={sourcesOpen ? "收起图纸列表" : "展开图纸列表"}
              title={sourcesOpen ? "收起图纸列表" : "展开图纸列表"}
              aria-expanded={sourcesOpen}
              aria-controls={`drawing-source-list-${session.patentId}`}
              onClick={() => setSourcesOpen((v) => !v)}
            >
              {sourcesOpen ? (
                <PanelLeftClose size={18} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={18} aria-hidden="true" />
              )}
            </button>
          </div>
          <div
            className="drawing-source-content"
            id={`drawing-source-list-${session.patentId}`}
            hidden={!sourcesOpen}
          >
            <button
              type="button"
              className="drawing-create-button"
              disabled={busy}
              onClick={() => void createCad()}
            >
              <span>新建图纸</span>
            </button>
            <div className="drawing-import-row">
              {" "}
              <button
                type="button"
                className="drawing-import"
                disabled={busy || !styleReady || window.patentApi.tutorial?.isSession}
                data-cad-save-locked={
                  cadSaving && !blockingBusy && styleReady && !window.patentApi.tutorial?.isSession
                }
                onClick={() => fileRef.current?.click()}
              >
                导入图纸
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".dwg,.dxf,.pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff"
                aria-label="选择图纸文件"
                disabled={window.patentApi.tutorial?.isSession ?? false}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFiles([file]);
                }}
              />
            </div>
            {projects.map((p) => (
              <DrawingProjectRow
                key={p.projectId}
                project={p}
                selected={activeId === p.projectId}
                busy={busy}
                backgroundSaving={cadSaving && !blockingBusy}
                onActivate={(id) => void selectProject(id)}
                onRename={renameProject}
                onDelete={deleteProject}
                onExport={(id, format) => exportEditableCad(format, id)}
              />
            ))}
            {current?.sourceKind === "pdf" && (
              <div className="drawing-pdf-page">
                <label>
                  PDF 页码（共 {pdfPages} 页）
                  <input
                    type="number"
                    min={1}
                    max={pdfPages}
                    value={page}
                    onChange={(e) => setPage(Number(e.target.value))}
                  />
                </label>
                <button type="button" disabled={busy} onClick={() => void addPdfPage()}>
                  打开此页
                </button>
              </div>
            )}
            <h3 className="drawing-side-section-title">说明书附图</h3>
            <div className="drawing-source-scroll">
              {listedRegions.length > 0 && (
                <section className="drawing-region-list" aria-label="已插入附图">
                  {listedRegions.map((r) => {
                    const figure = session.patent.figures.find((f) => f.figureId === r.figureId)!;
                    const asset = session.patent.assets.find((a) => a.assetId === figure.assetId);
                    return (
                      <DrawingFigureCard
                        key={`${r.projectId}:${r.id}:${figure.assetId}`}
                        sessionId={session.sessionId}
                        assetId={figure.assetId}
                        figureId={figure.figureId}
                        name={r.name}
                        aspectRatio={
                          asset?.widthPx && asset.heightPx ? asset.widthPx / asset.heightPx : 1
                        }
                        selected={activeId === r.projectId && locatedRegionId === r.id}
                        disabled={busy || !active}
                        onLocate={() => locatePublishedRegion(r)}
                      />
                    );
                  })}
                </section>
              )}
              {region && (
                <button type="button" onClick={() => {
                  if (cadVector) {
                    cadEditor.current?.selectHandles([]);
                    setCadSelection(null);
                  } else setRegionId("");
                }}>
                  取消选区
                </button>
              )}
              <div className="drawing-sidebar-output">
                {
                  <SpatialPresence>
                    {clipped.length > 0 && (
                      <p className="drawing-warning">
                        标号或引出线可能被裁切：{[...new Set(clipped)].join("、")}
                        。请检查预览或调整范围。
                        <button
                          type="button"
                          onClick={() => {
                            const a =
                              clippedMarks[
                                (clippedMarks.findIndex(
                                  (a) =>
                                    a.id ===
                                    (detailSelection
                                      ? `detail-${detailSelection.part === "title" ? "title" : "marker"}:${detailSelection.id}`
                                      : selected),
                                ) +
                                  1) %
                                  clippedMarks.length
                              ];
                            if (a) {
                              setPreviewMode(false);
                              setTool("select");
                              const detail = current?.detailViews?.find(
                                (d) =>
                                  `detail-marker:${d.id}` === a.id ||
                                  `detail-title:${d.id}` === a.id,
                              );
                              if (detail) {
                                setSelected("");
                                setDetailSelection({
                                  id: detail.id,
                                  part: a.id.startsWith("detail-title:") ? "title" : "marker",
                                });
                              } else {
                                setDetailSelection(null);
                                setSelected(a.id);
                              }
                              focusArea([
                                ...a.points,
                                { x: a.x - a.fontSize * 2, y: a.y - a.fontSize * 2 },
                                { x: a.x + a.fontSize * 2, y: a.y + a.fontSize * 2 },
                              ]);
                            }
                          }}
                        >
                          定位被裁切标号
                        </button>
                      </p>
                    )}
                  </SpatialPresence>
                }
              </div>
            </div>
          </div>
        </aside>
        <header className="drawing-header">
          <div className="drawing-heading">
            <strong>图纸工作区</strong>
            <span title={current?.name}>{current?.name || "导入图纸，开始标号"}</span>
          </div>
          <div className="drawing-header-actions">
            <button
              type="button"
              disabled={busy || !styleReady}
              className="drawing-icon-button"
              aria-label="导出设置"
              title="导出设置"
              onClick={() => setExportSettingsOpen(true)}
            >
              <Settings2 size={17} aria-hidden="true" />
            </button>
            {importing && (
              <button type="button" data-drawing-cancel onClick={() => void cancelImport()}>
                取消导入
              </button>
            )}
            <button
              type="button"
              className="drawing-icon-button"
              aria-label="撤销标号编辑"
              title={platformShortcut("撤销（Ctrl+Z）")}
              disabled={busy || !history.undo.length}
              onClick={() => undoRedo("undo")}
            >
              <Undo2 size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="drawing-icon-button"
              aria-label="重做标号编辑"
              title={platformEditorShortcut("重做（Ctrl+Y）")}
              disabled={busy || !history.redo.length}
              onClick={() => undoRedo("redo")}
            >
              <Redo2 size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="drawing-primary"
              disabled={!region || !base || busy || !styleReady}
              onClick={() => void makePreview()}
            >
              预览成图
            </button>
            <button
              type="button"
              className="drawing-replace-button"
              title={
                session.patent.figures.length
                  ? "将当前选区替换到指定说明书附图"
                  : "请先插入说明书附图"
              }
              disabled={
                !region ||
                !base ||
                busy ||
                !styleReady ||
                !session.patent.drawingBooksEnabled ||
                !session.patent.figures.length
              }
              onClick={openReplacement}
            >
              <Replace size={16} aria-hidden="true" />
              替换附图
            </button>
            <button
              type="button"
              className="drawing-primary"
              title={
                insertShortcut
                  ? `插入附图（${platformShortcut(insertShortcut)}）`
                  : "插入附图（可在快捷键设置中配置）"
              }
              disabled={
                !region || !base || busy || !styleReady || !session.patent.drawingBooksEnabled
              }
              onClick={() => void deliver("insert", true)}
            >
              插入附图
            </button>
          </div>
        </header>
        <div className="drawing-toolbar" ref={railTopBoundaryRef}>
          {!imageDrawing && <fieldset className="drawing-tool-segment" aria-label="图纸工具">
            {tools
              .filter((t) => t.id !== "label" && (t.id !== "detail" || !current?.cad))
              .map((t) => renderToolButton(t))}
          </fieldset>}
          {tools.filter((t) => t.id === "label").map((t) => renderToolButton(t))}
          <button
            type="button"
            className="drawing-tool-button drawing-cancel-button"
            aria-label="取消"
            disabled={busy || !current}
            title="取消当前操作或选择（Esc）"
            onClick={() => {
              const canvas = svgRef.current;
              canvas?.focus({ preventScroll: true });
              // Use the same cancellation path as the canvas Escape key.
              canvas?.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
              );
            }}
          >
            <X size={24} aria-hidden="true" />
            <span>取消</span>
          </button>
          <div className="drawing-tool-options">
            {selectedIds.size > 0 && (
              <span data-selected-annotation-count>
                {pendingSelection ? "将选中" : "已选中"} {selectedIds.size} 个标号
              </span>
            )}
            <SpatialCollapse open={alignableCount >= 2 && !crossSelection.current}>
              {alignableCount >= 2 && !crossSelection.current ? (
                <fieldset className="drawing-batch-actions" aria-label="整理对齐标号">
                  <button
                    type="button"
                    className="drawing-icon-button"
                    aria-label="水平对齐"
                    title="在标号附近水平等距排列"
                    disabled={busy}
                    onClick={() => alignBatch("horizontal")}
                  >
                    <AlignCenterHorizontal size={17} />
                  </button>
                  <button
                    type="button"
                    className="drawing-icon-button"
                    aria-label="竖向对齐"
                    title="在标号附近竖向等距排列"
                    disabled={busy}
                    onClick={() => alignBatch("vertical")}
                  >
                    <AlignCenterVertical size={17} />
                  </button>
                </fieldset>
              ) : null}
            </SpatialCollapse>
            <SpatialCollapse
              open={Boolean(
                tool === "label" || tool === "detail" || selectedIds.size > 0 || selectedDetail,
              )}
            >
              {tool === "label" || tool === "detail" || selectedIds.size > 0 || selectedDetail ? (
                <label className="drawing-size-slider">
                  字号
                  <input
                    type="range"
                    aria-label="标号字号"
                    disabled={!styleReady || !base || busy}
                    min={region && output.mode === "uniform" ? 2 : 1}
                    max={region && output.mode === "uniform" ? 8 : Math.max(120, selectedSize)}
                    step={region && output.mode === "uniform" ? 0.1 : 1}
                    value={
                      region && output.mode === "uniform" ? output.labelHeightMm : selectedSize
                    }
                    onPointerDown={() => {
                      annotationInput.current?.flush();
                      inlineInput.current?.flush();
                      const project = state.current.projects.find((p) => p.projectId === activeId);
                      if (project) sizeGesture.current = project;
                    }}
                    onChange={(e) => changeSize(Number(e.target.value))}
                    onPointerUp={finishSize}
                    onPointerCancel={finishSize}
                    onBlur={finishSize}
                  />
                  <span>
                    {region && output.mode === "uniform"
                      ? `${formatCadNumber(output.labelHeightMm)} mm`
                      : formatCadNumber(selectedSize)}
                  </span>
                </label>
              ) : null}
            </SpatialCollapse>
            {
              <SpatialCollapse
                open={Boolean(
                  crossSelection.current ||
                    (batchIds.length > 0 && !cadEditing) ||
                    (rangeSelection && region),
                )}
              >
                {(crossSelection.current ||
                  (batchIds.length > 0 && !cadEditing) ||
                  (rangeSelection && region)) && (
                  <fieldset className="drawing-batch-actions" aria-label="批量标号操作">
                    <button
                      type="button"
                      className="drawing-icon-button"
                      aria-label={rangeSelection && region ? "复制选区" : "复制选中标号"}
                      title={
                        rangeSelection && region
                          ? platformShortcut("复制底图和标号 (Ctrl+C)")
                          : platformShortcut("复制选中标号 (Ctrl+C)")
                      }
                      disabled={busy}
                      onClick={copySelection}
                    >
                      <Copy size={17} />
                    </button>
                    <button
                      type="button"
                      className="drawing-icon-button"
                      aria-label={copiedBase.current ? "粘贴选区" : "粘贴标号"}
                      title={platformShortcut("粘贴 (Ctrl+V)")}
                      disabled={busy || !hasCopiedAnnotations}
                      onClick={pasteSelection}
                    >
                      <ClipboardPaste size={17} />
                    </button>
                    <button
                      type="button"
                      className="drawing-icon-button"
                      aria-label={rangeSelection && region ? "删除选区" : "删除选中标号"}
                      title="删除选中内容 (Delete)"
                      disabled={
                        busy ||
                        (!crossSelection.current &&
                          !selectedIds.size &&
                          !(rangeSelection && region))
                      }
                      onClick={deleteSelection}
                    >
                      <Trash2 size={17} />
                    </button>
                  </fieldset>
                )}
              </SpatialCollapse>
            }
            {!imageDrawing && !current?.cad && renderDetailControls()}
            <SpatialCollapse
              open={Boolean(
                rangeSelection && region && selectedIds.size > 0 && !annotation && tool !== "label",
              )}
            >
              {rangeSelection &&
              region &&
              selectedIds.size > 0 &&
              !annotation &&
              tool !== "label" ? (
                <div className="drawing-annotation-properties" inert={busy}>
                  <label htmlFor={`${numericFieldId}-selected-size`}>
                    标号字号
                    <CadNumberInput
                      id={`${numericFieldId}-selected-size`}
                      aria-label="选区标号字号"
                      min={output.mode === "uniform" ? 2 : 1}
                      max={output.mode === "uniform" ? 8 : 1000}
                      step={output.mode === "uniform" ? 0.1 : 1}
                      value={output.mode === "uniform" ? output.labelHeightMm : selectedSize}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (
                          n >= (output.mode === "uniform" ? 2 : 1) &&
                          n <= (output.mode === "uniform" ? 8 : 1000)
                        )
                          changeSize(n);
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </SpatialCollapse>
            <SpatialCollapse open={Boolean(tool === "label" || annotation)}>
              {tool === "label" || annotation ? (
                <div className="drawing-annotation-properties" inert={busy}>
                  <h3>{annotation ? `编辑标号：${annotation.text}` : "添加标号"}</h3>
                  <label htmlFor="drawing-label-value">
                    {annotation ? "标号内容" : "下一标号"}
                    {annotation ? (
                      <DraftText
                        key={annotation.id}
                        ref={annotationInput}
                        id="drawing-label-value"
                        value={annotation.text}
                        label="标号内容"
                        onCommit={(text) => changeAnnotation({ text })}
                      />
                    ) : (
                      <input
                        ref={nextLabelInput}
                        id="drawing-label-value"
                        aria-label="标号内容"
                        value={label}
                        maxLength={100}
                        onChange={(e) => {
                          setLabel(e.target.value);
                          if (e.target.value.trim())
                            preferences({ nextLabel: e.target.value.trim() });
                        }}
                      />
                    )}
                  </label>
                  {!annotation && (
                    <label className="drawing-check">
                      <input
                        type="checkbox"
                        checked={current?.repeatLabel ?? false}
                        onChange={(e) => preferences({ repeatLabel: e.target.checked })}
                      />
                      连续使用此编号
                    </label>
                  )}
                  {(!region || output.mode === "drawing") && (
                    <details className="spatial-disclosure drawing-more">
                      <summary>标号样式</summary>
                      <div className="drawing-style-popover">
                        <label htmlFor={`${numericFieldId}-label-size`}>
                          标号字号
                          <CadNumberInput
                            id={`${numericFieldId}-label-size`}
                            aria-label="标号字号数值"
                            min={1}
                            max={1000}
                            value={annotation?.fontSize ?? fontSize}
                            onChange={(e) => {
                              const value = Number(e.target.value);
                              if (value >= 1 && value <= 1000) {
                                setFontSize(value);
                                changeAnnotation({ fontSize: value });
                              }
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={savingStyle || !styleReady}
                          onClick={async () => {
                            const defaults = {
                              fontSize: annotation?.fontSize ?? fontSize,
                              // 模型的默认样式里线宽仍是必填字段，但引出线不再取这个值。
                              lineWidth: LEGACY_ANNOTATION_LINE_WIDTH,
                            };
                            setSavingStyle(true);
                            setFailure("");
                            try {
                              const result = await window.patentApi.settings.update({
                                drawingAnnotationDefaults: defaults,
                              });
                              if (!result.ok) throw new Error(result.error.message);
                              setFontSize(defaults.fontSize);
                              setMessage("标号字号已保存为默认，下次启动后继续使用。");
                            } catch (error) {
                              status(error);
                            } finally {
                              setSavingStyle(false);
                            }
                          }}
                        >
                          {savingStyle ? "正在保存…" : "保存为默认"}
                        </button>
                        <span className="drawing-style-note">
                          关闭自动调整时，引出线按 0.3 mm 输出。
                        </span>
                      </div>
                    </details>
                  )}
                  {annotation && current && (
                    <div className="drawing-row">
                      <button
                        type="button"
                        className="drawing-icon-button"
                        aria-label="复制标号"
                        title="复制标号"
                        onClick={copySelection}
                      >
                        <Copy size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="drawing-icon-button"
                        aria-label="粘贴标号"
                        title={platformShortcut("粘贴标号 (Ctrl+V)")}
                        disabled={!hasCopiedAnnotations}
                        onClick={pasteSelection}
                      >
                        <ClipboardPaste size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="drawing-icon-button"
                        aria-label="删除标号"
                        title="删除标号"
                        onClick={() => {
                          commit({
                            ...current,
                            annotations: current.annotations.filter((a) => a.id !== selected),
                          });
                          setSelected("");
                        }}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </SpatialCollapse>
          </div>
        </div>
        <div className="drawing-layout">
          <section className="drawing-stage" data-infinite-cad={infiniteCad}>
            <div ref={setCadSettingsTarget} className="cad-transient-host" />
            {current ? (
              <div
                ref={sceneRef}
                className="drawing-viewport"
                data-cad-detail-live={
                  liveScene ? (current.cad?.overlayAssetId ? "overlay" : "base") : undefined
                }
              >
                <PanPreviewSurface
                  ref={panPreview}
                  view={view}
                  displayView={displayView}
                  composited={Boolean(current.cad?.unified)}
                  imageCoverage={Boolean(
                    current.cad?.unified &&
                      !current.cad.overlayAssetId &&
                      !liveScene &&
                      (current.sourceKind === "dwg" || current.sourceKind === "dxf")
                  )}
                >
                  {({ camera, view: sourceView, displayView: sourceDisplayView, size }) => {
                    const baseView =
                      base?.mapping &&
                      current.cad &&
                      (base.mapping.originX !== current.cad.mapping.originX ||
                        base.mapping.originY !== current.cad.mapping.originY)
                        ? {
                            ...sourceView,
                            x:
                              sourceView.x -
                              (base.mapping.originX - current.cad.mapping.originX) *
                                current.cad.mapping.scale,
                            y:
                              sourceView.y -
                              (current.cad.mapping.originY - base.mapping.originY) *
                                current.cad.mapping.scale,
                          }
                        : sourceView;
                    const referenceScale =
                      size.width && size.height
                        ? Math.min(
                            size.width / ((base?.width ?? current.width) * 1.08),
                            size.height / ((base?.height ?? current.height) * 1.08),
                          )
                        : undefined;
                    const sourceUnit =
                      size.width && size.height
                        ? Math.max(displayView.width / size.width, displayView.height / size.height)
                        : unitsPerPixel;
                    return (
                      <>
                        {paper && !infiniteCad && (
                          <svg
                            className="drawing-cad-paper"
                            aria-hidden="true"
                            viewBox={`${sourceDisplayView.x} ${sourceDisplayView.y} ${sourceDisplayView.width} ${sourceDisplayView.height}`}
                          >
                            <rect
                              x={paper?.x}
                              y={paper?.y}
                              width={paper?.width}
                              height={paper?.height}
                              fill="white"
                            />
                          </svg>
                        )}
                        {base &&
                          !current.baseFragments &&
                          (current.sourceKind === "dwg" ||
                            current.sourceKind === "dxf" ||
                            current.sourceKind === "pdf") && (
                            <VectorDrawingPreview
                              source={drawingPreviewSource(base.bytes)}
                              tiled={base.tiled}
                              sourceKind={current.sourceKind}
                              pageNumber={current.pageNumber}
                              width={base.width}
                              height={base.height}
                              view={baseView}
                              infinite={infiniteCad}
                              strokeReferenceScale={referenceScale}
                              onPending={() => {
                                setVectorReady(false);
                                if (liveViewport) setPaintedView(livePaintedView.current);
                                setLiveViewport(false);
                              }}
                              onPainted={(next, live = false) => {
                                // Asset handoff is independent of camera object identity.
                                // A concurrent view update must not leave the already
                                // painted checkpoint under its duplicate live strokes.
                                if (
                                  current.cad &&
                                  !current.cad.overlayAssetId &&
                                  base.assetId === current.baseAssetId
                                )
                                  acknowledgeCadPaint(current.projectId, current.cad.assetId);
                                if (drag.current?.mode === "pan" || next !== baseView) return;
                                if (live) livePaintedView.current = camera;
                                else setPaintedView(camera);
                                setLiveViewport(live);
                                setVectorReady(true);
                              }}
                              onError={setFailure}
                            />
                          )}
                        {base &&
                          Boolean(
                            current.baseFragments ||
                              (!fixedBase &&
                                (pastePreview?.fragments ||
                                  current.detailViews?.length ||
                                  candidateDetail ||
                                  pastedDetails.length)),
                          ) && (
                            <FragmentedDrawingPreview
                              project={
                                current.cad?.backgroundSize
                                  ? {
                                      ...current,
                                      width: current.cad.backgroundSize[0],
                                      height: current.cad.backgroundSize[1],
                                    }
                                  : current
                              }
                              fragments={previewFragments}
                              base={previewBase!}
                              view={sourceView}
                              strokeReferenceScale={referenceScale}
                              onPainted={(next) => {
                                if (drag.current?.mode === "pan" || next !== sourceView) return;
                                if (current.sourceKind !== "pdf") livePaintedView.current = camera;
                                else setPaintedView(camera);
                                setLiveViewport(current.sourceKind !== "pdf");
                                setVectorReady(true);
                                if (
                                  current.cad &&
                                  !current.cad.overlayAssetId &&
                                  base.assetId === current.baseAssetId
                                )
                                  acknowledgeCadPaint(current.projectId, current.cad.assetId);
                              }}
                              onError={setFailure}
                            />
                          )}
                        {base && pastePreview?.fragments && pastePosition && (
                          <FragmentedDrawingPreview
                            project={current}
                            fragments={translateFragments(
                              pastePreview.fragments,
                              pastePosition.x - pastePreview.anchor.x,
                              pastePosition.y - pastePreview.anchor.y,
                            )}
                            base={previewBase!}
                            view={sourceDisplayView}
                            ghost
                            onError={setFailure}
                          />
                        )}
                        {base &&
                          [
                            ...displayedDetails,
                            ...pastedDetails,
                            ...(candidateDetail ? [candidateDetail] : []),
                          ].map((d) => d === candidateDetail && detailDraft ? (
                            <DetailPointerPreview key={`draft-image-${detailDraft.stage}`} ref={detailImagePointer} initial={detailDraft.cursor}>
                              {cursor => <DetailViewImage sessionId={session.sessionId} detail={detailAtPointer(d,cursor)} project={current} base={previewBase!} view={sourceDisplayView} left={sourceDisplayView.x} top={sourceDisplayView.y} unit={sourceUnit} strokeReferenceScale={referenceScale} ghost onError={setFailure}/>}
                            </DetailPointerPreview>
                          ) : (
                            <DetailViewImage
                              sessionId={session.sessionId}
                              key={d.id}
                              detail={d}
                              project={current}
                              base={previewBase!}
                              view={sourceDisplayView}
                              left={sourceDisplayView.x}
                              top={sourceDisplayView.y}
                              unit={sourceUnit}
                              strokeReferenceScale={referenceScale}
                              ghost={d === candidateDetail || pastedDetails.includes(d)}
                              forcePreview={d.id === placedPreview?.id}
                              onError={setFailure}
                            />
                          ))}
                        {current.cad?.overlayAssetId && (
                          <CadOverlayPreview
                            project={current}
                            sessionId={session.sessionId}
                            view={sourceView}
                            onPainted={(id) => acknowledgeCadPaint(current.projectId, id)}
                            onError={setFailure}
                          />
                        )}
                      </>
                    );
                  }}
                </PanPreviewSurface>
                {liveScene && <CadSceneSurface canvas={svgRef} viewBox={`${displayView.x} ${displayView.y} ${displayView.width} ${displayView.height}`}>
                  <CadDetailGestureLayer project={current} preview={liveScene} selectedDetailId={!previewMode && !cadInside && detailSelection?.part === "content" ? selectedDetail?.id : undefined} visibleLabelIds={paintedNativeLabelIds} hiddenLabelId={activeDraggedLabelId} labelColors={new Map(current.annotations.flatMap(a=>{const color=annotationColor(a.id);return color==="black"?[]:[[a.id,color] as const];}))} />
                </CadSceneSurface>}
                <svg
                  ref={attachCanvas}
                  role="application"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Interactive drawing canvas supports keyboard history.
                  tabIndex={0}
                  data-panning="false"
                  data-cad-editing={cadEditing}
                  data-cad-pickbox={cadEditing && !cadToolActive}
                  data-cad-object-cursor={cadEditing && cadObjectCursor}
                  data-tool={tool}
                  data-space-pan={spacePan}
                  onContextMenu={(e) => {
                    if ((e.target as Element).closest("input,textarea,[contenteditable='true']"))
                      return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (secondaryPanMenu.current) return;
                    canvasContextAction();
                  }}
                  onDoubleClick={(e) => {
                    if (tool !== "select" || busy || previewMode) return;
                    const detail = (e.target as Element).closest<SVGElement>("[data-detail]")
                      ?.dataset.detail;
                    if (detail && current.cad?.unified && !imageDrawing) {
                      setDetailSelection(null);
                      cadEditor.current?.editDetail(detail);
                      return;
                    }
                    const id =
                      (e.target as Element).closest<SVGElement>("[data-annotation]")?.dataset
                        .annotation ?? selected;
                    if (id) {
                      cadEditor.current?.selectHandles(current.cad?.objects?.find(o=>o.kind==="label"&&o.id===id)?.label ?? []);
                      setSelected(id);
                      setInlineId(id);
                    } else if (cadEditing) cadEditor.current?.editText(point(e), unitsPerPixel * 7);
                  }}
                  aria-label="CAD标号画布"
                  viewBox={`${displayView.x} ${displayView.y} ${displayView.width} ${displayView.height}`}
                  onPointerDown={down}
                  onPointerMove={move}
                  onPointerLeave={() => {
                    if (!cadPointer.current) {
                      if (cadEditing) cadEditor.current?.leave();
                      else cadPreview.current?.update(null);
                    }
                  }}
                  onPointerUp={up}
                  onPointerCancel={(e) => {
                    if (cadPointer.current && cadPointer.current.pointerId === e.pointerId)
                      cadEditor.current?.cancel();
                    if (!drag.current || drag.current.pointerId === e.pointerId) cancelGesture(false);
                  }}
                  onLostPointerCapture={(e) => {
                    if (
                      cadPointer.current &&
                      cadPointer.current.pointerId === e.pointerId &&
                      !e.currentTarget.hasPointerCapture(e.pointerId)
                    ) {
                      if (e.buttons === 0) up(e, 0);
                      else {
                        cadEditor.current?.cancel();
                        cancelGesture(false);
                      }
                      return;
                    }
                    if (
                      drag.current?.pointerId === e.pointerId &&
                      !e.currentTarget.hasPointerCapture(e.pointerId)
                    ) {
                      // macOS can report a released-button move/capture loss before
                      // pointerup. Commit its final position instead of rolling back.
                      // Actual pointercancel has already cleared the gesture above;
                      // losing capture while a button is held still cancels it.
                      if (e.buttons === 0) up(e, drag.current.button);
                      else cancelGesture(false);
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                >
                  <g data-drawing-scene>
                    {!fixedBase &&
                      !current.baseFragments &&
                      !pastePreview?.fragments &&
                      !current.detailViews?.length &&
                      !candidateDetail &&
                      !pastedDetails.length && (
                        <rect
                          x={0}
                          y={0}
                          width={current.width}
                          height={current.height}
                          fill="white"
                        />
                      )}
                    {base &&
                      !fixedBase &&
                      !current.baseFragments &&
                      !pastePreview?.fragments &&
                      !current.detailViews?.length &&
                      !candidateDetail &&
                      !pastedDetails.length && (
                        <image
                          href={base.url}
                          width={current.width}
                          height={current.height}
                          preserveAspectRatio="none"
                        />
                      )}
                    {displayedDetails.map((d) => (
                      <DetailViewMarks
                        key={d.id}
                        detail={d}
                        titleColor={
                          detailSelection?.id === d.id && detailSelection.part !== "marker"
                            ? "#007AFF"
                            : annotationColor(`detail-title:${d.id}`)
                        }
                        markerColor={
                          detailSelection?.id === d.id && detailSelection.part === "marker"
                            ? "#007AFF"
                            : annotationColor(`detail-marker:${d.id}`)
                        }
                        selected={detailSelection?.id === d.id && detailSelection.part !== "title"}
                        part={detailSelection?.part ?? "content"}
                        unit={unitsPerPixel}
                        zoom={displayZoom}
                      />
                    ))}
                    {pastedDetails.map((d) => (
                      <DetailViewMarks
                        key={d.id}
                        detail={d}
                        selected={false}
                        part="content"
                        unit={unitsPerPixel}
                        zoom={displayZoom}
                        ghost
                      />
                    ))}
                    {ghostDetail && !detailDraft && (
                      <DetailViewMarks
                        detail={ghostDetail}
                        sourceOnly={false}
                        selected={false}
                        part="content"
                        unit={unitsPerPixel}
                        zoom={displayZoom}
                        ghost
                      />
                    )}
                    {detailDraft && <DetailPointerPreview key={`draft-marks-${detailDraft.stage}`} ref={detailMarksPointer} initial={detailDraft.cursor}>
                      {cursor => detailDraft.stage === "radius" ? <circle data-detail-radius-ghost cx={detailDraft.source.x} cy={detailDraft.source.y} r={Math.hypot(cursor.x-detailDraft.source.x,cursor.y-detailDraft.source.y)} fill="none" stroke="#0050ff" strokeWidth={unitsPerPixel} strokeDasharray={`${unitsPerPixel*4} ${unitsPerPixel*3}`} pointerEvents="none"/> : ghostDetail && <DetailViewMarks detail={detailAtPointer(ghostDetail,cursor,detailDraft.stage==="leader"?detailMarkerPosition(cursor):undefined)} sourceOnly={detailDraft.stage==="leader"} selected={false} part="content" unit={unitsPerPixel} zoom={displayZoom} ghost/>}
                    </DetailPointerPreview>}
                    {shownAnnotations.filter((a) => a.id !== activeDraggedLabelId).map((a) => {
                      const nativeVisual = paintedNativeLabelIds.has(a.id);
                      const stored = nativeVisual ? current.annotations.find((item) => item.id === a.id) : undefined;
                      return <DrawingAnnotationView
                        key={a.id}
                        annotation={stored ? { ...stored, points: leaderPoints(stored) } : a}
                        nativeVisual={nativeVisual}
                        cadText={!!current.cad?.unified}
                        {...(current.cad ? {lineweightMm:cadLabelLineweight(current,a)} : {})}
                        selected={selectedIds.has(a.id) || cadSelectedLabelIds.has(a.id)}
                        handles={selected === a.id}
                        clipped={clippedIds.has(a.id)}
                        color={annotationColor(a.id)}
                        viewWidth={view.width}
                        unitsPerPixel={unitsPerPixel}
                        canvasWidth={svgRef.current?.clientWidth ?? 1000}
                      />;
                    })}
                    {promptedAnnotation && <CadLabelKeywordPrompt key={promptedAnnotation.id} ref={keywordPromptRef}
                      x={Math.max(shadeLeft + 8 * unitsPerPixel, Math.min(
                        promptedAnnotation.x + promptedAnnotation.text.length * promptedAnnotation.fontSize * 0.35 + 12 * unitsPerPixel,
                        shadeLeft + shadeWidth - 256 * unitsPerPixel,
                      ))}
                      y={Math.max(shadeTop + 8 * unitsPerPixel, Math.min(
                        promptedAnnotation.y - promptedAnnotation.fontSize,
                        shadeTop + shadeHeight - 100 * unitsPerPixel,
                      ))}
                      units={unitsPerPixel} number={Number(promptedAnnotation.text)}
                      onClose={() => setKeywordPrompt(null)}
                      onCommit={keyword => {
                        const result = registerReferenceMark({ number: Number(promptedAnnotation.text), keyword });
                        if (!result.ok) setFailure(result.message);
                        return result;
                      }} />}
                    {inlineId && annotation && (
                      <foreignObject
                        x={annotation.x - displayView.width * 0.05}
                        y={annotation.y - displayView.width * 0.018}
                        width={displayView.width * 0.1}
                        height={displayView.width * 0.04}
                        style={{
                          fontSize:
                            (displayView.width / Math.max(1, svgRef.current?.clientWidth ?? 1000)) *
                            14,
                        }}
                      >
                        <DraftText
                          value={annotation.text}
                          ref={inlineInput}
                          label="直接修改标号"
                          autoFocus
                          onCommit={(text) => changeAnnotation({ text })}
                          onFinish={() => {
                            setInlineId("");
                            svgRef.current?.focus({ preventScroll: true });
                          }}
                        />
                      </foreignObject>
                    )}
                    {pastePreview && (
                      <g data-drawing-preview="paste" pointerEvents="none" opacity={0.55}>
                        {pastedAnnotations.map((a) => (
                          <g key={a.id}>
                            <polyline
                              points={list(a.points)}
                              fill="none"
                              stroke="#0050ff"
                              strokeWidth={drawingLeaderWidth(unitsPerPixel)}
                              strokeDasharray={`${view.width / 180} ${view.width / 250}`}
                            />

                            <text
                              x={a.x}
                              y={a.y}
                              textAnchor="middle"
                              dominantBaseline="central"
                              fontFamily="Arial, sans-serif"
                              fontSize={a.fontSize}
                              fontWeight={400}
                              fill="#0050ff"
                            >
                              {a.text}
                            </text>
                          </g>
                        ))}
                      </g>
                    )}
                    {placement && tool === "label" && (
                      <LabelPlacementPreview
                        ref={labelPreviewRef}
                        start={placement.start}
                        end={placement.end}
                        text={label.trim()}
                        fontSize={placementStyle.fontSize}
                        cadText={!!current.cad?.unified}
                        unitsPerPixel={unitsPerPixel}
                        viewWidth={view.width}
                        references={current.annotations}
                        glyphPaths={loadedGlyph?.key === glyphKey ? loadedGlyph.paths : undefined}
                      />
                    )}
                    {activeDraggedLabelId && current.annotations.find((a) => a.id === activeDraggedLabelId) && (
                      <LabelDragPreview
                        ref={labelDragPreviewRef}
                        cadText={!!current.cad?.unified}
                        annotation={current.annotations.find((a) => a.id === activeDraggedLabelId)!}
                        glyphPaths={liveScene?.compiled.find((run) => run.labelId === activeDraggedLabelId)
                          ?.paths.filter((path) => path.fill !== "none")}
                        mapping={current.cad?.mapping}
                        unitsPerPixel={unitsPerPixel}
                      />
                    )}
                    {locatedRegion && (
                      <polygon
                        data-published-location
                        points={list(locatedRegion.points)}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={view.width / 800}
                        pointerEvents="none"
                      />
                    )}
                    {region && !cadVector && (
                      <>
                        <polygon
                          data-region-outline
                          points={list(region.points)}
                          fill="none"
                          stroke="#2563eb"
                          strokeWidth={view.width / 800}
                          pointerEvents="none"
                        />
                        {tool === "select" && (
                          <>
                            <polygon
                              data-region-move
                              points={list(region.points)}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={24 * unitsPerPixel}
                              style={{ cursor: "move" }}
                              pointerEvents="stroke"
                            />
                            {region.kind === "rectangle"
                              ? (() => {
                                  const xs = region.points.map((p) => p.x),
                                    ys = region.points.map((p) => p.y);
                                  const l = Math.min(...xs),
                                    r = Math.max(...xs),
                                    t = Math.min(...ys),
                                    b = Math.max(...ys),
                                    cx = (l + r) / 2,
                                    cy = (t + b) / 2;
                                  return (
                                    [
                                      ["nw", l, t],
                                      ["n", cx, t],
                                      ["ne", r, t],
                                      ["e", r, cy],
                                      ["se", r, b],
                                      ["s", cx, b],
                                      ["sw", l, b],
                                      ["w", l, cy],
                                    ] as const
                                  ).map(([handle, x, y]) => (
                                    <g key={handle}>
                                      <circle
                                        data-region-handle={handle}
                                        cx={x}
                                        cy={y}
                                        r={12 * unitsPerPixel}
                                        fill="transparent"
                                        style={{ cursor: `${handle}-resize` }}
                                      />
                                      <circle
                                        key={handle}
                                        data-region-handle={handle}
                                        cx={x}
                                        cy={y}
                                        r={(handle === "ne" ? 4 : 3) * unitsPerPixel}
                                        fill="white"
                                        stroke="var(--drawing-grip, #c45a00)"
                                        strokeWidth={1.5 * unitsPerPixel}
                                        style={{ cursor: `${handle}-resize` }}
                                      />
                                    </g>
                                  ));
                                })()
                              : region.points
                                  .filter(
                                    (_, i) =>
                                      i % Math.max(1, Math.floor(region.points.length / 30)) === 0,
                                  )
                                  .map((p) => (
                                    <circle
                                      key={`${p.x}-${p.y}`}
                                      data-region-point={region.points.indexOf(p)}
                                      cx={p.x}
                                      cy={p.y}
                                      r={
                                        (view.width /
                                          Math.max(1, svgRef.current?.clientWidth ?? 1000)) *
                                        1.5
                                      }
                                      fill="white"
                                      stroke="var(--drawing-grip, #c45a00)"
                                      strokeWidth={view.width / 900}
                                      style={{ cursor: "move" }}
                                    />
                                  ))}
                          </>
                        )}
                      </>
                    )}
                    <polygon
                      ref={rangePreview.ref}
                      data-drawing-preview="range"
                      strokeWidth={view.width / 800}
                      pointerEvents="none"
                    />
                    {cadEditing && !liveDetailGesture && (
                      <CadSelectionOverlay
                        project={current}
                        showGrips={!cadToolActive}
                        selection={
                          liveWorkingScene && cadSelection?.scene === liveWorkingScene.scene
                            ? { ...cadSelection, checkpointId: current.cad?.assetId }
                            : cadSelection
                        }
                        unit={unitsPerPixel}
                        inside={cadInside}
                      />
                    )}
                    {current.cad?.unified && (
                      <CadGesturePreview ref={cadPreview} project={current} unit={unitsPerPixel} />
                    )}
                    <g visibility={liveScene ? "hidden" : undefined}>
                      <CadPendingDrawings
                        key={current.projectId}
                        ref={cadPendingPreview}
                        project={current}
                      />
                    </g>
                  </g>
                </svg>
              </div>
            ) : (
              <div className="drawing-empty">
                <h2>先导入一张图纸</h2>
                <p>支持 DWG、PDF 和图片。</p>
                <p>直接在整张图上标号，编辑完成后再选择取图范围。</p>
              </div>
            )}
            <SpatialPresence>
              {importing || batchImporting ? (
                <div className="drawing-import-progress" data-drawing-import-progress>
                  <div className="drawing-import-progress__card">
                    <DrawingImportProgressSurface
                      key={importOperation.current?.id ?? "between-imports"}
                      sessionId={session.sessionId}
                      operation={importOperation.current}
                      message={message}
                    />
                  </div>
                </div>
              ) : null}
            </SpatialPresence>
          </section>
        </div>
        {current && current.warnings.length > 0 ? (
          <aside className="drawing-import-warnings" aria-label="导入检查提示">
            <div className="drawing-import-warnings__header">
              <strong>导入检查提示</strong>
              <button
                type="button"
                className="drawing-import-warnings__close"
                aria-label="关闭导入检查提示"
                title="关闭提示"
                onClick={() => commit({ ...current, warnings: [] }, false)}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <ul>
              {[...new Set(current.warnings)].map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </aside>
        ) : null}
        <div className="drawing-status" role="status" data-history-version={historyTick}>
          <span className="drawing-feedback" title={failure || message}>
            {
              <SpatialPresence>
                {failure ? <span role="alert">{failure}</span> : message}
              </SpatialPresence>
            }
          </span>
          {cadRetry && cadRetry.projectId === current?.projectId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!cadRetry) return;
                unifiedAttempts.current.delete(cadRetry.key);
                setCadRetry(null);
                setFailure("");
                setCadRetryTick((value) => value + 1);
              }}
            >
              重试加载图纸
            </button>
          )}
          <fieldset className="drawing-view-tools" aria-label="图纸视图">
            <button
              type="button"
              className="drawing-icon-button"
              title="缩小图纸"
              aria-label="缩小图纸"
              disabled={!current || busy}
              onClick={() => zoomView(1.2)}
            >
              <Minus size={18} aria-hidden="true" />
            </button>
            <span className="drawing-zoom-value" title="缩放比例">
              {Math.round(displayZoom * 100)}%
            </span>
            <button
              type="button"
              className="drawing-icon-button"
              title="放大图纸"
              aria-label="放大图纸"
              disabled={!current || busy}
              onClick={() => zoomView(1 / 1.2)}
            >
              <Plus size={18} aria-hidden="true" />
            </button>
            {region && (
              <button
                type="button"
                className="drawing-icon-button"
                aria-label="定位选区"
                title="定位选区"
                disabled={busy}
                onClick={() => {
                  setPreviewMode(false);
                  focusArea(region.points);
                }}
              >
                <LocateFixed size={18} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="drawing-icon-button"
              aria-label="适合窗口"
              title="适合窗口"
              disabled={!current || busy}
              onClick={() => current && setView(drawingFitBounds(current, cadEditor.current?.contentBounds()))}
            >
              <Maximize size={18} aria-hidden="true" />
            </button>
          </fieldset>

          {current?.cad && !previewMode && (cadEditing || tool === "detail") ? (
            <div className="cad-status-instruction" ref={setCadInstructionTarget} />
          ) : (
            <DrawingGuidance>
              {busy
                ? "正在准备图纸，请稍候"
                : !current
                  ? "点击“导入图纸”开始"
                  : previewMode
                    ? "使用缩放按钮检查成图，确认后导出或插入"
                    : pastePreview
                      ? "移动鼠标，点击放置，按 Esc 取消"
                      : fixedBase && !vectorReady
                        ? "正在准备图纸，请稍候"
                        : tool === "detail" || detailPaste
                          ? detailDraft?.stage === "radius"
                            ? "移动鼠标确定圆的大小，再点击确认"
                            : detailDraft?.stage === "leader"
                              ? "移动鼠标拉出字母引线，点击确定标记位置 · Esc / 右键取消"
                              : detailDraft?.stage === "place" || detailPaste
                                ? "移动鼠标放置局部放大图 · 点击确认 · Esc / 右键取消"
                                : "点击取图圆心 · Esc / 右键退出"
                          : tool === "label"
                            ? placement
                              ? "移动鼠标，点击放置编号"
                              : hasPlacedLabel
                                ? "直接输入下一个编号，继续点击标号；右键结束"
                                : "点击图中位置，再点击放置编号；也可以按住左键拖动标号"
                            : draft.length > 0
                              ? drag.current?.annotationsOnly
                                ? "拖动框选或圈选标号，松开完成选择"
                                : tool === "lasso"
                                  ? "按住左键圈出取图范围，松开完成"
                                  : drag.current?.crossing
                                    ? "松开完成取图，碰到的标号会完整保留"
                                    : "松开完成取图，按 Esc 取消"
                              : tool === "lasso"
                                ? cadVector
                                  ? "按住左键圈选线条和标号，松开完成选择"
                                  : "按住左键圈出取图范围，松开完成"
                                : batchIds.length > 1
                                  ? platformShortcut(
                                      "拖动整体移动，按 Delete / Backspace 删除，Ctrl+C 复制",
                                    )
                                  : selected || batchIds.length === 1
                                    ? "拖动数字调整位置，拖动引线整体移动，按 Delete / Backspace 删除"
                                    : region
                                      ? "拖动边缘调整范围，点击“预览成图”查看结果"
                                      : cadEditing
                                        ? "点选或框选对象 · 按住滚轮平移图纸"
                                        : isMacPlatform()
                                          ? "双指滑动或按压拖动平移 · 捏合缩放 · 鼠标中键平移"
                                          : "拖动鼠标选取图片范围，按住滚轮移动图纸"}
            </DrawingGuidance>
          )}
          {(checkpointError || annotationError) && (
            <button type="button" onClick={() => void flush()}>
              重试后台保存
            </button>
          )}
          <span
            className="drawing-save-badge"
            data-save-state={
              checkpointError || annotationError ? "failed" : checkpointSaving || annotationSyncing ? "saving" : session.aggregateSaveState
            }
          >
            {checkpointError || annotationError || session.aggregateSaveState === "failed"
              ? "保存失败"
              : checkpointSaving || annotationSyncing
                ? "后台保存中"
                : session.aggregateSaveState === "saving"
                  ? "正在保存…"
                  : "已保存"}
          </span>
        </div>
        {referenceMarkRail}
      </section>
      <MotionPresence>
        {active && insertFeedback && (
          <OperationFeedbackOverlay
            feedback={insertFeedback}
            onClose={() => setInsertFeedback(null)}
          />
        )}
      </MotionPresence>
      <DrawingExportSettingsDialog
        open={active && exportSettingsOpen}
        autoAdjust={autoAdjustLabelSize}
        scale={autoLabelScale}
        disabled={busy || !styleReady}
        saving={savingExportSettings}
        failure={failure}
        onClose={() => setExportSettingsOpen(false)}
        onAutoAdjustChange={(enabled) => void changeAutoAdjustLabelSize(enabled)}
        onScaleChange={setAutoLabelScale}
        onScaleCommit={() => void saveAutoLabelScale()}
      />
      <MotionPresence>
        {active && replaceOpen ? (
          <DrawingReplaceDialog
            open
            sessionId={session.sessionId}
            figures={session.patent.figures}
            onPreview={makeReplacementPreview}
            onConfirm={(target, rendered) =>
              deliver("replace", true, { target, preview: rendered })
            }
            onCancel={() => setReplaceOpen(false)}
          />
        ) : null}
      </MotionPresence>
      <FigureExportDialog
        open={active && previewMode && Boolean(preview)}
        title="成图预览"
        onCancel={() => setPreviewMode(false)}
        busy={busy}
        options={
          <>
            <fieldset className="flowchart-export-section">
              <legend>导出范围</legend>
              <p>当前取图选区</p>
            </fieldset>
            {preview && (
              <fieldset className="flowchart-export-section">
                <legend>成图信息</legend>
                <p>{formatCadNumber(preview.widthMm)} × {formatCadNumber(preview.widthMm * preview.height / preview.width)} 毫米</p>
                <p>{preview.width} × {preview.height} 像素</p>
              </fieldset>
            )}
            <p className="flowchart-export-hint">请检查取图范围和标号，再导出或插入。</p>
          </>
        }
        footer={
          <>
            <span
              className="drawing-preview-status"
              data-failure={Boolean(failure)}
              aria-live="polite"
            >
              {failure || message}
            </span>
            <button type="button" disabled={busy} onClick={() => setPreviewMode(false)}>取消</button>
            <SpatialPresence>
              {preview && (
                <div className="drawing-output">
                  <button type="button" disabled={busy} onClick={() => void deliver("save")}>
                    <Download size={16} aria-hidden="true" />
                    导出 JPG
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !session.patent.drawingBooksEnabled}
                    onClick={() => void deliver("insert")}
                  >
                    <ImagePlus size={16} aria-hidden="true" />
                    插入说明书附图
                  </button>
                </div>
              )}
            </SpatialPresence>
          </>
        }
      >
        {preview && (
          <FlowchartImagePreview
            src={preview.url}
            alt="取图导出预览"
            title={<span>成图预览</span>}
            fitOnLoad
            outputWidthMm={preview.widthMm}
          />
        )}
      </FigureExportDialog>
    </section>
  );
}
