import {
  Brush,
  Check,
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Droplet,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  FolderPlus,
  Hand,
  Lasso,
  Layers,
  Lock,
  Maximize2,
  Merge,
  MousePointer2,
  PaintBucket,
  Pipette,
  Plus,
  Redo2,
  Save,
  Square,
  Stamp,
  Trash2,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DesignCorrectionNavigation } from "../design-workspace-shell";
import { KlecksBucketColor } from "./klecks-bucket-color";
import { KlecksCanvasFocus, klecksFocusField } from "./klecks-canvas-focus";
import { type KlecksMenuItem, showKlecksContextMenu } from "./klecks-context-menu";
import type { KlecksFrameClient } from "./klecks-frame-client";
import { resolveKlecksShortcut } from "./klecks-keyboard";
import { KlecksQuickImageSize } from "./klecks-quick-image-size";
import type { KlecksEditorState } from "./klecks-state-port";
import { KlecksStatusDock } from "./klecks-status-dock";
import type { KlecksBrush, KlecksTool, KlecksToolCommand } from "./klecks-tool-port";
import { klecksTransformMatrix } from "./klecks-transform";
import "./klecks-editor-panels.css";
import {
  type AutoTrimOptions,
  DEFAULT_AUTO_TRIM,
} from "../../../../shared/settings/design-auto-trim";
import { MotionPresence } from "../../app/motion-presence";
import { KlecksAutoTrimButton, KlecksAutoTrimSettings } from "./klecks-auto-trim-controls";
import { KlecksDocumentTabs } from "./klecks-document-tabs";
import { KlecksFloatingPanel } from "./klecks-floating-panel";
import {
  KlecksLayerMaskControls,
  LayerMaskIcon,
  maskMenuItems,
} from "./klecks-layer-mask-controls";
import { KlecksSizeDialog } from "./klecks-size-dialog";
import { KlecksToneDialog } from "./klecks-tone-dialog";
import { KlecksWhitespaceDialog } from "./klecks-whitespace-dialog";

