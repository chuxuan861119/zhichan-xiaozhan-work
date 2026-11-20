import { isMacPlatform, platformShortcut } from "../../../shared/platform";
import { MacCadIntents } from "./mac-cad-intents";
import { CadAppearancePanel } from "./cad-appearance-panel";
import { hitsCadSelection } from "./cad-selection-hit";
import { CAD_GRIP_OBJECT_LIMIT } from "./cad-interaction";
import { affineMirrorType } from "./cad-mirror-preview";
import { supportsCadAppearance } from "./cad-appearance-support";
import {
  ArrowUpRight,
  BetweenHorizontalStart,
  Circle,
  Combine,
  Copy,
  CornerDownRight,
  CornerUpRight,
  createLucideIcon,
  Ellipse,
  Eraser,
  FlipHorizontal2,
  Grid2X2,
  Cog,
  Group,
  type LucideIcon,
  Minus,
  Move,
  Orbit,
  PaintBucket,
  Pentagon,
  Radius,
  RotateCw,
  Ruler,
  RulerDimensionLine,
  Scaling,
  Scissors,
  ScissorsLineDashed,
  Spline,
  Square,
  Type,
  UnfoldHorizontal,
  Ungroup,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CadNumberInput } from "./cad-number-input";
import { baseFragments } from "../../../shared/drawing-markup/base-fragments";
import { pasteCadMetadata } from "../../../shared/drawing-markup/cad-clipboard";
import { cadObjectHandles } from "../../../shared/drawing-markup/cad-objects";
import type { CadClipboard, CadClipboardRef } from "./cad-clipboard-state";
import { planCadExplode } from "../../../shared/drawing-markup/cad-explode";
import {
  applyCadMutation,
  expandPatentSelection,
  scopeCadSelection,
} from "../../../shared/drawing-markup/cad-mutation";
import {
  type CadPatentObject,
  patentObjectAtHandle,
  remapPatentHandles,
} from "../../../shared/drawing-markup/cad-objects";
import { canAcceptNativeSnapshot } from "./cad-native-snapshot";
import { cadToPage, pageToCad } from "../../../shared/drawing-markup/cad-state";
import type { DrawingPoint, DrawingProject } from "../../../shared/drawing-markup/model";
import {
  type AidResult,
  type AidSettings,
  CadDraftingAids,
  DEFAULT_AID_SETTINGS,
} from "./cad-drafting-aids";
import type { DraftCurve } from "./cad-drafting-geometry";
import { CadDrawingPipeline } from "./cad-drawing-pipeline";
import { compileDrawMethod, DRAW_METHODS, drawMethod } from "./cad-draw-methods";
import { rectangleGeometry, type RectangleOptions } from "./cad-rectangle";
import { CadToolMenu, type CadMenuChoice } from "./cad-tool-menu";
import { cadToolIcon } from "./cad-tool-icons";
import { CadGearProperties } from "./cad-gear-properties";
import { CadChainProperties } from "./cad-chain-properties";
import { chainGripLabel } from "./cad-chain-geometry";
import { CadTransientWindow } from "./cad-transient-window";
import { CadGearMeshSettings, CadGearMeshStatus } from "./cad-gear-mesh-settings";
import { cadGearMates, cadGearName, cadGearSelection } from "./cad-gear-feedback";
import { CadSpringProperties } from "./cad-spring-properties";
import { type CadCorner, type CornerValue, cornerAt, cornerCandidates, cornerGeometry, cornerGrips, clampCorner, dragCorner } from "./cad-corner";
import { compileCadGesture, EXTRA_CAD_TOOLS, type ExtraCadTool } from "./cad-gesture";
import type { CadPreview } from "./cad-gesture-preview";
import { cadGearGripLabel, cadGripLabel, cadGripPreviewPaths } from "./cad-grip-preview";
import {
  type CadTool,
  expandCadGroups,
  resolveCadPointer,
  resolveCadWindow,
} from "./cad-interaction";
import {
  CAD_MODIFY_TARGETS,
  cadTargetLimit,
  cadTransform,
  CadRotationGesture,
  mergeCadSelection,
} from "./cad-modify-gesture";
import { type CadSnapType, cadGripSnapType } from "./cad-object-snap";
import { isPatternTool } from "./cad-pattern-command";
import { type CadPatternHandle, CadPatternPanel } from "./cad-pattern-panel";
import { rememberHatchPreferences } from "./cad-hatch-preferences";
import type { PendingCadDrawing } from "./cad-pending-drawings";
import { CadPrimitiveBatch } from "./cad-primitive-highlight";
import { CadcraftClient, type CadScene, type CadCheckpoint, ensureCadcraftClient } from "./cadcraft-client";
import { cadSceneDelta, mergeCadScene } from "./cad-scene-delta";
import { CadTextEditor } from "./cad-text-editor";

type Mode = CadTool;
type ArraySelection = { epoch: number; handles: string[] };
export type CadEditingHandle = {
  contentBounds(): { x: number; y: number; width: number; height: number } | null;
  pointUp(point: DrawingPoint, aperture: number, dragged: boolean): boolean;
  pointDown(
    point: DrawingPoint,
    aperture: number,
    orthogonal: boolean,
    additive?: boolean,
  ): boolean;
  click(point: DrawingPoint, additive: boolean, aperture: number, orthogonal?: boolean): void;
  hover(point: DrawingPoint, aperture: number, orthogonal: boolean): void;
  leave(): void;
  window(
    start: DrawingPoint,
    end: DrawingPoint,
    additive: boolean,
    aperture: number,
    previewOnly: boolean,
  ): void;
  selectPolygon(points: DrawingPoint[], additive: boolean): void;
  canWindow(): boolean;
  canTrimStroke(): boolean;
  trimStroke(path: DrawingPoint[], aperture: number, shift: boolean, previewOnly: boolean): void;
  beginGrip(point: DrawingPoint, aperture: number): boolean;
  canDragSelection(point: DrawingPoint, aperture: number): boolean;
  cancelDraft(): boolean;
  finish(): void;
  rightClick(): boolean;
  painted(checkpointId: string): void;
  isCommandPicking(): boolean;
  prepareLineUndo(commit?: boolean): boolean;
  prepareLineRedo(): boolean;
  closeLine(): boolean;
  cycleSnap(): boolean;
  assistPoint(point: DrawingPoint, aperture: number, hover: boolean): DrawingPoint;
  erase(): void;
  cancel(): void;
  selectHandles(handles: string[], additive?: boolean): void;
  selectAll(): void;
  editDetail(id: string): void;
  editText(point: DrawingPoint, aperture: number): void;
  copySelected(cut?: boolean): void;
  pasteSelected(): boolean;
  beginMove(point: DrawingPoint, aperture: number): boolean;
  endMove(point: DrawingPoint, aperture: number, orthogonal: boolean): void;
  labelGlyph(text: string, fontSize: number): Promise<CadScene>;
  flush(preserveDraft?: boolean): Promise<boolean>;
};
export type CadSelection = {
  scene: CadScene;
  handles: string[];
  objects?: CadPatentObject[];
  checkpointId?: string | undefined;
  /** Scene hydration/rebase, not a new selection made by the user. */
  passive?: boolean;
} | null;
type Props = {
  /** Retain legacy raster overlays and glyphs without CAD command UI or portals. */
  compatibilityOnly?: boolean;
  runtimeEnabled?: boolean;
  instructionTarget?: HTMLElement | null;
  settingsTarget?: HTMLElement | null;
  getCanvas?(): SVGSVGElement | null;
  detailTool?: {
    button: ReactNode;
    active: boolean;
    controlsOpen?: boolean;
    hint: string;
    controls: ReactNode;
    close?(): void;
  };
  ref: Ref<CadEditingHandle>;
  project: DrawingProject;
  sessionId: string;
  enabled: boolean;
  disabled: boolean;
  onEnabled(enabled: boolean): void;
  onSelection(selection: CadSelection): void;
  onTextEditing?(handles: string[]): void;
  onPreview(preview: CadPreview | null): void;
  onBusy(busy: boolean): void;
  onSaving?(pending: boolean): void;
  onWorkingScene?(
    scene: CadScene,
    objects: CadPatentObject[],
    sequence: number,
    projectId: string,
    command: string,
  ): void;
  onPendingDrawing?(drawing: PendingCadDrawing): void;
  onPaintedDrawing?(sequence: number): void;
  onDrawingActive?(active: boolean): void;
  onUndoSegment?(): void;
  onToolActive?(active: boolean): void;
  onObjectCursor?(active: boolean): void;
  onToolChosen?(): void;
  onRepeatTool?(): boolean;
  onError(message: string): void;
  onLoadError?(): void;
  retryGeneration?: number;
  onInside?(id: string | undefined): void;
  readCheckpoint?(id: string): Promise<Uint8Array | CadCheckpoint>;
  clipboard?: CadClipboardRef;
  checkpointScene?(id: string): CadScene | undefined;
  onNativeCommit?(data: Uint8Array | CadCheckpoint, scene: CadScene, metadata?: DrawingProject):
    { checkpointId: string; objects: CadPatentObject[]; scene: CadScene };
  onCommit(
    bytes: Uint8Array | CadCheckpoint,
    prepared: (checkpointId: string) => void,
    metadata?: DrawingProject,
    background?: boolean,
  ): Promise<{ bytes: Uint8Array | CadCheckpoint; objects: CadPatentObject[]; scene: CadScene }>;
};
const ArcIcon = createLucideIcon("CadArc", [["path", { d: "M4 20A16 16 0 0 1 20 4", key: "arc" }]]);
const JoinIcon = cadToolIcon("join", Combine);
const ExplodeIcon = cadToolIcon("explode", UnfoldHorizontal);
const GroupIcon = cadToolIcon("group", Group);
const UngroupIcon = cadToolIcon("ungroup", Ungroup);
const EXTRA_ICONS: Record<ExtraCadTool, LucideIcon> = {
  arc: cadToolIcon("arc", ArcIcon),
  ellipse: cadToolIcon("ellipse", Ellipse),
  polygon: cadToolIcon("polygon", Pentagon),
  mirror: cadToolIcon("mirror", FlipHorizontal2),
  break: ScissorsLineDashed,
  dimlinear: RulerDimensionLine,
  dimaligned: Ruler,
  dimradius: Radius,
  offset: BetweenHorizontalStart,
  trim: cadToolIcon("trim", Scissors),
  extend: cadToolIcon("extend", ArrowUpRight),
  fillet: cadToolIcon("fillet", CornerUpRight),
  chamfer: cadToolIcon("chamfer", CornerDownRight),
};
const TOOLS = [
  ["line", "直线", Minus],
  ["rectang", "矩形", cadToolIcon("rectang", Square)],
  ["polygon", "正多边形", cadToolIcon("polygon", Square)],
  ["circle", "圆", cadToolIcon("circle", Circle)],
  ["text", "文字", Type],
  ["move", "移动", Move],
  ["copy", "复制", Copy],
  ["rotate", "旋转", RotateCw],
  ["scale", "缩放", Scaling],
  ["spline", "样条曲线", Spline],
  ["arrayrect", "线性阵列", cadToolIcon("arrayrect", Grid2X2)],
  ["arraypolar", "圆周阵列", cadToolIcon("arraypolar", Orbit)],
  ["hatch", "剖面填充", cadToolIcon("hatch", PaintBucket)],
  ...EXTRA_CAD_TOOLS.filter(([id]) => id !== "polygon").map(
    ([id, label]) => [id, label, EXTRA_ICONS[id]] as const,
  ),
  ["gear", "齿轮", cadToolIcon("gear.external", Cog)],
  ["chain", "链条", cadToolIcon("chain.drive", Cog)],
  ["spring", "弹簧", cadToolIcon("spring", Spline)],
] as const;
const BACKGROUND_MODIFY_COMMANDS = new Set([
  "bridge.appearance",
  "move", "copy", "rotate", "scale", "mirror", "offset", "break", "fillet", "chamfer",
  "arrayrect", "arraypolar", "arraypath", "erase", "join", "group", "ungroup", "bridge.paste",
]);
const DRAW_COMMANDS = new Set([
  "chain",
  "gear",
  "spring",
  "line",
  "rectang",
  "circle",
  "text",
  "pline",
  "spline",
  "arc",
  "ellipse",
  "polygon",
]);
const DRAW_TOOL_IDS = new Set([...DRAW_COMMANDS, "dimlinear", "dimaligned", "dimradius"]);
const TOOL_GROUPS = [
  // Keep native dimension compatibility without offering dimension creation in patent drawings.
  { label: "绘图", tools: TOOLS.filter(([id]) => DRAW_COMMANDS.has(id)) },
  { label: "修改", tools: TOOLS.filter(([id]) => !DRAW_TOOL_IDS.has(id)) },
];
const MENU_TOOLS: Record<string, string[]> = {
  chain: ["chain"],
  gear: ["gear"],
  spring: ["spring"],
  rectang: ["rectang"], polygon: ["polygon"], circle: ["circle"], arc: ["arc"], ellipse: ["ellipse"],
  trim: ["trim", "extend"], fillet: ["fillet", "chamfer"], arrayrect: ["arrayrect", "arraypolar", "arraypath"],
};
function menuChoices(id: string): CadMenuChoice[] {
  return (MENU_TOOLS[id] ?? []).flatMap(tool => {
    const entry = TOOLS.find(t => t[0] === tool);
    const Icon = cadToolIcon(tool, entry?.[2] ?? Spline);
    return DRAW_METHODS[tool]?.map(m => ({ id: m.id, tool, Icon: cadToolIcon(m.id, Icon), label: tool === "polygon" ? `正多边形 · ${m.label}` : m.label })) ??
      [{ id: tool, tool, Icon, label: tool === "arrayrect" ? "矩形阵列" : tool === "arraypolar" ? "环形阵列" : tool === "arraypath" ? "路径阵列" : entry?.[1] ?? tool }];
  });
}

function extraHint(mode: Mode, count: number): string | undefined {
  const hints: Partial<Record<Mode, string[]>> = {
    arc: ["依次指定圆弧起点、经过点、终点。", "指定圆弧经过点。", "指定终点；预览显示实际圆弧。"],
    ellipse: [
      "依次指定中心、第一条轴端点、另一条轴半径；长短轴顺序不限。",
      "指定第一条轴端点，可以是长轴或短轴。",
      "指定另一条轴的半径，可以大于或小于第一条轴。",
    ],
    polygon: ["输入边数，再指定中心和外接圆半径。", "指定半径；预览显示实际多边形。"],
    mirror: ["先选择对象，再指定镜像轴的两个点。", "指定镜像轴另一点；虚线为镜像轴。"],
    break: ["只选择一个对象，再依次指定断开区间两端。", "指定断开区间另一端。"],
    dimlinear: [
      "依次指定两端测量点、尺寸线位置。",
      "指定第二测量点。",
      "指定尺寸线位置；虚线为定位辅助线。",
    ],
    dimaligned: [
      "依次指定两端测量点、尺寸线位置。",
      "指定第二测量点。",
      "指定尺寸线位置；虚线为定位辅助线。",
    ],
    dimradius: ["先选择一个圆或圆弧，再指定尺寸标注位置。"],
    offset: ["只选择一个对象，输入偏移距离，再点击偏移侧。"],
    trim: ["点击要移除的部分，或拖划栏选；Shift 临时延伸，右键 / Enter 结束。"],
    extend: ["先选择待延伸对象，再 Shift 选择边界；点击要延伸的一端。"],
    fillet: ["点击要处理的角，拖动圆弧上的控制点调整半径；Esc 结束。"],
    chamfer: ["点击要处理的角；中间控制点调整整体大小，两端控制点分别调整一侧。"],
    spline: ["依次指定曲线经过点；Enter 完成，Esc 取消。"],
  };
  const steps = hints[mode];
  return steps?.[Math.min(count, steps.length - 1)];
}

