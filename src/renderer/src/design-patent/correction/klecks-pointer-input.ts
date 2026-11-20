import { clickZoom, marqueeZoom, scrubZoom } from "./klecks-navigation";
import {
  type SelectionPoint,
  type SelectionRegion,
  type SelectionShapeTool,
  selectionShape,
} from "./klecks-selection-shape";
import type { KlecksSelectionOptions } from "./klecks-tool-port";
import { fitViewport, type KlecksViewport, panViewport, screenToImage } from "./klecks-viewport";

export function pointerToDocument(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  box: Pick<DOMRect, "left" | "top">,
  view: KlecksViewport,
) {
  return screenToImage(view, { x: event.clientX - box.left, y: event.clientY - box.top });
}

type Point = readonly [number, number, number];
export type KlecksPointerDriver = {
  getImageSize?(): { width: number; height: number } | null;
  platform?: "windows" | "mac" | "harmony";
  prepareMove?(point: Point, toggleAutoSelect: boolean): void;
  onActiveTool?(tool: ReturnType<KlecksPointerDriver["getTool"]> | null): void;
  onSelectionMode?(mode: KlecksSelectionOptions["mode"] | null): void;
  getSelectionOptions?(): KlecksSelectionOptions;
  hasSelection?(): boolean;
  deselect?(): void;
  getNavigation?(): { mode: "marquee" | "scrubby"; center: boolean };
  previewZoom?(rect: { left: number; top: number; width: number; height: number } | null): void;
  getViewport(): KlecksViewport;
  setViewport(view: KlecksViewport): void;
  getTool():
    | "brush"
    | "clone"
    | "blur"
    | "eraser"
    | "hand"
    | "zoom"
    | "rectangle"
    | "ellipse"
    | "lasso"
    | "polygon"
    | "eyedropper"
    | "move"
    | "crop"
    | "magicWand"
    | "bucket";
  bucket?(point: Point): void;
  cloneSample?(point: Point): void;
  magicWand?(point: Point, mode: "replace" | "add" | "subtract" | "intersect"): void;
  crop?(region: SelectionRegion, phase: "preview" | "ready" | "cancel"): void;
  movePixels?(dx: number, dy: number, phase: "preview" | "commit" | "cancel", copy?: boolean): void;
  selectionContains?(point: Point): boolean;
  moveSelection?(dx: number, dy: number, phase: "preview" | "commit" | "cancel"): void;
  sampleColor?(point: Point): void;
  onPendingChange?(pending: boolean): void;
  select?(region: SelectionRegion, mode: "replace" | "add" | "subtract" | "intersect"): void;
  previewSelection?(region: SelectionRegion): void;
  previewPolygon?(
    points: readonly SelectionPoint[] | null,
    mode?: KlecksSelectionOptions["mode"],
  ): void;
  onPolygonCloseHint?(close: boolean): void;
  onPolygonDraftChange?(navigable: boolean): void;
  beginStroke(point: Point, connectPrevious?: boolean): void;
  moveStroke(point: Point): void;
  endStroke(): void;
  cancelStroke(): void;
  redraw(): void;
  onError(error: unknown): void;
};