type Props = {
  autoTrimDefaults?: AutoTrimOptions | undefined;
  frame: KlecksFrameClient | null;
  state: KlecksEditorState | null;
  documents: {
    viewId: string;
    name: string;
    label: string;
    temporary?: boolean;
    dirty?: boolean;
  }[];
  temporaryFiles?: {
    busy: boolean;
    active: boolean;
    import(): void;
    export(): void;
    exportAll(): void;
    close(id: string): void;
  };
  canvas: ReactNode;
  onActivate(viewId: string): void;
  onAddImages(): void;
  onSave(): Promise<unknown> | void;
  onApply?(): Promise<unknown> | void;
  onApplyAll?(): Promise<unknown> | void;
  onFocusCanvas?(): void;
  loadingId?: string | null;
  loadError?: string | null;
  notice?: ReactNode;
};
function PolygonLassoIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 19 2 7l12 2.5L22 1l-1.5 18H6" />
      <path d="M6 19c1.5-2 3.5-3.5 4-1.5.8 2.8-5.3 5.2-4.5 2.5.6-2 3.6-2.4 4.5-1.5.7.8-.5 3-2.5 4.5" />
    </svg>
  );
}
type ToolChoice<T extends string> = readonly [
  T,
  string,
  ComponentType<{ size?: number }>,
  command?: boolean,
];
function ToolGroup<T extends string>({
  value,
  active,
  disabled,
  onSelect,
  choices,
  menuLabel,
  toggleLabel,
  onDismiss,
}: {
  value: T;
  active: boolean;
  disabled: boolean;
  onSelect(value: T): void;
  choices: readonly ToolChoice<T>[];
  menuLabel: string;
  toggleLabel: string;
  onDismiss?: (() => void) | undefined;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const open = () => {
    const rect = root.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        left: rect.right + 6,
        top: Math.min(rect.top, window.innerHeight - 100),
      });
    }
  };
  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPosition(null);
        if (onDismiss) onDismiss();
        else root.current?.querySelector("button")?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [position, onDismiss]);
  useEffect(() => {
    if (disabled) setPosition(null);
  }, [disabled]);
  const [, label, Icon] = choices.find(([name]) => name === value)!;
  return (
    <div className="klecks-panels__marquee" ref={root}>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        aria-pressed={active}
        onClick={() => onSelect(value)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!disabled) open();
        }}
      >
        <Icon size={18} />
      </button>
      <button
        className="klecks-panels__marquee-toggle"
        type="button"
        aria-label={toggleLabel}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={disabled}
        onClick={() => (position ? setPosition(null) : open())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            open();
            queueMicrotask(() => menu.current?.querySelector<HTMLButtonElement>("button")?.focus());
          }
        }}
      >
        <ChevronDown size={10} />
      </button>
      {position
        ? createPortal(
            <div
              className="klecks-marquee-menu"
              ref={menu}
              role="menu"
              aria-label={menuLabel}
              style={{ position: "fixed", ...position }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const buttons = [...event.currentTarget.querySelectorAll("button")];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  buttons[
                    (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
                  ]?.focus();
                }
              }}
            >
              {choices.map(([name, text, Shape, command]) => {
                const onChoose = () => {
                  setPosition(null);
                  onSelect(name);
                };
                const label = (
                  <>
                    <Shape size={17} />
                    {text}
                  </>
                );
                return command ? (
                  <button key={name} type="button" role="menuitem" onClick={onChoose}>
                    {label}
                  </button>
                ) : (
                  <button
                    key={name}
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === name}
                    onClick={onChoose}
                  >
                    {label}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
const tools: [KlecksTool, string, ComponentType<{ size?: number }>][] = [
  ["move", "移动 (V)", MousePointer2],
  ["rectangle", "矩形选框 (M)", Square],
  ["polygon", "多边形套索 (Shift+L)", PolygonLassoIcon],
  ["magicWand", "魔棒 (W)", WandSparkles],
  ["bucket", "油漆桶 (G)", PaintBucket],
  ["brush", "画笔 (B)", Brush],
  ["clone", "仿制图章 (S)", Stamp],
  ["blur", "模糊", Droplet],
  ["eraser", "橡皮擦 (E)", Eraser],
  ["eyedropper", "吸管 (I)", Pipette],
  ["crop", "裁剪 (C)", Crop],
  ["hand", "抓手 (H)", Hand],
  ["zoom", "缩放 (Z)", ZoomIn],
];
const hex = (color: { r: number; g: number; b: number }) =>
  "#" +
  [color.r, color.g, color.b]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("");
const rgb = (value: string) => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
});
function NumberField({
  label,
  value,
  min = -10000,
  max = 10000,
  step = 1,
  disabled = false,
  onCommit,
  live = false,
  mixed = false,
  onValidityChange,
  resetKey,
  integer = false,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onCommit(value: number): void;
  live?: boolean;
  mixed?: boolean;
  onValidityChange?(valid: boolean): void;
  resetKey?: number;
  integer?: boolean;
}) {
  const [draft, setDraft] = useState(mixed ? "" : String(value)),
    [invalid, setInvalid] = useState(false),
    cancelBlur = useRef(false),
    focused = useRef(false),
    startValue = useRef(value),
    lastCommitted = useRef(value);
  const validDraft = (text: string) =>
    !!text &&
    Number.isFinite(Number(text)) &&
    Number(text) >= min &&
    Number(text) <= max &&
    (!integer || Number.isInteger(Number(text)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: External value or reset changes refresh the draft; inline validity callbacks must not restart it.
  useEffect(() => {
    if (focused.current) return;
    lastCommitted.current = value;
    setDraft(mixed ? "" : String(Math.round(value * 10000) / 10000));
    setInvalid(false);
    onValidityChange?.(true);
  }, [value, mixed, resetKey]);
  return (
    <label className="klecks-panels__number">
      <span>{label}</span>
      <input
        aria-label={label}
        aria-invalid={invalid}
        type="number"
        value={draft}
        placeholder={mixed ? "混合" : undefined}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onFocus={() => {
          focused.current = true;
          startValue.current = value;
          lastCommitted.current = value;
        }}
        onChange={(event) => {
          const text = event.currentTarget.value,
            next = Number(text);
          setDraft(text);
          const valid = validDraft(text);
          setInvalid(live && !valid);
          onValidityChange?.(valid);
          if (live && valid && next !== lastCommitted.current) {
            lastCommitted.current = next;
            onCommit(next);
          }
        }}
        onBlur={() => {
          focused.current = false;
          if (cancelBlur.current) {
            cancelBlur.current = false;
            return;
          }
          const next = Number(draft);
          if (mixed && !draft) {
            setInvalid(false);
            return;
          }
          if (!validDraft(draft)) {
            setInvalid(true);
            onValidityChange?.(false);
            return;
          }
          if (mixed || next !== (live ? lastCommitted.current : value)) {
            lastCommitted.current = next;
            onCommit(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            if (!(mixed && !draft) && !validDraft(draft)) {
              setInvalid(true);
              return;
            }
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelBlur.current = true;
            const original = live ? startValue.current : value;
            if (live && lastCommitted.current !== original) {
              lastCommitted.current = original;
              onCommit(original);
            }
            setDraft(mixed ? "" : String(original));
            setInvalid(false);
            onValidityChange?.(true);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
export function KlecksEditorPanels({
  autoTrimDefaults = DEFAULT_AUTO_TRIM,
  frame,
  state,
  documents,
  canvas,
  onActivate,
  onAddImages,
  onSave,
  onApply,
  onApplyAll,
  onFocusCanvas,
  loadingId,
  loadError,
  notice,
  temporaryFiles,
}: Props) {
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [layersOpen, setLayersOpen] = useState(true);
  const [sizeDialog, setSizeDialog] = useState<"image" | "canvas" | null>(null);
  const [rangePanelKey, setRangePanelKey] = useState(0);
  const [autoTrimOverride, setAutoTrimOptions] = useState<AutoTrimOptions>();
  const autoTrimOptions = autoTrimOverride ?? autoTrimDefaults;
  const [autoTrimSettings, setAutoTrimSettings] = useState(false);
  const [rangeInputReset, setRangeInputReset] = useState(0);
  const rangeOpen = !!state?.colorRange;
  // Exiting panels remain mounted briefly; a new session must not inherit drafts.
  useEffect(() => {
    if (!rangeOpen) setRangePanelKey((key) => key + 1);
  }, [rangeOpen]);
  const [marquee, setMarquee] = useState<"rectangle" | "ellipse">("rectangle");
  const [lasso, setLasso] = useState<"polygon" | "lasso">("polygon");
  const [dropLayer, setDropLayer] = useState<{
    id: string;
    edge: "before" | "after";
  } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameRequest = useRef<string | null>(null);
  const selectionAnchor = useRef<{ viewId: string; id: string } | null>(null);
  useEffect(() => {
    if (state?.tool === "rectangle" || state?.tool === "ellipse") setMarquee(state.tool);
    if (state?.tool === "polygon" || state?.tool === "lasso") setLasso(state.tool);
  }, [state?.tool]);
  const brushEdits = useRef<{
    key: string;
    desired: KlecksBrush;
    pending: number;
  } | null>(null);
  const menus = useRef<HTMLDivElement>(null);
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const workflowNavigation = useContext(DesignCorrectionNavigation);
  const displayMenu = useRef<HTMLDetailsElement>(null);
  const ownedMenus = useCallback(
    () => [
      ...new Set([
        ...Array.from(
          menus.current
            ?.closest("section.klecks-panels")
            ?.querySelectorAll<HTMLDetailsElement>("details") ?? [],
        ),
        ...(displayMenu.current ? [displayMenu.current] : []),
      ]),
    ],
    [],
  );
  const closeContextMenu = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: View, tool, and pending-operation transitions dismiss the old context menu.
  useEffect(() => () => closeContextMenu.current(), [state?.activeId, state?.tool, state?.pending]);
  useEffect(() => {
    const closeExcept = (except?: HTMLDetailsElement) => {
      ownedMenus().forEach((menu) => {
        if (menu !== except) menu.open = false;
      });
    };
    const pointer = (event: Event) => {
      if (event.target instanceof Element && !event.target.closest(".klecks-panels__menu-slot"))
        setCompactMenuOpen(false);
      const current = event.target instanceof Element ? event.target.closest("details") : null;
      closeExcept(
        current instanceof HTMLDetailsElement && ownedMenus().includes(current)
          ? current
          : undefined,
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeExcept();
        setCompactMenuOpen(false);
      }
    };
    const click = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const current = event.target.closest("details");
      if (!(current instanceof HTMLDetailsElement) || !ownedMenus().includes(current)) return;
      if (event.target.closest("summary")) closeExcept(current);
      else if (event.target.closest("button")) current.open = false;
    };
    const change = (event: Event) => {
      const current = event.target instanceof Element ? event.target.closest("details") : null;
      if (
        current instanceof HTMLDetailsElement &&
        ownedMenus().includes(current) &&
        event.target instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(event.target.type)
      )
        current.open = false;
    };
    const toggle = (event: Event) => {
      const current = event.target;
      if (current instanceof HTMLDetailsElement && current.open && ownedMenus().includes(current))
        closeExcept(current);
    };
    const blur = () => closeExcept();
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("click", click);
    document.addEventListener("change", change);
    document.addEventListener("toggle", toggle, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("click", click);
      document.removeEventListener("change", change);
      document.removeEventListener("toggle", toggle, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
    };
  }, [ownedMenus]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: View, tool, and pending-operation transitions close the menus rendered for the old state.
  useEffect(() => {
    ownedMenus().forEach((menu) => {
      menu.open = false;
    });
  }, [ownedMenus, state?.tool, state?.pending, state?.activeId]);
  const drag = useRef<{ viewId: string; id: string; ids: string[] } | null>(null),
    controls = state?.controls,
    target = state?.identity;
  const onlyLayer = state?.layers.length === 1 ? state.layers[0] : undefined;
  const active =
    onlyLayer ??
    (state?.selectedLayerIds?.length === 0
      ? undefined
      : state?.layers.find((layer) => layer.id === state.activeLayerId));
  const below =
    state?.layers[(state?.layers.findIndex((layer) => layer.id === state.activeLayerId) ?? 0) - 1];
  const selectedIds = onlyLayer
    ? [onlyLayer.id]
    : (state?.selectedLayerIds ?? (active ? [active.id] : []));
  const selectedLayers = state?.layers.filter((layer) => selectedIds.includes(layer.id)) ?? [];
  const multiple = selectedIds.length > 1;
  const batchIds = multiple ? { ids: selectedIds } : {};
  const editingPending = !!state?.pending && !state?.navigationActive;
  const unavailable = !target || !frame || !!state?.locked || !!loadingId || busy,
    disabled = unavailable || editingPending;
  useEffect(() => {
    if (renameRequest.current && renameRequest.current === active?.id && !multiple && !disabled) {
      renameRequest.current = null;
      renameInput.current?.focus();
      renameInput.current?.select();
    }
  }, [active?.id, multiple, disabled]);
  const running = useRef(0);
  const run = async (operation: () => Promise<unknown> | void, focus = true, blocking = true) => {
    setError(null);
    if (blocking) {
      running.current++;
      setBusy(true);
    }
    try {
      await operation();
      if (focus) onFocusCanvas?.();
    } catch (failure) {
      setError(
        typeof failure === "object" &&
          failure !== null &&
          "message" in failure &&
          typeof failure.message === "string"
          ? failure.message
          : "图片操作未完成，请重试。",
      );
    } finally {
      if (blocking) {
        running.current--;
        setBusy(running.current > 0);
      }
    }
  };
  const changeBrush = (field: "size" | "hardness" | "opacity" | "flow", value: number) => {
    if (!target || !frame || !state) return;
    const key = JSON.stringify(target);
    let edits = brushEdits.current;
    if (!edits || edits.key !== key) {
      edits = { key, desired: { ...state.brush }, pending: 0 };
      brushEdits.current = edits;
    }
    const current = edits.pending
      ? edits.desired
      : (frame.state?.snapshot?.()?.brush ?? state.brush);
    const next = { ...current, [field]: value };
    edits.desired = next;
    edits.pending++;
    const captured = edits;
    void run(
      async () => {
        try {
          await frame.tools.send(target, { action: "brush", ...next });
        } finally {
          captured.pending--;
        }
      },
      false,
      false,
    );
  };
  const tool = (command: KlecksToolCommand, focus = true) => {
    if (target && frame)
      void run(
        () => frame.tools.send(target, command),
        focus,
        ![
          "retouchOptions",
          "tone",
          "whitespace",
          "colorRange",
          "bucketOptions",
          "bucketInputValidity",
          "colors",
        ].includes(command.action) &&
          !(
            command.action === "layer" &&
            ["select", "selectMany", "visibility", "solo", "opacity", "locks", "rename"].includes(
              command.operation,
            )
          ),
      );
  };
  const action = (command: Parameters<KlecksFrameClient["send"]>[1]) => {
    if (target && frame)
      void run(async () => {
        const code = await frame.send(target, command);
        if (code !== "ACCEPTED") throw new Error("当前操作不可用，请先完成或取消正在进行的操作。");
      });
  };
  const crop = controls?.crop ?? {
    left: 0,
    top: 0,
    width: state?.size?.width ?? 1,
    height: state?.size?.height ?? 1,
  };
  const updateCrop = (change: Partial<typeof crop>) =>
    tool(
      {
        action: "crop",
        operation: "preview",
        rect: { ...crop, ...change },
        deletePixels: controls?.deletePixels ?? false,
      },
      false,
    );
  const transform = controls?.transform;
  const mirrorScope =
    transform?.target === "selection"
      ? "选区轮廓"
      : multiple
        ? "所选图层"
        : state?.hasSelection
          ? "选中内容"
          : "当前图层";
  const mirrorDisabled =
    unavailable ||
    (!!editingPending && !transform) ||
    (!transform &&
      (selectedLayers.length === 0 ||
        selectedLayers.some(
          (layer) => layer.locks.all || layer.locks.pixels || layer.locks.position,
        )));
  const mirrorHint = mirrorDisabled
    ? "请先完成当前操作，并选择未锁定的图层；背景层可先转换为普通图层。"
    : `仅翻转${mirrorScope}，不影响其他图片；可撤销。`;
  const sx = transform ? Math.hypot(transform.matrix.a, transform.matrix.b) : 1,
    sy = transform
      ? (transform.matrix.a * transform.matrix.d - transform.matrix.b * transform.matrix.c) / sx
      : 1;
  const angle = transform
    ? (Math.atan2(transform.matrix.b, transform.matrix.a) * 180) / Math.PI
    : 0;
  const center = transform
    ? {
        x: transform.bounds.left + transform.bounds.width / 2,
        y: transform.bounds.top + transform.bounds.height / 2,
      }
    : { x: 0, y: 0 };
  const tx = transform
      ? transform.matrix.a * center.x +
        transform.matrix.c * center.y +
        transform.matrix.e -
        center.x
      : 0,
    ty = transform
      ? transform.matrix.b * center.x +
        transform.matrix.d * center.y +
        transform.matrix.f -
        center.y
      : 0;
  const updateTransform = (
    change: Partial<{
      dx: number;
      dy: number;
      scaleX: number;
      scaleY: number;
      angle: number;
    }>,
  ) => {
    if (!transform || !target || !frame) return;
    if (controls?.transformLinked) {
      if (change.scaleX !== undefined) change = { ...change, scaleY: (sy * change.scaleX) / sx };
      else if (change.scaleY !== undefined && sy !== 0)
        change = { ...change, scaleX: (sx * change.scaleY) / sy };
    }
    void run(
      () =>
        frame.tools.send(target, {
          action: "transform",
          operation: "preview",
          matrix: klecksTransformMatrix(transform.bounds, {
            dx: tx,
            dy: ty,
            scaleX: sx,
            scaleY: sy,
            angle,
            ...change,
          }),
        }),
      false,
    );
  };
  const preferences = controls?.navigation;
  const guardNavigationInteraction = (event: SyntheticEvent) => {
    if (state?.navigationActive) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <section
      className="klecks-panels"
      aria-label="图片编辑工作区"
      data-layers={layersOpen}
      onClickCapture={guardNavigationInteraction}
      onPointerDownCapture={guardNavigationInteraction}
      onChangeCapture={guardNavigationInteraction}
      onKeyDownCapture={(event) => {
        if (
          state?.colorRange &&
          ["Escape", "Enter"].includes(event.key) &&
          !klecksFocusField(event.target as Element)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape" && target && frame)
            void run(
              async () => {
                await frame.tools.send(target, { action: "colorRange", operation: "cancel" });
                await frame.tools.send(target, { action: "tool", tool: "hand" });
              },
              true,
              false,
            );
          else tool({ action: "colorRange", operation: "apply" });
          return;
        }
        if (
          event.key === "Escape" &&
          state?.wandBusy &&
          !klecksFocusField(event.target as Element)
        ) {
          event.preventDefault();
          event.stopPropagation();
          tool({ action: "cancelWand" });
          return;
        }
        if (event.key !== "Escape") guardNavigationInteraction(event);
      }}
    >
      <header className="klecks-panels__header">
        <span className="klecks-panels__workbench-label">外观工作台</span>
        <div className="klecks-panels__menu-slot" data-expanded={compactMenuOpen}>
          <button
            type="button"
            className="klecks-panels__menu-trigger"
            aria-haspopup="true"
            aria-expanded={compactMenuOpen}
            onClick={() => setCompactMenuOpen((open) => !open)}
          >
            修图菜单 <ChevronDown size={12} aria-hidden="true" />
          </button>
          {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Delegates activation from native buttons, including keyboard-generated clicks. */}
          <div
            className="klecks-panels__menus"
            ref={menus}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button"))
                setCompactMenuOpen(false);
            }}
          >
            <details>
              <summary>文件</summary>
              <fieldset aria-label="图片文件命令">
                {temporaryFiles ? (
                  <button
                    type="button"
                    disabled={busy || temporaryFiles.busy || editingPending}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      temporaryFiles.import();
                    }}
                  >
                    <FolderPlus size={15} />
                    <span>打开临时图片…</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="补充图片"
                  disabled={editingPending || busy}
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onAddImages();
                  }}
                >
                  <FolderPlus size={15} />
                  <span>补充专利附图</span>
                </button>
                <button
                  type="button"
                  aria-label={temporaryFiles?.active ? "导出临时图片" : "保存编辑"}
                  disabled={disabled || !!temporaryFiles?.busy}
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    void run(onSave);
                  }}
                >
                  <Save size={15} />
                  <span>{temporaryFiles?.active ? "导出临时图片…" : "保存编辑"}</span>
                  <kbd>{/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}+S</kbd>
                </button>
                {temporaryFiles && !temporaryFiles.active ? (
                  <button
                    type="button"
                    disabled={disabled || temporaryFiles.busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      temporaryFiles.export();
                    }}
                  >
                    <Save size={15} />
                    <span>导出图片…</span>
                  </button>
                ) : null}
                {temporaryFiles && documents.some((item) => item.temporary) ? (
                  <button
                    type="button"
                    disabled={disabled || temporaryFiles.busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      temporaryFiles.exportAll();
                    }}
                  >
                    <Save size={15} />
                    <span>导出所有临时图片…</span>
                  </button>
                ) : null}
              </fieldset>
            </details>
            <details>
              <summary>编辑</summary>
              <fieldset aria-label="编辑图片命令">
                {(
                  [
                    ["undo", "撤销", "Z"],
                    ["redo", "重做", "Shift+Z"],
                    ["cut", "剪切", "X"],
                    ["copy", "复制", "C"],
                    ["copyMerged", "合并复制", "Shift+C"],
                    ["paste", "粘贴", "V"],
                    ["pasteInPlace", "原位粘贴", "Shift+V"],
                    ["layerViaCopy", "通过拷贝的图层", "J"],
                    ["selectAll", "全选", "A"],
                    ["deselect", "取消选区", "D"],
                    ["reselect", "重新选择", "Shift+D"],
                    ["invertSelection", "反选", "Shift+I"],
                  ] as const
                ).map(([command, label, key]) => (
                  <button
                    key={command}
                    type="button"
                    disabled={
                      ((command === "undo" || command === "redo") && controls?.transform
                        ? unavailable
                        : disabled) ||
                      (command === "undo" && state?.canUndo === false) ||
                      (command === "redo" && state?.canRedo === false)
                    }
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      action(command);
                    }}
                  >
                    {label}
                    <kbd>
                      {/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}+{key}
                    </kbd>
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="油漆桶"
                  disabled={disabled}
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    action("fillDialog");
                  }}
                >
                  油漆桶<kbd>G</kbd>
                </button>
                <fieldset className="klecks-panels__mirror-group">
                  <legend>变换 · {mirrorScope}</legend>
                  {(["horizontal", "vertical"] as const).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      disabled={mirrorDisabled}
                      title={`${axis === "horizontal" ? "左右镜像" : "上下镜像"}。${mirrorHint}`}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        tool({ action: "flip", axis, target: "pixels" });
                      }}
                    >
                      {axis === "horizontal" ? "水平翻转" : "垂直翻转"}
                    </button>
                  ))}
                </fieldset>
              </fieldset>
            </details>
            <details>
              <summary>选择</summary>
              <fieldset aria-label="选区命令">
                {(
                  [
                    ["selectAll", "全选"],
                    ["deselect", "取消选区"],
                    ["reselect", "重新选择"],
                    ["invertSelection", "反选"],
                  ] as const
                ).map(([command, label]) => (
                  <button
                    key={command}
                    type="button"
                    disabled={disabled}
                    onClick={() => action(command)}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            </details>
            <details>
              <summary>图层</summary>
              <fieldset aria-label="图层命令">
                {(
                  [
                    ["layerViaCopy", "通过拷贝的图层", "J"],
                    ["mergeLayers", multiple ? "合并所选图层" : "向下合并", "E"],
                    ["mergeVisible", "合并可见图层", "Shift+E"],
                    ["stampLayers", "盖印所选图层", "Alt+E"],
                    ["stampVisible", "盖印可见图层", "Alt+Shift+E"],
                    ["layerForward", "上移一层", "]"],
                    ["layerBackward", "下移一层", "["],
                    ["layerToFront", "置于顶层", "Shift+]"],
                    ["layerToBack", "置于底层", "Shift+["],
                    ["selectAllLayers", "选择所有普通图层", "Alt+A"],
                    ["deleteLayers", "删除所选图层", ""],
                  ] as const
                ).map(([command, label, key]) => (
                  <button
                    key={command}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      action(command);
                    }}
                  >
                    {label}
                    {key ? (
                      <kbd>
                        {/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}+{key}
                      </kbd>
                    ) : null}
                  </button>
                ))}
                {active && !multiple ? (
                  <fieldset className="klecks-panels__mirror-group">
                    <legend>图层蒙版</legend>
                    {maskMenuItems(active, (maskOperation) =>
                      tool({ action: "layer", operation: "mask", id: active.id, maskOperation }),
                    ).map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        disabled={disabled || item.disabled}
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open");
                          item.run?.();
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </fieldset>
                ) : null}
              </fieldset>
            </details>
            <details>
              <summary>图像</summary>
              <fieldset aria-label="图像尺寸命令">
                {(["levels", "threshold"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      tool({ action: "tone", operation: "begin", mode }, false);
                    }}
                  >
                    {mode === "levels" ? "色阶…" : "阈值…"}
                  </button>
                ))}
                {(["trim", "pad"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      tool({ action: "whitespace", operation: "begin", mode }, false);
                    }}
                  >
                    {mode === "trim" ? "自动裁白边…" : "增加留白…"}
                  </button>
                ))}
                {(["image", "canvas"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setSizeDialog(kind);
                    }}
                  >
                    {kind === "image" ? "图像大小…" : "画布大小…"}
                  </button>
                ))}
                {([90, 270, 180] as const).map((degrees) => (
                  <button
                    key={degrees}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      tool({ action: "rotateCanvas", degrees });
                    }}
                  >
                    {degrees === 90
                      ? "顺时针旋转 90°"
                      : degrees === 270
                        ? "逆时针旋转 90°"
                        : "旋转 180°"}
                  </button>
                ))}
                {(["horizontal", "vertical"] as const).map((axis) => (
                  <button
                    key={axis}
                    type="button"
                    disabled={disabled}
                    title={`翻转当前图片的全部图层，包括隐藏和锁定图层；其他图片不受影响。${axis === "horizontal" ? "左右镜像" : "上下镜像"}。`}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      tool({ action: "flip", axis, target: "canvas" });
                    }}
                  >
                    {axis === "horizontal" ? "水平翻转画布" : "垂直翻转画布"}
                  </button>
                ))}
              </fieldset>
            </details>
            <details>
              <summary>视图</summary>
              <fieldset aria-label="画布查看命令">
                {(
                  [
                    ["zoomIn", "放大", "+"],
                    ["zoomOut", "缩小", "−"],
                    ["fitCanvas", "适合窗口", "0"],
                    ["actualPixels", "100%", "1"],
                  ] as const
                ).map(([command, label, key]) => (
                  <button
                    key={command}
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      action(command);
                    }}
                  >
                    {label}
                    <kbd>
                      {/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}+{key}
                    </kbd>
                  </button>
                ))}
              </fieldset>
            </details>
          </div>
        </div>
        {workflowNavigation ?? <strong>小栈修图</strong>}
        <KlecksDocumentTabs
          documents={documents}
          activeId={state?.activeId ?? null}
          loadingId={loadingId}
          dirty={!!state?.dirty}
          disabled={editingPending || busy || !!state?.locked || !!temporaryFiles?.busy}
          onActivate={onActivate}
          onClose={temporaryFiles?.close}
        />
        <div className="klecks-panels__header-actions">
          <KlecksAutoTrimButton
            options={autoTrimOptions}
            disabled={disabled}
            onRun={() => tool({ action: "autoTrim", options: autoTrimOptions })}
            onSettings={() => setAutoTrimSettings(true)}
          />
          {onApplyAll ? (
            <button
              type="button"
              className="klecks-panels__secondary"
              aria-label="应用到全部"
              title="将本案件所有已分配图片的编辑结果应用到各自视图，不包含暂存图片和临时图片"
              disabled={disabled || !documents.some((document) => !document.temporary)}
              onClick={() => void run(onApplyAll)}
            >
              <Check size={15} />
              <span>应用到全部</span>
            </button>
          ) : null}
          {onApply ? (
            <button
              className="klecks-panels__primary"
              type="button"
              aria-label="应用到视图"
              title="应用到视图"
              disabled={disabled || !state?.unapplied}
              onClick={() => void run(onApply)}
            >
              <Check size={15} />
              <span>应用到视图</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label="显示或隐藏图层"
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen((value) => !value)}
          >
            <Layers size={16} />
          </button>
        </div>
      </header>
      <section className="klecks-panels__options" aria-label="当前工具选项" data-tool={state?.tool}>
        {transform ? (
          <>
            <strong>{transform.target === "selection" ? "变换选区" : "自由变换"}</strong>
            <NumberField
              label="水平位移"
              value={tx}
              onCommit={(dx) => updateTransform({ dx })}
              disabled={unavailable}
            />
            <NumberField
              label="垂直位移"
              value={ty}
              onCommit={(dy) => updateTransform({ dy })}
              disabled={unavailable}
            />
            <NumberField
              label="宽度 %"
              value={sx * 100}
              min={-10000}
              max={10000}
              step={0.1}
              onCommit={(value) => updateTransform({ scaleX: value / 100 })}
              disabled={unavailable}
            />
            <NumberField
              label="高度 %"
              value={sy * 100}
              min={-10000}
              max={10000}
              step={0.1}
              onCommit={(value) => updateTransform({ scaleY: value / 100 })}
              disabled={unavailable}
            />
            <label>
              <input
                type="checkbox"
                aria-label="等比缩放"
                checked={controls?.transformLinked ?? true}
                disabled={unavailable}
                onChange={(event) =>
                  tool(
                    {
                      action: "transformLinked",
                      enabled: event.currentTarget.checked,
                    },
                    false,
                  )
                }
              />
              等比
            </label>
            <NumberField
              label="旋转 °"
              value={angle}
              min={-36000}
              max={36000}
              step={0.1}
              onCommit={(angle) => updateTransform({ angle })}
              disabled={unavailable}
            />
            <button
              type="button"
              disabled={unavailable}
              onClick={() => tool({ action: "transform", operation: "apply" })}
            >
              <Check size={15} />
              应用
            </button>
            {(["horizontal", "vertical"] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                disabled={mirrorDisabled}
                aria-label={axis === "horizontal" ? "水平翻转" : "垂直翻转"}
                title={`${axis === "horizontal" ? "左右镜像" : "上下镜像"} · ${mirrorScope}；Enter 确认，Esc 取消。`}
                onClick={() => tool({ action: "flip", axis, target: "pixels" })}
              >
                {axis === "horizontal" ? (
                  <FlipHorizontal2 size={16} />
                ) : (
                  <FlipVertical2 size={16} />
                )}
              </button>
            ))}
            {Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-6 ? (
              <small role="status">此变换改变长宽比例，请核对外观结构后再应用。</small>
            ) : null}
            <button
              type="button"
              disabled={unavailable}
              onClick={() => tool({ action: "transform", operation: "cancel" })}
            >
              <X size={15} />
              取消
            </button>
          </>
        ) : (state?.tool === "clone" || state?.tool === "blur") && state.preferences ? (
          <>
            <strong>{state.tool === "clone" ? "仿制图章" : "模糊"}</strong>
            {(
              [
                "size",
                "hardness",
                ...(state.tool === "clone" ? (["opacity", "flow"] as const) : []),
              ] as const
            ).map((field) => (
              <NumberField
                key={field}
                label={
                  field === "size"
                    ? "大小 px"
                    : field === "hardness"
                      ? "硬度 %"
                      : field === "flow"
                        ? "流量 %"
                        : "不透明度 %"
                }
                value={state.brush[field] * (field === "size" ? 1 : 100)}
                min={field === "size" ? 1 : 0}
                max={field === "size" ? 5000 : 100}
                live
                disabled={disabled}
                onCommit={(value) => changeBrush(field, value / (field === "size" ? 1 : 100))}
              />
            ))}
            {state.tool === "clone" ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={state.preferences.retouch.aligned}
                    disabled={disabled}
                    onChange={(e) =>
                      tool(
                        {
                          action: "retouchOptions",
                          ...state.preferences!.retouch,
                          aligned: e.currentTarget.checked,
                        },
                        false,
                      )
                    }
                  />
                  对齐
                </label>
                <label>
                  取样
                  <select
                    aria-label="仿制图章取样"
                    value={state.preferences.retouch.merged ? "merged" : "current"}
                    disabled={disabled}
                    onChange={(e) =>
                      tool(
                        {
                          action: "retouchOptions",
                          ...state.preferences!.retouch,
                          merged: e.currentTarget.value === "merged",
                        },
                        false,
                      )
                    }
                  >
                    <option value="current">当前图层</option>
                    <option value="merged">所有可见图层</option>
                  </select>
                </label>
                <small>Alt／Option 单击取样后涂抹；重新取样可重设对齐。</small>
              </>
            ) : (
              <NumberField
                label="强度 %"
                value={state.preferences.retouch.strength * 100}
                min={0}
                max={100}
                live
                disabled={disabled}
                onCommit={(value) =>
                  tool(
                    {
                      action: "retouchOptions",
                      ...state.preferences!.retouch,
                      strength: value / 100,
                    },
                    false,
                  )
                }
              />
            )}
          </>
        ) : state?.tool === "brush" || state?.tool === "eraser" ? (
          <>
            <strong>
              {state.tool === "brush" ? "画笔" : "橡皮擦"}
              {active?.mask?.active ? " · 蒙版" : ""}
            </strong>
            {(["size", "hardness", "opacity", "flow"] as const).map((field, index) => (
              <NumberField
                key={field}
                label={["大小 px", "硬度 %", "不透明度 %", "流量 %"][index]!}
                value={state.brush[field] * (field === "size" ? 1 : 100)}
                min={field === "size" ? 1 : 0}
                max={field === "size" ? 5000 : 100}
                disabled={disabled}
                live
                onCommit={(value) => changeBrush(field, value / (field === "size" ? 1 : 100))}
              />
            ))}
            {controls ? (
              <label>
                笔尖
                <select
                  value={controls.cursor.tip}
                  disabled={disabled}
                  onChange={(event) =>
                    tool(
                      {
                        action: "cursor",
                        ...controls.cursor,
                        tip: event.currentTarget.value as typeof controls.cursor.tip,
                      },
                      false,
                    )
                  }
                >
                  <option value="normal">普通笔尖</option>
                  <option value="full">完整笔尖</option>
                  <option value="precise">精确十字</option>
                </select>
              </label>
            ) : null}
          </>
        ) : state?.tool === "crop" ? (
          <>
            <strong>裁剪</strong>
            {(["width", "height"] as const).map((field, index) => (
              <NumberField
                key={field}
                label={["宽度 px", "高度 px"][index]!}
                value={crop[field]}
                min={1}
                disabled={unavailable || (editingPending && !controls?.crop)}
                onCommit={(value) => updateCrop({ [field]: Math.round(value) })}
              />
            ))}
            <button
              type="button"
              disabled={unavailable || !controls?.crop}
              onClick={() => tool({ action: "crop", operation: "apply" })}
            >
              <Check size={15} />
              应用
            </button>
            <button
              type="button"
              disabled={unavailable || !controls?.crop}
              onClick={() => tool({ action: "crop", operation: "cancel" })}
            >
              <X size={15} />
              取消
            </button>
            <div className="klecks-panels__menus klecks-panels__crop-precision">
              <details>
                <summary>精确调整</summary>
                <div>
                  {(["left", "top"] as const).map((field, index) => (
                    <NumberField
                      key={field}
                      label={["左侧 px", "顶部 px"][index]!}
                      value={crop[field]}
                      min={-10000}
                      disabled={unavailable || (editingPending && !controls?.crop)}
                      onCommit={(value) => updateCrop({ [field]: Math.round(value) })}
                    />
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={controls?.deletePixels ?? false}
                      disabled={unavailable}
                      onChange={(event) =>
                        tool(
                          {
                            action: "crop",
                            operation: "preview",
                            rect: crop,
                            deletePixels: event.currentTarget.checked,
                          },
                          false,
                        )
                      }
                    />
                    删除裁剪的像素
                  </label>
                </div>
              </details>
            </div>
          </>
        ) : state &&
          ["rectangle", "ellipse", "lasso", "polygon", "magicWand"].includes(state.tool) &&
          controls ? (
          <>
            <strong>{state.tool === "magicWand" ? "魔棒" : "选区"}</strong>
            <label>
              模式
              <select
                value={controls.selection.mode}
                disabled={disabled}
                onChange={(event) =>
                  tool(
                    {
                      action: "selectionOptions",
                      ...controls.selection,
                      mode: event.currentTarget.value as typeof controls.selection.mode,
                    },
                    false,
                  )
                }
              >
                <option value="replace">新建选区</option>
                <option value="add">添加</option>
                <option value="subtract">减去</option>
                <option value="intersect">交叉</option>
              </select>
            </label>
            {state.tool === "magicWand" && controls.magicWand ? (
              <>
                <NumberField
                  label="容差"
                  value={controls.magicWand.tolerance}
                  min={0}
                  max={255}
                  step={1}
                  disabled={disabled}
                  onCommit={(tolerance) =>
                    tool(
                      {
                        action: "wandOptions",
                        ...controls.magicWand!,
                        tolerance: Math.round(tolerance),
                      },
                      false,
                    )
                  }
                />
                <label>
                  取样大小{" "}
                  <select
                    aria-label="魔棒取样大小"
                    value={controls.magicWand.sampleSize}
                    disabled={disabled}
                    onChange={(event) =>
                      tool(
                        {
                          action: "wandOptions",
                          ...controls.magicWand!,
                          sampleSize: Number(event.currentTarget.value) as 1 | 3 | 5 | 11,
                        },
                        false,
                      )
                    }
                  >
                    <option value={1}>取样点</option>
                    <option value={3}>3 × 3 平均</option>
                    <option value={5}>5 × 5 平均</option>
                    <option value={11}>11 × 11 平均</option>
                  </select>
                </label>
                <label title="开启时只选择与点击位置相连的同色区域；关闭时选择整张图中的相近颜色。">
                  <input
                    type="checkbox"
                    checked={controls.magicWand.contiguous}
                    disabled={disabled}
                    onChange={(event) =>
                      tool(
                        {
                          action: "wandOptions",
                          ...controls.magicWand!,
                          contiguous: event.currentTarget.checked,
                        },
                        false,
                      )
                    }
                  />
                  连续区域
                </label>
                <label title="按所有可见图层合成后的颜色建立选区，不修改图层。">
                  <input
                    type="checkbox"
                    checked={controls.magicWand.sampleAllLayers}
                    disabled={disabled}
                    onChange={(event) =>
                      tool(
                        {
                          action: "wandOptions",
                          ...controls.magicWand!,
                          sampleAllLayers: event.currentTarget.checked,
                        },
                        false,
                      )
                    }
                  />
                  取样所有图层
                </label>
              </>
            ) : null}
            {state.tool !== "magicWand" ? (
              <NumberField
                label="羽化 px"
                value={controls.selection.feather}
                min={0}
                max={1000}
                disabled={disabled}
                onCommit={(feather) =>
                  tool(
                    {
                      action: "selectionOptions",
                      ...controls.selection,
                      feather,
                    },
                    false,
                  )
                }
              />
            ) : null}
            <div className="klecks-panels__menus klecks-panels__selection-settings">
              <details>
                <summary>更多参数</summary>
                <div>
                  {["rectangle", "ellipse"].includes(state.tool) ? (
                    <>
                      <label>
                        样式
                        <select
                          value={controls.selection.style}
                          disabled={disabled}
                          onChange={(event) =>
                            tool(
                              {
                                action: "selectionOptions",
                                ...controls.selection,
                                style: event.currentTarget.value as typeof controls.selection.style,
                              },
                              false,
                            )
                          }
                        >
                          <option value="normal">正常</option>
                          <option value="ratio">固定比例</option>
                          <option value="fixed">固定尺寸</option>
                        </select>
                      </label>
                      {controls.selection.style !== "normal"
                        ? (["width", "height"] as const).map((field) => (
                            <NumberField
                              key={field}
                              label={field === "width" ? "选框宽度" : "选框高度"}
                              value={controls.selection[field]}
                              min={1}
                              disabled={disabled}
                              onCommit={(value) =>
                                tool(
                                  {
                                    action: "selectionOptions",
                                    ...controls.selection,
                                    [field]: value,
                                  },
                                  false,
                                )
                              }
                            />
                          ))
                        : null}
                    </>
                  ) : null}
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.selection.antiAlias}
                      disabled={disabled || state.tool === "rectangle"}
                      onChange={(event) =>
                        tool(
                          {
                            action: "selectionOptions",
                            ...controls.selection,
                            antiAlias: event.currentTarget.checked,
                          },
                          false,
                        )
                      }
                    />
                    消除锯齿
                  </label>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => action("invertSelection")}
                  >
                    反选
                  </button>
                </div>
              </details>
            </div>
            {state.tool === "magicWand" && !state.wandBusy ? (
              <small title="Shift 添加，Alt 减去，Shift+Alt 交叉；W 调用魔棒，Esc 返回手型。">
                点击相近颜色建立选区
              </small>
            ) : null}
          </>
        ) : state?.tool === "bucket" && controls?.bucket ? (
          <>
            <strong>油漆桶</strong>
            <KlecksBucketColor
              color={controls.colors.foreground}
              disabled={disabled}
              onChange={(foreground) =>
                tool(
                  { action: "colors", foreground, background: controls.colors.background },
                  false,
                )
              }
              onValidity={(valid) =>
                tool({ action: "bucketInputValidity", field: "color", valid }, false)
              }
            />
            <NumberField
              label="不透明度 %"
              value={controls.bucket.opacity}
              min={0}
              max={100}
              live
              disabled={disabled}
              onValidityChange={(valid) =>
                tool({ action: "bucketInputValidity", field: "opacity", valid }, false)
              }
              onCommit={(opacity) => tool({ action: "bucketOptions", options: { opacity } }, false)}
            />
            <NumberField
              label="容差"
              value={controls.bucket.tolerance}
              min={0}
              max={255}
              integer
              live
              disabled={disabled || !!state.hasSelection}
              onValidityChange={(valid) =>
                tool({ action: "bucketInputValidity", field: "tolerance", valid }, false)
              }
              onCommit={(tolerance) =>
                tool({ action: "bucketOptions", options: { tolerance } }, false)
              }
            />
            <label>
              <input
                type="checkbox"
                checked={controls.bucket.contiguous}
                disabled={disabled || !!state.hasSelection}
                onChange={(e) =>
                  tool(
                    { action: "bucketOptions", options: { contiguous: e.currentTarget.checked } },
                    false,
                  )
                }
              />
              连续区域
            </label>
            <label>
              <input
                type="checkbox"
                checked={controls.bucket.antiAlias}
                disabled={disabled || !!state.hasSelection}
                onChange={(e) =>
                  tool(
                    { action: "bucketOptions", options: { antiAlias: e.currentTarget.checked } },
                    false,
                  )
                }
              />
              消除锯齿
            </label>
            <label>
              <input
                type="checkbox"
                checked={controls.bucket.sampleAllLayers}
                disabled={disabled || !!state.hasSelection}
                onChange={(e) =>
                  tool(
                    {
                      action: "bucketOptions",
                      options: { sampleAllLayers: e.currentTarget.checked },
                    },
                    false,
                  )
                }
              />
              取样所有图层
            </label>
            <label title={active?.locks.alpha ? "当前图层已锁定透明像素，填充会保留透明度" : ""}>
              <input
                type="checkbox"
                checked={controls.bucket.preserveTransparency || !!active?.locks.alpha}
                disabled={disabled || !!active?.locks.alpha}
                onChange={(e) =>
                  tool(
                    {
                      action: "bucketOptions",
                      options: { preserveTransparency: e.currentTarget.checked },
                    },
                    false,
                  )
                }
              />
              保留透明度
            </label>
            <label>
              模式
              <select
                aria-label="油漆桶混合模式"
                value={controls.bucket.blend}
                disabled={disabled}
                onChange={(e) =>
                  tool(
                    {
                      action: "bucketOptions",
                      options: { blend: e.currentTarget.value as typeof controls.bucket.blend },
                    },
                    false,
                  )
                }
              >
                {(
                  [
                    ["normal", "正常"],
                    ["multiply", "正片叠底"],
                    ["screen", "滤色"],
                    ["overlay", "叠加"],
                    ["darken", "变暗"],
                    ["lighten", "变亮"],
                    ["difference", "差值"],
                  ] as const
                ).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <small>
              {state.hasSelection
                ? "点击选区内部，填满整个选区"
                : "点击相近颜色区域填充；Alt 临时取色"}
            </small>
          </>
        ) : state?.tool === "eyedropper" && controls ? (
          <>
            <strong>吸管</strong>
            <label>
              取样
              <select
                value={controls.sampleSource}
                disabled={disabled}
                onChange={(event) =>
                  tool(
                    {
                      action: "sampleSource",
                      source: event.currentTarget.value as "current" | "merged",
                    },
                    false,
                  )
                }
              >
                <option value="current">当前图层</option>
                <option value="merged">所有可见图层</option>
              </select>
            </label>
          </>
        ) : state?.tool === "move" ? (
          <>
            <strong>移动</strong>
            <label>
              <input
                type="checkbox"
                checked={controls?.autoSelect ?? false}
                disabled={disabled}
                onChange={(event) =>
                  tool(
                    {
                      action: "autoSelect",
                      enabled: event.currentTarget.checked,
                    },
                    false,
                  )
                }
              />
              自动选择图层
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => tool({ action: "transform", operation: "begin" })}
            >
              自由变换
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                tool({
                  action: "transform",
                  operation: "begin",
                  target: "selection",
                })
              }
            >
              变换选区
            </button>
            {(["horizontal", "vertical"] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                disabled={mirrorDisabled}
                aria-label={axis === "horizontal" ? "水平翻转" : "垂直翻转"}
                title={`${axis === "horizontal" ? "左右镜像" : "上下镜像"}。${mirrorHint}`}
                onClick={() => tool({ action: "flip", axis, target: "pixels" })}
              >
                {axis === "horizontal" ? (
                  <FlipHorizontal2 size={16} />
                ) : (
                  <FlipVertical2 size={16} />
                )}
              </button>
            ))}
          </>
        ) : (
          <>
            <strong>画布导航</strong>
            <button type="button" disabled={disabled} onClick={() => tool({ action: "fit" })}>
              适合窗口
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => tool({ action: "zoom", zoom: 1 })}
            >
              100%
            </button>
            {state?.tool === "zoom" && preferences ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.mode === "scrubby"}
                    disabled={disabled}
                    onChange={(event) =>
                      tool(
                        {
                          action: "navigation",
                          ...preferences,
                          mode: event.currentTarget.checked ? "scrubby" : "marquee",
                        },
                        false,
                      )
                    }
                  />
                  连续拖动缩放
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.center}
                    disabled={disabled}
                    onChange={(event) =>
                      tool(
                        {
                          action: "navigation",
                          ...preferences,
                          center: event.currentTarget.checked,
                        },
                        false,
                      )
                    }
                  />
                  点击点居中
                </label>
              </>
            ) : null}
          </>
        )}
        {state?.wandBusy ? (
          <>
            <span role="status">正在计算魔棒选区…</span>
            <button
              type="button"
              disabled={unavailable}
              onClick={() => tool({ action: "cancelWand" })}
            >
              取消计算（Esc）
            </button>
          </>
        ) : null}
        {state?.hasSelection ? (
          <button
            type="button"
            className="klecks-panels__deselect"
            disabled={disabled}
            onClick={() => action("deselect")}
          >
            取消选区
          </button>
        ) : null}
      </section>
      {error || loadError ? (
        <div className="klecks-panels__error" role="alert">
          {error ?? loadError}
        </div>
      ) : null}
      <div className="klecks-panels__body">
        <nav className="klecks-panels__tools" aria-label="图片工具">
          <KlecksAutoTrimButton
            compact
            options={autoTrimOptions}
            disabled={disabled}
            onRun={() => tool({ action: "autoTrim", options: autoTrimOptions })}
            onSettings={() => setAutoTrimSettings(true)}
          />
          {tools.map(([name, label, Icon]) =>
            name === "rectangle" ? (
              <ToolGroup<"rectangle" | "ellipse">
                key={name}
                choices={[
                  ["rectangle", "矩形选框 (M)", Square],
                  ["ellipse", "椭圆选框 (Shift+M)", Circle],
                ]}
                menuLabel="选框工具"
                toggleLabel="切换选框工具"
                onDismiss={onFocusCanvas}
                value={marquee}
                active={state?.tool === "rectangle" || state?.tool === "ellipse"}
                disabled={!target || !frame || !!state?.locked || editingPending || !!loadingId}
                onSelect={(value) => {
                  setMarquee(value);
                  tool({ action: "tool", tool: value });
                }}
              />
            ) : name === "polygon" ? (
              <ToolGroup<"polygon" | "lasso">
                key={name}
                choices={[
                  ["polygon", "多边形套索 (Shift+L)", PolygonLassoIcon],
                  ["lasso", "自由套索 (L)", Lasso],
                ]}
                menuLabel="套索工具"
                toggleLabel="切换套索工具"
                onDismiss={onFocusCanvas}
                value={lasso}
                active={state?.tool === "polygon" || state?.tool === "lasso"}
                disabled={!target || !frame || !!state?.locked || editingPending || !!loadingId}
                onSelect={(value) => {
                  setLasso(value);
                  tool({ action: "tool", tool: value });
                }}
              />
            ) : name === "magicWand" ? (
              <ToolGroup<"magicWand" | "colorRange">
                key={name}
                choices={[
                  ["magicWand", "魔棒 (W)", WandSparkles],
                  ["colorRange", "色彩范围…", Pipette, true],
                ]}
                menuLabel="魔棒工具"
                toggleLabel="切换魔棒工具"
                onDismiss={onFocusCanvas}
                value="magicWand"
                active={state?.tool === "magicWand" || rangeOpen}
                disabled={!target || !frame || !!state?.locked || editingPending || !!loadingId}
                onSelect={(value) =>
                  tool(
                    value === "colorRange"
                      ? { action: "colorRange", operation: "begin" }
                      : { action: "tool", tool: "magicWand" },
                  )
                }
              />
            ) : (
              <button
                key={name}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={state?.tool === name}
                disabled={!target || !frame || !!state?.locked || editingPending || !!loadingId}
                onClick={(event) =>
                  tool(
                    event.detail >= 2 && name === "hand"
                      ? { action: "fit" }
                      : event.detail >= 2 && name === "zoom"
                        ? { action: "zoom", zoom: 1 }
                        : { action: "tool", tool: name },
                  )
                }
              >
                <Icon size={18} />
              </button>
            ),
          )}
          {controls ? (
            <div className="klecks-panels__colors">
              <input
                aria-label="前景色"
                title="前景色：点击色块任意选色，与油漆桶颜色同步"
                type="color"
                value={hex(controls.colors.foreground)}
                disabled={disabled}
                onChange={(event) =>
                  tool(
                    {
                      action: "colors",
                      foreground: rgb(event.currentTarget.value),
                      background: controls.colors.background,
                    },
                    false,
                  )
                }
              />
              <input
                aria-label="背景色"
                type="color"
                value={hex(controls.colors.background)}
                disabled={disabled}
                onChange={(event) =>
                  tool(
                    {
                      action: "colors",
                      foreground: controls.colors.foreground,
                      background: rgb(event.currentTarget.value),
                    },
                    false,
                  )
                }
              />
            </div>
          ) : null}
        </nav>
        <div className="klecks-panels__canvas" aria-busy={!!loadingId}>
          <div hidden={documents.length === 0} style={{ height: "100%", width: "100%" }}>
            {canvas}
          </div>
          {documents.length === 0 ? (
            <div className="klecks-panels__empty">
              <FolderPlus size={32} />
              <strong>尚未导入图片</strong>
              <p>专利附图由第一步分配。临时图片仅在此编辑，不会保存到专利。</p>
              <button type="button" onClick={temporaryFiles?.import ?? onAddImages}>
                {temporaryFiles ? "打开临时图片" : "去导入图片"}
              </button>
            </div>
          ) : null}
          {loadingId ? <div className="klecks-panels__loading">正在加载图片…</div> : null}
        </div>
        {layersOpen ? (
          <aside
            className="klecks-panels__layers"
            aria-label="图层面板"
            onKeyDown={(event) => {
              const command = resolveKlecksShortcut(event.nativeEvent, {
                platform: /Mac/i.test(navigator.platform) ? "mac" : "windows",
                editingText: !!klecksFocusField(event.target as Element),
                enabled: !disabled,
                pending: !!state?.pending,
                activeTool: "move",
                maskTarget: !!active?.mask?.active,
              });
              if (command?.action === "tool") {
                event.preventDefault();
                event.stopPropagation();
                tool({ action: "toolKey", key: event.key, shiftKey: event.shiftKey });
                return;
              }
              if (
                command &&
                [
                  "undo",
                  "redo",
                  "layerViaCopy",
                  "mergeLayers",
                  "mergeVisible",
                  "stampLayers",
                  "stampVisible",
                  "layerForward",
                  "layerBackward",
                  "layerToFront",
                  "layerToBack",
                  "selectAllLayers",
                  "selectLayerAbove",
                  "selectLayerBelow",
                  "extendLayerAbove",
                  "extendLayerBelow",
                  "deleteLayers",
                  "clear",
                  "invertMask",
                  "targetMask",
                  "targetImage",
                  "viewMask",
                  "defaultColors",
                  "swapColors",
                  "transform",
                ].includes(command.action)
              ) {
                event.preventDefault();
                event.stopPropagation();
                action(command.action as Parameters<KlecksFrameClient["send"]>[1]);
              }
            }}
          >
            <header>
              <Layers size={15} />
              <strong>图层</strong>
              <span>{state?.layers.length ?? 0}</span>
            </header>
            <div className="klecks-panels__layer-properties">
              <NumberField
                label="图层不透明度 %"
                value={(active?.opacity ?? 1) * 100}
                mixed={
                  multiple && selectedLayers.some((layer) => layer.opacity !== active?.opacity)
                }
                min={0}
                max={100}
                disabled={
                  disabled ||
                  !active ||
                  selectedLayers.some((layer) => layer.locks.all || layer.background)
                }
                onCommit={(value) =>
                  active &&
                  tool(
                    {
                      action: "layer",
                      operation: "opacity",
                      id: active.id,
                      ...batchIds,
                      opacity: value / 100,
                    },
                    false,
                  )
                }
              />
              <div className="klecks-panels__locks">
                <Lock size={13} />
                {(["alpha", "pixels", "position", "all"] as const).map((lock, index) => (
                  <label
                    key={lock}
                    title={["锁定透明像素", "锁定图像像素", "锁定位置", "全部锁定"][index]}
                  >
                    <input
                      type="checkbox"
                      aria-label={["锁定透明像素", "锁定图像像素", "锁定位置", "全部锁定"][index]}
                      checked={
                        selectedLayers.length > 0 &&
                        selectedLayers.every((layer) => layer.locks[lock])
                      }
                      ref={(node) => {
                        if (node)
                          node.indeterminate =
                            selectedLayers.some((layer) => layer.locks[lock]) &&
                            !selectedLayers.every((layer) => layer.locks[lock]);
                      }}
                      disabled={
                        disabled ||
                        !active ||
                        (selectedLayers.some((layer) => layer.background) &&
                          (lock === "alpha" || lock === "position"))
                      }
                      onChange={(event) =>
                        active &&
                        tool(
                          {
                            action: "layer",
                            operation: "locks",
                            id: active.id,
                            ...batchIds,
                            locks: { [lock]: event.currentTarget.checked },
                          },
                          false,
                        )
                      }
                    />
                    <span>{["透明", "像素", "位置", "全部"][index]}</span>
                  </label>
                ))}
              </div>
            </div>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: Only clicks on empty list space clear multi-selection; layer actions live on their own controls. */}
            <ul
              className="klecks-panels__layer-list"
              aria-label="图层列表"
              onContextMenu={(event) => {
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                if (disabled || !state) return;
                closeContextMenu.current = showKlecksContextMenu(
                  event.currentTarget.ownerDocument,
                  { x: event.clientX, y: event.clientY },
                  [
                    {
                      label: "新建图层",
                      disabled: state.layers.length >= 16,
                      run: () =>
                        tool({
                          action: "layer",
                          operation: "new",
                          name: `图层 ${state.layers.length}`,
                        }),
                    },
                    { label: "粘贴", run: () => action("paste") },
                    {
                      label: "合并可见图层",
                      disabled: state.layers.filter((layer) => layer.visible).length < 2,
                      run: () => action("mergeVisible"),
                    },
                  ],
                );
              }}
              onClick={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  disabled ||
                  !state?.activeLayerId ||
                  onlyLayer
                )
                  return;
                selectionAnchor.current = null;
                tool(
                  { action: "layer", operation: "selectMany", id: state.activeLayerId, ids: [] },
                  false,
                );
              }}
            >
              {[...(state?.layers ?? [])].reverse().map((layer) => (
                <li
                  key={layer.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (disabled || !state) return;
                    const ids = selectedIds.includes(layer.id) ? selectedIds : [layer.id],
                      many = ids.length > 1;
                    const chosen = state.layers.filter((item) => ids.includes(item.id)),
                      locked = chosen.some((item) => item.locks.all),
                      pixelsLocked = chosen.some((item) => item.locks.all || item.locks.pixels);
                    const index = state.layers.findIndex((item) => item.id === layer.id),
                      lower = state.layers[index - 1];
                    if (!selectedIds.includes(layer.id))
                      tool({ action: "layer", operation: "select", id: layer.id }, false);
                    const sendLayer = (operation: KlecksToolCommand) => () =>
                      tool(operation, false);
                    const items: KlecksMenuItem[] = [
                      {
                        label: "新建图层",
                        disabled: state.layers.length >= 16,
                        run: sendLayer({
                          action: "layer",
                          operation: "new",
                          name: `图层 ${state.layers.length}`,
                        }),
                      },
                      {
                        label: many ? "复制所选图层" : "复制图层",
                        disabled: state.layers.length + ids.length > 16,
                        run: sendLayer({ action: "layer", operation: "duplicateMany", ids }),
                      },
                      {
                        label: many ? "删除所选图层" : "删除图层",
                        disabled: locked || state.layers.length <= ids.length,
                        run: sendLayer({ action: "layer", operation: "deleteMany", ids }),
                      },
                      {
                        label: "重命名图层",
                        disabled: many || locked,
                        run: () => {
                          renameRequest.current = layer.id;
                          if (active?.id === layer.id && !many) {
                            renameRequest.current = null;
                            renameInput.current?.focus();
                            renameInput.current?.select();
                          }
                        },
                      },
                      {
                        label: "自由变换",
                        disabled: chosen.some((item) => item.locks.all || item.locks.position),
                        run: () => action("transform"),
                      },
                      {
                        label: "水平翻转",
                        disabled: chosen.some(
                          (item) => item.locks.all || item.locks.pixels || item.locks.position,
                        ),
                        run: sendLayer({ action: "flip", axis: "horizontal", target: "pixels" }),
                      },
                      {
                        label: "垂直翻转",
                        disabled: chosen.some(
                          (item) => item.locks.all || item.locks.pixels || item.locks.position,
                        ),
                        run: sendLayer({ action: "flip", axis: "vertical", target: "pixels" }),
                      },
                      {
                        label: layer.visible ? "隐藏图层" : "显示图层",
                        separator: true,
                        run: sendLayer({
                          action: "layer",
                          operation: "visibility",
                          id: layer.id,
                          visible: !layer.visible,
                        }),
                      },
                      {
                        label: "单独显示此图层／恢复显示",
                        run: sendLayer({ action: "layer", operation: "solo", id: layer.id }),
                      },
                      {
                        label: locked ? "解除全部锁定" : "全部锁定",
                        run: sendLayer({
                          action: "layer",
                          operation: "locks",
                          id: layer.id,
                          ids,
                          locks: {
                            all: !locked,
                            ...(locked ? { pixels: false, position: false, alpha: false } : {}),
                          },
                        }),
                      },
                      {
                        label: many ? "合并所选图层" : "向下合并",
                        separator: true,
                        disabled:
                          pixelsLocked ||
                          chosen.some((item) => !item.visible) ||
                          (!many &&
                            (!lower || !lower.visible || lower.locks.all || lower.locks.pixels)),
                        run: sendLayer(
                          many
                            ? { action: "layer", operation: "mergeMany", ids }
                            : { action: "layer", operation: "mergeDown", id: layer.id },
                        ),
                      },
                      {
                        label: "合并可见图层",
                        disabled: state.layers.filter((item) => item.visible).length < 2,
                        run: () => action("mergeVisible"),
                      },
                      {
                        label: "置于顶层",
                        disabled: chosen.some((item) => item.background),
                        run: () => action("layerToFront"),
                      },
                      {
                        label: "置于底层",
                        disabled: chosen.some((item) => item.background),
                        run: () => action("layerToBack"),
                      },
                    ];
                    if (!many)
                      items.push(
                        ...maskMenuItems(layer, (maskOperation) =>
                          tool(
                            { action: "layer", operation: "mask", id: layer.id, maskOperation },
                            false,
                          ),
                        ),
                      );
                    if (layer.background)
                      items.splice(3, 0, {
                        label: "背景图层转换为普通图层",
                        run: sendLayer({
                          action: "layer",
                          operation: "backgroundToLayer",
                          id: layer.id,
                          name: "图层 0",
                        }),
                      });
                    closeContextMenu.current = showKlecksContextMenu(
                      event.currentTarget.ownerDocument,
                      { x: event.clientX, y: event.clientY },
                      items,
                    );
                  }}
                  data-active={selectedIds.includes(layer.id)}
                  data-drop={dropLayer?.id === layer.id ? dropLayer.edge : undefined}
                  draggable={!disabled && !layer.background}
                  onDragStart={(event) => {
                    const ids = selectedIds.includes(layer.id) ? selectedIds : [layer.id];
                    if (
                      ids.some((id) => state?.layers.find((item) => item.id === id)?.background)
                    ) {
                      event.preventDefault();
                      return;
                    }
                    drag.current = {
                      viewId: state!.activeId!,
                      id: layer.id,
                      ids,
                    };
                    if (!selectedIds.includes(layer.id))
                      tool({ action: "layer", operation: "select", id: layer.id }, false);
                    event.dataTransfer.setData("text/plain", "klecks-layer");
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (!disabled && drag.current?.viewId === state?.activeId) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const rect = event.currentTarget.getBoundingClientRect();
                      const edge = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                      setDropLayer({ id: layer.id, edge });
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = drag.current;
                    drag.current = null;
                    const edge = dropLayer?.id === layer.id ? dropLayer.edge : "before";
                    setDropLayer(null);
                    if (
                      !disabled &&
                      source?.viewId === state?.activeId &&
                      !source.ids.includes(layer.id)
                    ) {
                      const remaining = state.layers.filter(
                        (item) => !source.ids.includes(item.id),
                      );
                      const insertion =
                        remaining.findIndex((item) => item.id === layer.id) +
                        (edge === "before" ? 1 : 0);
                      if (insertion === 0 && remaining[0]?.background) return;
                      tool({
                        action: "layer",
                        operation: "move",
                        id: source.id,
                        ids: source.ids,
                        index: Math.min(insertion, state.layers.length - 1),
                      });
                    }
                  }}
                  onDragEnd={() => {
                    drag.current = null;
                    setDropLayer(null);
                  }}
                >
                  <button
                    type="button"
                    aria-label={`${layer.visible ? "隐藏" : "显示"}图层 ${layer.name}`}
                    disabled={disabled}
                    title="Alt/Option 单击可单独显示此图层，再次单击恢复"
                    onClick={(event) =>
                      tool(
                        event.altKey
                          ? { action: "layer", operation: "solo", id: layer.id }
                          : {
                              action: "layer",
                              operation: "visibility",
                              id: layer.id,
                              visible: !layer.visible,
                            },
                        false,
                      )
                    }
                  >
                    {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  <KlecksLayerMaskControls
                    layer={layer}
                    active={layer.id === state?.activeLayerId}
                    disabled={disabled}
                    send={(command) => tool(command)}
                  />
                  <button
                    type="button"
                    className="klecks-panels__layer-name"
                    aria-label={`选择图层 ${layer.name}`}
                    aria-pressed={selectedIds.includes(layer.id)}
                    disabled={disabled}
                    onClick={(event) => {
                      const ordered = state?.layers ?? [],
                        toggle = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
                      if (onlyLayer && toggle) return;
                      let ids = [layer.id],
                        id = layer.id;
                      if (event.shiftKey) {
                        const anchor =
                          selectionAnchor.current &&
                          selectionAnchor.current.viewId === state?.activeId
                            ? selectionAnchor.current.id
                            : state?.activeLayerId;
                        const from = ordered.findIndex((item) => item.id === anchor),
                          to = ordered.findIndex((item) => item.id === layer.id);
                        ids = ordered
                          .slice(Math.min(from < 0 ? to : from, to), Math.max(from, to) + 1)
                          .map((item) => item.id);
                      } else if (toggle) {
                        ids = ordered
                          .filter((item) =>
                            item.id === layer.id
                              ? !selectedIds.includes(item.id)
                              : selectedIds.includes(item.id),
                          )
                          .map((item) => item.id);
                        if (ids.length && !ids.includes(id)) id = ids[ids.length - 1]!;
                      } else
                        selectionAnchor.current = {
                          viewId: state!.activeId!,
                          id: layer.id,
                        };
                      tool(
                        event.shiftKey || toggle
                          ? {
                              action: "layer",
                              operation: "selectMany",
                              id,
                              ids,
                            }
                          : { action: "layer", operation: "select", id },
                        false,
                      );
                    }}
                    onDoubleClick={() => {
                      renameRequest.current = layer.id;
                      if (layer.id === active?.id && !multiple && !disabled) {
                        renameRequest.current = null;
                        renameInput.current?.focus();
                        renameInput.current?.select();
                      }
                    }}
                  >
                    <span>{layer.name}</span>
                  </button>
                  {layer.background || Object.values(layer.locks).some(Boolean) ? (
                    <button
                      type="button"
                      className="klecks-panels__unlock"
                      aria-label={`${layer.background ? "解锁背景图层" : "解锁图层"} ${layer.name}`}
                      title={layer.background ? "解锁并转换为普通图层" : "解除此图层的全部锁定"}
                      disabled={disabled}
                      onClick={() =>
                        tool(
                          layer.background
                            ? {
                                action: "layer",
                                operation: "backgroundToLayer",
                                id: layer.id,
                                name: layer.name === "背景" ? "图层 0" : layer.name,
                              }
                            : {
                                action: "layer",
                                operation: "locks",
                                id: layer.id,
                                locks: {
                                  all: false,
                                  pixels: false,
                                  position: false,
                                  alpha: false,
                                },
                              },
                          false,
                        )
                      }
                    >
                      <Lock size={14} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {active ? (
              <label className="klecks-panels__rename">
                图层名称
                <input
                  aria-label="图层名称"
                  ref={renameInput}
                  key={`${state?.activeId}:${active.id}:${active.name}`}
                  defaultValue={active.name}
                  maxLength={200}
                  disabled={disabled || multiple || active.locks.all}
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name && name !== active.name)
                      tool(
                        {
                          action: "layer",
                          operation: "rename",
                          id: active.id,
                          name,
                        },
                        false,
                      );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.stopPropagation();
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      event.currentTarget.value = active.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
            ) : null}
            <footer className="klecks-panels__layer-actions">
              <button
                type="button"
                aria-label="添加图层蒙版"
                title="添加图层蒙版；有选区时显示选区，Alt/Option 单击反向隐藏"
                disabled={disabled || multiple || !active || !!active.mask || active.locks.all}
                onClick={(event) => {
                  if (active)
                    tool({
                      action: "layer",
                      operation: "mask",
                      id: active.id,
                      maskOperation: event.altKey ? "addHide" : "add",
                    });
                }}
              >
                <LayerMaskIcon />
              </button>
              <button
                type="button"
                title="新建图层"
                aria-label="新建图层"
                disabled={disabled || (state?.layers.length ?? 0) >= 16}
                onClick={() =>
                  tool({
                    action: "layer",
                    operation: "new",
                    name: `图层 ${(state?.layers.length ?? 0) + 1}`,
                  })
                }
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                title="复制图层"
                aria-label="复制图层"
                disabled={
                  disabled || !active || (state?.layers.length ?? 0) + selectedIds.length > 16
                }
                onClick={() =>
                  active &&
                  tool(
                    multiple
                      ? {
                          action: "layer",
                          operation: "duplicateMany",
                          ids: selectedIds,
                        }
                      : {
                          action: "layer",
                          operation: "duplicate",
                          id: active.id,
                        },
                  )
                }
              >
                <Copy size={15} />
              </button>
              <button
                type="button"
                title={multiple ? "合并所选图层" : "向下合并"}
                aria-label={multiple ? "合并所选图层" : "向下合并"}
                disabled={
                  disabled ||
                  !active ||
                  (multiple
                    ? selectedLayers.some(
                        (layer) => !layer.visible || layer.locks.all || layer.locks.pixels,
                      )
                    : !below ||
                      !active.visible ||
                      !below.visible ||
                      active.locks.all ||
                      active.locks.pixels ||
                      below.locks.all ||
                      below.locks.pixels)
                }
                onClick={() =>
                  active &&
                  tool(
                    multiple
                      ? {
                          action: "layer",
                          operation: "mergeMany",
                          ids: selectedIds,
                        }
                      : {
                          action: "layer",
                          operation: "mergeDown",
                          id: active.id,
                        },
                  )
                }
              >
                <Merge size={15} />
              </button>
              <button
                type="button"
                title="删除图层"
                aria-label="删除图层"
                disabled={
                  disabled ||
                  !active ||
                  selectedLayers.some((layer) => layer.locks.all) ||
                  (state?.layers.length ?? 0) <= selectedIds.length
                }
                onClick={() =>
                  active &&
                  tool(
                    multiple
                      ? {
                          action: "layer",
                          operation: "deleteMany",
                          ids: selectedIds,
                        }
                      : { action: "layer", operation: "delete", id: active.id },
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </footer>
            {active?.background ? (
              <button
                type="button"
                className="klecks-panels__background"
                disabled={disabled}
                onClick={() =>
                  tool({
                    action: "layer",
                    operation: "backgroundToLayer",
                    id: active.id,
                    name: "图层 0",
                  })
                }
              >
                转换为普通图层
              </button>
            ) : null}
          </aside>
        ) : null}
      </div>
      <KlecksStatusDock>
        {notice}
        <div>
          <button
            type="button"
            aria-label="撤销"
            title="撤销"
            disabled={(controls?.transform ? unavailable : disabled) || state?.canUndo === false}
            onClick={() => action("undo")}
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做"
            disabled={(controls?.transform ? unavailable : disabled) || state?.canRedo === false}
            onClick={() => action("redo")}
          >
            <Redo2 size={15} />
          </button>
          <NumberField
            label="缩放 %"
            value={(state?.zoom ?? 1) * 100}
            min={1}
            max={3200}
            disabled={disabled}
            onCommit={(value) => tool({ action: "zoom", zoom: value / 100 }, false)}
          />
          <button
            type="button"
            aria-label="适合窗口"
            title="适合窗口"
            disabled={disabled}
            onClick={() => tool({ action: "fit" })}
          >
            <Maximize2 size={15} />
          </button>
        </div>
        {state?.size && target && frame ? (
          <KlecksQuickImageSize
            key={`${target.sessionId}:${target.viewId}:${target.generation}`}
            size={state.size}
            identity={target}
            frame={frame}
            disabled={disabled || !!sizeDialog}
          />
        ) : (
          <span>{state?.size ? `${state.size.width} × ${state.size.height} px` : "无图片"}</span>
        )}
        <span role="status">
          {state?.locked
            ? "正在保存…"
            : state?.fill?.busy
              ? "正在填充…Esc 取消"
              : state?.colorRange
                ? "色彩范围预览 · Enter 确认 · Esc 取消"
                : state?.wandBusy
                  ? "正在计算魔棒选区 · Esc 取消"
                  : editingPending
                    ? "Enter 完成 · Esc 取消"
                    : temporaryFiles?.active
                      ? documents.find((item) => item.viewId === state?.activeId)?.dirty
                        ? "临时图片 · 修改尚未导出"
                        : state?.dirty
                          ? "临时图片 · 已导出当前版本"
                          : "临时图片 · 本次会话保留"
                      : state?.dirty
                        ? "有未保存编辑"
                        : state?.activeId
                          ? "编辑已保存"
                          : "就绪"}
          {!temporaryFiles?.active && state?.unapplied ? " · 尚未应用到视图" : ""}
        </span>
        {preferences ? (
          <details ref={displayMenu}>
            <summary>显示</summary>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.wheel}
                  disabled={disabled}
                  onChange={(event) =>
                    tool(
                      {
                        action: "navigation",
                        ...preferences,
                        wheel: event.currentTarget.checked,
                      },
                      false,
                    )
                  }
                />
                滚轮缩放
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.pixelGrid}
                  disabled={disabled}
                  onChange={(event) =>
                    tool(
                      {
                        action: "navigation",
                        ...preferences,
                        pixelGrid: event.currentTarget.checked,
                      },
                      false,
                    )
                  }
                />
                像素网格
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.selectionEdges}
                  disabled={disabled}
                  onChange={(event) =>
                    tool(
                      {
                        action: "navigation",
                        ...preferences,
                        selectionEdges: event.currentTarget.checked,
                      },
                      false,
                    )
                  }
                />
                选区边缘
              </label>
            </div>
          </details>
        ) : null}
      </KlecksStatusDock>
      {sizeDialog && frame && state?.size && state.identity ? (
        <KlecksSizeDialog
          kind={sizeDialog}
          frame={frame}
          state={state}
          onClose={() => setSizeDialog(null)}
        />
      ) : null}
      <MotionPresence>
        {state?.colorRange &&
          (() => {
            const range = state.colorRange,
              options = range.options;
            const update = (change: Partial<typeof options>) =>
              tool({ action: "colorRange", operation: "patch", change }, false);
            return (
              <KlecksFloatingPanel
                key={rangePanelKey}
                title="色彩范围"
                onClose={() => tool({ action: "colorRange", operation: "cancel" })}
                footer={
                  <>
                    {/* Confirmation commits; close always cancels. */}
                    <button
                      type="button"
                      disabled={unavailable || range.busy || !range.canApply}
                      onClick={() => tool({ action: "colorRange", operation: "apply" })}
                    >
                      确认色彩范围
                    </button>
                    <button
                      type="button"
                      disabled={unavailable}
                      onClick={() => tool({ action: "colorRange", operation: "cancel" })}
                    >
                      取消色彩范围
                    </button>
                  </>
                }
              >
                <fieldset className="klecks-color-range" aria-label="色彩范围设置">
                  <div className="klecks-color-range__row">
                    <label>
                      选择{" "}
                      <select
                        aria-label="色彩范围类型"
                        value={options.preset}
                        disabled={unavailable}
                        onChange={(e) =>
                          update({ preset: e.currentTarget.value as typeof options.preset })
                        }
                      >
                        {(
                          [
                            ["sampled", "取样颜色"],
                            ["highlights", "高光（白色）"],
                            ["midtones", "中间调"],
                            ["shadows", "阴影（黑色）"],
                            ["reds", "红色"],
                            ["yellows", "黄色"],
                            ["greens", "绿色"],
                            ["cyans", "青色"],
                            ["blues", "蓝色"],
                            ["magentas", "洋红"],
                          ] as const
                        ).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      模式{" "}
                      <select
                        aria-label="色彩范围选区模式"
                        value={options.mode}
                        disabled={unavailable}
                        onChange={(e) =>
                          update({ mode: e.currentTarget.value as typeof options.mode })
                        }
                      >
                        <option value="replace">新建选区</option>
                        <option value="add">添加到选区</option>
                        <option value="subtract" disabled={!state.hasSelection}>
                          从选区减去
                        </option>
                        <option value="intersect" disabled={!state.hasSelection}>
                          与选区交叉
                        </option>
                      </select>
                    </label>
                    <NumberField
                      label="模糊度"
                      value={options.fuzziness}
                      min={0}
                      max={200}
                      step={1}
                      integer
                      live
                      resetKey={rangeInputReset}
                      disabled={unavailable}
                      onValidityChange={(valid) =>
                        tool(
                          {
                            action: "colorRange",
                            operation: "inputValidity",
                            field: "fuzziness",
                            valid,
                          },
                          false,
                        )
                      }
                      onCommit={(fuzziness) => update({ fuzziness })}
                    />
                    <input
                      aria-label="模糊度滑块"
                      title="颜色越接近取样点，选中程度越高；提高模糊度可扩大颜色范围。"
                      type="range"
                      min="0"
                      max="200"
                      value={options.fuzziness}
                      disabled={unavailable}
                      onChange={(e) => {
                        setRangeInputReset((key) => key + 1);
                        update({ fuzziness: Number(e.currentTarget.value) });
                      }}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={options.invert}
                        disabled={unavailable}
                        onChange={(e) => update({ invert: e.currentTarget.checked })}
                      />
                      反向选择
                    </label>
                  </div>
                  <div className="klecks-color-range__row">
                    <fieldset aria-label="色彩范围取样方式">
                      {(
                        [
                          ["replace", "取样"],
                          ["add", "添加取样"],
                          ["subtract", "减去取样"],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={range.sampling === mode}
                          disabled={unavailable}
                          onClick={() =>
                            tool({ action: "colorRange", operation: "sampling", mode })
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </fieldset>
                    <button
                      type="button"
                      disabled={unavailable}
                      onClick={() => tool({ action: "colorRange", operation: "reset" })}
                    >
                      重置取样
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        checked={options.sampleAllLayers}
                        disabled={unavailable}
                        onChange={(e) => update({ sampleAllLayers: e.currentTarget.checked })}
                      />
                      取样所有可见图层
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={options.localized}
                        disabled={unavailable || options.preset !== "sampled"}
                        onChange={(e) => update({ localized: e.currentTarget.checked })}
                      />
                      局部颜色簇
                    </label>
                    <NumberField
                      label="局部范围 %"
                      value={options.range}
                      min={1}
                      max={100}
                      step={1}
                      integer
                      live
                      disabled={unavailable || !options.localized || options.preset !== "sampled"}
                      onValidityChange={(valid) =>
                        tool(
                          {
                            action: "colorRange",
                            operation: "inputValidity",
                            field: "range",
                            valid,
                          },
                          false,
                        )
                      }
                      onCommit={(range) => update({ range })}
                    />
                    <label>
                      预览{" "}
                      <select
                        aria-label="色彩范围预览"
                        value={options.preview}
                        disabled={unavailable}
                        onChange={(e) =>
                          update({ preview: e.currentTarget.value as typeof options.preview })
                        }
                      >
                        <option value="image">原图</option>
                        <option value="grayscale">灰度选区</option>
                        <option value="black">黑色衬底</option>
                        <option value="white">白色衬底</option>
                        <option value="overlay">红色叠加</option>
                      </select>
                    </label>
                  </div>
                  <div className="klecks-color-range__row">
                    <span role="status">
                      {range.busy
                        ? "正在计算色彩范围…"
                        : range.error ||
                          `已取样 ${range.positive} 色，减去 ${range.negative} 色 · 覆盖 ${range.percent}% 图幅`}
                    </span>
                    <small>
                      点击画布取样 · Shift 加样 · Alt
                      减样；灰度预览中白色选中、灰色部分选中、黑色未选中。
                    </small>
                  </div>
                </fieldset>
              </KlecksFloatingPanel>
            );
          })()}
      </MotionPresence>
      <KlecksCanvasFocus onFocus={onFocusCanvas} />
      {state?.whitespace && frame && (
        <KlecksWhitespaceDialog
          state={state.whitespace}
          frame={frame}
          send={(command) => tool(command, false)}
        />
      )}
      {autoTrimSettings ? (
        <KlecksAutoTrimSettings
          options={autoTrimOptions}
          onClose={() => setAutoTrimSettings(false)}
          onSave={(options) => {
            setAutoTrimOptions(options);
            setAutoTrimSettings(false);
          }}
        />
      ) : null}
      {state?.tone && frame && (
        <KlecksToneDialog
          state={state.tone}
          frame={frame}
          send={(command) => tool(command, false)}
        />
      )}
    </section>
  );
}