export function CadEditingPanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const client = useRef<CadcraftClient | null>(null);
  const [worker, setWorker] = useState<CadcraftClient | null>(null);
  const loadedWorker = useRef<CadcraftClient | null>(null);
  const recentHistoryScenes = useRef(new Map<string,CadScene>());
  function rememberHistoryScene(id: string | undefined, value: CadScene) {
    if(!id)return;
    recentHistoryScenes.current.delete(id);recentHistoryScenes.current.set(id,value);
    while(recentHistoryScenes.current.size>8)recentHistoryScenes.current.delete(recentHistoryScenes.current.keys().next().value!);
  }
  const workerRecovery = useRef<{
    instance: CadcraftClient;
    done: Promise<boolean>;
    finish(loaded: boolean): void;
  } | null>(null);
  const latestDrawingBytes = useRef<Uint8Array | CadCheckpoint | null>(null);
  const checkpointWorker = useRef<CadcraftClient | null>(null);
  async function materialize(draft: Uint8Array | CadCheckpoint): Promise<Uint8Array> {
    if (draft instanceof Uint8Array) return draft;
    checkpointWorker.current = ensureCadcraftClient(checkpointWorker.current);
    return checkpointWorker.current.request("materialize", draft);
  }
  useEffect(()=>()=>{checkpointWorker.current?.close();checkpointWorker.current=null;},[]);
  const [kernelReady, setReady] = useState(false);
  const [loadedCheckpoint, setLoadedCheckpoint] = useState<string>();
  const ready = kernelReady && loadedCheckpoint === props.project.cad?.assetId;
  const [working, setWorking] = useState(false);
  const [mode, setMode] = useState<Mode>("select");
  const [commandPicking, setCommandPicking] = useState(false);
  const trimPath = useRef<DrawingPoint[]>([]);
  const trimShift = useRef(false);
  const commandPickingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [handles, setHandles] = useState<string[]>([]);
  const selectedHandles = useMemo(() => new Set(handles), [handles]);
  const handlesRef = useRef(handles);
  handlesRef.current = handles;
  const scene = useRef<CadScene | null>(null);
  const anchor = useRef<DrawingPoint | null>(null);
  const windowStart = useRef<DrawingPoint | null>(null);
  const [windowSelecting, setWindowSelecting] = useState(false);
  const objectCursor = props.enabled && (mode === "trim" || mode === "extend") &&
    !trimPath.current.length;
  useLayoutEffect(() => { props.onObjectCursor?.(objectCursor); }, [objectCursor, props.onObjectCursor]);
  useLayoutEffect(() => {
    props.onToolActive?.(
      props.enabled && ((!commandPicking && mode !== "select") || windowSelecting),
    );
  }, [mode, commandPicking, windowSelecting, props.enabled, props.onToolActive]);
  const selectionPick = useRef<{ epoch: number; task: Promise<void>; window?: boolean } | null>(
    null,
  );
  const selectionCursor = useRef<{ page: DrawingPoint; aperture: number } | null>(null);
  const points = useRef<DrawingPoint[]>([]);
  const [methodId, setMethodId] = useState("");
  const methodRef = useRef("");
  const methodByTool = useRef(new Map<string, string>());
  const methodHandles = useRef<string[]>([]);
  const variantJob = useRef<{ preview: CadPreview; epoch: number; method: string; amount: number; handles: string[]; tolerance: number; gearHole: boolean; springWire: number | undefined } | null>(null);
  const variantBusy = useRef(false);
  const targetPoints = useRef(new Map<string, DrawingPoint>());
  const lineTrail = useRef<DrawingPoint[]>([]);
  const lineUndoRestore = useRef<DrawingPoint[] | null>(null);
  const lineRedoTrail = useRef<DrawingPoint[]>([]);
  const [pointCount, setPointCount] = useState(0);
  const snap = true;
  const [aidSettings] = useState<AidSettings>(() => ({
    ...DEFAULT_AID_SETTINGS,
    tracking: true,
    angle45: true,
    enabled: new Set(DEFAULT_AID_SETTINGS.enabled),
  }));
  const aids = useRef(new CadDraftingAids());
  const deferredTangent = useRef<DraftCurve | undefined>(undefined);
  const aidTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHover = useRef<{
    page: DrawingPoint;
    aperture: number;
    orthogonal: boolean;
    placement?: boolean;
  } | null>(null);
  const trimHover = useRef<{
    base: CadPreview;
    command: "trim" | "extend";
    at: DrawingPoint;
    bounds?: [number, number, number, number];
    visual: Pick<CadPreview, "trimOriginal" | "trimResult" | "curvePaths"> | null;
  } | null>(null);
  const trimExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTrimHover = useCallback(() => {
    clearTimeout(trimExitTimer.current);
    trimExitTimer.current = undefined;
    trimHover.current = null;
  }, []);
  const stopAidHover = useCallback(() => {
    clearTimeout(aidTimer.current);
    aidTimer.current = undefined;
    lastHover.current = null;
    aids.current.stopHover();
    clearTrimHover();
  }, [clearTrimHover]);
  const clearAidState = useCallback(() => {
    stopAidHover();
    aids.current.clear();
    deferredTangent.current = undefined;
  }, [stopAidHover]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Tool/session boundaries intentionally invalidate transient acquisition; the clear operation itself only uses refs.
  useLayoutEffect(() => {
    clearAidState();
  }, [mode, props.enabled, clearAidState]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "patent-workbench:cad-aids:v1",
        JSON.stringify({ ...aidSettings, enabled: [...aidSettings.enabled] }),
      );
    } catch {
      latest.current.onError("绘图辅助设置未能保存，本次使用不受影响。");
    }
  }, [aidSettings]);
  const lastTool = useRef<Mode | null>(null);
  const ownCheckpoint = useRef<string | null>(null);
  const pendingPaint = useRef<string | null>(null);
  const pendingGripHandoff = useRef(false);
  const [hint, setHint] = useState("点击或框选追加选择，Shift 移除选择；Esc 清除选择。");
  const [text, setText] = useState("");
  const [textDraft, setTextDraft] = useState<{
    page: DrawingPoint;
    at: DrawingPoint;
    width: number;
    rotation?: number | undefined;
    handle?: string;
    original?: {text:string;height:number;width:number};
  } | null>(null);
  const [pendingTexts, setPendingTexts] = useState<(NonNullable<typeof textDraft> & {id:number;text:string;height:number})[]>([]);
  const textSequence=useRef(0);
  const [textGripHandle,setTextGripHandle]=useState<string | null>(null);
  useEffect(()=>{
    latest.current.onTextEditing?.([textGripHandle,textDraft?.handle,...pendingTexts.map(d=>d.handle)].filter((h):h is string=>!!h));
  },[textDraft,pendingTexts,textGripHandle]);
  const textDraftRef = useRef<typeof textDraft>(null);
  const textValue = useRef("");
  const textPlacement = useRef<DrawingPoint | null>(null);
  function openText(draft: NonNullable<typeof textDraft>, value: string, height: number) {
    textDraftRef.current = draft;
    setTextDraft(draft);
    setText(value);
    textValue.current = value;
    setAmount(String(height));
    setSelection([]);
    latest.current.onPreview(null);
    setHint(platformShortcut("Enter 换行；Ctrl+Enter 或在文字外单击 / 右键完成；Esc 取消。"));
  }
  function finishText(save: boolean) {
    const draft = textDraftRef.current;
    if (!draft) return true;
    if (save && new TextEncoder().encode(textValue.current).byteLength > 200_000) {
      setHint("文字内容过长，请缩短文字或分成多个文字对象；当前内容仍可编辑。"); return false;
    }
    if (save && (!(Number(amount) > 0) || !Number.isFinite(Number(amount)))) {
      setHint("请输入大于 0 的有效字高，文字尚未提交。");
      return false;
    }
    if (save && (locked.current || props.disabled || !ready)) return false;
    const changed=!draft.original || draft.original.text!==textValue.current || draft.original.height!==Number(amount) || draft.original.width!==draft.width;
    if (save && changed && (textValue.current.trim() || draft.handle) && Number(amount) > 0) {
      const textId=++textSequence.current;
      if (!pipeline().enqueue({command:"bridge.text", textId, params: {
        ...(draft.handle ? {handle: draft.handle} : {at:[draft.at.x,draft.at.y]}),
        text: textValue.current, height:Number(amount), width:draft.width,
      }, inside:insideRef.current})) return false;
      setPendingTexts(previous=>[...previous,{...draft,id:textId,text:textValue.current,height:Number(amount)}]);
    }
    textDraftRef.current = null;
    setTextDraft(null);
    choose("select");
    return true;
  }
  const parameterInput = useRef<HTMLInputElement>(null);
  const parameterId = useId();
  const springWireId = useId();
  const [mirrorErase, setMirrorErase] = useState(() => {
    try {
      return localStorage.getItem("cad.mirror.delete-source") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (mode === "polygon" || mode === "gear" || mode === "spring" || mode === "chain") {
      parameterInput.current?.focus();
      parameterInput.current?.select();
    }
  }, [mode, methodId]);
  const [amount, setAmount] = useState("10");
  const scaleTyped = useRef(false);
  const pointerScaleFactor = useRef<number | null>(null);
  const scaleDisplay = useRef<{ update(value: string): void }>(null);
  const [gearHole, setGearHole] = useState(true);
  const [springWire, setSpringWire] = useState("");
  const [rectangleCorner,setRectangleCorner]=useState<NonNullable<RectangleOptions["corner"]>>("sharp");
  const [rectangleSize,setRectangleSize]=useState("1");
  const [rectangleSquare,setRectangleSquare]=useState(false);
  const rectangleOptions: RectangleOptions={corner:rectangleCorner,size:rectangleSize.trim()?Number(rectangleSize):NaN,square:rectangleSquare};
  const cornerActive=useRef<{target:CadCorner;value:CornerValue;fragmentId?:string|undefined} | null>(null);
  const cornerDrag=useRef<{target:CadCorner;value:CornerValue;index:number;fragmentId?:string|undefined}|null>(null);
  const refreshCorner=useRef<()=>void>(()=>{});
  refreshCorner.current=refreshAidHover;
  // A gear parameter change must refresh the retained pointer preview, not wait for mouse movement.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These are the inputs consumed by the retained gesture; pointer/session changes have their own refresh path.
  useEffect(()=>{if((mode==="gear"||mode==="spring"||mode==="chain"||mode==="scale"||mode==="rectang")&&lastHover.current) refreshAidHover();},[mode,amount,gearHole,springWire,methodId,rectangleCorner,rectangleSize,rectangleSquare]);
  const [patternPoint, setPatternPoint] = useState<DrawingPoint | null>(null);
  const [patternPath, setPatternPath] = useState<string>();
  const [hatchPoints, setHatchPoints] = useState<DrawingPoint[]>([]);
  const patternPreview = useRef<CadPreview | null>(null);
  const patternPanel = useRef<CadPatternHandle>(null);
  const toolAmounts = useRef(new Map<string, string>());
  const [inside, setInside] = useState<string>();
  const insideRef = useRef<string | undefined>(undefined);
  insideRef.current = inside;
  const localClipboard = useRef<CadClipboard | null>(null);
  const clipboard = props.clipboard ?? localClipboard;
  const pasteDraft = useRef<typeof clipboard.current>(null);
  function materializeClip(clip:CadClipboard) {
    clip.materialized ??= materialize(clip.bytes).catch(error=>{delete clip.materialized;throw error;});
    return clip.materialized;
  }
  const grip = useRef<{ handle: string; index: number } | null>(null);
  const rotationGesture = useRef<CadRotationGesture | null>(null);
  const gearGripJob = useRef<{preview:CadPreview;epoch:number;command?:{command:string;params:object};key?:string} | null>(null);
  const gearGripBusy = useRef(false);
  const gearGripVisual = useRef<{scene:CadScene;handle:string;primitives:CadScene["primitives"];hint:string} | null>(null);
  const locked = useRef(false);
  const gestureFragment = useRef<string | undefined>(undefined);
  const selectionEpoch = useRef(0);
  const toolChoiceEpoch = useRef(0);
  const loadedProject = useRef<string | null>(null);
  const restoredPicks = useRef<{checkpoint:string;project:string;epoch:number;instance:CadcraftClient;args:[DrawingPoint,boolean,number,boolean,boolean]}[]>([]);
  type MacIntent = { kind: "pick"; args: [DrawingPoint, boolean, number, boolean, boolean] }
    | { kind: "tool"; next: Mode; method?: string; activate: boolean };
  const macIntents = useRef(new MacCadIntents<MacIntent>());
  const macReplaying = useRef(false);
  const macPlannedMode = useRef<Mode | null>(null);
  const [macIntentVersion, wakeMacIntents] = useState(0);
  function clearMacIntents() {
    macIntents.current.clear();
    macPlannedMode.current = null;
  }
  const previewEpoch = useRef(0);
  const curveJob = useRef<{ preview: CadPreview; epoch: number } | null>(null);
  const curveBusy = useRef(false);
  const modifyJob = useRef<{
    preview: CadPreview;
    epoch: number;
    selectionEpoch: number;
    mode: Mode;
    picks: DrawingPoint[];
    amount: number;
    tolerance: number;
  } | null>(null);
  const modifyBusy = useRef(false);
  const mirrorLatestPreview = useRef<CadPreview | null>(null);
  const mirrorNativePreview = useRef<{context:number;scene:CadScene;paths:DrawingPoint[][]} | null>(null);
  const checkpointId = props.project.cad?.assetId;
  const sceneBindings = useRef<CadPatentObject[]>([]);
  const sceneCheckpoint = useRef<string | undefined>(undefined);
  const [drawingGeometryPending, setDrawingGeometryPending] = useState(false);
  const [drawingError, setDrawingError] = useState(false);
  const explodeFeedback = useRef<string | null>(null);
  const rejectedDrawing = useRef<string | null>(null);
  const pipelineDurable = useRef<{bytes:Uint8Array | CadCheckpoint;objects:CadPatentObject[];scene:CadScene;checkpointId?:string; native?: boolean} | null>(null);
  const pipelineProject = useRef<DrawingProject | null>(null);
  const paintedDrawing = useRef(new Map<string, number>());
  const drawingPipeline = useRef<CadDrawingPipeline<
    { command: string; params: object; inside?: string | undefined; textId?: number; clip?: NonNullable<typeof clipboard.current>; arraySelection?: ArraySelection },
    {
      command: string;
      bytes: Uint8Array | CadCheckpoint;
      scene: CadScene;
      metadata?: DrawingProject | undefined;
      unchanged?: boolean;
      arraySelection?: ArraySelection;
      hatchPreferences?: object;
      committed?: { bytes: Uint8Array | CadCheckpoint; objects: CadPatentObject[]; scene: CadScene;checkpointId?:string; native?: boolean };
    }
  > | null>(null);
  function pipeline() {
    drawingPipeline.current ??= new CadDrawingPipeline({
      byteLength: (result) => result.bytes instanceof Uint8Array ? result.bytes.byteLength : result.bytes.source.byteLength + result.bytes.edits.reduce((n,e)=>n+(e.paste?.byteLength ?? 0)+JSON.stringify(e.params).length*2,0),
      execute: async ({ command, params, inside: commandInside, textId, clip, arraySelection }, sequence) => {
        const instance = await restoredClient();
        const before = new Set(scene.current?.entities.map((entity) => entity.handle));
        rejectedDrawing.current = null;
        const currentProject = {
          ...(pipelineProject.current ?? latest.current.project),
          cad: { ...latest.current.project.cad!, objects: sceneBindings.current },
        };
        const context = clip || commandInside || sceneBindings.current.some(o => o.kind === "detail" && o.body !== undefined)
          ? {project:currentProject, before:[...before], inside:commandInside,
              ...(clip ? {clip:{project:clip.project,handles:clip.handles}} : {})}
          : undefined;
        const raw = await instance.request<{
          bytes?: Uint8Array;
          checkpoint?: CadCheckpoint;
          scene: CadScene;
          result?: Record<string, unknown> | null;
          metadata?: DrawingProject;
          rejected?: string;
        }>(clip ? "editPaste" : "edit", clip ? await materializeClip(clip) : command, params, ...(context ? [context] : []));
        if (raw.rejected) {
          rejectedDrawing.current = raw.rejected;
          pendingGripHandoff.current = false;
          setTextGripHandle(null);
          if (textId !== undefined) setPendingTexts(previous => previous.filter(item => item.id !== textId));
          setHint(raw.rejected);
          latest.current.onPreview(null);
          return {command,bytes:latestDrawingBytes.current!,scene:scene.current!,unchanged:true};
        }
        const draft = raw.checkpoint ?? raw.bytes;
        if (!draft) throw new Error("CAD 编辑未生成可恢复的快照。");
        const result = {...raw,bytes:draft,scene:scene.current?mergeCadScene(scene.current,raw.scene):raw.scene};
        if (clip && !Array.isArray(result.result?.handles))
          throw new Error("粘贴结果缺少对象对应信息，未保存修改。");
        if (command === "explode") {
          const skipped = (Array.isArray(result.result?.skipped) ? result.result.skipped.length : 0) + Number((params as {retained?: number}).retained ?? 0);
          const count = Number(result.result?.exploded ?? 0);
          const message = typeof result.result?.problem === "string" ? `分解未完成：${result.result.problem}原对象已保留。` : count
            ? `已分解 ${count} 个复合对象，生成 ${Array.isArray(result.result?.handles) ? result.result.handles.length : 0} 个独立对象。${skipped ? `${skipped} 个对象无法分解，已保留。` : ""}`
            : `所选 ${skipped || 1} 个对象无法分解，原对象已保留。`;
          if (modeRef.current === "select") { explodeFeedback.current = message; setHint(message); }
          if (result.result?.changed === false) return {...result, command, unchanged: true};
        }
        if ((command === "grip.move" || command === "bridge.gear_mesh" || command === "ungroup") && result.result?.changed === false) {
          pendingGripHandoff.current = false;
          latest.current.onPreview(null);
          return {...result,command,unchanged:true};
        }
        const metadata = raw.metadata ?? (clip
          ? pasteCadMetadata(currentProject, clip.project, clip.handles, result.result!.handles as string[],
              (params as {delta:[number,number]}).delta, [...before], result.scene.entities.map(e=>e.handle),
              ()=>crypto.randomUUID(), commandInside)
          : (commandInside || ["hatch", "hatchedit", "trim", "extend", "explode", "bridge.text", "bridge.gear", "bridge.spring", "bridge.chain", "bridge.corner"].includes(command) || BACKGROUND_MODIFY_COMMANDS.has(command))
            ? applyCadMutation(
                currentProject,
                {
                  command,
                  params: params as Record<string, unknown>,
                  result: result.result ?? null,
                  before: [...before],
                  after: result.scene.entities.map((e) => e.handle),
                  inside: commandInside,
                  primitives: result.scene.primitives,
                },
                () => crypto.randomUUID(),
              )
            : undefined);
        if (metadata?.cad?.objects) sceneBindings.current = metadata.cad.objects;
        if (metadata) pipelineProject.current = metadata;
        latestDrawingBytes.current = result.bytes;
        scene.current = result.scene;
        if(command==="bridge.corner"&&cornerActive.current){
          const active=cornerActive.current;
          const target=cornerCandidates(result.scene,active.value.kind).find(t=>t.existing&&Math.hypot(t.corner.x-active.target.corner.x,t.corner.y-active.target.corner.y)<1e-5&&[active.target.first.handle,active.target.second.handle].includes(t.first.handle)&&[active.target.first.handle,active.target.second.handle].includes(t.second.handle));
          cornerActive.current=target?{...active,target,value:target.value??active.value}:null;
          if(cornerActive.current){const amount=String(cornerActive.current.value.a);setAmount(amount);toolAmounts.current.set(active.value.kind,amount);}
          refreshCorner.current();
        }
        const presentHandles = new Set(result.scene.entities.map(entity => entity.handle));
        const retainedSelection = handlesRef.current.filter(handle => presentHandles.has(handle));
        if (retainedSelection.length !== handlesRef.current.length) {
          handlesRef.current = retainedSelection;
          setHandles(retainedSelection);
        }
        const created = new Set(
          result.scene.entities
            .filter((entity) => !before.has(entity.handle))
            .map((entity) => entity.handle),
        );
        const proxies = new Set(
          result.scene.groups
            ?.filter((group) => /^PW_LABEL_|^PW_DETAIL_.*_(?:FRAME|SOURCE)$/u.test(group.name))
            .flatMap((group) => group.members),
        );
        if (created.size && command !== "bridge.text")
          latest.current.onPendingDrawing?.({
            sequence,
            primitives: result.scene.primitives.filter(
              (primitive) => created.has(primitive.handle) && !proxies.has(primitive.handle),
            ),
            ...(command === "line" && anchor.current ? { lineAnchor: anchor.current } : {}),
            ...(command === "text"
              ? { text: params as { at: [number, number]; text: string; height: number } }
              : {}),
          });
        latest.current.onWorkingScene?.(
          result.scene,
          sceneBindings.current,
          sequence,
          latest.current.project.projectId,
          command,
        );
        if (textId !== undefined) setPendingTexts(previous=>previous.filter(item=>item.id!==textId));
        if (command === "grip.move") {pendingGripHandoff.current = false;setTextGripHandle(null);}
        if (modeRef.current === "select" || command === "offset" || command === "trim" || command === "extend") latest.current.onPreview(null);
        latest.current.onSelection({
          passive: true,
          scene: result.scene,
          handles: handlesRef.current,
          objects: sceneBindings.current,
          checkpointId: sceneCheckpoint.current,
        });
        return { ...result, command, metadata,
          ...(arraySelection && result.result?.changed !== false ? {arraySelection} : {}),
          ...(["hatch", "hatchedit"].includes(command) ? {hatchPreferences: params} : {}),
        };
      },
      save: async (result, sequence) => {
        if (result.unchanged) {
          // A no-op can be queued while a prior edit is being composed/saved. It
          // must still adopt that durable revision's regenerated semantic bindings.
          if (!pipelineDurable.current) return;
          result.committed = pipelineDurable.current;
        }
        if (!result.committed && latest.current.onNativeCommit && canAcceptNativeSnapshot(latest.current.project, result.metadata)) {
          const saved = latest.current.onNativeCommit(result.bytes, result.scene, result.metadata);
          ownCheckpoint.current = saved.checkpointId;
          setLoadedCheckpoint(saved.checkpointId);
          paintedDrawing.current.set(saved.checkpointId, sequence);
          result.committed = {...saved, bytes: result.bytes, native: true};
          pipelineDurable.current = result.committed;
        }
        if (!result.committed) {
          let checkpoint: string | undefined;
          const saved = await latest.current.onCommit(
            result.bytes,
            (id) => {
              checkpoint = id;
              ownCheckpoint.current = id;
              if (DRAW_COMMANDS.has(result.command.split(".")[0]!) && result.command !== "bridge.text")
                setLoadedCheckpoint(id);
              paintedDrawing.current.set(id, sequence);
            },
            result.metadata,
            true,
          );
          if (!checkpoint) throw new Error("CAD 工作稿尚未保存成功。");
          // A worker refresh can fail after a successful commit. Retrying that
          // refresh must not record the same edit a second time.
          result.committed = { bytes: saved.bytes, objects: saved.objects, scene: saved.scene, checkpointId:checkpoint };
          pipelineDurable.current = result.committed;
        }
        if (result.hatchPreferences) {
          rememberHatchPreferences(result.command, result.hatchPreferences);
          delete result.hatchPreferences;
        }
        const saved = result.committed;
        // Never rewind a worker that already contains a newer accepted stroke.
        if (drawingPipeline.current?.isLatest(sequence) && client.current) {
          const instance = await restoredClient();
          if (!drawingPipeline.current?.isLatest(sequence)) return;
          if (!saved.native) await instance.request("restore", saved.bytes, saved.checkpointId);
          else await instance.request("remember", saved.checkpointId, saved.bytes);
          const loaded = saved.scene;
          rememberHistoryScene(saved.checkpointId,loaded);
          latestDrawingBytes.current = saved.bytes;
          loadedWorker.current = instance;
          // Worker messages are FIFO: any point accepted during this load is
          // executed afterwards and must inherit these regenerated bindings.
          scene.current = loaded;
          // A completed array clears its selection, but must not erase a newer
          // selection or a tool's targets chosen while the checkpoint saved.
          handlesRef.current =
            result.arraySelection?.epoch === selectionEpoch.current &&
            result.arraySelection.handles === handlesRef.current
              ? []
              : remapPatentHandles(
                  sceneBindings.current,
                  saved.objects,
                  handlesRef.current,
                  new Set(loaded.entities.map((entity) => entity.handle)),
                );
          sceneBindings.current = saved.objects;
          sceneCheckpoint.current = saved.checkpointId;
          setHandles(handlesRef.current);
          latest.current.onSelection({
            passive: true,
            scene: loaded,
            handles: handlesRef.current,
            objects: saved.objects,
            checkpointId: sceneCheckpoint.current,
          });
        }
      },
      onPending: (pending) => {
        setDrawingGeometryPending(drawingPipeline.current?.geometryPending ?? false);
        latest.current.onSaving?.(pending);
        if (!pending) {
          pipelineDurable.current = null;
          pipelineProject.current = null;
          setDrawingError(false);
          if (rejectedDrawing.current) setHint(rejectedDrawing.current);
          else if (modeRef.current === "select" && !grip.current && !windowStart.current) setHint(explodeFeedback.current ?? "已保存。可继续绘图或选择对象。");
        }
      },
      onError: (error) => {
        clearMacIntents();
        pendingGripHandoff.current = false;
        latest.current.onPreview(null);
        setDrawingError(true);
        latest.current.onError(`绘图尚未保存，内容已保留。请重试保存。${error.message}`);
      },
    });
    return drawingPipeline.current;
  }
  async function restoredClient(): Promise<CadcraftClient> {
    while (client.current) {
      const recovery = workerRecovery.current;
      if (!recovery) break;
      const loaded = await recovery.done;
      if (recovery !== workerRecovery.current) continue;
      if (loaded && client.current === recovery.instance) return recovery.instance;
      throw new Error("CAD 图纸恢复未完成，请重新打开图纸后重试。");
    }
    throw new Error("CAD 编辑会话已关闭。");
  }
  const suspendedCheckpoint = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A user-requested retry replaces the worker while retaining the drawing pipeline and draft bytes.
  useEffect(() => {
    if (props.runtimeEnabled === false) {
      suspendedCheckpoint.current = sceneCheckpoint.current ?? null;
      setReady(false);
      setWorker(null);
      checkpointWorker.current?.close();
      checkpointWorker.current = null;
      return;
    }
    // Fast Refresh can retain a ref whose instance still has the old solver's prototype.
    aids.current = new CadDraftingAids();
    let instance: CadcraftClient;
    try {
      instance = new CadcraftClient();
    } catch (error) {
      setReady(false);
      latest.current.onError(error instanceof Error ? error.message : "CAD 编辑组件加载失败。");
      latest.current.onLoadError?.();
      return;
    }
    client.current = instance;
    let finish!: (loaded: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    workerRecovery.current = { instance, done, finish };
    setWorker(instance);
    // Fast Refresh preserves refs/state but replaces this native worker. An
    // acknowledgement from the old worker must never skip the new one's load.
    ownCheckpoint.current = null;
    setReady(false);
    return () => {
      clearMacIntents();
      finish(false);
      instance.close();
      client.current = null;
      if (latest.current.runtimeEnabled !== false) {
        latest.current.onSelection(null);
        latest.current.onPreview(null);
        latest.current.onToolActive?.(false);
      }
      stopAidHover();
    };
  }, [stopAidHover, props.retryGeneration, props.runtimeEnabled]);
  useEffect(() => {
    // This worker already contains our own saved revision. Reloading it would
    // discard the active LINE endpoint and repeat a costly parse after every point.
    if (
      checkpointId &&
      checkpointId === ownCheckpoint.current &&
      worker &&
      loadedWorker.current === worker
    ) {
      ownCheckpoint.current = null;
      sceneCheckpoint.current = checkpointId;
      setLoadedCheckpoint(checkpointId);
      setReady(true);
      workerRecovery.current?.finish(true);
      return;
    }
    const resumeInteraction = checkpointId != null && checkpointId === suspendedCheckpoint.current;
    setReady(false);
    if (!resumeInteraction) {
      clearMacIntents();
      pendingPaint.current = null;
      cornerActive.current = null;
      cornerDrag.current = null;
      clearTrimHover();
      selectionEpoch.current++;
      previewEpoch.current++;
      curveJob.current = null;
      const undoTrail = lineUndoRestore.current;
      lineUndoRestore.current = null;
      anchor.current = undoTrail?.at(-1) ?? null;
      windowStart.current = null;
      setWindowSelecting(false);
      points.current = [];
      grip.current = null;
      gestureFragment.current = undefined;
      rotationGesture.current = null;
      setPointCount(undoTrail?.length ?? 0);
      latest.current.onPreview(null);
    }
    let cancelled = false;
    const instance = worker;
    // Fast Refresh replaces the ref before React publishes the new worker state.
    // Never start a load on the disposed worker from that intermediate render.
    if (!checkpointId || !instance || instance !== client.current || instance.isClosed) return;
    void (async () => {
      // A hot replacement must inherit accepted, not-yet-durable strokes too.
      // Commands still in the pipeline remain queued until this load completes.
      const draft = drawingPipeline.current?.pending ? latestDrawingBytes.current : null;
      const retainedScene = !draft ? latest.current.checkpointScene?.(checkpointId) ?? recentHistoryScenes.current.get(checkpointId) : undefined;
      const checkout = retainedScene
        ? await instance.request<{restored?:boolean;checkpoint?:CadCheckpoint}>("checkout",checkpointId)
        : undefined;
      if(cancelled)return;
      let loaded: CadScene;
      let restoredBytes: Uint8Array | CadCheckpoint;
      if(checkout?.restored && checkout.checkpoint && retainedScene) {
        loaded=retainedScene;restoredBytes=checkout.checkpoint;
      } else {
        const result = draft
          ? { ok: true as const, value: draft }
          : latest.current.readCheckpoint
            ? { ok: true as const, value: await latest.current.readCheckpoint(checkpointId) }
            : await window.patentApi.assets.readDrawingSource(props.sessionId, checkpointId);
        if (!result.ok) throw new Error(result.error.message);
        if (cancelled) return;
        restoredBytes=result.value;
        loaded=retainedScene
          ? (await instance.request("restore",result.value,checkpointId),retainedScene)
          : await instance.request<CadScene>("load",result.value,checkpointId);
      }
      if (cancelled) return;
      loadedWorker.current = instance;
      loadedProject.current = latest.current.project.projectId;
      rememberHistoryScene(checkpointId,loaded);
      latestDrawingBytes.current = restoredBytes;
      scene.current = loaded;
      const objects = latest.current.project.cad?.objects ?? [];
      const retained = remapPatentHandles(
        sceneBindings.current,
        objects,
        handlesRef.current,
        new Set(loaded.entities.map((entity) => entity.handle)),
      );
      sceneBindings.current = objects;
      sceneCheckpoint.current = checkpointId;
      handlesRef.current = retained;
      setHandles(retained);
      latest.current.onSelection({ scene: loaded, handles: retained, objects, checkpointId, passive: true });
      setLoadedCheckpoint(checkpointId);
      suspendedCheckpoint.current = null;
      setReady(true);
      if (workerRecovery.current?.instance === instance) workerRecovery.current.finish(true);
    })().catch((error) => {
      if (!cancelled) {
        if (workerRecovery.current?.instance === instance) workerRecovery.current.finish(false);
        latest.current.onError(String(error));
        latest.current.onLoadError?.();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [checkpointId, props.sessionId, worker, clearTrimHover]);

  function choose(next: Mode, method?: string, activate = true) {
    if (isMacPlatform() && !macReplaying.current) {
      const picking = selectionPick.current?.epoch === selectionEpoch.current ? selectionPick.current : null;
      if ((drawingPipeline.current?.geometryPending || macIntents.current.pending || picking) &&
          modeRef.current === "select" && CAD_MODIFY_TARGETS.has(next)) {
        if (macIntents.current.push({kind: "tool", next, ...(method ? {method} : {}), activate})) {
          macPlannedMode.current = next;
          wakeMacIntents(value => value + 1);
          setHint("正在完成上一笔图形，随后继续选择；Esc 取消。");
          // A tool can be chosen before the worker has acknowledged its target.
          // Wake after that pick settles, so the following path click belongs to
          // the new tool rather than the old selection epoch.
          if (picking) void picking.task.then(() => wakeMacIntents(value => value + 1));
        }
        return;
      }
      clearMacIntents();
    }
    const choice = ++toolChoiceEpoch.current;
    const pending = selectionPick.current;
    if (modeRef.current === "select" && CAD_MODIFY_TARGETS.has(next) &&
        pending?.epoch === selectionEpoch.current) {
      // Preserve the user's object-then-tool sequence while worker picking finishes.
      // A newer tool, Escape, document switch or explicit selection cancels this intent.
      void pending.task.then(() => {
        if (choice === toolChoiceEpoch.current && pending.epoch === selectionEpoch.current &&
            latest.current.enabled) {
          if (selectionPick.current === pending) selectionPick.current = null;
          choose(next, method);
        }
      });
      return;
    }
    cornerActive.current=null;cornerDrag.current=null;
    if (textDraftRef.current && !finishText(true)) return;
    textPlacement.current=null;
    if (!pendingGripHandoff.current) setTextGripHandle(null);
    explodeFeedback.current = null;
    const nextMethod = method ?? methodByTool.current.get(next) ?? (next === "chain" ? "chain.drive" : next);
    methodByTool.current.set(next, nextMethod);
    methodRef.current = nextMethod;
    setMethodId(nextMethod);
    methodHandles.current = [];
    variantJob.current = null;
    setPatternPoint(null);
    setPatternPath(undefined);
    setHatchPoints([]);
    patternPreview.current = null;
    clearAidState();
    if (DRAW_COMMANDS.has(next) || next === "trim" || next === "extend" || next === "fillet" || next === "chamfer") setSelection([]);
    modeRef.current = next;
    latest.current.onDrawingActive?.(DRAW_COMMANDS.has(next) && !insideRef.current);
    pasteDraft.current = null;
    if (activate && next !== "select" && next !== "window") {
      lastTool.current = next;
      latest.current.onToolChosen?.();
    }
    selectionEpoch.current++;
    previewEpoch.current++;
    curveJob.current = null;
    gearGripVisual.current=null;gearGripJob.current=null;
    rotationGesture.current=null;
    props.onPreview(null);
    gestureFragment.current = undefined;
    anchor.current = null;
    scaleTyped.current = false;
    pointerScaleFactor.current = null;
    mirrorLatestPreview.current = null;
    mirrorNativePreview.current = null;
    windowStart.current = null;
    setWindowSelecting(false);
    selectionCursor.current = null;
    grip.current = null;
    points.current = [];
    lineTrail.current = [];
    lineRedoTrail.current = [];
    setPointCount(0);
    setMode(next);
    if (next === "polygon") {
      parameterInput.current?.focus();
      parameterInput.current?.select();
    }
    targetPoints.current.clear();
    trimPath.current = [];
    lineUndoRestore.current = null;
    const limit = cadTargetLimit(next);
    const picking =
      CAD_MODIFY_TARGETS.has(next) && next!=="fillet" && next!=="chamfer" &&
      (!handlesRef.current.length ||
        (Number.isFinite(limit) && handlesRef.current.length !== limit) ||
        limit === 2);
    commandPickingRef.current = picking;
    setCommandPicking(picking);
    if (picking) setSelection([]);
    // Direct dragging already owns the canvas pointer. Toolbar activation cancels it.
    if (activate) props.onEnabled(true);
    if (next === "polygon" || next === "text")
      setAmount(toolAmounts.current.get(next) ?? (next === "polygon" ? "6" : "10"));
    if (["offset", "fillet", "chamfer"].includes(next))
      setAmount(
        toolAmounts.current.get(next) ??
          String(10 / (props.project.cad?.mapping.scale ?? 1)),
      );
    if (drawMethod(nextMethod)?.parameter && next !== "polygon")
      setAmount(toolAmounts.current.get(nextMethod) ?? (nextMethod === "arc.sea" ? "90" : "10"));
    if (next === "gear") setAmount(toolAmounts.current.get(nextMethod) ?? "20");
    if (next === "chain") setAmount(toolAmounts.current.get(nextMethod) ?? "23");
    if (next === "spring") setAmount(toolAmounts.current.get(nextMethod) ?? (nextMethod === "spring.extension" ? "15" : "6"));
    if (next === "scale") setAmount("1");
    setHint(
      picking && (next === "trim" || next === "extend")
        ? "选择剪切边界；右键 / Enter 确认，直接确认使用全部对象。"
        : next === "explode"
          ? "选择要分解的对象；右键 / Enter 确认，Shift 移除，Esc 取消。"
        : picking
        ? limit === 2
          ? "点击第一个对象的保留侧。"
          : limit === 1
            ? "点击要修改的对象。"
            : "点击或框选要修改的对象；右键 / Enter 确认，Shift 移除，Esc 取消。"
        : next === "trim" || next === "extend"
          ? "点击要修改的部分，拖划或在空白处两点栏选；Shift 临时切换修剪/延伸。"
          : next === "rotate"
            ? "选择旋转基点。"
            : next === "scale"
              ? "选择缩放基点。"
              : ((nextMethod !== next || next === "rectang" ? drawMethod(nextMethod)?.steps[0] : undefined) ?? extraHint(next, 0) ??
                (next === "select"
                  ? "点击或框选追加选择，Shift 移除选择；右键重复上个工具，Esc 清除选择。"
                  : next === "text"
                    ? "单击放置文字，或按住拖动指定文字宽度。"
                    : next === "window"
                      ? "拖动框选，或依次点击两角；从右向左选择相交对象。"
                      : next === "line"
                        ? "指定起点，再连续指定下一点；右键 / Enter / 空格完成，Esc 结束。"
                        : next === "circle"
                          ? "点击圆心，再指定半径；移动鼠标可预览。"
                          : next === "move" || next === "copy"
                            ? "点击基点，再指定目标位置；按住 Shift 限制方向。"
                            : next === "pline" || next === "spline"
                              ? "依次指定各点；Enter / 空格 / 右键完成，Esc 结束。"
                              : "指定起点，再指定终点；按住 Shift 限制方向，Esc 结束。")),
    );
  }
  function setSelection(next: string[]) {
    const project = {...(pipelineProject.current ?? latest.current.project),
      cad:{...latest.current.project.cad!,objects:sceneBindings.current}};
    next = scopeCadSelection(project, next, insideRef.current);
    next = expandPatentSelection(project, next, insideRef.current);
    handlesRef.current = next;
    setHandles(next);
    if (scene.current)
      latest.current.onSelection({
        scene: scene.current,
        handles: next,
        objects: sceneBindings.current,
        checkpointId: sceneCheckpoint.current,
      });
    setHint(
      next.length
        ? `已选择 ${selectionCount(next)} 个对象。`
        : "点击或框选追加选择，Shift 移除选择；Esc 清除选择。",
    );
  }
  function selectionCount(next: string[]) {
    return new Set(
      next.map((handle) => {
        const owner = patentObjectAtHandle(sceneBindings.current, handle);
        return owner && !(insideRef.current === owner.object.id && owner.role === "body")
          ? `${owner.object.id}:${owner.role === "frame" ? "body" : owner.role}`
          : `native:${handle}`;
      }),
    ).size;
  }
  function trimParams(): Record<string, unknown> {
    return { mode: "quick" };
  }
  function trimCommand(shift: boolean): "trim" | "extend" {
    return (modeRef.current === "trim") !== shift ? "trim" : "extend";
  }
  function trimBatch(path: DrawingPoint[], shift: boolean) {
    if (path.length < 2 || !client.current || locked.current) return;
    clearTrimHover();
    const epoch = selectionEpoch.current;
    const command = trimCommand(shift);
    const params = { ...trimParams(), fence: path.map(p => [p.x, p.y]) };
    const instance = client.current;
    trimPath.current = [];
    latest.current.onPreview(null);
    const task = (async () => { try {
      // Native batch forms do not enumerate their targets. Inspect the exact native
      // result first so the same semantic-object and locked-layer guards still apply.
      const before = scene.current!;
      const result = await instance.request<CadScene>("query", "bridge.preview_modify", {command, params});
      if (epoch !== selectionEpoch.current || !latest.current.enabled) return;
      const { touched } = cadSceneDelta(before, result);
      const handles = before.entities.filter(e => touched.has(e.handle)).map(e => e.handle);
      await execute(command, {...params, handles});
    } catch (error) { if (epoch === selectionEpoch.current) setHint(`未完成本次操作：${String(error)}`); } })();
    selectionPick.current = {epoch, task};
    void task.finally(() => {if (selectionPick.current?.task === task) selectionPick.current = null;});
    return task;
  }
  async function execute(command: string, params: object) {
    if (command === "mirror") params = { ...params, erase: mirrorErase };
    if (locked.current || !ready || props.disabled || !client.current) return;
    clearTrimHover();
    if(command==="bridge.corner"){
      if(drawingPipeline.current?.geometryPending)return;
      pipeline().enqueue({command,params,inside:insideRef.current});
      return;
    }
    if (command === "bridge.gear_mesh") {
      if (drawingPipeline.current?.geometryPending) return;
      if (!pipeline().enqueue({command,params,inside:insideRef.current})) return;
      setHint((params as {enabled:boolean}).enabled ? "齿轮已啮合，可通过控制点转动任一齿轮。" : "已取消啮合，保留当前位置。");
      return;
    }
    if (command === "bridge.gear" || command === "bridge.spring" || command === "bridge.chain") {
      if (drawingPipeline.current?.geometryPending) return;
      if (!pipeline().enqueue({command,params,inside:insideRef.current})) return;
      if (!(params as {handle?:string}).handle) {choose("select");setSelection([]);}
      latest.current.onDrawingActive?.(false);
      setHint(command === "bridge.chain" ? "链轮已更新，可继续绘图。" : command === "bridge.spring" ? "弹簧已更新，可继续绘图。" : "齿轮已更新，可继续绘图。");
      return;
    }
    if (DRAW_COMMANDS.has(command.split(".")[0]!)) {
      if (!pipeline().enqueue({ command, params, inside: insideRef.current })) return;
      if (["rectang", "circle", "text", "arc", "ellipse", "polygon"].includes(command.split(".")[0]!)) {
        modeRef.current = "select";
        setMode("select");
      }
      if (command !== "line") latest.current.onDrawingActive?.(false);
      setHint(
        command === "line"
          ? "指定下一点；Enter / 空格完成，Esc 结束。"
          : "可继续绘图，工作稿正在后台保存。",
      );
      return;
    }
    if (drawingPipeline.current?.pending && !["grip.move", "hatch", "hatchedit", "trim", "extend", "explode"].includes(command) && !BACKGROUND_MODIFY_COMMANDS.has(command))
      return;
    if (command === "explode") {
      if (drawingPipeline.current?.geometryPending) return;
      const requested = (params as {handles:string[]}).handles;
      const inside = insideRef.current;
      const plan = planCadExplode({...pipelineProject.current ?? latest.current.project,
        cad:{...latest.current.project.cad!,objects:sceneBindings.current}},requested,inside);
      choose("select");
      setSelection([]);
      if (!plan.handles.length && !plan.details.length) { setHint("附图标号、单独的来源标记和图片局部放大不能直接分解，原对象已保留。"); return; }
      if (!pipeline().enqueue({command, params:{handles:plan.handles,
        ...(plan.details.length ? {details:plan.details} : {}),...(plan.retained ? {retained:plan.retained} : {})}, inside})) return;
      setHint("正在分解所选对象…");
      return;
    }
    const targets = params as { handles?: string[]; handle?: string; h1?: string; h2?: string };
    const edited = [...(targets.handles ?? []), targets.handle, targets.h1, targets.h2];
    const proxies =
      (pipelineProject.current ? sceneBindings.current : props.project.cad?.objects ?? sceneBindings.current).filter((o) =>
        [...(o.label ?? []), ...(o.frame ?? []), ...(o.source ?? [])].some((h) =>
          edited.includes(h),
        ),
      ) ?? [];
    if (
      proxies.length &&
      !["move", "copy", "rotate", "scale", "mirror", "erase", "bridge.paste", "bridge.appearance"].includes(command)
    ) {
      latest.current.onError("标号和详图标记请直接拖动夹点，或在选中后的标号、详图属性中修改。");
      return;
    }
    if (scene.current?.entities.some((e) => e.locked && edited.includes(e.handle))) {
      latest.current.onError("选中对象位于锁定图层，请先解锁图层。");
      return;
    }
    if (command === "trim" || command === "extend") {
      previewEpoch.current++;
      if (!pipeline().enqueue({command, params, inside: insideRef.current})) return;
      setHint("继续选择要修改的部分；Shift 临时切换，右键 / Enter 结束。");
      return;
    }
    if (command === "hatch" || command === "hatchedit") {
      if (
        drawingPipeline.current?.geometryPending ||
        !pipeline().enqueue({ command, params, inside: insideRef.current })
      )
        return;
      modeRef.current = "select";
      setMode("select");
      setHint("填充已确认，工作稿正在后台保存。");
      return;
    }
    if (command === "grip.move") {
      if (drawingPipeline.current?.geometryPending) return;
      previewEpoch.current++;
      gearGripJob.current = null;
      if (!pipeline().enqueue({ command, params, inside:insideRef.current })) return;
      pendingGripHandoff.current = true;
      setHint("夹点已更新，工作稿正在后台保存。");
      return;
    }
    if (BACKGROUND_MODIFY_COMMANDS.has(command)) {
      previewEpoch.current++;
      modifyJob.current = null;
      const clip = command === "bridge.paste" ? pasteDraft.current : undefined;
      if (command === "bridge.paste" && !clip) return;
      const arraySelection = isPatternTool(command) && command !== "hatch"
        ? { epoch: selectionEpoch.current, handles: handlesRef.current }
        : undefined;
      if (!pipeline().enqueue({
        command, params, inside: insideRef.current,
        ...(clip ? { clip } : {}),
        ...(arraySelection ? { arraySelection } : {}),
      })) return;
      if (clip) {pasteDraft.current = null; anchor.current = null;}
      if (["move", "break", "rotate", "scale", "arrayrect", "arraypolar", "arraypath", "bridge.paste"].includes(command)) {
        modeRef.current = "select";
        setMode("select");
      }
      if (command === "offset") {
        setSelection([]);
        commandPickingRef.current = true;
        setCommandPicking(true);
      }
      setHint(command==="offset" ? "选择下一个要偏移的对象；右键 / Enter 结束。" : "修改正在处理，可继续操作；工作稿在后台保存。");
      return;
    }
    locked.current = true;
    previewEpoch.current++;
    curveJob.current = null;
    setWorking(true);
    props.onBusy(true);
    try {
      const beforeScene = scene.current!;
      const beforeObjects = latest.current.project.cad?.objects ?? [];
      const clip = command === "bridge.paste" ? pasteDraft.current : null;
      const result = clip
        ? await client.current.request<{
            scene: CadScene;
            bytes: Uint8Array;
            result: Record<string, unknown> | null;
          }>("paste", await materializeClip(clip), params)
        : await client.current.request<{
            scene: CadScene;
            bytes: Uint8Array;
            result: Record<string, unknown> | null;
          }>("execute", command, params);
      if (clip && !Array.isArray(result.result?.handles))
        throw new Error("粘贴结果缺少对象对应信息，未保存修改。");
      const metadata = clip
        ? pasteCadMetadata(
            latest.current.project,
            clip.project,
            clip.handles,
            result.result!.handles as string[],
            (params as { delta: [number, number] }).delta,
            beforeScene.entities.map((e) => e.handle),
            result.scene.entities.map((e) => e.handle),
            () => crypto.randomUUID(),
            insideRef.current,
          )
        : applyCadMutation(
            latest.current.project,
            {
              command,
              params: params as Record<string, unknown>,
              result: result.result,
              before: beforeScene.entities.map((e) => e.handle),
              after: result.scene.entities.map((e) => e.handle),
              inside: insideRef.current,
              primitives: result.scene.primitives,
            },
            () => crypto.randomUUID(),
          );
      let savedCheckpoint: string | undefined;
      const saved = await latest.current.onCommit(
        result.bytes,
        (id) => {
          savedCheckpoint = id;
          ownCheckpoint.current = id;
          pendingPaint.current = id;
        },
        metadata,
      );
      await client.current.request("restore", saved.bytes);
      scene.current = saved.scene;
      loadedWorker.current = client.current;
      latestDrawingBytes.current = saved.bytes;
      setLoadedCheckpoint(savedCheckpoint);
      sceneBindings.current = saved.objects;
      sceneCheckpoint.current = savedCheckpoint ?? undefined;
      const present = new Set(scene.current.entities.map((e) => e.handle));
      const next = remapPatentHandles(beforeObjects, saved.objects, handlesRef.current, present);
      handlesRef.current = next;
      setHandles(next);
      latest.current.onSelection({
        scene: scene.current,
        handles: next,
        objects: saved.objects,
        checkpointId: sceneCheckpoint.current,
      });
      if (
        [
          "rectang",
          "circle",
          "text",
          "arc",
          "ellipse",
          "polygon",
          "move",
          "rotate",
          "scale",
          "arrayrect",
          "arraypolar",
          "arraypath",
          "hatch",
          "hatchedit",
        ].includes(command.split(".")[0]!)
      )
        setMode("select");
      if (clip) {
        pasteDraft.current = null;
        anchor.current = null;
        setMode("select");
      }
      setHint(
        (command === "line" && mode === "line") || (command === "copy" && mode === "copy")
          ? "指定下一点；Enter / 空格完成，Esc 结束。"
          : command === "trim" || command === "extend"
            ? "继续选择要修改的部分；Shift 临时切换，右键 / Enter 结束。"
            : "已保存。可继续绘图或选择对象。",
      );
    } catch (error) {
      ownCheckpoint.current = null;
      pendingPaint.current = null;
      anchor.current = null;
      points.current = [];
      setPointCount(0);
      latest.current.onPreview(null);
      // A failed checkpoint must not leave a hidden unsaved geometry revision in the worker.
      const current = latest.current.project.cad;
      if (current && client.current) {
        try {
          const saved = latest.current.readCheckpoint
            ? { ok: true as const, value: await latest.current.readCheckpoint(current.assetId) }
            : await window.patentApi.assets.readDrawingSource(props.sessionId, current.assetId);
          if (saved.ok) {
            scene.current = await client.current.request<CadScene>("load", saved.value);
            loadedWorker.current = client.current;
            latestDrawingBytes.current = saved.value;
            setSelection(handlesRef.current);
          } else setReady(false);
        } catch {
          setReady(false);
        }
      }
      latest.current.onError(error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false;
      setWorking(false);
      latest.current.onBusy(false);
    }
  }
  function pointer(
    page: DrawingPoint,
    aperture: number,
    exact = false,
    _orthogonal = false,
    hover = false,
  ) {
    const mapped =
      exact && props.project.cad
        ? {
            point: pageToCad(page, props.project.cad.mapping),
            tolerance: 1e-6,
            fragmentId: undefined,
          }
        : resolveCadPointer(props.project, page, aperture, gestureFragment.current);
    if (!mapped) return null;
    const chainEntity=grip.current&&scene.current?.entities.find(e=>e.handle===grip.current?.handle&&e.chain);
    if(chainEntity?.chain&&grip.current!.index>=(chainEntity.chain.single?1:3)) return {...mapped,snapped:false,snapType:undefined,aid:null};
    const gearEntity = grip.current && scene.current?.entities.find(e=>e.handle===grip.current?.handle && e.gear);
    if (gearEntity && grip.current!.index>0) {
      const center=gearEntity.grips?.[0];
      if(center && grip.current!.index===3) {
        const dx=mapped.point.x-center[0],dy=mapped.point.y-center[1],length=Math.hypot(dx,dy);
        const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*Math.PI/4;
        if(length>mapped.tolerance*2&&Math.hypot(dx-length*Math.cos(angle),dy-length*Math.sin(angle))<=mapped.tolerance) {
          const point={x:center[0]+length*Math.cos(angle),y:center[1]+length*Math.sin(angle)};
          return {...mapped,point,snapped:true,snapType:"polar" as const,aid:{point,type:"polar" as const,start:{x:center[0],y:center[1]},guides:[[{x:center[0],y:center[1]},point]] as [DrawingPoint,DrawingPoint][],references:[]}};
        }
      }
      return {...mapped,snapped:false,snapType:undefined,aid:null};
    }
    const gripFrom =
      mode === "select" && grip.current
        ? scene.current?.entities.find((entity) => entity.handle === grip.current?.handle)?.grips?.[
            grip.current.index
          ]
        : undefined;
    const start = gripFrom
      ? { x: gripFrom[0], y: gripFrom[1] }
      : (anchor.current ?? points.current.at(-1));
    const gripAxis: AidResult | null =
      !exact && gripFrom && start
        ? (() => {
            const deltaX = mapped.point.x - start.x;
            const deltaY = mapped.point.y - start.y;
            const horizontal =
              aidSettings.tracking &&
              Math.abs(deltaY) <= mapped.tolerance &&
              Math.abs(deltaX) > mapped.tolerance;
            const vertical =
              aidSettings.tracking &&
              Math.abs(deltaX) <= mapped.tolerance &&
              Math.abs(deltaY) > mapped.tolerance;
            if (!horizontal && !vertical) return null;
            const point = horizontal
              ? { x: mapped.point.x, y: start.y }
              : { x: start.x, y: mapped.point.y };
            return {
              point,
              type: "polar" as const,
              guides: [[start, point]] as [DrawingPoint, DrawingPoint][],
              references: [],
            };
          })()
        : null;
    const aid =
      !exact &&
      snap &&
      scene.current &&
      (mode !== "select" || !!grip.current) &&
      mode !== "window" &&
      mode !== "hatch" &&
      !commandPickingRef.current &&
      mode !== "trim" &&
      mode !== "extend"
        ? aids.current.resolve(
            mapped.point,
            scene.current,
            mapped.tolerance,
            {
              anchor: start ?? null,
              orthogonal: false,
              tangent: mode === "line" || mode === "pline",
              circle: mode === "circle" && methodRef.current === "circle",
              arc: mode === "arc" && methodRef.current === "arc" ? points.current : undefined,
              deferred: deferredTangent.current,
              hover,
            },
            aidSettings,
          )
        : null;
    const ownNode =
      !exact && snap && (mode === "spline" || mode === "pline")
        ? points.current.find(
            (p) => Math.hypot(p.x - mapped.point.x, p.y - mapped.point.y) <= mapped.tolerance,
          )
        : undefined;
    const chosen: AidResult | null = ownNode
      ? { point: ownNode, type: "endpoint", guides: [], references: [] }
      : aid?.type || aid?.invalid
        ? aid
        : (gripAxis ?? aid);
    const point = chosen?.point ?? mapped.point;
    return {
      ...mapped,
      point,
      snapped: !!chosen?.type && !chosen.invalid,
      snapType: chosen?.type,
      aid: chosen,
    };
  }
  function selectedGripAt(point: DrawingPoint, tolerance: number) {
    if (handlesRef.current.length > CAD_GRIP_OBJECT_LIMIT) return null;
    const selected = new Set(handlesRef.current);
    const protectedHandles = new Set(
      props.project.cad?.objects?.flatMap((object) => [
        ...(object.label ?? []),
        ...(object.frame ?? []),
        ...(object.source ?? []),
        ...(object.id === insideRef.current ? [] : (object.body ?? [])),
      ]),
    );
    let nearest: {
      handle: string;
      index: number;
      point: DrawingPoint;
      type: CadSnapType;
      distance: number;
    } | null = null;
    for (const entity of scene.current?.entities ?? []) {
      if (
        entity.locked ||
        entity.visible === false ||
        entity.type.toLowerCase() === "hatch" ||
        protectedHandles.has(entity.handle) ||
        !selected.has(entity.handle)
      )
        continue;
      for (const [index, [x, y]] of (entity.grips ?? []).entries()) {
        const distance = Math.hypot(x - point.x, y - point.y);
        if (distance <= tolerance && (!nearest || distance < nearest.distance))
          nearest = {
            handle: entity.handle,
            index,
            point: { x, y },
            type: cadGripSnapType(entity.type, index),
            distance,
          };
      }
    }
    return nearest;
  }
  function cornerAllowed(handle:string){const owner=patentObjectAtHandle(sceneBindings.current,handle);return !owner||(owner.role==="body"&&owner.object.id===insideRef.current);}
  function applyScaleFactor() {
    const factor = scaleTyped.current ? Number(amount) : pointerScaleFactor.current ?? Number(amount);
    if (mode !== "scale" || !anchor.current || commandPickingRef.current || disabled || drawingPipeline.current?.geometryPending || !(factor > 0) || !Number.isFinite(factor)) return;
    const base = [anchor.current.x, anchor.current.y];
    anchor.current = null;
    points.current = [];
    scaleTyped.current = false;
    void execute("scale", {handles: handlesRef.current, base, factor});
    props.getCanvas?.()?.focus({preventScroll: true});
  }
  function applyCornerAmount(){
    const active=cornerActive.current,n=Number(amount);if(!active||!(n>0)||!Number.isFinite(n)||drawingPipeline.current?.geometryPending)return;
    const value=clampCorner(active.target,{...active.value,a:n,b:active.value.kind==="chamfer"?active.value.b*n/active.value.a:active.value.b});
    cornerActive.current={...active,value};refreshCorner.current();void execute("bridge.corner",cornerGeometry(active.target,value).params);
    props.getCanvas?.()?.focus({preventScroll:true});
  }
  function paintCorner(mapped:NonNullable<ReturnType<typeof pointer>>,target:CadCorner,value:CornerValue,changing:boolean){
    const source=scene.current;if(!source)return;
    const change=changing?cornerGeometry(target,value):undefined;
    const affected=new Set([target.first.handle,target.second.handle,...(target.existing?[target.existing.handle]:[])]);
    const style=source.primitives.find(p=>p.handle===target.first.handle);
    latest.current.onPreview({mode:value.kind,scene:source,anchor:null,points:[],cursor:mapped.point,snapped:false,handles:[],fragmentId:mapped.fragmentId,
      cornerGrips:cornerGrips(target,value),cornerKind:value.kind,
      ...(change?{hideOriginal:true,trimOriginal:source.primitives.filter(p=>affected.has(p.handle)),trimResult:change.paths.map((path,i)=>({handle:`corner-${i}`,kind:"polyline",points:path.map(p=>[p.x,p.y] as [number,number]),color:style?.color??[0,0,0],aci7:style?.aci7??true,lineweight:style?.lineweight??0}))}:{})});
  }
  function currentTransform(cursor:DrawingPoint) {
    if(!anchor.current||(mode!=="rotate"&&mode!=="scale"))return null;
    if (mode === "scale" && scaleTyped.current) {
      const factor = Number(amount);
      return factor > 0 && Number.isFinite(factor)
        ? {command: "scale" as const, base: [anchor.current.x, anchor.current.y] as [number, number], factor}
        : null;
    }
    const transform=cadTransform(mode,anchor.current,points.current[0]??null,cursor);
    if(transform?.command==="rotate") {
      rotationGesture.current??=new CadRotationGesture(anchor.current,{x:anchor.current.x+1,y:anchor.current.y});
      transform.angle=rotationGesture.current.update(cursor);
    }
    return transform;
  }
  function publish(mapped: NonNullable<ReturnType<typeof pointer>>, window?: CadPreview["window"]) {
    if (!scene.current) return;
    if(mode==="fillet"||mode==="chamfer"){
      const dragging=cornerDrag.current;
      if(dragging){paintCorner(mapped,dragging.target,dragCorner(dragging.target,dragging.value,dragging.index,mapped.point),true);return;}
      const target=cornerAt(scene.current,mode,mapped.point,mapped.tolerance*1.6,cornerAllowed);
      const active=cornerActive.current;
      if(active)paintCorner(mapped,active.target,active.value,!active.target.existing);
      else if(target){const value=target.value??clampCorner(target,{kind:mode,a:Number(amount)||10,b:Number(amount)||10});paintCorner(mapped,target,value,!target.existing);}
      else latest.current.onPreview(null);
      return;
    }
    if (mode === "text" && textPlacement.current) {
      latest.current.onPreview({mode:"rectang",anchor:textPlacement.current,points:[],cursor:mapped.point,snapped:false,scene:scene.current,handles:[],fragmentId:mapped.fragmentId});
      return;
    }
    if (isPatternTool(mode) && !commandPickingRef.current) {
      if (mode === "hatch") patternPanel.current?.hover(mapped.point);
      latest.current.onPreview({
        ...(patternPreview.current ?? {
          mode,
          scene: scene.current,
          handles: [],
          anchor: null,
          points: [],
          fragmentId: mapped.fragmentId,
        }),
        cursor: mapped.point,
        snapped: mapped.snapped,
        snapType: mapped.snapType,
        guides: mapped.aid?.guides,
      });
      return;
    }
    const from =
      grip.current &&
      scene.current.entities.find((e) => e.handle === grip.current?.handle)?.grips?.[
        grip.current.index
      ];
    const preview: CadPreview = {
      mode: commandPickingRef.current ? "select" : mode,
      anchor: mapped.aid?.start ?? anchor.current,
      points: mode === "scale" ? [] : points.current.map((p, i) => (i === 0 && mapped.aid?.start ? mapped.aid.start : p)),
      cursor: mapped.point,
      snapped: mapped.snapped,
      snapType: mapped.snapType,
      guides: mapped.aid?.guides,
      references: mapped.aid?.references,
      invalid: mapped.aid?.invalid,
      problem: mapped.aid?.problem,
      scene: pasteDraft.current?.scene ?? scene.current,
      ...(pasteDraft.current ? {clipboardProject:pasteDraft.current.project} : {}),
      handles: pasteDraft.current?.handles ?? handlesRef.current,
      fragmentId: mapped.fragmentId,
      window,
      ...((mode === "trim" || mode === "extend") && trimPath.current.length ? {
        trimFence: [...trimPath.current, mapped.point],
      } : {}),
      ...(from ? { gripFrom: { x: from[0], y: from[1] } } : {}),
      ...(grip.current ? { gripTarget: grip.current } : {}),
      height: Number(amount),
      ...((mode === "rotate" || mode === "scale") && anchor.current
        ? {
            transform:
              currentTransform(mapped.point) ??
              undefined,
          }
        : {}),
    };
    if (preview.mode === "mirror") {
      const retained=mirrorNativePreview.current;
      if(retained?.context===selectionEpoch.current&&retained.scene===preview.scene)preview.curvePaths=retained.paths;
      mirrorLatestPreview.current=preview;
    }
    const gearTarget = grip.current ?? (mode === "select" && !window && !windowStart.current && !commandPickingRef.current ? selectedGripAt(mapped.point,mapped.tolerance) : null);
    const gripEntity=gearTarget&&scene.current.entities.find(e=>e.handle===gearTarget.handle);
    if(gripEntity&&gearTarget) preview.gripHint=cadGripLabel(gripEntity,gearTarget.index);
    const chainEntity=gearTarget&&scene.current.entities.find(e=>e.handle===gearTarget.handle&&e.chain);
    if(chainEntity?.chain&&gearTarget) {
      preview.gripHint=chainGripLabel(chainEntity.chain,gearTarget.index);
      if(grip.current){
        const originals=scene.current.primitives.filter(p=>p.handle===gearTarget.handle);
        preview.trimOriginal=originals;preview.hideOriginal=true;
        preview.trimResult=cadGripPreviewPaths(scene.current,gearTarget,mapped.point).map(path=>({...originals[0]!,kind:"polyline",points:path.map(p=>[p.x,p.y] as [number,number])}));
        latest.current.onPreview(preview);return;
      }
    }
    const gearEntity = gearTarget && scene.current.entities.find(e=>e.handle===gearTarget.handle&&e.gear);
    if (gearEntity?.gear && gearTarget) {
      preview.gearControl={handle:gearTarget.handle,index:gearTarget.index,point:mapped.point,active:!!grip.current};
      preview.gripHint = `${cadGearName(gearEntity)} · ${cadGearGripLabel(gearEntity.gear,gearTarget.index)}`;
      if (grip.current && (gearTarget.index>0 || gearEntity.gearMate)) {
        const meshHandles=cadGearSelection(scene.current,[gearTarget.handle]);
        const originals=scene.current.primitives.filter(p=>meshHandles.has(p.handle));
        preview.trimOriginal=originals;preview.hideOriginal=true;
        const paths=gearEntity.gearMate ? [] : cadGripPreviewPaths(scene.current,gearTarget,mapped.point);
        preview.trimResult=paths.length ? paths.map((path,i)=>({...originals[i]!,points:path.map(p=>[p.x,p.y] as [number,number])}))
          : gearGripVisual.current?.scene===scene.current&&gearGripVisual.current.handle===gearTarget.handle ? gearGripVisual.current.primitives : originals;
        const center=gearEntity.grips?.[0];
        if(gearTarget.index===2&&gearGripVisual.current?.scene===scene.current&&gearGripVisual.current.handle===gearTarget.handle)
          preview.gripHint=gearGripVisual.current.hint;
        if(center&&from&&gearTarget.index===1){
          const size=Math.min(1e8,Math.max(1e-5,gearEntity.gear.size*Math.hypot(mapped.point.x-center[0],mapped.point.y-center[1])/Math.hypot(from[0]-center[0],from[1]-center[1])));
          preview.gripHint=cadGearGripLabel({...gearEntity.gear,size},1);
        }
        if(center&&from&&gearTarget.index===3){
          rotationGesture.current??=new CadRotationGesture({x:center[0],y:center[1]},{x:from[0],y:from[1]});
          preview.rotationAngle=rotationGesture.current.update(mapped.point);
          const angle=(gearEntity.rotation??0)+preview.rotationAngle;
          preview.gripHint=`绕圆心旋转 · ${Number(angle.toFixed(1))}°`;
        }
        if(center)preview.guides=gearTarget.index===2&&from ? [[{x:from[0],y:from[1]},mapped.point]] : [[{x:center[0],y:center[1]},mapped.point]];
        latest.current.onPreview(preview);
        const epoch=++previewEpoch.current;
        if(gearTarget.index===2 || gearEntity.gearMate){gearGripJob.current={preview,epoch};void previewGearGrip();}
        return;
      }
    }
    const meshTransform=preview.transform
      ? {...preview.transform,handles:handlesRef.current}
      : mode==="move"&&preview.anchor ? {command:"move",handles:handlesRef.current,delta:[mapped.point.x-preview.anchor.x,mapped.point.y-preview.anchor.y]} : null;
    // Ordinary selections need no gear lookup per selected object. Scanning the
    // scene inside flatMap made every pointer sample quadratic for large drawings.
    const meshEntities = meshTransform && !commandPickingRef.current
      ? scene.current.entities.filter(e => e.gearMate && handlesRef.current.includes(e.handle)) : [];
    if (meshTransform && meshEntities.length) {
      const meshHandles = cadGearSelection(scene.current,handlesRef.current);
      const key=`${mode}:${handlesRef.current.join(",")}`;
      const retained=gearGripVisual.current;
      preview.trimOriginal=scene.current.primitives.filter(p=>meshHandles.has(p.handle));preview.hideOriginal=true;
      preview.trimResult=retained?.scene===scene.current&&retained.handle===key ? retained.primitives : preview.trimOriginal;
      latest.current.onPreview(preview);
      gearGripJob.current={preview,epoch:++previewEpoch.current,key,command:{command:meshTransform.command,params:meshTransform}};
      void previewGearGrip();return;
    }
    if (mode === "rectang") {
      const picks=[...points.current,mapped.point];
      try {
        const result=rectangleGeometry(methodRef.current,picks,rectangleOptions);
        preview.curvePaths=result ? [result.path] : points.current.length ? [picks] : [];
      } catch(error) {
        preview.curvePaths=[];
        preview.invalid=true;
        preview.problem=error instanceof Error?error.message:String(error);
      }
      latest.current.onPreview(preview);
      return;
    }
    const alternate = (methodRef.current !== mode || mode === "spring") && DRAW_COMMANDS.has(mode) && !!drawMethod(methodRef.current);
    if (alternate) preview.curvePaths = points.current.length ? [[...points.current, mapped.point]] : [];
    const trimming = (mode === "trim" || mode === "extend") &&
      !commandPickingRef.current && !trimPath.current.length;
    const trimOperation = trimCommand(lastHover.current?.orthogonal ?? false);
    if (trimming) {
      const previous = trimHover.current;
      if (!previous || previous.base.scene !== preview.scene || previous.command !== trimOperation ||
          previous.base.fragmentId !== preview.fragmentId) {
        clearTrimHover();
        trimHover.current = {base: preview, command: trimOperation, at: preview.cursor, visual: null};
      }
      trimHover.current!.base = preview;
      // Updating the pointer must not expose the unmodified backdrop while the
      // worker computes the next preview. Replace one completed result with another.
      latest.current.onPreview({...preview, ...trimHover.current!.visual});
    } else {
      clearTrimHover();
      latest.current.onPreview(preview);
    }
    const epoch = ++previewEpoch.current;
    if (alternate) {
      variantJob.current = { preview, epoch, method: methodRef.current, amount: Number(amount), handles: [...methodHandles.current], tolerance: mapped.tolerance, gearHole, springWire:springWire === "" ? undefined : Number(springWire) };
      void previewVariant();
    }
    if (mode === "spline" && points.current.length) {
      curveJob.current = { preview, epoch };
      void previewCurve();
    }
    if (["mirror", "offset", "break", "fillet", "chamfer", "trim", "extend"].includes(mode) && !((mode === "trim" || mode === "extend") && !trimming)) {
      modifyJob.current = {
        preview,
        epoch,
        selectionEpoch: selectionEpoch.current,
        mode:
          (mode === "trim" || mode === "extend") && lastHover.current?.orthogonal
            ? mode === "trim"
              ? "extend"
              : "trim"
            : mode,
        picks: [...points.current],
        amount: Number(amount),
        tolerance: mapped.tolerance,
      };
      void previewModify();
    }
  }
  function missTrimHover(preview: CadPreview, tolerance: number) {
    const retained = trimHover.current;
    if (!retained?.visual || retained.base.scene !== preview.scene) return;
    const clear = () => {
      trimExitTimer.current = undefined;
      if (trimHover.current !== retained || scene.current !== retained.base.scene || !latest.current.enabled) return;
      retained.visual = null;
      latest.current.onPreview(retained.base);
    };
    // A small boundary wobble should not flash the line. Definite departures
    // clear immediately, and a stationary miss expires without another mousemove.
    const [left, bottom, right, top] = retained.bounds ?? [retained.at.x, retained.at.y, retained.at.x, retained.at.y];
    const distance = Math.hypot(Math.max(left - preview.cursor.x, 0, preview.cursor.x - right),
      Math.max(bottom - preview.cursor.y, 0, preview.cursor.y - top));
    if (distance > tolerance * 2.5) {
      clearTimeout(trimExitTimer.current);
      clear();
    } else if (trimExitTimer.current === undefined) {
      trimExitTimer.current = setTimeout(clear, 75);
    }
  }
  async function previewVariant() {
    if (variantBusy.current || !client.current) return;
    variantBusy.current = true;
    try {
      while (variantJob.current && client.current) {
        const job = variantJob.current;
        variantJob.current = null;
        try {
          const definition = drawMethod(job.method)!;
          const hs = job.handles;
          if (definition.picks) {
            const hit = await client.current.request<string | undefined>("pick", job.preview.cursor.x, job.preview.cursor.y, job.tolerance);
            if (!hit) continue;
            hs.push(hit);
          }
          const previewPoints = [...job.preview.points, job.preview.cursor];
          const compiled = job.method === "ellipse.arc" && previewPoints.length >= 3 && previewPoints.length < 5
            ? compileDrawMethod("ellipse.axis", previewPoints.slice(0, 3), job.amount)
            : compileDrawMethod(job.method, previewPoints, job.amount, hs, {gearHole:job.gearHole,springWire:job.springWire});
          if (!compiled || job.epoch !== previewEpoch.current) continue;
          const result = await client.current.request<CadScene>("query", "bridge.preview_draw", compiled);
          if (job.epoch !== previewEpoch.current || !latest.current.enabled) continue;
          latest.current.onPreview({ ...job.preview, curvePaths: result.primitives.map(p => p.points.map(([x, y]) => ({ x, y }))) });
        } catch {
          if (job.epoch === previewEpoch.current)
            latest.current.onPreview({ ...job.preview, curvePaths: [], invalid: true, problem: "此位置无法生成图形，请调整位置或参数。" });
        }
      }
    } finally { variantBusy.current = false; }
  }
  async function previewGearGrip() {
    if(gearGripBusy.current||!client.current)return;
    gearGripBusy.current=true;
    try {
      while(gearGripJob.current&&client.current){
        const job=gearGripJob.current;gearGripJob.current=null;
        if(job.epoch!==previewEpoch.current||(!job.preview.gripTarget&&!job.command))continue;
        try {
          const result=await client.current.request<CadScene>("query",job.command?"bridge.preview_modify":"bridge.preview_draw",job.command?{...job.command,compact:true}:{command:"grip.move",params:{...job.preview.gripTarget,to:[job.preview.cursor.x,job.preview.cursor.y],...(job.preview.rotationAngle!==undefined?{angle:job.preview.rotationAngle}:{})}});
          if(job.epoch!==previewEpoch.current||(!job.command&&!grip.current)||!latest.current.enabled)continue;
          const entity=result.entities.find(e=>e.handle===job.preview.gripTarget?.handle);
          const hint=entity?.gear ? job.preview.gripTarget?.index===3 ? `绕圆心旋转 · ${Number((entity.rotation??0).toFixed(1))}°` : cadGearGripLabel(entity.gear,job.preview.gripTarget?.index??0) : job.preview.gripHint??"";
          const primitives=result.primitives.length ? result.primitives : job.preview.trimOriginal??[];
          gearGripVisual.current={scene:job.preview.scene,handle:job.key??job.preview.gripTarget!.handle,primitives,hint};
          latest.current.onPreview({...job.preview,trimResult:primitives,gripHint:hint});
        }catch(error){if(job.epoch===previewEpoch.current)latest.current.onPreview({...job.preview,invalid:true,problem:error instanceof Error?error.message:"无法预览齿数，请调整控制点。"});}
      }
    }finally{gearGripBusy.current=false;}
  }
  async function previewModify() {
    if (modifyBusy.current || !client.current) return;
    modifyBusy.current = true;
    try {
      while (modifyJob.current && client.current) {
        const job = modifyJob.current;
        modifyJob.current = null;
        if (job.epoch !== previewEpoch.current || locked.current) continue;
        let compiled: { command: string; params: Record<string, unknown> } | null = null;
        try {
          if (job.mode === "trim" || job.mode === "extend") {
            const p = job.preview.cursor;
            const handle = await client.current.request<string | undefined>(
              "pick",
              p.x,
              p.y,
              job.tolerance,
              ...(job.mode === "trim" ? ["trim"] : []),
            );
            if (job.epoch !== previewEpoch.current) continue;
            if (!handle) missTrimHover(job.preview, job.tolerance);
            if (handle)
              compiled = {
                command: job.mode,
                params: { handle, pick: [p.x, p.y], ...trimParams() },
              };
          } else if (
            commandPickingRef.current &&
            (job.mode === "fillet" || job.mode === "chamfer") &&
            targetPoints.current.size === 1 &&
            handlesRef.current.length === 1
          ) {
            const p = job.preview.cursor;
            const handle = await client.current.request<string | undefined>(
              "pick",
              p.x,
              p.y,
              job.tolerance,
            );
            if (handle && handle !== handlesRef.current[0])
              compiled = compileCadGesture(
                job.mode,
                [targetPoints.current.values().next().value!, p],
                [handlesRef.current[0]!, handle],
                job.amount,
              );
          } else if (!commandPickingRef.current) {
            compiled = compileCadGesture(
              job.mode as ExtraCadTool,
              [...job.picks, job.preview.cursor],
              job.preview.handles,
              job.amount,
            );
          }
          const mirrorCurrent = () => job.mode === "mirror" && !!mirrorLatestPreview.current && modeRef.current === "mirror" && job.selectionEpoch === selectionEpoch.current && job.preview.scene === scene.current;
          if (!compiled || (job.epoch !== previewEpoch.current && !mirrorCurrent())) continue;
          if (compiled.command === "mirror") {
            const selected = new Set(job.preview.handles);
            const nativeHandles = job.preview.scene.entities.filter(e=>selected.has(e.handle)&&!affineMirrorType(e.type)).map(e=>e.handle);
            if (!nativeHandles.length) continue;
            compiled.params = {...compiled.params,handles:nativeHandles,erase:mirrorErase};
          }
          const result = await client.current.request<CadScene>(
            "query",
            "bridge.preview_modify",
            {...compiled,compact:true},
          );
          if ((job.epoch !== previewEpoch.current && !mirrorCurrent()) || !latest.current.enabled || locked.current)
            continue;
          const {changed, touched} = cadSceneDelta(job.preview.scene, result);
          const completed: CadPreview = {
            ...(mirrorCurrent() ? mirrorLatestPreview.current ?? job.preview : job.preview),
            ...(["trim","break"].includes(job.mode) ? {
              trimOriginal: job.preview.scene.primitives.filter(p => touched.has(p.handle)),
              trimResult: result.primitives.filter(p => changed.has(p.handle)),
            } : {}),
            curvePaths: ["trim","break"].includes(job.mode) ? [] : result.primitives
              .filter((p) => changed.has(p.handle))
              .map((p) => p.points.map(([x, y]) => ({ x, y }))),
          };
          if (mirrorCurrent()) mirrorNativePreview.current={context:job.selectionEpoch,scene:job.preview.scene,paths:completed.curvePaths??[]};
          if (job.mode === "trim" || job.mode === "extend") {
            const retained = trimHover.current;
            if (!retained || retained.command !== job.mode || retained.base.scene !== job.preview.scene) continue;
            if (!touched.size) {missTrimHover(job.preview, job.tolerance); continue;}
            clearTimeout(trimExitTimer.current);
            trimExitTimer.current = undefined;
            retained.at = job.preview.cursor;
            const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
            const include = (x: number, y: number) => {
              bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
              bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
            };
            for (const primitive of completed.trimOriginal ?? []) for (const [x,y] of primitive.points) include(x,y);
            for (const path of completed.curvePaths ?? []) for (const point of path) include(point.x,point.y);
            if (Number.isFinite(bounds[0])) retained.bounds = bounds;
            retained.visual = {
              curvePaths: completed.curvePaths ?? [],
              ...(completed.trimOriginal ? {trimOriginal: completed.trimOriginal} : {}),
              ...(completed.trimResult ? {trimResult: completed.trimResult} : {}),
            };
          }
          latest.current.onPreview(completed);
        } catch {
          // Invalid prospective geometry is not a failed edit and never enters history.
          if (job.epoch === previewEpoch.current && (job.mode === "trim" || job.mode === "extend"))
            missTrimHover(job.preview, job.tolerance);
        }
      }
    } finally {
      modifyBusy.current = false;
    }
  }
  async function previewCurve() {
    if (curveBusy.current || !client.current) return;
    curveBusy.current = true;
    try {
      while (curveJob.current && client.current) {
        const job = curveJob.current;
        curveJob.current = null;
        const result = await client.current.request<CadScene>("query", "bridge.preview_spline", {
          fit: [...job.preview.points, job.preview.cursor].map((p) => [p.x, p.y]),
        });
        if (previewEpoch.current === job.epoch && latest.current.enabled)
          latest.current.onPreview({
            ...job.preview,
            curvePaths: result.primitives.map((p) => p.points.map(([x, y]) => ({ x, y }))),
          });
      }
    } catch {
      // Degenerate cursor positions have no valid curve; committed geometry is untouched.
    } finally {
      curveBusy.current = false;
    }
  }
  function scheduleAidHover(delay: number | undefined) {
    clearTimeout(aidTimer.current);
    aidTimer.current = undefined;
    if (delay !== undefined) aidTimer.current = setTimeout(refreshAidHover, Math.max(1, delay));
  }
  function refreshAidHover() {
    const saved = lastHover.current;
    if (!saved || !client.current || locked.current || latest.current.disabled) return;
    if (saved.placement) {
      assistPoint(saved.page, saved.aperture, true);
      return;
    }
    const mapped = pointer(saved.page, saved.aperture, false, saved.orthogonal, true);
    if (mapped) {
      publish(mapped);
      scheduleAidHover(mapped.aid?.delay);
    }
  }
  function assistPoint(page: DrawingPoint, aperture: number, hover: boolean): DrawingPoint {
    if (!ready || props.disabled || !snap || !scene.current || !props.project.cad) return page;
    const mapped = resolveCadPointer(props.project, page, aperture);
    if (!mapped) return page;
    const result = aids.current.resolve(
      mapped.point,
      scene.current,
      mapped.tolerance,
      { hover },
      aidSettings,
    );
    if (hover) {
      lastHover.current = { page, aperture, orthogonal: false, placement: true };
      latest.current.onPreview({
        mode: "select",
        anchor: null,
        points: [],
        cursor: result.point,
        snapped: !!result.type && !result.invalid,
        snapType: result.type,
        guides: result.guides,
        references: result.references,
        invalid: result.invalid,
        problem: result.problem,
        scene: scene.current,
        handles: [],
        fragmentId: mapped.fragmentId,
      });
      scheduleAidHover(result.delay);
    }
    return cadToPage(result.point, props.project.cad.mapping);
  }
  function click(
    page: DrawingPoint,
    additive: boolean,
    aperture: number,
    exact = false,
    orthogonal = false,
    pickOnly = false,
  ) {
    if (isMacPlatform() && !macReplaying.current && ready && !locked.current &&
        !props.disabled && props.enabled && !drawingError &&
        (drawingPipeline.current?.geometryPending || macIntents.current.pending)) {
      const intended = macPlannedMode.current ?? modeRef.current;
      // Only retain selection/array anchors, never drawing, grip moves or an edit confirmation.
      if (intended === "select" || intended === "arraypath" || intended === "arraypolar") {
        if (macIntents.current.push({kind: "pick", args: [{...page}, additive, aperture, exact, orthogonal]}))
          wakeMacIntents(value => value + 1);
        setHint("正在完成上一笔图形，随后继续选择；Esc 取消。");
        return;
      }
    }
    if(!ready) {
      // History has already repainted the saved scene, but its editing worker may still be restoring.
      // Retain selection intent only, never an edit or a click from another drawing/session.
      if(modeRef.current==="select"&&props.enabled&&!props.disabled&&props.project.cad&&client.current&&loadedWorker.current===client.current&&loadedProject.current===props.project.projectId)
        restoredPicks.current.push({checkpoint:props.project.cad.assetId,project:props.project.projectId,epoch:selectionEpoch.current,instance:client.current,args:[page,additive,aperture,exact,orthogonal]});
      return;
    }
    if (locked.current || props.disabled || !props.project.cad || !client.current) return;
    if (textDraftRef.current) {
      finishText(true);
      return;
    }
    if (
      drawingError ||
      (drawingPipeline.current?.pending &&
        !DRAW_COMMANDS.has(mode) &&
        mode !== "trim" && mode !== "extend" && mode!=="fillet" && mode!=="chamfer" &&
        !(BACKGROUND_MODIFY_COMMANDS.has(mode) && !drawingPipeline.current.geometryPending) &&
        !(mode === "select" && !drawingPipeline.current.geometryPending))
    )
      return;
    // Picking runs in the worker. Keep rapid clicks ordered until we know
    // whether the first click hit an object or started a two-corner window.
    const pendingPick = selectionPick.current;
    if (
      (mode === "select" || mode === "trim" || mode === "extend" || commandPickingRef.current) &&
      pendingPick?.epoch === selectionEpoch.current
    ) {
      void pendingPick.task.then(() => {
        if (selectionEpoch.current === pendingPick.epoch && modeRef.current === mode)
          click(page, additive, aperture, exact, orthogonal, pickOnly);
      });
      return;
    }
    const mapped = pointer(page, aperture, exact, orthogonal);
    if (!mapped) {
      setHint("请在画布中的可见图形上操作。");
      return;
    }
    const point = mapped.point;
    if(mode==="fillet"||mode==="chamfer"){
      if(drawingPipeline.current?.geometryPending)return;
      const target=cornerAt(scene.current!,mode,point,mapped.tolerance*1.6,cornerAllowed);
      if(!target){setHint("请点击两条直边相接的角，或已有的圆角/倒角。");return;}
      const value=target.value??clampCorner(target,{kind:mode,a:Number(amount)||10,b:Number(amount)||10});
      cornerActive.current={target,value,fragmentId:mapped.fragmentId};
      paintCorner(mapped,target,value,!target.existing);
      setHint(mode==="fillet"?"拖动圆弧上的控制点调整半径；点击其他角可继续。":"拖动中间点调整整体大小；两端点分别调整一侧，形成倾斜倒角。");
      if(!target.existing)void execute("bridge.corner",cornerGeometry(target,value).params);
      return;
    }
    if (mode === "rectang") {
      if (modeRef.current !== mode) return;
      try {
        const next=[...points.current,point];
        if (next.length === 2 && Math.hypot(point.x-next[0]!.x,point.y-next[0]!.y)<1e-9)
          throw new Error("请指定不同的位置。");
        const result=rectangleGeometry(methodRef.current,next,rectangleOptions);
        gestureFragment.current ??= mapped.fragmentId;
        if (result) {
          // Keep the final lightweight preview until the pipeline hands over its optimistic scene.
          publish(mapped);
          points.current=[];
          anchor.current=null;
          setPointCount(0);
          void execute(result.command,result.params);
          gestureFragment.current=undefined;
        } else {
          points.current=next;
          anchor.current=point;
          setPointCount(next.length);
          setHint(drawMethod(methodRef.current)?.steps[next.length] ?? "指定下一点。");
          publish(mapped);
        }
      } catch(error) {
        setHint(error instanceof Error?error.message:String(error));
      }
      return;
    }
    if ((methodRef.current !== mode || mode === "spring") && DRAW_COMMANDS.has(mode) && drawMethod(methodRef.current)) {
      const definition = drawMethod(methodRef.current)!;
      const epoch = selectionEpoch.current;
      const method = methodRef.current;
      const accept = async () => {
        try {
          const h = definition.picks ? await client.current!.request<string | undefined>("pick", point.x, point.y, mapped.tolerance) : undefined;
          if (epoch !== selectionEpoch.current || method !== methodRef.current || modeRef.current !== mode) return;
          if (definition.picks && !h) { setHint("请靠近要相切的线条或圆点击。"); return; }
          const next = [...points.current, point], hs = [...methodHandles.current, ...(h ? [h] : [])];
          const compiled = compileDrawMethod(method, next, Number(amount), hs, {gearHole,springWire:springWire === "" ? undefined : Number(springWire)});
          if (compiled) {
            // Validate in an isolated native preview before enqueueing a durable edit.
            await client.current!.request("query", "bridge.preview_draw", compiled);
            if (epoch !== selectionEpoch.current || method !== methodRef.current || modeRef.current !== mode) return;
            previewEpoch.current++;
            variantJob.current = null;
            points.current = []; methodHandles.current = []; setPointCount(0);
            await execute(compiled.command, compiled.params);
          } else {
            points.current = next; methodHandles.current = hs; setPointCount(next.length);
            setHint(definition.steps[next.length] ?? "指定下一点。");
          }
        } catch (e) { if (epoch === selectionEpoch.current) setHint(`无法生成图形，请调整位置或参数。${String(e)}`); }
      };
      const pending = selectionPick.current?.task ?? Promise.resolve();
      const task = pending.then(accept);
      selectionPick.current = { epoch, task };
      void task.finally(() => { if (selectionPick.current?.task === task) selectionPick.current = null; });
      return;
    }
    if (mapped.aid?.invalid) {
      setHint(mapped.aid.problem ?? "此位置无法形成切线，请移到圆外或选择其他切线方向。");
      publish(mapped);
      return;
    }
    if (mapped.aid?.deferred && !deferredTangent.current) {
      deferredTangent.current = mapped.aid.deferred;
      setHint("待定相切：指定圆外终点或另一圆；Tab 切换切线，Esc 取消。");
    }
    gestureFragment.current ??= mapped.fragmentId;
    publish(mapped);
    if (
      (mode === "select" || mode === "window" || commandPickingRef.current) &&
      windowStart.current
    ) {
      const start = windowStart.current;
      windowStart.current = null;
      setWindowSelecting(false);
      anchor.current = null;
      selectWindow(start, page, additive, aperture);
      return;
    }
    if (mode === "select" || commandPickingRef.current) {
      if (!pickOnly && !commandPickingRef.current && grip.current) {
        const selectedGrip = grip.current;
        const angle=selectedGrip.index===3?rotationGesture.current?.update(point):undefined;
        grip.current = null;
        rotationGesture.current=null;
        void execute("grip.move", { ...selectedGrip, to: [point.x, point.y],...(angle!==undefined?{angle}:{}) });
        return;
      }
      const tolerance = mapped.tolerance;
      const hit = !pickOnly && !commandPickingRef.current && !additive ? selectedGripAt(point,tolerance) : null;
      if (hit) {
        grip.current = { handle: hit.handle, index:hit.index };
        rotationGesture.current=null;
        gearGripVisual.current=null;
        const entity=scene.current?.entities.find(e=>e.handle===hit.handle);
        setHint(`${entity ? cadGripLabel(entity,hit.index) : "移动控制点"}；点击新位置，Esc 取消。`);
        return;
      }
      const epoch = selectionEpoch.current;
      selectionCursor.current = { page, aperture };
      const task = client.current
        .request<string | undefined>("pick", point.x, point.y, tolerance)
        .then((handle) => {
          if (epoch !== selectionEpoch.current || !latest.current.enabled) return;
          if (!handle) {
            startWindow(page, point, aperture);
            return;
          }
          const members =
            handle && scene.current
              ? expandPatentSelection(
                  latest.current.project,
                  commandPickingRef.current && Number.isFinite(cadTargetLimit(mode))
                    ? [handle]
                    : expandCadGroups(scene.current, [handle]),
                  insideRef.current,
                )
              : [];
          const next = mergeCadSelection(handlesRef.current, members, additive);
          for (const member of members) {
            if (additive) targetPoints.current.delete(member);
            else if (cadTargetLimit(mode) === 2) targetPoints.current.set(member, point);
          }
          setSelection(next);
          if (commandPickingRef.current && !additive) {
            const limit = cadTargetLimit(mode);
            if (Number.isFinite(limit) && next.length === limit) {
              commandPickingRef.current = false;
              setCommandPicking(false);
              if (limit === 2) {
                try {
                  const compiled = compileCadGesture(
                    mode as ExtraCadTool,
                    next.flatMap((handle) => {
                      const p = targetPoints.current.get(handle);
                      return p ? [p] : [];
                    }),
                    next,
                    Number(amount),
                  );
                  targetPoints.current.clear();
                  if (compiled) void execute(compiled.command, compiled.params);
                } catch (error) {
                  latest.current.onError(String(error));
                }
                choose(mode);
              } else setHint(mode === "offset" ? "点击偏移的一侧。" : "点击断开区间的第一点。");
            } else
              setHint(
                limit === 2
                  ? "点击第二个对象的保留侧；Shift 移除，Esc 取消。"
                  : "继续选择对象；右键 / Enter 确认，Shift 移除，Esc 取消。",
              );
          }
          gestureFragment.current = undefined;
          refreshAidHover();
        })
        .catch((error) => latest.current.onError(String(error)))
        .finally(() => {
          if (selectionPick.current?.task === task) selectionPick.current = null;
        });
      selectionPick.current = { epoch, task };
      return;
    }
    if (isPatternTool(mode)) {
      if (mode === "arraypath") {
        const epoch = selectionEpoch.current;
        void client.current.request<string | undefined>("pick", point.x, point.y, mapped.tolerance).then(h => {
          if (epoch !== selectionEpoch.current || modeRef.current !== "arraypath") return;
          if (!h || patentObjectAtHandle(sceneBindings.current, h)) { setHint("请选择普通 CAD 线条作为路径。"); return; }
          setPatternPath(h);
        }).catch(e => latest.current.onError(String(e)));
        return;
      }
      // A canvas point chooses a region, even if unrelated objects were preselected.
      if (mode === "hatch") {
        setSelection([]);
        setHatchPoints((points) => {
          if (additive)
            return points.filter((p) => Math.hypot(p.x - point.x, p.y - point.y) > aperture);
          if (points.some((p) => p.x === point.x && p.y === point.y)) return points;
          return [...points, point];
        });
      }
      if (mode !== "arrayrect") setPatternPoint(point);
      return;
    }
    if (mode === "window") {
      selectionCursor.current = { page, aperture };
      startWindow(page, point, aperture);
      return;
    }
    if (mode === "trim" || mode === "extend") {
      trimShift.current = additive;
      if (trimPath.current.length) {
        trimPath.current.push(point);
        if (trimPath.current.length >= 2) void trimBatch(trimPath.current, additive);
        publish(mapped);
        return;
      }
      const epoch = selectionEpoch.current;
      const command = trimCommand(additive);
      const task = client.current
        .request<string | undefined>("pick", point.x, point.y, mapped.tolerance, ...(command === "trim" ? ["trim"] : []))
        .then(async (handle) => {
          if (epoch !== selectionEpoch.current || modeRef.current !== mode || locked.current)
            return;
          if (!handle) {
            trimPath.current = [point];
            setHint("指定栏选的第二点，或 Esc 取消。");
            return;
          }
          const params = { handle, pick: [point.x, point.y], ...trimParams() };
          await client.current!.request("query", "bridge.preview_modify", {command,params});
          if (epoch !== selectionEpoch.current || modeRef.current !== mode) return;
          return execute(command, params);
        })
        .catch((error) => {if (epoch === selectionEpoch.current) setHint(`未完成本次操作：${String(error)}`);});
      selectionPick.current = {epoch, task};
      void task.finally(() => { if (selectionPick.current?.task === task) selectionPick.current = null; });
      return;
    }
    if (mode === "rotate" || mode === "scale") {
      if (!anchor.current) {
        anchor.current = point;
        rotationGesture.current=null;
        setHint(
          mode === "rotate" ? "移动鼠标预览旋转，点击确认；Esc 取消。" : "移动鼠标预览缩放并点击确认，或输入缩放比例；Esc 取消。",
        );
        if (mode === "scale") {
          // Use the selected geometry's size as the initial scale, without another pick.
          const selected = new Set(handlesRef.current);
          let length = mapped.tolerance;
          for (const primitive of scene.current?.primitives ?? []) {
            if (!selected.has(primitive.handle)) continue;
            for (const [x,y] of primitive.points) length = Math.max(length, Math.hypot(x-point.x,y-point.y));
          }
          for (const entity of scene.current?.entities ?? []) {
            if (!selected.has(entity.handle)) continue;
            for (const [x,y] of entity.grips ?? []) length = Math.max(length, Math.hypot(x-point.x,y-point.y));
          }
          // Half the reference distance gives mouse scaling twice the response.
          points.current = [{x:point.x+length/2,y:point.y}];
        }
      } else {
        const transform = currentTransform(point);
        if (transform) {
          anchor.current = null;
          rotationGesture.current=null;
          points.current = [];
          const { command, ...params } = transform;
          void execute(command, { handles: handlesRef.current, ...params });
        }
      }
      publish(mapped);
      return;
    }
    if (mode === "pline" || mode === "spline") {
      if (mapped.aid?.start && points.current.length) {
        points.current[0] = mapped.aid.start;
        deferredTangent.current = undefined;
      }
      points.current.push(point);
      publish(mapped);
      setPointCount(points.current.length);
      setHint(`已指定 ${points.current.length} 个点，继续点击或选择完成。`);
      return;
    }
    if (EXTRA_CAD_TOOLS.some((tool) => tool[0] === mode)) {
      points.current.push(point);
      publish(mapped);
      setPointCount(points.current.length);
      try {
        const compiled = compileCadGesture(
          mode as ExtraCadTool,
          points.current,
          handlesRef.current,
          Number(amount),
        );
        if (compiled) {
          points.current = [];
          setPointCount(0);
          void execute(compiled.command, compiled.params);
        } else
          setHint(
            extraHint(mode, points.current.length) ??
              `已指定 ${points.current.length} 个点，请继续点击。`,
          );
      } catch (error) {
        points.current.pop();
        setPointCount(points.current.length);
        publish(mapped);
        latest.current.onError(String(error));
      }
      return;
    }
    if (mode === "text") {
      if (!(Number(amount) > 0)) {
        setHint("请输入大于 0 的字高。");
        return;
      }
      openText({ page: cadToPage(point,props.project.cad.mapping), at: point, width:Number(amount)*12 }, "", Number(amount));
      return;
    }
    if ((mode === "move" || mode === "copy") && !handlesRef.current.length && !pasteDraft.current) {
      setHint("请先选择需要操作的对象。");
      return;
    }
    if (!anchor.current) {
      anchor.current = point;
      if (mode === "line") {
        lineTrail.current = [point];
        setPointCount(1);
      }
      publish(mapped);
      setHint(
        mapped.aid?.deferred
          ? "移动到外部终点或另一圆上确定切线；Tab 切换切点。"
          : "点击终点；Esc 取消。",
      );
      return;
    }
    const start = mapped.aid?.start ?? anchor.current;
    if (Math.hypot(point.x - start.x, point.y - start.y) < 1e-9 && !pasteDraft.current) {
      setHint("请指定与起点不同的位置。");
      return;
    }
    anchor.current = mode === "line" ? point : mode === "copy" ? start : null;
    deferredTangent.current = undefined;
    if (mode !== "line" && mode !== "copy") gestureFragment.current = undefined;
    const first = [start.x, start.y],
      last = [point.x, point.y];
    if (mode === "line") {
      lineTrail.current.push(point);
      lineRedoTrail.current = [];
      setPointCount(lineTrail.current.length);
      void execute("line", { points: [first, last] });
    }
    if (mode === "circle")
      void execute("circle", {
        center: first,
        radius: Math.hypot(point.x - start.x, point.y - start.y),
      });
    if (mode === "move" || mode === "copy")
      void execute(pasteDraft.current ? "bridge.paste" : mode, {
        handles: pasteDraft.current?.handles ?? handlesRef.current,
        delta: [point.x - start.x, point.y - start.y],
      });
  }
  function startWindow(page: DrawingPoint, point: DrawingPoint, aperture: number) {
    windowStart.current = page;
    setWindowSelecting(true);
    anchor.current = point;
    setHint("点击框选的另一角；从右向左为交叉选择。Esc 取消。");
    const cursor = selectionCursor.current ?? { page, aperture };
    const mapped = pointer(cursor.page, cursor.aperture);
    if (mapped)
      publish(
        mapped,
        resolveCadWindow(props.project, page, cursor.page, cursor.aperture) ?? undefined,
      );
  }
  function selectWindow(
    start: DrawingPoint,
    end: DrawingPoint,
    additive: boolean,
    aperture: number,
  ) {
    if (!client.current || locked.current) return;
    const window = resolveCadWindow(props.project, start, end, aperture);
    if (!window) return;
    const epoch = selectionEpoch.current;
    const pending = selectionPick.current;
    gestureFragment.current = undefined;
    latest.current.onPreview(null);
    const query = () =>
      epoch === selectionEpoch.current && latest.current.enabled
        ? client.current!.request<{ handles: string[] }>("query", "bridge.select_polygon", {
            polygon: window.polygon.map((p) => [p.x, p.y]),
            crossing: window.crossing,
          })
        : undefined;
    const task = (pending?.epoch === epoch ? pending.task.then(query) : Promise.resolve(query()))
      .then((result) => {
        if (result && epoch === selectionEpoch.current && latest.current.enabled)
          setSelection(
            scene.current
              ? mergeCadSelection(
                  handlesRef.current,
                  expandCadGroups(scene.current, result.handles),
                  additive,
                )
              : [],
          );
      })
      .catch((error) => latest.current.onError(String(error)))
      .finally(() => {
        if (selectionPick.current?.task === task) selectionPick.current = null;
      });
    selectionPick.current = { epoch, task, window: true };
  }
  function selectPolygon(points: DrawingPoint[], additive: boolean) {
    if (!client.current || locked.current || !props.project.cad || points.length < 3) return;
    const epoch = selectionEpoch.current;
    const pending = selectionPick.current;
    const polygon = points.map((point) => {
      const cad = pageToCad(point, props.project.cad!.mapping);
      return [cad.x, cad.y];
    });
    const query = () =>
      epoch === selectionEpoch.current && latest.current.enabled
        ? client.current!.request<{ handles: string[] }>("query", "bridge.select_polygon", {
            polygon,
            crossing: true,
          })
        : undefined;
    const task = (pending?.epoch === epoch ? pending.task.then(query) : Promise.resolve(query()))
      .then((result) => {
        if (result && epoch === selectionEpoch.current && latest.current.enabled)
          setSelection(scene.current
            ? mergeCadSelection(handlesRef.current, expandCadGroups(scene.current, result.handles), additive)
            : []);
      })
      .catch((error) => latest.current.onError(String(error)))
      .finally(() => {
        if (selectionPick.current?.task === task) selectionPick.current = null;
      });
    selectionPick.current = { epoch, task, window: true };
  }
  function finish() {
    const pendingPick = selectionPick.current;
    if ((commandPickingRef.current || mode === "trim" || mode === "extend") && pendingPick?.epoch === selectionEpoch.current) {
      const selectedMode = modeRef.current;
      void pendingPick.task.then(() => {
        if (
          selectionEpoch.current === pendingPick.epoch &&
          modeRef.current === selectedMode &&
          (commandPickingRef.current || selectedMode === "trim" || selectedMode === "extend")
        )
          finish();
      });
      return;
    }
    if (deferredTangent.current && mode === "pline" && points.current.length < 2) {
      points.current = [];
      setPointCount(0);
    }
    if (locked.current || props.disabled) return;
    if (modeRef.current === "explode" && commandPickingRef.current) {
      if (!handlesRef.current.length) { choose("select"); return; }
      commandPickingRef.current = false;
      setCommandPicking(false);
      void execute("explode", {handles:[...handlesRef.current]});
      return;
    }
    if (mode === "trim" || mode === "extend") {
      if (trimPath.current.length >= 2) void trimBatch(trimPath.current, trimShift.current);
      else choose("select");
      return;
    }
    if (isPatternTool(modeRef.current) && !commandPickingRef.current) {
      patternPanel.current?.apply();
      return;
    }
    if (commandPickingRef.current) {
      if (!handlesRef.current.length) {
        setHint("请先点击或框选要修改的对象。");
        return;
      }
      const limit = cadTargetLimit(mode);
      if (Number.isFinite(limit) && handlesRef.current.length !== limit) {
        setHint(`请选择 ${limit} 个对象。`);
        return;
      }
      commandPickingRef.current = false;
      setCommandPicking(false);
      windowStart.current = null;
      setWindowSelecting(false);
      anchor.current = null;
      setHint(
        mode === "rotate"
          ? "选择旋转基点。"
          : mode === "scale"
            ? "选择缩放基点。"
            : mode === "mirror"
              ? "选择镜像轴的第一点。"
              : mode === "hatch"
                ? "调整填充参数，右键 / Enter 或点击应用完成。"
                : "选择操作基点。",
      );
      return;
    }
    if (windowStart.current) {
      choose(mode);
      return;
    }
    if (mode === "select") {
      if (latest.current.onRepeatTool?.()) return;
      if (lastTool.current === "explode") startExplode();
      else if (lastTool.current) choose(lastTool.current);
      return;
    }
    if (mode !== "pline" && mode !== "spline") {
      choose("select");
      return;
    }
    if (points.current.length < 2) {
      choose("select");
      return;
    }
    const values = points.current.map((p) => [p.x, p.y]);
    points.current = [];
    gestureFragment.current = undefined;
    setPointCount(0);
    void execute(mode, mode === "pline" ? { vertices: values } : { fit: values });
    modeRef.current = "select";
    setMode("select");
    latest.current.onDrawingActive?.(false);
  }
  function startExplode() {
    choose("explode");
    if (handlesRef.current.length) void execute("explode", {handles:[...handlesRef.current]});
  }
  function rightClick(): boolean {
    if (!ready || locked.current || props.disabled) return false;
    if (textDraftRef.current) return finishText(true);
    const pendingPick = selectionPick.current;
    if (pendingPick?.epoch === selectionEpoch.current) {
      const selectedMode = modeRef.current;
      void pendingPick.task.then(() => {
        if (selectionEpoch.current === pendingPick.epoch && modeRef.current === selectedMode)
          rightClick();
      });
      return true;
    }
    const limit = cadTargetLimit(modeRef.current);
    if (
      grip.current ||
      pasteDraft.current ||
      (commandPickingRef.current && modeRef.current !== "trim" && modeRef.current !== "extend" &&
        (!handlesRef.current.length ||
          (Number.isFinite(limit) && handlesRef.current.length !== limit)))
    ) {
      cancel();
      return true;
    }
    if (isPatternTool(modeRef.current) && !commandPickingRef.current) {
      if (!patternPanel.current?.apply()) cancel();
      return true;
    }
    finish();
    return true;
  }
  function closeLine(): boolean {
    const first = lineTrail.current[0],
      last = anchor.current;
    if (
      modeRef.current !== "line" ||
      !first ||
      !last ||
      lineTrail.current.length < 2 ||
      props.disabled ||
      locked.current
    )
      return false;
    if (Math.hypot(last.x - first.x, last.y - first.y) > 1e-9)
      void execute("line", {
        points: [
          [last.x, last.y],
          [first.x, first.y],
        ],
      });
    choose("select");
    return true;
  }
  function cancel() {
    clearMacIntents();
    toolChoiceEpoch.current++;
    cornerDrag.current=null;cornerActive.current=null;
    textPlacement.current=null;
    if (!pendingGripHandoff.current) setTextGripHandle(null);
    trimPath.current = [];
    if (textDraftRef.current) {
      finishText(false);
      return;
    }
    commandPickingRef.current = false;
    setCommandPicking(false);
    clearAidState();
    modeRef.current = "select";
    latest.current.onDrawingActive?.(false);
    if (locked.current || props.disabled) return;
    // Ending a multi-point curve commits accepted points, never the cursor preview.
    if ((mode === "pline" || mode === "spline") && points.current.length >= 2) {
      finish();
      return;
    }
    if (mode === "explode") { setSelection([]); explodeFeedback.current = null; }
    const pending = Boolean(
      anchor.current ||
        grip.current ||
        points.current.length ||
        selectionPick.current?.epoch === selectionEpoch.current ||
        mode !== "select",
    );
    selectionEpoch.current++;
    previewEpoch.current++;
    curveJob.current = null;
    latest.current.onPreview(null);
    gestureFragment.current = undefined;
    anchor.current = null;
    windowStart.current = null;
    setWindowSelecting(false);
    grip.current = null;
    points.current = [];
    rotationGesture.current=null;
    setPointCount(0);
    setMode("select");
    pasteDraft.current = null;
    if (!pending && insideRef.current) {
      setInside(undefined);
      insideRef.current = undefined;
      latest.current.onInside?.(undefined);
    }
    if (!pending) setSelection([]);
    setHint(pending ? "已取消当前操作。拖动或点击两角框选。" : "已取消选择。拖动或点击两角框选。");
  }
  // Replay only after React has published ready handlers; Escape, another undo and project changes invalidate the intent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: click is the current ready handler, not a new restore trigger.
  useEffect(()=>{
    if(!props.enabled){restoredPicks.current=[];return;}
    if(!ready)return;
    const picks=restoredPicks.current;restoredPicks.current=[];
    for(const pick of picks) if(pick.checkpoint===checkpointId&&pick.project===props.project.projectId&&pick.instance===client.current&&pick.epoch===selectionEpoch.current&&props.enabled&&modeRef.current==="select")click(...pick.args,true);
  },[ready,checkpointId,props.project.projectId,props.enabled]);
  const macReplay = useRef({ready: false, apply: async (_intent: MacIntent) => {}});
  macReplay.current = {
    ready: ready && props.enabled && !props.disabled && !locked.current && !drawingError &&
      !drawingPipeline.current?.geometryPending,
    apply: async intent => {
      macReplaying.current = true;
      try {
        if (intent.kind === "tool") choose(intent.next, intent.method, intent.activate);
        else click(...intent.args, true);
      } finally { macReplaying.current = false; }
      await selectionPick.current?.task;
      // Publish the new tool's handlers before applying its path/centre pick.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    },
  };
  useEffect(() => {
    if (!isMacPlatform()) return;
    if (!props.enabled || drawingError) { clearMacIntents(); return; }
    const canReplay = () => macReplay.current.ready && !drawingPipeline.current?.geometryPending &&
      selectionPick.current?.epoch !== selectionEpoch.current;
    void macIntents.current.drain(canReplay, intent => macReplay.current.apply(intent))
      .catch(error => { clearMacIntents(); latest.current.onError(String(error)); })
      .finally(() => {
        if (!macIntents.current.pending) macPlannedMode.current = null;
        else if (!macIntents.current.draining && canReplay())
          wakeMacIntents(value => value + 1);
      });
  }, [macIntentVersion, ready, drawingGeometryPending, props.enabled, props.disabled, drawingError]);
  useImperativeHandle(props.ref, () => ({
    contentBounds() {
      const bounds = ready ? scene.current?.bounds : null;
      const mapping = props.project.cad?.mapping;
      if (!bounds || !mapping) return null;
      const x = (bounds.min[0] - mapping.originX) * mapping.scale;
      const y = (mapping.originY - bounds.max[1]) * mapping.scale;
      return { x, y, width: (bounds.max[0] - bounds.min[0]) * mapping.scale,
        height: (bounds.max[1] - bounds.min[1]) * mapping.scale };
    },
    labelGlyph(text, fontSize) {
      if (!client.current) return Promise.reject(new Error("CAD 文字引擎尚未就绪。"));
      return client.current.request<CadScene>("labelGlyph", text, fontSize);
    },
    flush: async (preserveDraft = false) => {
      if (!preserveDraft && textDraftRef.current && !finishText(true)) return false;
      setDrawingError(false);
      return drawingPipeline.current ? drawingPipeline.current.flush() : true;
    },
    beginMove(page, aperture) {
      if (!ready || locked.current || props.disabled || !props.enabled ||
          drawingPipeline.current?.geometryPending || modeRef.current !== "select" ||
          windowStart.current || grip.current ||
          selectionPick.current?.epoch === selectionEpoch.current || !handlesRef.current.length) return false;
      // A direct drag keeps the exact grab offset; snapping applies to its destination.
      const mapped = resolveCadPointer(props.project, page, aperture);
      if (!mapped) return false;
      choose("move", undefined, false);
      anchor.current = mapped.point;
      gestureFragment.current = mapped.fragmentId;
      setHint("拖动选中对象，松开鼠标确认；Esc 取消。");
      return true;
    },
    endMove(page, aperture, orthogonal) {
      if (modeRef.current !== "move") return;
      click(page, false, aperture, false, orthogonal);
      // A drop that snaps back to the grab point is a no-op, not a two-click MOVE draft.
      if (anchor.current) cancel();
    },
    canDragSelection(page, aperture) {
      if (!ready || locked.current || props.disabled || !props.enabled ||
          modeRef.current !== "select" || commandPickingRef.current ||
          grip.current || windowStart.current || drawingPipeline.current?.geometryPending ||
          selectionPick.current?.epoch === selectionEpoch.current || !scene.current) return false;
      const mapped = resolveCadPointer(props.project, page, aperture);
      return !!mapped && !selectedGripAt(mapped.point, mapped.tolerance) &&
        hitsCadSelection(scene.current, handlesRef.current, mapped.point, mapped.tolerance);
    },
    selectHandles(next, removing) {
      clearMacIntents();
      selectionEpoch.current++;
      setSelection(
        removing === undefined ? next : mergeCadSelection(handlesRef.current, next, removing),
      );
    },
    selectAll() {
      clearMacIntents();
      if (!ready || locked.current || props.disabled) return;
      selectionEpoch.current++;
      setSelection(
        scene.current?.entities.filter((e) => e.visible !== false).map((e) => e.handle) ?? [],
      );
    },
    editDetail(id) {
      setInside(id);
      insideRef.current = id;
      latest.current.onInside?.(id);
      choose("select");
      setSelection([]);
    },
    copySelected(cut = false) {
      if (
        !ready ||
        props.disabled ||
        !client.current ||
        !scene.current ||
        !handlesRef.current.length ||
        locked.current || drawingPipeline.current?.geometryPending || !latestDrawingBytes.current
      )
        return;
      const selected=new Set(handlesRef.current);
      const objects=sceneBindings.current.filter(o=>cadObjectHandles(o).some(h=>selected.has(h)));
      const ids=new Set(objects.map(o=>o.id));
      const source=pipelineProject.current ?? latest.current.project;
      const capture = {
        project: structuredClone({...source,regions:[],baseFragments:[],
          annotations:source.annotations.filter(a=>ids.has(a.id)),detailViews:source.detailViews?.filter(d=>ids.has(d.id)),
          cad: {...source.cad!, objects}}),
        handles: [...handlesRef.current],
        scene: scene.current,
        base: selectionCenter(),
      };
      // Worker checkpoints are immutable and already paired with the current scene.
      clipboard.current = {...capture, sessionId:props.sessionId, bytes: latestDrawingBytes.current,
        scene:{...capture.scene,entities:capture.scene.entities.filter(e=>selected.has(e.handle)),
          primitives:capture.scene.primitives.filter(p=>selected.has(p.handle))},
        base: {x:capture.base[0],y:capture.base[1]}};
      setHint("已复制选中对象，粘贴后点击放置位置。");
      if (cut) void execute("erase", {handles:capture.handles});
    },
    pasteSelected() {
      if (!ready || !clipboard.current || clipboard.current.sessionId!==props.sessionId || locked.current || props.disabled || drawingPipeline.current?.geometryPending) return false;
      choose("copy");
      commandPickingRef.current = false;
      setCommandPicking(false);
      pasteDraft.current = clipboard.current;
      anchor.current = clipboard.current.base;
      setHint("点击粘贴位置；Esc 取消。");
      return true;
    },
    pointDown(page, aperture, orthogonal, additive = false) {
      if (mode === "text" && !textDraftRef.current && ready && !locked.current && !props.disabled) {
        const mapped = pointer(page, aperture, false, orthogonal);
        if (mapped) textPlacement.current = mapped.point;
        return false;
      }
      const first = !anchor.current && ["line", "rectang", "circle", "move", "copy"].includes(mode);
      const gearFirst = (mode === "gear" || mode === "spring" || mode === "chain") && !points.current.length && !selectionPick.current
        && ready && !locked.current && !props.disabled && !drawingPipeline.current?.geometryPending;
      click(page, additive, aperture, false, orthogonal);
      return gearFirst || (first && Boolean(anchor.current));
    },
    pointUp(page, aperture, dragged) {
      const corner=cornerDrag.current;
      if(corner){
        cornerDrag.current=null;
        const mapped=resolveCadPointer(props.project,page,aperture,corner.fragmentId);
        if(mapped&&dragged){const value=dragCorner(corner.target,corner.value,corner.index,mapped.point);cornerActive.current={target:corner.target,value,fragmentId:corner.fragmentId};void execute("bridge.corner",cornerGeometry(corner.target,value).params);}
        else refreshAidHover();
        return true;
      }
      const start = textPlacement.current;
      if (!start) return false;
      textPlacement.current = null;
      if (modeRef.current !== "text" || !props.project.cad) return true;
      const end = resolveCadPointer(props.project,page,aperture)?.point ?? start;
      const height = Number(amount);
      if (!(height > 0) || !Number.isFinite(height)) {setHint("请输入大于 0 的有效字号。"); return true;}
      const at = dragged ? {x:Math.min(start.x,end.x),y:Math.max(start.y,end.y)} : start;
      openText({page:cadToPage(at,props.project.cad.mapping),at,width:dragged ? Math.max(height,Math.abs(end.x-start.x)) : height*12},"",height);
      return true;
    },
    canTrimStroke: () => ready && !props.disabled && !commandPickingRef.current && (mode === "trim" || mode === "extend") && !trimPath.current.length,
    trimStroke(path, aperture, shift, previewOnly) {
      if (!ready || locked.current || props.disabled || !props.enabled || commandPickingRef.current || (mode !== "trim" && mode !== "extend")) return;
      const mapped = path.map(p => resolveCadPointer(props.project, p, aperture, gestureFragment.current));
      if (mapped.some(p => !p)) return;
      const values = mapped.map(p => p!.point);
      if (previewOnly) {
        trimPath.current = values.slice(0, -1);
        const last = mapped.at(-1)!;
        publish({...last, snapped: false, snapType: undefined, aid: null});
        trimPath.current = [];
      } else void trimBatch(values, shift);
    },
    cancelDraft() {
      const pending = Boolean(
        anchor.current || points.current.length || grip.current || windowStart.current,
      );
      if (pending) choose(mode);
      return pending;
    },
    beginGrip(page, aperture) {
      if((mode==="fillet"||mode==="chamfer")&&cornerActive.current&&!drawingPipeline.current?.geometryPending&&ready&&!props.disabled){
        const active=cornerActive.current;
        const mapped=resolveCadPointer(props.project,page,aperture,active.fragmentId);
        if(mapped){let index=-1,distance=mapped.tolerance*1.2;cornerGrips(active.target,active.value).forEach((p,i)=>{const d=Math.hypot(p.x-mapped.point.x,p.y-mapped.point.y);if(d<distance){index=i;distance=d;}});
          if(index>=0){cornerDrag.current={...active,index};return true;}}
      }
      if (
        drawingPipeline.current?.geometryPending ||
        windowStart.current ||
        selectionPick.current?.epoch === selectionEpoch.current ||
        mode !== "select" ||
        grip.current ||
        !ready ||
        locked.current ||
        props.disabled
      )
        return false;
      const mapped = pointer(page, aperture);
      if (!mapped) return false;
      const hit = selectedGripAt(mapped.point, mapped.tolerance);
      if (hit) {
        selectionEpoch.current++;
        grip.current = { handle: hit.handle, index: hit.index };
        rotationGesture.current=null;
        gearGripVisual.current=null;
        const entity=scene.current?.entities.find(e=>e.handle===hit.handle);
        if (entity?.textOrigin && entity.grips?.length===3) setTextGripHandle(hit.handle);
        gestureFragment.current = mapped.fragmentId;
        setHint(`${entity ? cadGripLabel(entity,hit.index) : "移动控制点"}；拖动或点击新位置，Esc 取消。`);
        publish(mapped);
        return true;
      }
      return false;
    },
    click: (page, additive, aperture, orthogonal) =>
      click(page, additive, aperture, false, orthogonal),
    hover(page, aperture, orthogonal) {
      if (textDraftRef.current) return;
      if (!ready || locked.current || props.disabled || !props.enabled) return;
      if (pendingGripHandoff.current) return;
      selectionCursor.current = { page, aperture };
      lastHover.current = { page, aperture, orthogonal };
      const mapped = pointer(page, aperture, false, orthogonal, true);
      if (mode === "scale" && anchor.current && mapped) {
        const wasTyped = scaleTyped.current;
        scaleTyped.current = false;
        const transform = currentTransform(mapped.point);
        if (transform?.command === "scale") {
          // Updating the input must not rebuild the whole tool/appearance rail
          // for every pointer sample in a large selection.
          if (wasTyped || pointerScaleFactor.current === null) setAmount(String(transform.factor));
          pointerScaleFactor.current = transform.factor;
          scaleDisplay.current?.update(String(transform.factor));
        }
      }
      if (mapped) {
        const selectedGrip =
          mode === "select" && !grip.current && !windowStart.current && !commandPickingRef.current
            ? selectedGripAt(mapped.point, mapped.tolerance)
            : null;
        publish(
          selectedGrip
            ? { ...mapped, point: selectedGrip.point, snapped: true, snapType: selectedGrip.type }
            : mapped,
          windowStart.current
            ? (resolveCadWindow(props.project, windowStart.current, page, aperture) ?? undefined)
            : undefined,
        );
      } else if (mode === "hatch") {
        patternPanel.current?.hover(null);
      } else if (!isPatternTool(mode)) {
        mirrorLatestPreview.current = null;
        previewEpoch.current++;
        modifyJob.current = null;
        clearTrimHover();
        props.onPreview(null);
      }
      scheduleAidHover(mapped?.aid?.delay);
    },
    leave() {
      mirrorLatestPreview.current = null;
      stopAidHover();
      if (mode === "hatch") patternPanel.current?.hover(null);
      previewEpoch.current++;
      modifyJob.current = null;
      if (pendingGripHandoff.current || (isPatternTool(mode) && patternPreview.current) || ((mode==="fillet"||mode==="chamfer")&&cornerActive.current)) return;
      if (!locked.current && !pendingPaint.current) latest.current.onPreview(null);
    },
    window(start, end, additive, aperture, previewOnly) {
      if (!ready || locked.current || props.disabled || !props.enabled) return;
      const window = resolveCadWindow(props.project, start, end, aperture);
      if (!window) return;
      const last = resolveCadPointer(props.project, end, aperture, window.fragmentId);
      if (!last) return;
      if (previewOnly) publish({ ...last, snapped: false, snapType: undefined, aid: null }, window);
      else {
        anchor.current = null;
        windowStart.current = null;
        setWindowSelecting(false);
        selectWindow(start, end, additive, aperture);
      }
    },
    selectPolygon(points, additive) {
      if (!ready || locked.current || props.disabled || !props.enabled) return;
      selectPolygon(points, additive);
    },
    canWindow: () =>
      ready &&
      !props.disabled &&
      (mode === "select" ||
        mode === "window" ||
        (commandPickingRef.current && cadTargetLimit(mode) === Infinity)) &&
      !grip.current &&
      !windowStart.current &&
      (selectionPick.current?.epoch !== selectionEpoch.current || !!selectionPick.current.window),
    finish,
    rightClick,
    editText: function editText(page, aperture) {
      if (
        !ready ||
        locked.current ||
        props.disabled ||
        !client.current ||
        modeRef.current !== "select"
      )
        return;
      // A second corner can emit dblclick. It must not invalidate a pending window/pick.
      const pending = selectionPick.current;
      if (pending?.epoch === selectionEpoch.current) {
        if (!pending.window)
          void pending.task.then(() => {
            if (pending.epoch === selectionEpoch.current && !windowStart.current)
              editText(page, aperture);
          });
        return;
      }
      if (windowStart.current) return;
      const mapped = resolveCadPointer(props.project, page, aperture);
      if (!mapped) return;
      const epoch = ++selectionEpoch.current;
      void client.current
        .request<string | undefined>("pick", mapped.point.x, mapped.point.y, mapped.tolerance)
        .then((handle) => {
          if (epoch !== selectionEpoch.current || modeRef.current !== "select") return;
          const entity = scene.current?.entities.find((e) => e.handle === handle);
          if (!entity || entity.locked) return;
          if (
            latest.current.project.cad?.objects?.some((o) =>
              [...(o.label ?? []), ...(o.source ?? []), ...(o.frame ?? [])].includes(entity.handle),
            )
          )
            return;
          if (entity.type.toLowerCase() === "hatch") {
            setSelection([entity.handle]);
            choose("hatch");
            return;
          }
          if (!["text", "mtext"].includes(entity.type.toLowerCase())) return;
          const at = entity.textOrigin ?? entity.grips?.[0];
          const position = at ? {x:at[0],y:at[1]} : mapped.point;
          openText(
            { page:cadToPage(position,props.project.cad!.mapping), at:position, handle: entity.handle, width:entity.width || (entity.height ?? 10)*12, rotation:entity.rotation,
              original:{text:entity.plainText ?? entity.text ?? "",height:entity.height ?? 10,width:entity.width || (entity.height ?? 10)*12}},
            entity.plainText ?? entity.text ?? "",
            entity.height ?? 10,
          );
        })
        .catch((error) => latest.current.onError(String(error)));
    },
    painted(id) {
      const sequence = paintedDrawing.current.get(id);
      if (sequence !== undefined) {
        latest.current.onPaintedDrawing?.(sequence);
        for (const [checkpoint, value] of paintedDrawing.current) {
          if (value <= sequence) paintedDrawing.current.delete(checkpoint);
        }
      }
      if (pendingPaint.current === id) {
        pendingPaint.current = null;
        latest.current.onPreview(null);
      }
    },
    isCommandPicking: () => commandPickingRef.current,
    prepareLineUndo(commit = true) {
      if (modeRef.current !== "line" || lineTrail.current.length < 2) return false;
      if (commit) {
        lineRedoTrail.current.push(lineTrail.current.pop()!);
        lineUndoRestore.current = [...lineTrail.current];
        anchor.current = lineTrail.current.at(-1) ?? null;
        setPointCount(lineTrail.current.length);
        previewEpoch.current++;
        latest.current.onPreview(null);
      }
      return true;
    },
    prepareLineRedo() {
      if(modeRef.current !== "line" || !lineRedoTrail.current.length)return false;
      lineTrail.current.push(lineRedoTrail.current.pop()!);
      lineUndoRestore.current=[...lineTrail.current];
      anchor.current=lineTrail.current.at(-1)??null;
      setPointCount(lineTrail.current.length);
      previewEpoch.current++;latest.current.onPreview(null);
      return true;
    },
    closeLine,
    cycleSnap() {
      if (!aids.current.cycle() || !lastHover.current) return false;
      refreshAidHover();
      return true;
    },
    assistPoint(page, aperture, hover) {
      return assistPoint(page, aperture, hover);
    },
    erase() {
      if (handlesRef.current.length) void execute("erase", { handles: handlesRef.current });
    },
    cancel,
  }));
  function selectionCenter(): [number, number] {
    const selected=new Set(handlesRef.current);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const primitive of scene.current?.primitives??[]) if(selected.has(primitive.handle)) for (const [x, y] of primitive.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0,0];
  }
  const disabled = props.disabled || working || !ready || drawingError;
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectionCount reads only these handles, current scene bindings and the inside-object scope.
  const selectedCount = useMemo(() => selectionCount(handles), [handles, sceneBindings.current, inside]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the worker scene invalidates this summary even when the handle Set is retained.
  const selectedAppearances = useMemo(() => (scene.current?.entities ?? [])
    .filter(e => selectedHandles.has(e.handle))
    .map(e => e.appearance ?? {color:"#000000",lineweight:e.lineweight??0.25,linetype:"Continuous"}),
    [scene.current, selectedHandles]);
  const gearCandidate = mode === "select" && handles.length === 1
    ? scene.current?.entities.find(entity=>entity.handle===handles[0]&&entity.gear)
    : undefined;
  const gearOwner=gearCandidate?patentObjectAtHandle(sceneBindings.current,gearCandidate.handle):undefined;
  const selectedGear=!gearOwner||(gearOwner.role==="body"&&gearOwner.object.id===insideRef.current)?gearCandidate:undefined;
  const gearMates=selectedGear ? cadGearMates(selectedGear).flatMap(h=>scene.current?.entities.filter(e=>e.handle===h&&e.gear&&cornerAllowed(e.handle))??[]) : [];
  const meshCandidates=mode==="select"&&handles.length===2 ? handles.map(h=>scene.current?.entities.find(e=>e.handle===h&&e.gear)) : [];
  const meshPair=meshCandidates.length===2&&meshCandidates.every(e=>{
    if(!e)return false;const owner=patentObjectAtHandle(sceneBindings.current,e.handle);
    return !owner||(owner.role==="body"&&owner.object.id===insideRef.current);
  }) ? meshCandidates as [CadScene["entities"][number],CadScene["entities"][number]] : null;
  async function applyMesh(pair: [CadScene["entities"][number],CadScene["entities"][number]],enabled:boolean) {
    const epoch=selectionEpoch.current,instance=client.current!,base=scene.current,selection=handlesRef.current;
    const params={handles:pair.map(e=>e.handle),enabled};
    await instance.request("query","bridge.preview_modify",{command:"bridge.gear_mesh",params,compact:true});
    if(epoch!==selectionEpoch.current||instance!==client.current||base!==scene.current||selection!==handlesRef.current||!latest.current.enabled||modeRef.current!=="select")return;
    await execute("bridge.gear_mesh",params);props.getCanvas?.()?.focus({preventScroll:true});
  }
  const springCandidate = mode === "select" && handles.length === 1
    ? scene.current?.entities.find(entity=>entity.handle===handles[0]&&entity.spring)
    : undefined;
  const springOwner=springCandidate?patentObjectAtHandle(sceneBindings.current,springCandidate.handle):undefined;
  const selectedSpring=!springOwner||(springOwner.role==="body"&&springOwner.object.id===insideRef.current)?springCandidate:undefined;
  const activeMethod = mode === "select" ? undefined : drawMethod(methodId);
  const chainCandidate = mode === "select" && handles.length === 1 ? scene.current?.entities.find(e=>e.handle===handles[0]&&e.chain) : undefined;
  const chainOwner=chainCandidate?patentObjectAtHandle(sceneBindings.current,chainCandidate.handle):undefined;
  const selectedChain=!chainOwner||(chainOwner.role==="body"&&chainOwner.object.id===insideRef.current)?chainCandidate:undefined;
  const methodParameter = activeMethod?.parameter;
  const parameterTool = ["text", "polygon", "offset", "fillet", "chamfer", "scale"].includes(mode) || !!methodParameter;
  const hasToolSettings =
    props.enabled &&
    (parameterTool ||
      !!textDraft ||
      mode === "mirror" ||
      mode === "rectang" ||
      mode === "line" ||
      mode === "pline" ||
      mode === "spline");
  const toolName = textDraft ? "文字" : activeMethod && methodId !== mode ? activeMethod.label : (TOOLS.find(([id]) => id === mode)?.[1] ?? "绘图");
  const canvas = props.getCanvas?.();
  const instructionTitle = props.detailTool?.active
    ? "局部放大"
    : working
      ? "正在更新图形…"
      : mode === "window"
        ? "框选对象"
        : mode === "select"
          ? "选择对象"
          : mode === "explode" ? "分解" : (activeMethod && methodId !== mode ? activeMethod.label : TOOLS.find((t) => t[0] === mode)?.[1] ??
            (mode === "pline"
              ? "多段线"
              : mode === "spline"
                ? "样条曲线"
                : EXTRA_CAD_TOOLS.find((t) => t[0] === mode)?.[1]));
  const instructionMessage = props.detailTool?.active
    ? props.detailTool.hint
    : inside
      ? `在圆内绘制和修改；完成后返回图纸。${hint}`
      : hint;
  const detailSettingsOpen = props.detailTool?.controlsOpen ?? props.detailTool?.active;
  const settingsTitle = detailSettingsOpen || inside ? "局部放大"
    : selectedChain ? selectedChain.chain?.single ? "链轮" : "链条"
    : selectedGear?.gear ? selectedGear.gear.kind === "rack" ? "齿条" : selectedGear.gear.kind === "internal" ? "内齿圈" : "外齿轮"
    : selectedSpring ? "弹簧" : meshPair ? "齿轮啮合" : isPatternTool(mode) ? instructionTitle ?? "绘图"
    : hasToolSettings ? toolName : "对象";
  function closeSettings() {
    if (detailSettingsOpen) props.detailTool?.close?.();
    if (insideRef.current) {
      setInside(undefined); insideRef.current = undefined; props.onInside?.(undefined);
    }
    cancel();
    props.getCanvas?.()?.focus({ preventScroll: true });
  }
  const instruction = (
    <div
      className="cad-instruction-card"
      data-tone={rejectedDrawing.current === hint || mode === "hatch" && /未能填充|无法生成|未闭合/.test(hint) ? "error" : undefined}
      aria-live="polite"
      aria-atomic="true"
      role="status"
      title={`${instructionTitle}：${instructionMessage}`}
    >
      <strong>{instructionTitle}</strong>
      <span>{instructionMessage}</span>
    </div>
  );
  if (props.compatibilityOnly) return null;
  return (
    <section
      className="cad-editing-panel"
      data-cad-ready={ready}
      aria-label="CAD实体编辑"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const field = event.target;
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
            event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
          if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
            if (disabled || field.matches(":disabled") || field instanceof HTMLInputElement && field.readOnly) return;
            // Portal controls bubble through React, while the workspace deliberately
            // ignores editable targets. Reuse the command's confirmation path.
            if (field.closest(".cad-pattern-panel") &&
              (field instanceof HTMLSelectElement || field.type === "number" || field.type === "text")) {
              event.preventDefault();
              event.stopPropagation();
              finish();
              return;
            }
          }
        }
        if (event.key === "Enter" && mode === "scale" && event.target === parameterInput.current && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          applyScaleFactor();
          return;
        }
        if (event.key === "Enter" && (mode === "fillet" || mode === "chamfer") &&
          cornerActive.current && event.target === parameterInput.current) {
          event.preventDefault();
          event.stopPropagation();
          applyCornerAmount();
          return;
        }
        if (
          event.key === "Enter" &&
          textDraftRef.current &&
          event.target === parameterInput.current &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          finishText(true);
          return;
        }
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          props.getCanvas?.()?.focus({ preventScroll: true });
        } else if (
          event.key === "Enter" &&
          event.target === parameterInput.current &&
          !event.nativeEvent.isComposing &&
          parameterInput.current?.checkValidity()
        ) {
          event.preventDefault();
          event.stopPropagation();
          props.getCanvas?.()?.focus({ preventScroll: true });
        }
      }}
    >
      {canvas && pendingTexts.map(draft=>createPortal(
        <g key={draft.id} data-cad-pending-text transform={`rotate(${-(draft.rotation ?? 0)} ${draft.page.x} ${draft.page.y})`}>
          <CadTextEditor readOnly value={draft.text} x={draft.page.x} y={draft.page.y}
            width={draft.width * props.project.cad!.mapping.scale} fontSize={draft.height * props.project.cad!.mapping.scale / 0.729}
            onChange={()=>{}} onFinish={()=>{}} />
        </g>,canvas,String(draft.id)))}
      {textDraft &&
        canvas &&
        createPortal(
          <g transform={`rotate(${-(textDraft.rotation ?? 0)} ${textDraft.page.x} ${textDraft.page.y})`}>
            <CadTextEditor value={text} x={textDraft.page.x} y={textDraft.page.y}
              width={textDraft.width * props.project.cad!.mapping.scale}
              fontSize={(Number(amount) > 0 ? Number(amount) : 10) * props.project.cad!.mapping.scale / 0.729}
              onChange={value => {textValue.current=value; setText(value);}}
              onFinish={finishText} />
          </g>,
          canvas,
        )}
      <CadTransientWindow target={props.settingsTarget} title={settingsTitle}
        onClose={closeSettings} focusCanvas={() => props.getCanvas?.()?.focus({ preventScroll: true })}>
      {selectedChain?.chain && props.enabled && <CadChainProperties key={`${selectedChain.handle}:${JSON.stringify(selectedChain.chain)}`} chain={selectedChain.chain}
        disabled={disabled||drawingGeometryPending||!!selectedChain.locked} apply={async chain=>{
          const handle=selectedChain.handle,epoch=selectionEpoch.current,instance=client.current;
          try{
            await instance!.request("query","bridge.preview_draw",{command:"bridge.chain",params:{...chain,handle}});
            if(epoch!==selectionEpoch.current||instance!==client.current||modeRef.current!=="select")return;
            await execute("bridge.chain",{...chain,handle});
          }catch(error){setHint(`链轮未修改：${String(error)}`);}
        }}/>}
      {meshPair && props.enabled && <CadGearMeshSettings
        key={`${meshPair.map(e=>`${e.handle}:${cadGearMates(e).join(";")}`).join(",")}`}
        pair={meshPair} disabled={disabled||drawingGeometryPending||meshPair.some(e=>!!e.locked)}
        apply={enabled=>applyMesh(meshPair,enabled)}/>}
      {selectedGear&&props.enabled&&gearMates.map(gearMate=><CadGearMeshStatus key={`${selectedGear.handle}:${gearMate.handle}`} entity={selectedGear} mate={gearMate}
        disabled={disabled||drawingGeometryPending||!!selectedGear.locked||!!gearMate.locked}
        select={()=>{setSelection([gearMate.handle]);props.getCanvas?.()?.focus({preventScroll:true});}}
        disconnect={()=>applyMesh([selectedGear,gearMate],false)}/>)}
      {selectedGear?.gear && props.enabled && <CadGearProperties
        key={`${selectedGear.handle}:${JSON.stringify(selectedGear.gear)}`}
        gear={selectedGear.gear} disabled={disabled||drawingGeometryPending||!!selectedGear.locked}
        apply={async gear=>{
          const handle=selectedGear.handle;
          try {
            await client.current!.request("query","bridge.preview_draw",{command:"bridge.gear",params:{...gear,handle}});
            if (handlesRef.current.length!==1||handlesRef.current[0]!==handle||modeRef.current!=="select") return;
            await execute("bridge.gear",{...gear,handle});
            props.getCanvas?.()?.focus({preventScroll:true});
          } catch(error) {setHint(`齿轮未修改：${String(error)}`);}
        }}/>}
      {selectedSpring?.spring && props.enabled && <CadSpringProperties
        key={`${selectedSpring.handle}:${JSON.stringify(selectedSpring.spring)}`}
        spring={selectedSpring.spring} disabled={disabled||drawingGeometryPending||!!selectedSpring.locked}
        apply={async spring=>{
          const handle=selectedSpring.handle;
          try {
            await client.current!.request("query","bridge.preview_draw",{command:"bridge.spring",params:{...spring,handle}});
            if (handlesRef.current.length!==1||handlesRef.current[0]!==handle||modeRef.current!=="select") return;
            await execute("bridge.spring",{...spring,handle});
            props.getCanvas?.()?.focus({preventScroll:true});
          } catch(error) {setHint(`弹簧未修改：${String(error)}`);}
        }}/>}
      {hasToolSettings && (
        <section
          className="cad-tool-settings function-rail-transient-panel"
          aria-label={`${toolName}设置`}
        >
          <header>
            <strong>{toolName}设置</strong>
          </header>
          {mode === "rectang" && <>
            <label>角部样式
              <select aria-label="角部样式" value={rectangleCorner} disabled={disabled}
                onChange={event=>setRectangleCorner(event.target.value as NonNullable<RectangleOptions["corner"]>)}>
                <option value="sharp">直角</option><option value="round">圆角</option><option value="chamfer">倒角</option>
              </select>
            </label>
            {rectangleCorner !== "sharp" && <label>{rectangleCorner==="round"?"圆角半径":"倒角大小"}
              <CadNumberInput aria-label={rectangleCorner==="round"?"矩形圆角半径":"矩形倒角大小"}
                value={rectangleSize} min={0} step="any" disabled={disabled}
                onChange={event=>setRectangleSize(event.target.value)}/>
            </label>}
            <label className="cad-snap-toggle"><input type="checkbox" checked={rectangleSquare}
              disabled={disabled} onChange={event=>setRectangleSquare(event.target.checked)}/>正方形</label>
          </>}
          {mode === "mirror" && (
            <label className="cad-snap-toggle">
              <input
                type="checkbox"
                checked={mirrorErase}
                onChange={(event) => {
                  setMirrorErase(event.target.checked);
                  try {
                    localStorage.setItem("cad.mirror.delete-source", String(event.target.checked));
                  } catch {
                    /* Session choice remains usable. */
                  }
                }}
              />
              删除源对象
            </label>
          )}
          {(parameterTool || !!textDraft) && (
            <label htmlFor={parameterId}>
              {methodParameter ?? (mode === "text" || textDraft
                ? "字号"
                : mode === "scale" ? "缩放比例"
                : mode === "polygon"
                  ? "边数"
                  : mode === "offset"
                    ? "偏移距离"
                    : mode === "fillet"
                      ? "圆角半径"
                      : "倒角大小")}
              <CadNumberInput
                id={parameterId}
                ref={parameterInput}
                liveRef={mode === "scale" ? scaleDisplay : undefined}
                onLiveValueFocus={setAmount}
                decimals={mode === "polygon" || mode === "gear" || mode === "spring" || mode === "chain" ? null : 1}
                min={mode === "chain" ? 8 : mode === "spring" ? 3 : mode === "gear" ? methodId === "gear.rack" ? 2 : 8 : mode === "polygon" ? 3 : methodId === "arc.ser" || methodId === "arc.sea" ? undefined : mode === "fillet" || mode === "chamfer" || mode === "scale" ? 0 : 0.001}
                max={mode === "spring" ? 24 : mode === "gear" || mode === "chain" ? 120 : mode === "polygon" ? 20 : undefined}
                step={mode === "polygon" || mode === "gear" || mode === "spring" || mode === "chain" ? 1 : "any"}
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  if (mode === "scale") scaleTyped.current = true;
                  toolAmounts.current.set(mode, event.target.value);
                  toolAmounts.current.set(methodId, event.target.value);
                }}
                disabled={disabled}
              />
            </label>
          )}
          {(mode==="fillet"||mode==="chamfer")&&cornerActive.current&&<div className="cad-tool-settings__actions"><button type="button" disabled={disabled||drawingGeometryPending||!(Number(amount)>0)} onClick={applyCornerAmount}>应用</button></div>}
          {mode === "scale" && <div className="cad-tool-settings__actions"><button type="button" disabled={disabled || drawingGeometryPending || !anchor.current || commandPicking || !(Number(amount)>0) || !Number.isFinite(Number(amount))} onClick={applyScaleFactor}>应用</button></div>}
          {mode === "polygon" && <small>{methodId === "polygon.edge" ? "输入 3～20 的整数，再指定一条边的两个端点。" : "输入 3～20 的整数，再点选中心与半径。"}</small>}
          {mode === "gear" && methodId === "gear.external" && <label className="cad-snap-toggle"><input type="checkbox" checked={gearHole} onChange={event=>setGearHole(event.target.checked)}/>中心孔</label>}
          {mode === "spring" && <label htmlFor={springWireId}>线径（留空自动）<CadNumberInput id={springWireId} aria-label="弹簧线径" min={0.001} step="any" placeholder="自动" value={springWire} onChange={event=>setSpringWire(event.target.value)} disabled={disabled}/></label>}
          {mode === "line" && (
            <div className="cad-tool-settings__actions">
              <button
                type="button"
                title={platformShortcut("撤回上一段（Ctrl+Z）")}
                disabled={disabled || lineTrail.current.length < 2}
                onClick={props.onUndoSegment}
              >
                撤回一段
              </button>
              <button
                type="button"
                title="闭合折线（C）"
                disabled={disabled || lineTrail.current.length < 2}
                onClick={closeLine}
              >
                闭合
              </button>
            </div>
          )}
          {(mode === "pline" || mode === "spline") && (
            <button type="button" disabled={disabled || pointCount < 2} onClick={finish}>
              完成绘制（{pointCount} 点）
            </button>
          )}
        </section>
      )}
      {detailSettingsOpen && props.detailTool?.controls}
      {drawingError && (
        <button
          type="button"
          onClick={() => void drawingPipeline.current?.flush().then((ok) => setDrawingError(!ok))}
        >
          重试保存图纸
        </button>
      )}
      {inside && (
        <div className="cad-detail-breadcrumb">
          <span>
            详图 {props.project.detailViews?.find((d) => d.id === inside)?.label} · 内部编辑
          </span>
          <button
            type="button"
            onClick={() => {
              setInside(undefined);
              insideRef.current = undefined;
              props.onInside?.(undefined);
              choose("select");
              setSelection([]);
            }}
          >
            完成
          </button>
        </div>
      )}
      {
        <>
            {isPatternTool(mode) && scene.current && props.enabled && (
              <CadPatternPanel
                path={patternPath}
                ref={patternPanel}
                key={`${mode}:${checkpointId}`}
                mode={mode}
                handles={handles}
                scene={scene.current}
                point={patternPoint}
                points={hatchPoints}
                removePoint={(index) =>
                  setHatchPoints((points) => points.filter((_, i) => i !== index))
                }
                picking={commandPicking}
                disabled={disabled || drawingGeometryPending}
                protectedHandles={(props.project.cad?.objects ?? []).flatMap((o) => [
                  ...(o.label ?? []),
                  ...(o.frame ?? []),
                  ...(o.source ?? []),
                ])}
                query={(command, params) => client.current!.request("query", command, params)}
                preview={(result) => {
                  const source = scene.current;
                  if (!result || !source || !isPatternTool(modeRef.current) || locked.current) {
                    patternPreview.current = null;
                    latest.current.onPreview(null);
                    return;
                  }
                  const originals = new Map(
                    result.partial
                      ? []
                      : source.entities.map((e) => [e.handle, JSON.stringify(e.geometry)]),
                  );
                  const changed = new Set(
                    result.entities
                      .filter(
                        (e) =>
                          !originals.has(e.handle) ||
                          originals.get(e.handle) !== JSON.stringify(e.geometry),
                      )
                      .map((e) => e.handle),
                  );
                  const replacingHatches = new Set(
                    source.entities
                      .filter((e) => changed.has(e.handle) && e.type.toLowerCase() === "hatch")
                      .map((e) => e.handle),
                  );
                  const previous = source.primitives
                    .filter((p) => replacingHatches.has(p.handle))
                    .flatMap((p) => p.points);
                  let hatchContext: CadPreview["hatchContext"];
                  if (mode === "hatch" && previous.length) {
                    let minX = Infinity,
                      minY = Infinity,
                      maxX = -Infinity,
                      maxY = -Infinity;
                    for (const [x, y] of previous) {
                      minX = Math.min(minX, x);
                      minY = Math.min(minY, y);
                      maxX = Math.max(maxX, x);
                      maxY = Math.max(maxY, y);
                    }
                    hatchContext = {
                      bounds: [minX, minY, maxX, maxY],
                      primitives: (result.partial ? source : result).primitives.filter((p) => {
                        if (changed.has(p.handle)) return false;
                        let left = Infinity,
                          right = -Infinity,
                          bottom = Infinity,
                          top = -Infinity;
                        for (const [x, y] of p.points) {
                          left = Math.min(left, x);
                          right = Math.max(right, x);
                          bottom = Math.min(bottom, y);
                          top = Math.max(top, y);
                        }
                        return right >= minX && left <= maxX && top >= minY && bottom <= maxY;
                      }),
                    };
                  }
                  patternPreview.current = {
                    mode,
                    scene: source,
                    handles: [],
                    anchor: null,
                    points: [],
                    cursor: patternPoint ?? { x: 0, y: 0 },
                    snapped: false,
                    fragmentId: gestureFragment.current,
                    nativePrimitives: result.primitives.filter((p) => changed.has(p.handle)),
                    gapPoints: result.gapPoints,
                    ...(hatchContext ? { hatchContext } : {}),
                  };
                  latest.current.onPreview(patternPreview.current);
                }}
                apply={execute}
                hint={setHint}
                cancel={cancel}
                pick={(objects) => {
                  previewEpoch.current++;
                  selectionEpoch.current++;
                  patternPreview.current = null;
                  latest.current.onPreview(null);
                  setPatternPoint(null);
                  setHatchPoints([]);
                  if (objects || mode === "hatch") setSelection([]);
                  commandPickingRef.current = objects;
                  setCommandPicking(objects);
                  windowStart.current = null;
                  setWindowSelecting(false);
                  setHint(
                    objects
                      ? "点击或框选对象，Enter 确认选择。"
                      : mode === "hatch"
                        ? "点击封闭区域内部。"
                        : "在画布上指定阵列圆心。",
                  );
                }}
              />
            )}
        </>
      }
      </CadTransientWindow>
      {props.instructionTarget === undefined
        ? instruction
        : props.instructionTarget && createPortal(instruction, props.instructionTarget)}
      {
        <>
          {TOOL_GROUPS.map((group) => (
            <fieldset key={group.label} className="cad-tool-group" aria-label={group.label}>
              <legend className="cad-tool-heading">
                {group.label}
                {group.label === "修改" && (
                  <span>{handles.length ? `${selectedCount} 个对象已选中` : ""}</span>
                )}
              </legend>
              <div className="cad-entity-tools">
                {group.tools.filter(([id]) => !["extend", "chamfer", "arraypolar"].includes(id)).map(([id, label, Icon]) => (
                  <Fragment key={id}>
                  {MENU_TOOLS[id] ? (
                  <CadToolMenu key={id} name={id === "arc" ? "圆弧" : id === "arrayrect" ? "阵列" : label}
                    choices={menuChoices(id)} active={props.enabled && MENU_TOOLS[id]!.includes(mode)}
                    activeChoiceId={methodId}
                    disabled={disabled || (drawingGeometryPending && !DRAW_COMMANDS.has(id) && id !== "trim")}
                    focusCanvas={() => props.getCanvas?.()?.focus({ preventScroll: true })}
                    choose={choice => choose(choice.tool as Mode, choice.id)} />
                ) : (
                  <button
                    key={id}
                    type="button"
                    disabled={
                      disabled ||
                      (drawingGeometryPending &&
                        !DRAW_COMMANDS.has(id) &&
                        (id !== "hatch" || drawingGeometryPending))
                    }
                    aria-pressed={props.enabled && mode === id}
                    aria-label={label}
                    onClick={() => choose(id)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                )}
                  {id === "copy" && props.detailTool?.button}
                  </Fragment>
                ))}
                {group.label === "修改" && (
                  <>
                    <button
                      type="button"
                      disabled={disabled || drawingGeometryPending || !handles.length}
                      onClick={() => void execute("erase", { handles })}
                    >
                      <Eraser size={18} aria-hidden="true" />
                      <span>删除</span>
                    </button>
                    <button
                      type="button"
                      disabled={disabled || drawingGeometryPending || handles.length < 2}
                      onClick={() => void execute("join", { handles })}
                    >
                      <JoinIcon size={18} aria-hidden="true" />
                      <span>合并线段</span>
                    </button>
                    <button
                      type="button"
                      disabled={disabled || drawingGeometryPending}
                      aria-pressed={props.enabled && mode === "explode"}
                      aria-description="分解复合对象；每次分解一层"
                      onClick={startExplode}
                    >
                      <ExplodeIcon size={18} aria-hidden="true" />
                      <span>分解</span>
                    </button>
                    <button
                      type="button"
                      disabled={disabled || drawingGeometryPending || !handles.length}
                      onClick={() => void execute("group", { handles })}
                    >
                      <GroupIcon size={18} aria-hidden="true" />
                      <span>编组</span>
                    </button>
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        drawingGeometryPending ||
                        !scene.current?.groups?.some((group) =>
                          !group.name.startsWith("PW_GEAR_MESH_")&&group.members.some((handle) => selectedHandles.has(handle)),
                        )
                      }
                      onClick={() => void execute("ungroup", { handles })}
                    >
                      <UngroupIcon size={18} aria-hidden="true" />
                      <span>取消编组</span>
                    </button>
                  </>
                )}
              </div>
            </fieldset>
          ))}
          <CadAppearancePanel
            key={handles.join(":")}
            defaults={scene.current?.appearance ?? {color:"#000000",lineweight:0.25,linetype:"Continuous"}}
            selected={selectedAppearances}
            linetypes={scene.current?.linetypes ?? []}
            disabled={disabled || drawingGeometryPending || (scene.current?.entities.some(e=>selectedHandles.has(e.handle)&&e.locked) ?? false) || (handles.length>0&&!scene.current?.entities.some(e=>selectedHandles.has(e.handle)&&supportsCadAppearance(e,"color")))}
            available={{lineweight:!handles.length||!!scene.current?.entities.some(e=>selectedHandles.has(e.handle)&&supportsCadAppearance(e,"lineweight")),linetype:!handles.length||!!scene.current?.entities.some(e=>selectedHandles.has(e.handle)&&supportsCadAppearance(e,"linetype"))}}
            apply={patch=>execute("bridge.appearance",{...patch,...(handles.length?{handles:handles.filter(h=>scene.current?.entities.some(e=>e.handle===h&&supportsCadAppearance(e,Object.keys(patch)[0]!)))}: {})})}
            focusCanvas={()=>props.getCanvas?.()?.focus({preventScroll:true})}
            onError={props.onError}
          />
          {!!props.project.baseFragments?.length && (
            <p>编辑源图实体会同步到引用它的所有片段；局部放大图保留创建时的版本。</p>
          )}
        </>
      }
      {!ready && <p role="status">正在加载 CAD 编辑内核…</p>}
    </section>
  );
}

