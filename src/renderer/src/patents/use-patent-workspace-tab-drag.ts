import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PatentDocumentTargetInput,
  PatentWorkspaceLayoutState,
  WorkspacePane,
} from "./patent-workspace-layout";
import {
  classifyWorkspaceTabDrop,
  passedWorkspaceTabDragThreshold,
  type WorkspacePoint,
  type WorkspaceRect,
  type WorkspaceTabDragBindings,
  type WorkspaceTabDragSource,
  type WorkspaceTabDragStartRequest,
  type WorkspaceTabDropEffect,
  workspacePaneAtPoint,
} from "./patent-workspace-tab-drag";
import { workspaceTabDragTiming } from "./workspace-tab-drag-motion";

export type WorkspaceTabDragSession = Readonly<{
  sequence: number;
  status: "dragging" | "settling" | "cancelling";
  source: WorkspaceTabDragSource;
  sourceRect: WorkspaceRect;
  origin: WorkspacePoint;
  point: WorkspacePoint;
  offset: WorkspacePoint;
  workspaceRect: WorkspaceRect | null;
  pane: WorkspacePane | null;
  effect: WorkspaceTabDropEffect | null;
}>;

type PendingWorkspaceTabDrag = {
  sequence: number;
  request: WorkspaceTabDragStartRequest;
  sourceRect: WorkspaceRect;
  origin: WorkspacePoint;
  offset: WorkspacePoint;
  dragging: boolean;
  lastSession: WorkspaceTabDragSession | null;
};

type UsePatentWorkspaceTabDragOptions = Readonly<{
  enabled: boolean;
  layout: PatentWorkspaceLayoutState;
  /** 单屏实际显示的目标（内嵌 CAD标号/流程图 时是工具，而非背后的书册）。 */
  singleCurrentTarget?: PatentDocumentTargetInput | null | undefined;
  getWorkspaceRect(): WorkspaceRect | null;
  onDrop(
    target: PatentDocumentTargetInput,
    pane: WorkspacePane,
    effect: WorkspaceTabDropEffect,
    source: WorkspaceTabDragSource,
  ): Promise<boolean>;
}>;

