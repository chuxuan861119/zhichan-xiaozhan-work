import { klecksToolShape } from "./klecks-cursor-shapes";
import type { KlecksViewport } from "./klecks-viewport";

/** Display-only full-size circular tip. It never enters the document or export canvas. */
export function bindKlecksToolCursor(
  canvas: HTMLCanvasElement,
  state: () => {
    tool: string;
    cloneSource?: { x: number; y: number; offset?: { x: number; y: number } } | null;
    size: number;
    viewport: KlecksViewport | null;
    enabled: boolean;
    drawingSelection?: boolean;
    override?: string | null;
    adjusting?: boolean;
    tip?: "normal" | "full" | "precise";
    hardness?: number;
    crosshair?: boolean;
    platform?: "windows" | "mac" | "harmony";
    gestureActive?: boolean;
    polygonDraft?: boolean;
    polygonClose?: boolean;
    selectionMode?: "replace" | "add" | "subtract" | "intersect";
    gestureSelectionMode?: "replace" | "add" | "subtract" | "intersect" | null;
  },
) {
  const controller = new AbortController(),
    options = { signal: controller.signal };
  const overlay = document.createElement("div"),
    ring = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;pointer-events:none;overflow:hidden;z-index:10;display:none";
  overlay.setAttribute("aria-hidden", "true");
  ring.dataset.klecksBrushCursor = "";
  ring.style.cssText =
    "position:absolute;pointer-events:none;border:1px solid #111;box-shadow:0 0 0 1px white;border-radius:50%;box-sizing:border-box;transform:translate(-50%,-50%)";
  overlay.append(ring);
  const sourceMark = document.createElement("div");
  sourceMark.dataset.klecksCloneSource = "";
  sourceMark.style.cssText =
    "position:absolute;display:none;width:13px;height:13px;transform:translate(-50%,-50%);filter:drop-shadow(0 0 1px white);background:linear-gradient(transparent 6px,#111 6px,#111 7px,transparent 7px),linear-gradient(90deg,transparent 6px,#111 6px,#111 7px,transparent 7px)";
  overlay.append(sourceMark);
  const badge = document.createElement("div");
  badge.dataset.klecksSelectionCursor = "";
  badge.style.cssText =
    "position:absolute;display:none;color:#111;text-shadow:0 0 2px white,1px 0 white,-1px 0 white;font:bold 15px sans-serif;line-height:18px";
  overlay.append(badge);
  const closeBadge = document.createElement("div");
  closeBadge.dataset.klecksPolygonClose = "";
  closeBadge.style.cssText =
    "position:absolute;display:none;width:7px;height:7px;border:1px solid #111;border-radius:50%;box-shadow:0 0 0 1px white;box-sizing:border-box";
  overlay.append(closeBadge);
  const crosshair = document.createElement("div");
  crosshair.style.cssText =
    "position:absolute;left:50%;top:50%;width:9px;height:9px;transform:translate(-50%,-50%);background:linear-gradient(transparent 4px,#111 4px,#111 5px,transparent 5px),linear-gradient(90deg,transparent 4px,#111 4px,#111 5px,transparent 5px)";
  ring.append(crosshair);
  canvas.parentElement?.append(overlay);
  const previousCursor = canvas.style.cursor;
  let point: { x: number; y: number } | null = null,
    space = false,
    alt = false,
    down = false,
    precise = false,
    middle = false;
  let ctrl = false,
    meta = false,
    shift = false;
  const refresh = () => {
    const current = state(),
      box = canvas.getBoundingClientRect();
    const primary = current.platform === "mac" ? meta : ctrl,
      temporary = !current.gestureActive || !!current.polygonDraft;
    const spaceActive = space && temporary && !current.drawingSelection;
    const tool = middle
      ? "hand"
      : spaceActive
        ? primary
          ? "zoom"
          : "hand"
        : temporary && primary && !["hand", "zoom", "crop", "polygon"].includes(current.tool)
          ? "move"
          : ["brush", "bucket"].includes(current.tool) && alt && !current.adjusting && temporary
            ? "eyedropper"
            : current.tool;
    const painting =
      current.enabled &&
      !current.override &&
      !spaceActive &&
      (!alt || current.adjusting || !temporary) &&
      !precise &&
      current.tip !== "precise" &&
      ["brush", "eraser", "clone", "blur"].includes(tool) &&
      !!current.viewport;
    canvas.style.cursor = current.override
      ? current.override
      : !current.enabled
        ? "not-allowed"
        : tool === "hand"
          ? down
            ? "grabbing"
            : "grab"
          : tool === "zoom"
            ? alt
              ? "zoom-out"
              : "zoom-in"
            : tool === "move"
              ? klecksToolShape(tool, precise)
              : painting && point
                ? "none"
                : klecksToolShape(tool, precise);
    const mode = current.gestureActive
      ? (current.gestureSelectionMode ?? current.selectionMode ?? "replace")
      : shift && alt
        ? "intersect"
        : shift
          ? "add"
          : alt
            ? "subtract"
            : (current.selectionMode ?? "replace");
    const copying = current.enabled && !current.override && tool === "move" && alt;
    const selecting =
      (current.enabled &&
        !current.override &&
        ["rectangle", "ellipse", "lasso", "polygon", "magicWand"].includes(tool) &&
        mode !== "replace" &&
        point) ||
      (copying && point);
    badge.style.display = selecting ? "block" : "none";
    badge.textContent =
      copying || mode === "add" ? "+" : mode === "subtract" ? "−" : mode === "intersect" ? "∩" : "";
    const closing =
      current.enabled && !current.override && tool === "polygon" && current.polygonClose && !!point;
    closeBadge.style.display = closing ? "block" : "none";
    const source =
      current.enabled && tool === "clone" && current.cloneSource && current.viewport && point;
    sourceMark.style.display = source ? "block" : "none";
    if (source && current.cloneSource && current.viewport && point) {
      const v = current.viewport,
        s = current.cloneSource,
        scale = v.zoom / v.pixelRatio;
      sourceMark.style.left = `${s.offset ? point.x - box.left + s.offset.x * scale : v.x + s.x * scale}px`;
      sourceMark.style.top = `${s.offset ? point.y - box.top + s.offset.y * scale : v.y + s.y * scale}px`;
    }
    if (tool === "clone" && alt) canvas.style.cursor = "crosshair";
    overlay.style.display =
      (painting || selecting || closing || source) && point ? "block" : "none";
    ring.style.display = painting && point ? "block" : "none";
    overlay.style.left = `${box.left}px`;
    overlay.style.top = `${box.top}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    if (point) {
      badge.style.left = `${point.x - box.left + 9}px`;
      badge.style.top = `${point.y - box.top + 7}px`;
    }
    if (point) {
      closeBadge.style.left = `${point.x - box.left + 21}px`;
      closeBadge.style.top = `${point.y - box.top + 19}px`;
    }
    if (!painting || !point || !current.viewport) return;
    const diameter = Math.max(
      1,
      ((current.size * current.viewport.zoom) / current.viewport.pixelRatio) *
        (current.tip === "normal" && !current.adjusting ? 0.5 + 0.5 * (current.hardness ?? 1) : 1),
    );
    overlay.style.left = `${box.left}px`;
    overlay.style.top = `${box.top}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    ring.style.width = ring.style.height = `${diameter}px`;
    ring.style.background = current.adjusting ? "rgba(220,45,45,0.25)" : "transparent";
    crosshair.style.display = current.crosshair ? "block" : "none";
    ring.style.left = `${point.x - box.left}px`;
    ring.style.top = `${point.y - box.top}px`;
  };
  const reset = () => {
    point = null;
    space = false;
    alt = false;
    down = false;
    precise = false;
    middle = false;
    ctrl = false;
    meta = false;
    shift = false;
    refresh();
  };
  const modifiers = (event: KeyboardEvent | PointerEvent) => {
    ctrl = event.ctrlKey;
    meta = event.metaKey;
    shift = event.shiftKey;
    alt = event.altKey;
    precise = event.getModifierState?.("CapsLock") ?? false;
  };
  const pointer = (event: PointerEvent) => {
    point = { x: event.clientX, y: event.clientY };
    modifiers(event);
    refresh();
  };
  canvas.addEventListener("pointermove", pointer, options);
  canvas.addEventListener("pointerenter", pointer, options);
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      down = true;
      middle = event.button === 1;
      pointer(event);
    },
    options,
  );
  canvas.addEventListener(
    "pointerup",
    (event) => {
      down = false;
      middle = false;
      pointer(event);
    },
    options,
  );
  canvas.addEventListener(
    "pointerleave",
    () => {
      point = null;
      refresh();
    },
    options,
  );
  canvas.addEventListener("pointercancel", reset, options);
  canvas.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      modifiers(event);
      if (event.code === "Space") space = true;
      refresh();
    },
    options,
  );
  canvas.addEventListener(
    "keyup",
    (event) => {
      modifiers(event);
      if (event.code === "Space") space = false;
      refresh();
    },
    options,
  );
  canvas.addEventListener("blur", reset, options);
  canvas.ownerDocument.defaultView?.addEventListener("blur", reset, options);
  refresh();
  return {
    syncPointer: pointer,
    refresh,
    destroy() {
      controller.abort();
      overlay.remove();
      canvas.style.cursor = previousCursor;
    },
  };
}