export function CadSelectionOverlay({
  project,
  selection,
  unit = 1,
  inside,
  showGrips = true,
}: {
  project: DrawingProject;
  selection: CadSelection;
  unit?: number;
  inside?: string | undefined;
  showGrips?: boolean;
}) {
  if (!project.cad || !selection?.handles.length) return null;
  if (selection.checkpointId && selection.checkpointId !== project.cad.assetId) return null;
  const selected = new Set(selection.handles);
  const selectedGears=selection.scene.entities.filter(e=>e.gear&&selected.has(e.handle));
  const bindings = selection.objects ?? project.cad.objects;
  const proxies = new Set(
    bindings?.flatMap((o) => [...(o.label ?? []), ...(o.frame ?? []), ...(o.source ?? [])]),
  );
  const wholeBody = new Set(
    bindings?.filter((o) => o.kind === "detail" && o.id !== inside).flatMap((o) => o.body ?? []),
  );
  const masks = new Set(
    selection.scene.primitives.filter((p) => p.kind === "mask").map((p) => p.handle),
  );
  const objects = (gripUnit: number) => (
    <>
      <CadPrimitiveBatch primitives={selection.scene.primitives.filter(
          (primitive) =>
            selected.has(primitive.handle) &&
            !proxies.has(primitive.handle) &&
            !masks.has(primitive.handle),
        )} point={([x,y])=>cadToPage({x,y},project.cad!.mapping)}
        pointKey={`page:${project.cad!.mapping.originX}:${project.cad!.mapping.originY}:${project.cad!.mapping.scale}`} />
      {showGrips && selected.size <= CAD_GRIP_OBJECT_LIMIT && <g className="cad-control-points" color="var(--drawing-grip, #c45a00)" stroke="currentColor">
      {selection.scene.entities
        .filter(
          (entity) =>
            selected.has(entity.handle) &&
            !entity.locked &&
            entity.type.toLowerCase() !== "hatch" &&
            !proxies.has(entity.handle) &&
            !masks.has(entity.handle) &&
            !wholeBody.has(entity.handle),
        )
        .flatMap((entity) =>
          (entity.grips ?? []).map(([x, y], index) => {
            const point = cadToPage({ x, y }, project.cad!.mapping);
            if(entity.chain) return <g key={`${entity.handle}-grip-${index}`} data-cad-chain-grip={index} data-cad-chain-handle={entity.handle} aria-label={chainGripLabel(entity.chain,index)}>
              <title>{chainGripLabel(entity.chain,index)}</title>
              <rect x={point.x-3.5*gripUnit} y={point.y-3.5*gripUnit} width={7*gripUnit} height={7*gripUnit} fill="white" vectorEffect="non-scaling-stroke"/>
            </g>;
            if (entity.spring && index < 2) return <rect key={`${entity.handle}-grip-${index}`}
              x={point.x-4*gripUnit} y={point.y-4*gripUnit} width={8*gripUnit} height={8*gripUnit}
              fill="white" vectorEffect="non-scaling-stroke"/>;
            if (entity.spring && index === 2) return <polygon key={`${entity.handle}-grip-${index}`}
              points={`${point.x},${point.y-5*gripUnit} ${point.x+5*gripUnit},${point.y} ${point.x},${point.y+5*gripUnit} ${point.x-5*gripUnit},${point.y}`}
              fill="white" vectorEffect="non-scaling-stroke"/>;
            if (entity.spring && index === 3) return <g key={`${entity.handle}-grip-${index}`}>
              <circle cx={point.x} cy={point.y} r={5*gripUnit} fill="white" vectorEffect="non-scaling-stroke"/>
              <circle cx={point.x} cy={point.y} r={2*gripUnit} fill="currentColor" stroke="none"/></g>;
            if(entity.gear) {
              const s=3.5*gripUnit;
              const label=cadGearGripLabel(entity.gear,index);
              const companion=selectedGears.length===2?selectedGears.find(e=>e.handle!==entity.handle)?.handle:undefined;
              const color="var(--drawing-grip, #c45a00)";
              return <g key={`${entity.handle}-grip-${index}`} data-cad-gear-grip={index} data-cad-gear-handle={entity.handle} aria-label={`${cadGearName(entity,companion)} · ${label}`} color={color} stroke={color}>
                <title>{label}</title>
                {index===1 ? <rect x={point.x-s} y={point.y-s} width={s*2} height={s*2} fill="white" vectorEffect="non-scaling-stroke"/>
                  : index===2 ? <path d={`M${point.x} ${point.y-s*1.3}L${point.x+s*1.3} ${point.y}L${point.x} ${point.y+s*1.3}L${point.x-s*1.3} ${point.y}Z`} fill="white" vectorEffect="non-scaling-stroke"/>
                    : <circle cx={point.x} cy={point.y} r={s} fill="white" vectorEffect="non-scaling-stroke"/>}
                {index===3&&<path d={`M${point.x-s*.5} ${point.y-s*.25}a${s*.6} ${s*.6} 0 1 1 ${s*.8} ${s*.7}m0 ${-s*.55}v${s*.55}h${s*.55}`} strokeWidth={1} vectorEffect="non-scaling-stroke"/>}
              </g>;
            }
            return (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: Index is the CAD engine's stable grip identifier.
                key={`${entity.handle}-grip-${index}`}
                cx={point.x}
                cy={point.y}
                r={3 * gripUnit}
                fill="white"
                vectorEffect="non-scaling-stroke"
              />
            );
          }),
        )}
      </g>}
    </>
  );
  return (
    <g
      className="cad-selection-overlay"
      pointerEvents="none"
      color="#007aff"
      stroke="#007aff"
      strokeWidth={2}
      fill="none"
    >
      {project.cad.unified ? objects(unit) : baseFragments(project).map((fragment, index) => {
        const prefix = `cad-selection-${project.projectId}-${index}`;
        const clipped = fragment.clips.reduce(
          (children, clip, clipIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: The stateless clip stack is recreated per immutable scene revision.
            <g key={`${prefix}-${clipIndex}`} clipPath={`url(#${prefix}-${clipIndex})`}>
              {children}
              <defs>
                <clipPath id={`${prefix}-${clipIndex}`}>
                  <polygon points={clip.map((point) => `${point.x},${point.y}`).join(" ")} />
                </clipPath>
              </defs>
            </g>
          ),
          objects(unit / (fragment.scale ?? 1)),
        );
        return (
          <g
            key={fragment.id}
            transform={`translate(${fragment.offset.x} ${fragment.offset.y}) rotate(${fragment.rotation ?? 0}) scale(${fragment.scale ?? 1})`}
          >
            {clipped}
          </g>
        );
      })}
    </g>
  );
}