function workspaceRect(rect: DOMRect): WorkspaceRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function usePatentWorkspaceTabDrag({
  enabled,
  layout,
  singleCurrentTarget = null,
  getWorkspaceRect,
  onDrop,
}: UsePatentWorkspaceTabDragOptions): Readonly<{
  bindings: WorkspaceTabDragBindings;
  session: WorkspaceTabDragSession | null;
}> {
  const [session, setSession] = useState<WorkspaceTabDragSession | null>(null);
  const enabledRef = useRef(enabled);
  const layoutRef = useRef(layout);
  const singleCurrentTargetRef = useRef(singleCurrentTarget);
  const getWorkspaceRectRef = useRef(getWorkspaceRect);
  const onDropRef = useRef(onDrop);
  const pendingRef = useRef<PendingWorkspaceTabDrag | null>(null);
  const cancelledPointerRef = useRef<{ pointerId: number; sourceKey: string } | null>(null);
  const sequenceRef = useRef(0);
  const visualTimerRef = useRef<number | null>(null);
  const suppressedClickRef = useRef<string | null>(null);
  const suppressedClickTimerRef = useRef<number | null>(null);
  enabledRef.current = enabled;
  layoutRef.current = layout;
  singleCurrentTargetRef.current = singleCurrentTarget;
  getWorkspaceRectRef.current = getWorkspaceRect;
  onDropRef.current = onDrop;

  const clearVisualTimer = useCallback(() => {
    if (visualTimerRef.current === null) return;
    window.clearTimeout(visualTimerRef.current);
    visualTimerRef.current = null;
  }, []);

  const scheduleVisualClear = useCallback(
    (paint: WorkspaceTabDragSession) => {
      const sequence = paint.sequence;
      if (sequence !== sequenceRef.current) return;
      clearVisualTimer();
      visualTimerRef.current = window.setTimeout(() => {
        setSession((current) => (current?.sequence === sequence ? null : current));
        visualTimerRef.current = null;
      }, workspaceTabDragTiming(paint).duration + 20);
    },
    [clearVisualTimer],
  );

  const suppressNextClick = useCallback((sourceKey: string) => {
    if (suppressedClickTimerRef.current !== null) {
      window.clearTimeout(suppressedClickTimerRef.current);
    }
    suppressedClickRef.current = sourceKey;
    suppressedClickTimerRef.current = window.setTimeout(() => {
      if (suppressedClickRef.current === sourceKey) suppressedClickRef.current = null;
      suppressedClickTimerRef.current = null;
    }, 0);
  }, []);

  const showCancellation = useCallback(
    (pending: PendingWorkspaceTabDrag) => {
      const lastSession = pending.lastSession;
      if (!lastSession) return;
      setSession({
        ...lastSession,
        status: "cancelling",
        workspaceRect: null,
        pane: null,
        effect: null,
      });
      scheduleVisualClear({ ...lastSession, status: "cancelling" });
    },
    [scheduleVisualClear],
  );

  useEffect(() => {
    const cancel = (pointerId: number | null = null, waitForPointerUp = false) => {
      const pending = pendingRef.current;
      if (!pending || (pointerId !== null && pointerId !== pending.request.pointerId)) return;
      pendingRef.current = null;
      if (!pending.dragging) return;
      if (waitForPointerUp) {
        cancelledPointerRef.current = {
          pointerId: pending.request.pointerId,
          sourceKey: pending.request.source.key,
        };
      } else {
        suppressNextClick(pending.request.source.key);
      }
      showCancellation(pending);
    };

    const move = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.request.pointerId) return;
      if (event.buttons === 0) {
        cancel(event.pointerId);
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      if (!pending.dragging) {
        if (!passedWorkspaceTabDragThreshold(pending.origin, point)) return;
        pending.dragging = true;
        if (typeof pending.request.sourceElement.setPointerCapture === "function") {
          pending.request.sourceElement.setPointerCapture(event.pointerId);
        }
      }
      event.preventDefault();
      const dropRect = getWorkspaceRectRef.current();
      const pane = dropRect ? workspacePaneAtPoint(dropRect, point) : null;
      const effect = pane
        ? classifyWorkspaceTabDrop(
            layoutRef.current,
            pane,
            pending.request.source.target,
            singleCurrentTargetRef.current,
          )
        : null;
      const nextSession: WorkspaceTabDragSession = {
        sequence: pending.sequence,
        status: "dragging",
        source: pending.request.source,
        sourceRect: pending.sourceRect,
        origin: pending.origin,
        point,
        offset: pending.offset,
        workspaceRect: dropRect,
        pane,
        effect,
      };
      pending.lastSession = nextSession;
      setSession(nextSession);
    };

    const finish = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending) {
        const cancelledPointer = cancelledPointerRef.current;
        if (!cancelledPointer || event.pointerId !== cancelledPointer.pointerId) return;
        cancelledPointerRef.current = null;
        event.preventDefault();
        suppressNextClick(cancelledPointer.sourceKey);
        return;
      }
      if (event.pointerId !== pending.request.pointerId) return;
      pendingRef.current = null;
      if (!pending.dragging) return;
      event.preventDefault();
      suppressNextClick(pending.request.source.key);
      const lastSession = pending.lastSession;
      if (!enabledRef.current || !lastSession?.pane || !lastSession.effect) {
        showCancellation(pending);
        return;
      }
      setSession({ ...lastSession, status: "settling" });
      void onDropRef
        .current(
          pending.request.source.target,
          lastSession.pane,
          lastSession.effect,
          pending.request.source,
        )
        .then((accepted) => {
          setSession((current) => {
            if (current?.sequence !== pending.sequence) return current;
            return accepted
              ? { ...current, status: "settling" }
              : {
                  ...current,
                  status: "cancelling",
                  workspaceRect: null,
                  pane: null,
                  effect: null,
                };
          });
          scheduleVisualClear({ ...lastSession, status: accepted ? "settling" : "cancelling" });
        });
    };

    const cancelPointer = (event: PointerEvent) => cancel(event.pointerId);
    const cancelLostPointerCapture = (event: PointerEvent) => cancel(event.pointerId, true);
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel(null, true);
    };
    const cancelOnBlur = () => cancel();

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("lostpointercapture", cancelLostPointerCapture);
    window.addEventListener("keydown", cancelWithEscape);
    window.addEventListener("blur", cancelOnBlur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("lostpointercapture", cancelLostPointerCapture);
      window.removeEventListener("keydown", cancelWithEscape);
      window.removeEventListener("blur", cancelOnBlur);
    };
  }, [scheduleVisualClear, showCancellation, suppressNextClick]);

  useEffect(
    () => () => {
      clearVisualTimer();
      if (suppressedClickTimerRef.current !== null) {
        window.clearTimeout(suppressedClickTimerRef.current);
      }
    },
    [clearVisualTimer],
  );

  const start = useCallback(
    (request: WorkspaceTabDragStartRequest) => {
      if (!enabledRef.current || request.button !== 0 || pendingRef.current) return;
      cancelledPointerRef.current = null;
      clearVisualTimer();
      setSession(null);
      const rect = workspaceRect(request.sourceElement.getBoundingClientRect());
      sequenceRef.current += 1;
      pendingRef.current = {
        sequence: sequenceRef.current,
        request,
        sourceRect: rect,
        origin: { x: request.clientX, y: request.clientY },
        offset: { x: request.clientX - rect.left, y: request.clientY - rect.top },
        dragging: false,
        lastSession: null,
      };
    },
    [clearVisualTimer],
  );

  const consumeClick = useCallback((sourceKey: string) => {
    if (suppressedClickRef.current !== sourceKey) return false;
    suppressedClickRef.current = null;
    return true;
  }, []);

  const bindings = useMemo<WorkspaceTabDragBindings>(
    () => ({ start, consumeClick }),
    [consumeClick, start],
  );

  return { bindings, session };
}