/** Owns only this surface's events; never captures system input or global app shortcuts. */
export function bindKlecksPointerInput(
  element: HTMLElement,
  driver: KlecksPointerDriver,
): (() => void) & { refreshViewport(): void } {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let polygon: {
    origin: "lasso" | "polygon";
    points: SelectionPoint[];
    mode: "replace" | "add" | "subtract" | "intersect";
    undoStarts: number[];
    altLatched: boolean;
  } | null = null;
  let paintPoint: Point | null = null;
  let shapePointer: SelectionPoint | null = null;
  let paintConstraint: { origin: Point; axis: "x" | "y" | null } | null = null;
  let active: {
    id: number;
    kind: "paint" | "pan" | "select" | "sample" | "move" | "boundary" | "crop";
    x: number;
    y: number;
    shape: SelectionShapeTool | null;
    points: SelectionPoint[];
    shift: boolean;
    alt: boolean;
    copy?: boolean;
    dragged?: boolean;
    continuation?: "lasso" | "polygon";
    straight?: boolean;
    polygonUndo?: number[];
    mode: "replace" | "add" | "subtract" | "intersect";
  } | null = null;
  let space = false;
  let polygonPointer: { clientX: number; clientY: number; shiftKey: boolean } | null = null;
  let hHeld = false,
    bird: {
      id: number;
      view: KlecksViewport;
      fit: KlecksViewport;
      center: { x: number; y: number };
      offset: { x: number; y: number };
      width: number;
      height: number;
      movable: boolean;
    } | null = null;
  const previewBird = () => {
    if (!bird) return;
    const scale = bird.fit.zoom / bird.fit.pixelRatio;
    driver.previewZoom?.(
      bird.movable
        ? {
            left: bird.fit.x + (bird.center.x - bird.width / 2) * scale,
            top: bird.fit.y + (bird.center.y - bird.height / 2) * scale,
            width: bird.width * scale,
            height: bird.height * scale,
          }
        : null,
    );
  };
  let zoomGesture: {
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    view: KlecksViewport;
    out: boolean;
    mode: "marquee" | "scrubby";
  } | null = null;
  let zoomKey = false;
  const modeFor = (event: PointerEvent) =>
    event.shiftKey && event.altKey
      ? "intersect"
      : event.shiftKey
        ? "add"
        : event.altKey
          ? "subtract"
          : (driver.getSelectionOptions?.().mode ?? "replace");
  const release = () => {
    const previous = active;
    active = null;
    driver.onPolygonDraftChange?.(!!polygon);
    driver.onSelectionMode?.(polygon?.mode ?? null);
    driver.onActiveTool?.(null);
    const zoom = zoomGesture;
    const previousBird = bird;
    bird = null;
    if (previousBird && element.hasPointerCapture(previousBird.id))
      element.releasePointerCapture(previousBird.id);
    zoomGesture = null;
    if (zoom && element.hasPointerCapture(zoom.id)) element.releasePointerCapture(zoom.id);
    driver.previewZoom?.(null);
    paintPoint = null;
    shapePointer = null;
    paintConstraint = null;
    if (previous && element.hasPointerCapture(previous.id))
      element.releasePointerCapture(previous.id);
    driver.onPendingChange?.(Boolean(polygon));
  };
  const cancel = () => {
    try {
      if (bird) driver.setViewport(bird.view);
      if (zoomGesture) driver.setViewport(zoomGesture.view);
      if (active?.kind === "paint") driver.cancelStroke();
      if (active?.kind === "move") driver.movePixels?.(0, 0, "cancel");
      if (active?.kind === "boundary") driver.moveSelection?.(0, 0, "cancel");
      if (active?.kind === "crop") driver.crop?.([], "cancel");
      if (active?.kind === "select") driver.previewSelection?.([]);
      if (polygon) {
        polygon = null;
        driver.previewSelection?.([]);
      }
      driver.previewPolygon?.(null);
      driver.onPolygonCloseHint?.(false);
    } finally {
      release();
      driver.redraw();
    }
  };
  const run = (action: () => void) => {
    try {
      action();
    } catch (error) {
      try {
        cancel();
      } catch {
        /* Report the original operation failure. */
      }
      driver.onError(error);
    }
  };
  const point = (event: PointerEvent): Point => {
    const result = pointerToDocument(event, element.getBoundingClientRect(), driver.getViewport());
    return [result.x, result.y, event.pointerType === "mouse" ? 1 : event.pressure];
  };
  const polygonCandidate = () => {
    if (!polygon || !polygonPointer) return null;
    const raw = pointerToDocument(
      polygonPointer,
      element.getBoundingClientRect(),
      driver.getViewport(),
    );
    let next: SelectionPoint = [raw.x, raw.y];
    const previous = polygon.points.at(-1);
    if (polygonPointer.shiftKey && previous) {
      const dx = next[0] - previous[0],
        dy = next[1] - previous[1],
        angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4,
        length = Math.hypot(dx, dy);
      next = [previous[0] + Math.cos(angle) * length, previous[1] + Math.sin(angle) * length];
    }
    return next;
  };
  const nearStart = (next: SelectionPoint) => {
    if (!polygon || polygon.points.length < 3) return false;
    const view = driver.getViewport(),
      first = polygon.points[0]!;
    if (polygonPointer) {
      const raw = pointerToDocument(polygonPointer, element.getBoundingClientRect(), view);
      next = [raw.x, raw.y];
    }
    return (Math.hypot(next[0] - first[0], next[1] - first[1]) * view.zoom) / view.pixelRatio <= 5;
  };
  const refreshPolygon = () => {
    if (!polygon) return;
    const candidate = polygonCandidate(),
      close = !!candidate && nearStart(candidate);
    const points = candidate
      ? [...polygon.points, close ? polygon.points[0]! : candidate]
      : polygon.points;
    if (points.length > 49999) throw new Error("选区路径过于复杂，请减少节点。");
    driver.onPolygonCloseHint?.(close);
    if (driver.previewPolygon) driver.previewPolygon(points, polygon.mode);
    else driver.previewSelection?.(selectionShape("polygon", points));
    driver.redraw();
  };
  const rememberPolygonPointer = (event: PointerEvent) => {
    polygonPointer = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey };
  };
  const finishPolygon = () => {
    if (!polygon) return;
    const points = polygon.points,
      first = points[0],
      second = points.find((p) => p[0] !== first?.[0] || p[1] !== first?.[1]);
    const nonCollinear =
      first &&
      second &&
      points.some(
        (p) =>
          Math.abs(
            (second[0] - first[0]) * (p[1] - first[1]) - (second[1] - first[1]) * (p[0] - first[0]),
          ) > 1e-9,
      );
    if (nonCollinear) {
      if (!driver.select) throw new Error("选区工具尚未连接。");
      driver.select(selectionShape("polygon", points), polygon.mode);
    }
    polygon = null;
    driver.previewPolygon?.(null);
    driver.onPolygonCloseHint?.(false);
    driver.previewSelection?.([]);
    release();
    driver.redraw();
  };
  const updateShape = (event: PointerEvent): SelectionRegion => {
    if (!active?.shape) return [];
    const next = point(event);
    if (space && active.kind === "select" && active.shape !== "lasso" && shapePointer) {
      const dx = next[0] - shapePointer[0],
        dy = next[1] - shapePointer[1];
      active.points = active.points.map(([x, y]) => [x + dx, y + dy]);
    } else {
      if (active.shape !== "lasso") active.points.splice(1);
      if (active.shape === "lasso" && event.altKey && active.continuation !== "polygon") {
        if (active.straight) active.points.pop();
        active.straight = true;
      } else active.straight = false;
      active.points.push([next[0], next[1]]);
    }
    shapePointer = [next[0], next[1]];
    if (active.continuation === "polygon") return [];
    return selectionShape(active.shape, active.points, {
      ...(active.kind === "select" ? driver.getSelectionOptions?.() : {}),
      constrain: event.shiftKey && !active.shift,
      fromCenter: event.altKey && !active.alt,
    });
  };
  element.addEventListener(
    "pointerdown",
    (event) =>
      run(() => {
        if (active || zoomGesture || bird || (event.button !== 0 && event.button !== 1)) return;
        element.focus({ preventScroll: true });
        const imageSize = driver.getImageSize?.();
        if (hHeld && !space && !polygon && event.button === 0 && imageSize) {
          const box = element.getBoundingClientRect(),
            view = driver.getViewport(),
            fit = fitViewport(imageSize, { width: box.width, height: box.height }, view.pixelRatio),
            center = screenToImage(view, { x: box.width / 2, y: box.height / 2 }),
            pointer = screenToImage(fit, {
              x: event.clientX - box.left,
              y: event.clientY - box.top,
            });
          bird = {
            id: event.pointerId,
            view,
            fit,
            center,
            offset: { x: center.x - pointer.x, y: center.y - pointer.y },
            width: (box.width * view.pixelRatio) / view.zoom,
            height: (box.height * view.pixelRatio) / view.zoom,
            movable: view.zoom > fit.zoom,
          };
          driver.onActiveTool?.("hand");
          element.setPointerCapture(event.pointerId);
          driver.onPendingChange?.(true);
          driver.setViewport(fit);
          previewBird();
          event.preventDefault();
          driver.redraw();
          return;
        }
        const selected = driver.getTool();
        const primary = driver.platform === "mac" ? event.metaKey : event.ctrlKey;
        const tool =
          zoomKey && event.button !== 1
            ? "zoom"
            : space || event.button === 1
              ? "hand"
              : primary && !polygon && !["hand", "zoom", "crop", "polygon"].includes(selected)
                ? "move"
                : ["brush", "bucket"].includes(selected) && event.altKey
                  ? "eyedropper"
                  : selected;
        driver.onActiveTool?.(tool);
        const selectionPoint = point(event);
        if (tool === "clone" && event.altKey) {
          driver.cloneSample?.(selectionPoint);
          driver.onActiveTool?.(null);
          event.preventDefault();
          return;
        }
        if (tool === "bucket") {
          driver.bucket?.(selectionPoint);
          driver.onActiveTool?.(null);
          event.preventDefault();
          return;
        }
        if (tool === "magicWand") {
          driver.magicWand?.(selectionPoint, modeFor(event));
          driver.onActiveTool?.(null);
          event.preventDefault();
          return;
        }
        if (
          !polygon &&
          ["rectangle", "ellipse", "lasso", "polygon"].includes(tool) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          (driver.getSelectionOptions?.().mode ?? "replace") === "replace" &&
          driver.moveSelection &&
          driver.selectionContains?.(selectionPoint)
        ) {
          active = {
            id: event.pointerId,
            kind: "boundary",
            x: event.clientX,
            y: event.clientY,
            shape: tool as SelectionShapeTool,
            points: [[selectionPoint[0], selectionPoint[1]]],
            shift: false,
            alt: false,
            mode: "replace",
          };
          element.setPointerCapture(event.pointerId);
          driver.onPendingChange?.(true);
          driver.moveSelection(0, 0, "preview");
          event.preventDefault();
          driver.redraw();
          return;
        }
        if (polygon && tool !== "hand" && tool !== "zoom" && (primary || event.detail >= 2)) {
          rememberPolygonPointer(event);
          const next = polygonCandidate()!;
          if (primary && !nearStart(next)) {
            const previous = polygon.points.at(-1);
            if (!previous || previous[0] !== next[0] || previous[1] !== next[1])
              polygon.points.push(next);
          }
          event.preventDefault();
          finishPolygon();
          return;
        }
        if (
          polygon &&
          tool !== "hand" &&
          tool !== "zoom" &&
          ((polygon.origin === "polygon" && event.altKey && !polygon.altLatched) ||
            (polygon.origin === "lasso" && !event.altKey))
        ) {
          const raw = point(event),
            prior = polygon;
          active = {
            id: event.pointerId,
            kind: "select",
            x: event.clientX,
            y: event.clientY,
            shape: "lasso",
            points: [...prior.points, [raw[0], raw[1]]],
            shift: event.shiftKey,
            alt: event.altKey,
            mode: prior.mode,
            continuation: prior.origin,
            polygonUndo: [...prior.undoStarts, prior.points.length],
          };
          polygon = null;
          driver.onPolygonDraftChange?.(false);
          driver.onPolygonCloseHint?.(false);
          element.setPointerCapture(event.pointerId);
          driver.onPendingChange?.(true);
          event.preventDefault();
          return;
        }
        if (tool === "polygon" || (polygon && tool !== "hand" && tool !== "zoom")) {
          if (!polygon)
            polygon = {
              origin: "polygon",
              points: [],
              mode: modeFor(event),
              undoStarts: [],
              altLatched: event.altKey,
            };
          rememberPolygonPointer(event);
          const next = polygonCandidate()!;
          const previous = polygon.points.at(-1);
          if (nearStart(next)) {
            finishPolygon();
            event.preventDefault();
            return;
          }
          if (!previous || previous[0] !== next[0] || previous[1] !== next[1]) {
            polygon.undoStarts.push(polygon.points.length);
            polygon.points.push(next);
          }
          driver.onPolygonDraftChange?.(true);
          driver.onSelectionMode?.(polygon.mode);
          driver.onPendingChange?.(true);
          refreshPolygon();
          event.preventDefault();
          return;
        }
        if (tool === "zoom") {
          if (polygon) {
            driver.onPolygonDraftChange?.(false);
            driver.onPolygonCloseHint?.(false);
          }
          const box = element.getBoundingClientRect();
          const view = driver.getViewport();
          zoomGesture = {
            id: event.pointerId,
            x: event.clientX - box.left,
            y: event.clientY - box.top,
            lastX: event.clientX - box.left,
            lastY: event.clientY - box.top,
            view,
            out: event.altKey,
            mode: driver.getNavigation?.().mode ?? "marquee",
          };
          element.setPointerCapture(event.pointerId);
          driver.onPendingChange?.(true);
          event.preventDefault();
          driver.redraw();
          return;
        }
        active = {
          id: event.pointerId,
          kind:
            tool === "hand"
              ? "pan"
              : tool === "eyedropper"
                ? "sample"
                : tool === "move"
                  ? "move"
                  : tool === "crop"
                    ? "crop"
                    : tool === "rectangle" || tool === "ellipse" || tool === "lasso"
                      ? "select"
                      : "paint",
          x: event.clientX,
          y: event.clientY,
          shape:
            tool === "crop"
              ? "rectangle"
              : tool === "rectangle" || tool === "ellipse" || tool === "lasso"
                ? tool
                : null,
          points: [[point(event)[0], point(event)[1]]],
          shift: event.shiftKey && driver.hasSelection?.() !== false,
          alt: event.altKey && driver.hasSelection?.() !== false,
          mode: modeFor(event),
          copy: tool === "move" && event.altKey,
        };
        if (polygon) {
          driver.onPolygonDraftChange?.(false);
          driver.onPolygonCloseHint?.(false);
        }
        if (active.kind === "select") driver.onSelectionMode?.(active.mode ?? "replace");
        element.setPointerCapture(event.pointerId);
        const initialPoint = point(event);
        shapePointer = [initialPoint[0], initialPoint[1]];
        driver.onPendingChange?.(true);
        if (active.kind === "paint") {
          paintPoint = point(event);
          paintConstraint = event.shiftKey ? { origin: paintPoint, axis: null } : null;
          driver.beginStroke(paintPoint, event.shiftKey);
        }
        if (active.kind === "move") {
          driver.prepareMove?.(initialPoint, selected === "move" && primary);
          if (!driver.movePixels) throw new Error("移动工具尚未连接。");
          driver.movePixels(0, 0, "preview", active.copy);
        }
        if (active.kind === "sample") {
          if (!driver.sampleColor) throw new Error("吸管工具尚未连接。");
          driver.sampleColor(point(event));
        }
        event.preventDefault();
        driver.redraw();
      }),
    options,
  );
  element.addEventListener(
    "pointermove",
    (event) =>
      run(() => {
        if (bird && bird.id === event.pointerId) {
          if (bird.movable) {
            const box = element.getBoundingClientRect(),
              position = screenToImage(bird.fit, {
                x: event.clientX - box.left,
                y: event.clientY - box.top,
              }),
              size = driver.getImageSize?.();
            bird.center = {
              x: Math.max(0, Math.min(size?.width ?? Infinity, position.x + bird.offset.x)),
              y: Math.max(0, Math.min(size?.height ?? Infinity, position.y + bird.offset.y)),
            };
            previewBird();
          }
          driver.redraw();
          return;
        }
        if (polygon && !active && !zoomGesture) {
          rememberPolygonPointer(event);
          if (!event.altKey) polygon.altLatched = false;
          refreshPolygon();
          return;
        }
        if (zoomGesture && zoomGesture.id === event.pointerId) {
          const gesture = zoomGesture,
            box = element.getBoundingClientRect(),
            x = event.clientX - box.left,
            y = event.clientY - box.top;
          if (gesture.mode === "scrubby")
            driver.setViewport(
              scrubZoom(gesture.view, { x: gesture.x, y: gesture.y }, x - gesture.x),
            );
          else {
            if (space) {
              gesture.x += x - gesture.lastX;
              gesture.y += y - gesture.lastY;
            }
            driver.previewZoom?.({
              left: Math.min(x, gesture.x),
              top: Math.min(y, gesture.y),
              width: Math.abs(x - gesture.x),
              height: Math.abs(y - gesture.y),
            });
          }
          gesture.lastX = x;
          gesture.lastY = y;
          driver.redraw();
          return;
        }
        if (!active || active.id !== event.pointerId) return;
        if (Math.abs(event.clientX - active.x) > 3 || Math.abs(event.clientY - active.y) > 3)
          active.dragged = true;
        if (active.kind === "pan") {
          driver.setViewport(
            panViewport(driver.getViewport(), {
              x: event.clientX - active.x,
              y: event.clientY - active.y,
            }),
          );
          active.x = event.clientX;
          active.y = event.clientY;
          if (polygon) {
            rememberPolygonPointer(event);
            refreshPolygon();
          }
        } else if ((active.kind === "select" || active.kind === "crop") && active.shape) {
          const region = updateShape(event);
          if (active.kind === "crop") {
            if (!driver.crop) throw new Error("裁剪工具尚未连接。");
            driver.crop(region, "preview");
          } else if (active.continuation === "polygon" && driver.previewPolygon)
            driver.previewPolygon(active.points, active.mode);
          else driver.previewSelection?.(region);
        } else if (active.kind === "move" || active.kind === "boundary") {
          const next = point(event),
            origin = active.points[0];
          if (origin) {
            const dx = Math.round(next[0] - origin[0]),
              dy = Math.round(next[1] - origin[1]);
            if (active.kind === "move") driver.movePixels?.(dx, dy, "preview", active.copy);
            else driver.moveSelection?.(dx, dy, "preview");
          }
        } else if (active.kind === "sample") driver.sampleColor?.(point(event));
        else {
          let next = point(event);
          if (event.shiftKey && paintPoint) {
            paintConstraint ??= { origin: paintPoint, axis: null };
            const origin = paintConstraint.origin;
            const dx = next[0] - origin[0],
              dy = next[1] - origin[1];
            if (!paintConstraint.axis && (dx !== 0 || dy !== 0))
              paintConstraint.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
            if (paintConstraint.axis === "x") next = [next[0], origin[1], next[2]];
            if (paintConstraint.axis === "y") next = [origin[0], next[1], next[2]];
          } else paintConstraint = null;
          driver.moveStroke(next);
          paintPoint = next;
        }
        driver.redraw();
      }),
    options,
  );
  element.addEventListener(
    "pointerup",
    (event) =>
      run(() => {
        if (bird && bird.id === event.pointerId) {
          const box = element.getBoundingClientRect(),
            view = bird.movable
              ? {
                  ...bird.view,
                  x: box.width / 2 - (bird.center.x * bird.view.zoom) / bird.view.pixelRatio,
                  y: box.height / 2 - (bird.center.y * bird.view.zoom) / bird.view.pixelRatio,
                }
              : bird.view;
          driver.setViewport(view);
          release();
          driver.redraw();
          return;
        }
        if (zoomGesture && zoomGesture.id === event.pointerId) {
          const gesture = zoomGesture,
            box = element.getBoundingClientRect();
          const x = event.clientX - box.left,
            y = event.clientY - box.top,
            dx = x - gesture.x,
            dy = y - gesture.y;
          if (gesture.mode === "scrubby" && Math.abs(dx) > 3)
            driver.setViewport(scrubZoom(gesture.view, { x: gesture.x, y: gesture.y }, dx));
          else if (
            gesture.mode === "marquee" &&
            !gesture.out &&
            Math.abs(dx) > 3 &&
            Math.abs(dy) > 3
          )
            driver.setViewport(
              marqueeZoom(
                gesture.view,
                {
                  left: Math.min(x, gesture.x),
                  top: Math.min(y, gesture.y),
                  width: Math.abs(dx),
                  height: Math.abs(dy),
                },
                box,
              ),
            );
          else
            driver.setViewport(
              clickZoom(
                gesture.view,
                { x: gesture.x, y: gesture.y },
                box,
                gesture.out,
                driver.getNavigation?.().center ?? false,
              ),
            );
          release();
          refreshPolygon();
          driver.redraw();
          return;
        }
        if (active?.id !== event.pointerId) return;
        if (
          (active.kind === "select" || active.kind === "boundary") &&
          active.shape === "rectangle" &&
          !active.dragged &&
          Math.abs(event.clientX - active.x) <= 3 &&
          Math.abs(event.clientY - active.y) <= 3 &&
          active.mode === "replace" &&
          !active.shift &&
          !active.alt &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          driver.getSelectionOptions?.().style !== "fixed" &&
          driver.hasSelection?.()
        ) {
          if (active.kind === "boundary") driver.moveSelection?.(0, 0, "cancel");
          driver.previewSelection?.([]);
          driver.deselect?.();
          release();
          driver.redraw();
          return;
        }
        if (active.kind === "paint") driver.endStroke();
        if (active.kind === "move" || active.kind === "boundary") {
          const next = point(event),
            origin = active.points[0];
          if (origin) {
            const dx = Math.round(next[0] - origin[0]),
              dy = Math.round(next[1] - origin[1]);
            if (active.kind === "move") driver.movePixels?.(dx, dy, "commit", active.copy);
            else driver.moveSelection?.(dx, dy, "commit");
          }
        }
        if ((active.kind === "select" || active.kind === "crop") && active.shape) {
          const region = updateShape(event);
          if (active.shape === "lasso" && (event.altKey || active.continuation === "polygon")) {
            polygon = {
              origin: active.continuation ?? "lasso",
              points: active.points,
              mode: active.mode,
              undoStarts: active.polygonUndo ?? [0],
              altLatched: false,
            };
            rememberPolygonPointer(event);
            release();
            refreshPolygon();
            return;
          }
          if (active.kind === "crop") {
            if (!driver.crop) throw new Error("裁剪工具尚未连接。");
            driver.crop(region, "ready");
          } else {
            if (!driver.select) throw new Error("选区工具尚未连接。");
            if (region.length) driver.select(region, active.mode);
            driver.previewSelection?.([]);
          }
        }
        release();
        refreshPolygon();
        driver.redraw();
      }),
    options,
  );
  element.addEventListener(
    "pointercancel",
    (event) =>
      run(() => {
        if (active?.id === event.pointerId || zoomGesture?.id === event.pointerId) cancel();
      }),
    options,
  );
  element.addEventListener(
    "lostpointercapture",
    (event) =>
      run(() => {
        if (active?.id === event.pointerId || zoomGesture?.id === event.pointerId) cancel();
      }),
    options,
  );
  element.addEventListener("dblclick", () => run(finishPolygon), options);
  element.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (
        event.key.toLowerCase() === "h" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !active &&
        !polygon &&
        !zoomGesture
      )
        hHeld = true;
      if (polygon && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        run(finishPolygon);
      }
      if (polygon && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        event.stopPropagation();
        run(() => {
          polygon!.points.splice(
            polygon!.undoStarts.pop() ?? Math.max(0, polygon!.points.length - 1),
          );
          if (!polygon!.points.length) {
            polygon = null;
            driver.previewPolygon?.(null);
            driver.previewSelection?.([]);
            driver.onPolygonCloseHint?.(false);
            release();
            driver.redraw();
          } else refreshPolygon();
        });
      }
      if (event.code === "Space" && !event.isComposing) {
        space = true;
        zoomKey = driver.platform === "mac" ? event.metaKey : event.ctrlKey;
        event.preventDefault();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        run(cancel);
      }
      if (polygon && event.key === "Shift" && polygonPointer) {
        polygonPointer.shiftKey = event.shiftKey;
        run(refreshPolygon);
      }
    },
    options,
  );
  element.addEventListener(
    "keyup",
    (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key.toLowerCase() === "h") hHeld = false;
      if (event.code === "Space") {
        space = false;
        zoomKey = false;
      }
      if (event.key === "Control" || event.key === "Meta") zoomKey = false;
      if (event.key === "Shift" || event.code === "ShiftLeft" || event.code === "ShiftRight")
        paintConstraint = null;
      if (polygon) {
        if (event.key === "Alt") polygon.altLatched = false;
        if (event.key === "Shift" && polygonPointer) {
          polygonPointer.shiftKey = false;
          run(refreshPolygon);
        }
      }
    },
    options,
  );
  element.addEventListener(
    "blur",
    () =>
      run(() => {
        space = false;
        hHeld = false;
        zoomKey = false;
        cancel();
      }),
    options,
  );
  element.ownerDocument.defaultView?.addEventListener(
    "blur",
    () =>
      run(() => {
        space = false;
        zoomKey = false;
        hHeld = false;
        cancel();
      }),
    options,
  );
  const unbind = () => {
    controller.abort();
    run(cancel);
  };
  return Object.assign(unbind, { refreshViewport: () => run(refreshPolygon) });
}
