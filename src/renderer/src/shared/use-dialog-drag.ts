import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { surfaceRestingSize } from "./use-surface-resize-motion";

type DialogPosition = {
  left: number;
  top: number;
};

type DragState = DialogPosition & {
  pointerX: number;
  pointerY: number;
  pointerId: number;
  started: boolean;
};

type UseDialogDragOptions = {
  positionKey: string;
  /** "none" keeps a position only while movable; disabling restores the anchor. */
  memory?: "persistent" | "session" | "none";
  movable?: boolean;
  stackable?: boolean;
  minTop?: number;
  /** Opt in for a header whose buttons support both clicking and dragging. */
  dragFromControls?: boolean;
};

export type DialogDragResult<TElement extends HTMLElement> = {
  dragging: boolean;
  isTopmost(): boolean;
  surfaceRef: RefObject<TElement | null>;
  titleBarRef: RefObject<HTMLElement | null>;
  bringToFront(): void;
  setPosition(position: DialogPosition): void;
  layerStyle: CSSProperties;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerDownCapture(): void;
  onClickCapture(event: ReactMouseEvent<HTMLElement>): void;
  style: CSSProperties;
};

const positionStoragePrefix = "patent-workbench.dialog-position.";

type ModelessStackEntry = {
  setOrder(order: number): void;
};

const modelessStack: ModelessStackEntry[] = [];

function publishModelessStack(): void {
  modelessStack.forEach((entry, index) => {
    entry.setOrder(index + 1);
  });
}

function registerModelessDialog(entry: ModelessStackEntry): () => void {
  modelessStack.push(entry);
  publishModelessStack();
  return () => {
    const index = modelessStack.indexOf(entry);
    if (index === -1) return;
    modelessStack.splice(index, 1);
    publishModelessStack();
  };
}

function promoteModelessDialog(entry: ModelessStackEntry): void {
  const index = modelessStack.indexOf(entry);
  if (index === -1 || index === modelessStack.length - 1) return;
  modelessStack.splice(index, 1);
  modelessStack.push(entry);
  publishModelessStack();
}

function readStoredPosition(
  positionKey: string,
  memory: "persistent" | "session",
): DialogPosition | null {
  try {
    const storage = memory === "session" ? window.sessionStorage : window.localStorage;
    const raw = storage.getItem(`${positionStoragePrefix}${positionKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    return { left: parsed.left, top: parsed.top };
  } catch {
    return null;
  }
}

function clampPosition(
  position: DialogPosition,
  width: number,
  height: number,
  minTop = 0,
): DialogPosition {
  return {
    left: Math.min(Math.max(0, window.innerWidth - width), Math.max(0, position.left)),
    top: Math.min(Math.max(minTop, window.innerHeight - height), Math.max(minTop, position.top)),
  };
}

export function useDialogDrag<TElement extends HTMLElement>({
  positionKey,
  memory = "persistent",
  movable = true,
  stackable = false,
  minTop = 0,
  dragFromControls = false,
}: UseDialogDragOptions): DialogDragResult<TElement> {
  const surfaceRef = useRef<TElement>(null);
  const titleBarRef = useRef<HTMLElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const stopDraggingRef = useRef<() => void>(() => undefined);
  const captureRef = useRef<{ element: HTMLElement; pointerId: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [position, setPosition] = useState<DialogPosition | null>(() =>
    movable && memory !== "none" ? readStoredPosition(positionKey, memory) : null,
  );
  const [stackOrder, setStackOrder] = useState(0);
  const stackEntry = useMemo<ModelessStackEntry>(() => ({ setOrder: setStackOrder }), []);
  const positionRef = useRef<DialogPosition | null>(position);

  useEffect(() => {
    if (!stackable) return;
    return registerModelessDialog(stackEntry);
  }, [stackable, stackEntry]);

  const bringToFront = useCallback(() => {
    if (stackable) promoteModelessDialog(stackEntry);
  }, [stackable, stackEntry]);

  const persistPosition = useCallback(
    (next: DialogPosition) => {
      if (memory === "none") return;
      try {
        const storage = memory === "session" ? window.sessionStorage : window.localStorage;
        storage.setItem(`${positionStoragePrefix}${positionKey}`, JSON.stringify(next));
      } catch {
        // Position memory is optional; an unavailable storage must not block dragging.
      }
    },
    [positionKey, memory],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      const surface = surfaceRef.current;
      if (!dragState || !surface) return;
      if (event.pointerId !== dragState.pointerId) return;
      if ((event.buttons & 1) === 0) {
        stopDraggingRef.current();
        return;
      }
      if (!dragState.started) {
        if (Math.hypot(event.clientX - dragState.pointerX, event.clientY - dragState.pointerY) < 6)
          return;
        dragState.started = true;
        suppressClickRef.current = true;
        setDragging(true);
        // Wait until dragging is confirmed so a normal button click keeps its target.
        const element = titleBarRef.current ?? surface;
        captureRef.current = { element, pointerId: event.pointerId };
        element.addEventListener("lostpointercapture", stopDraggingRef.current);
        element.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      const bounds = surface.getBoundingClientRect();
      const next = clampPosition(
        {
          left: dragState.left + event.clientX - dragState.pointerX,
          top: dragState.top + event.clientY - dragState.pointerY,
        },
        bounds.width,
        bounds.height,
        minTop,
      );
      positionRef.current = next;
      setPosition(next);
    },
    [minTop],
  );

  const stopDragging = useCallback(() => {
    const dragState = dragStateRef.current;
    dragStateRef.current = null;
    setDragging(false);
    if (dragState?.started && positionRef.current) persistPosition(positionRef.current);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDragging);
    window.removeEventListener("pointercancel", stopDragging);
    window.removeEventListener("blur", stopDragging);
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      capture.element.removeEventListener("lostpointercapture", stopDragging);
      if (capture.element.hasPointerCapture?.(capture.pointerId))
        capture.element.releasePointerCapture(capture.pointerId);
    }
  }, [onPointerMove, persistPosition]);
  stopDraggingRef.current = stopDragging;

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!movable || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!dragFromControls && target?.closest("button,input,textarea,select,a,[role='button']"))
        return;
      const surface = surfaceRef.current;
      if (!surface) return;
      suppressClickRef.current = false;
      const bounds = surface.getBoundingClientRect();
      const current = position ?? { left: bounds.left, top: bounds.top };
      const clamped = clampPosition(current, bounds.width, bounds.height, minTop);
      positionRef.current = clamped;
      dragStateRef.current = {
        left: clamped.left,
        top: clamped.top,
        pointerX: event.clientX,
        pointerY: event.clientY,
        pointerId: event.pointerId,
        started: !dragFromControls,
      };
      if (!dragFromControls) {
        setPosition(clamped);
        setDragging(true);
        event.preventDefault();
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
      window.addEventListener("blur", stopDragging);
      if (!dragFromControls) {
        const captureElement = titleBarRef.current ?? surface;
        captureRef.current = { element: captureElement, pointerId: event.pointerId };
        captureElement.addEventListener("lostpointercapture", stopDragging);
        captureElement.setPointerCapture?.(event.pointerId);
      }
    },
    [movable, onPointerMove, position, stopDragging, minTop, dragFromControls],
  );

  useEffect(() => {
    const titleBar = titleBarRef.current;
    if (!movable || !titleBar) return;
    const handlePointerDown = (event: PointerEvent) => {
      onPointerDown(event as unknown as ReactPointerEvent<HTMLElement>);
    };
    titleBar.addEventListener("pointerdown", handlePointerDown);
    return () => titleBar.removeEventListener("pointerdown", handlePointerDown);
  }, [movable, onPointerDown]);

  useEffect(() => {
    if (!movable) return;
    const handleResize = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const size = surfaceRestingSize(surface);
      setPosition((current) => {
        if (!current) return current;
        const next = clampPosition(current, size.width, size.height, minTop);
        positionRef.current = next;
        persistPosition(next);
        return next;
      });
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [movable, persistPosition, minTop]);

  useEffect(() => stopDragging, [stopDragging]);
  useEffect(() => {
    if (!movable) {
      stopDragging();
      if (memory === "none") {
        positionRef.current = null;
        setPosition(null);
      }
    }
  }, [movable, memory, stopDragging]);

  return {
    dragging,
    isTopmost: () => !stackable || modelessStack.at(-1) === stackEntry,
    setPosition: (next) => {
      positionRef.current = next;
      setPosition(next);
      persistPosition(next);
    },
    surfaceRef,
    titleBarRef,
    bringToFront,
    layerStyle: stackable ? ({ "--modeless-dialog-stack-order": stackOrder } as CSSProperties) : {},
    onPointerDown,
    onPointerDownCapture: () => {
      suppressClickRef.current = false;
    },
    onClickCapture: (event) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      if (event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    },
    style: position
      ? {
          position: "fixed",
          left: position.left,
          top: position.top,
          margin: 0,
          transform: "none",
        }
      : {},
  };
}
