import { useCallback, useEffect, useRef } from "react";
import type { PatentBookKind } from "../../../shared/patent/model";
import type { EditorCommandBus } from "../app/command-bus";
import { hasVisibleElement, isVisibleControl } from "../shared/focusable-elements";

const TEXT_BOOK_KINDS = new Set<PatentBookKind>(["claims", "description", "abstract"]);

const TEMPORARY_FOCUS_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[data-selectable-tool-text]",
].join(",");

const OPEN_TRANSIENT_SURFACE_SELECTOR = "[role='dialog'], [role='menu'], [aria-modal='true']";
const POINTER_DRAG_THRESHOLD_PX = 4;

type RestoreRequest = { collapseSelection?: boolean; activeEditorChanged?: boolean };

export function isTextPatentBook(kind: PatentBookKind | null | undefined): boolean {
  return kind ? TEXT_BOOK_KINDS.has(kind) : false;
}

export function historyCommandFromKeyboardEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}): "undo" | "redo" | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

export function shouldRoutePatentHistoryShortcut({
  activeBookKind,
  modalOpen,
  target,
}: {
  activeBookKind: PatentBookKind | null | undefined;
  modalOpen: boolean;
  target: EventTarget | null;
}): boolean {
  if (!activeBookKind || modalOpen) return false;
  if (!(target instanceof Element)) return true;
  if (target.closest("[data-patent-editor-id]")) return true;
  return !target.closest("input, textarea, select, [contenteditable='true']");
}

export function shouldRouteReferenceMarkUndo({
  activeBookKind,
  canUndo,
  modalOpen,
  target,
}: {
  activeBookKind: PatentBookKind | null | undefined;
  canUndo: boolean;
  modalOpen: boolean;
  target: EventTarget | null;
}): boolean {
  return (
    canUndo &&
    isTextPatentBook(activeBookKind) &&
    shouldRoutePatentHistoryShortcut({ activeBookKind, modalOpen, target })
  );
}

export function mayRestorePatentFocus(activeElement: Element | null): boolean {
  if (hasVisibleElement(OPEN_TRANSIENT_SURFACE_SELECTOR)) return false;
  if (!activeElement || activeElement === document.body) return true;
  if (activeElement instanceof HTMLElement && !isVisibleControl(activeElement)) return true;
  return !activeElement.matches(TEMPORARY_FOCUS_SELECTOR);
}

function isInsideActiveEditor(target: EventTarget | null, activeEditorId: string): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest("[data-patent-editor-id]")?.getAttribute("data-patent-editor-id") ===
    activeEditorId
  );
}

const TEXT_PROJECTION_EXCLUSION_SELECTOR =
  "button, input, textarea, select, a[href], [role='button'], .document-structure-ruler, .patent-global-function-rail-slot, .status-bar";
const EDITOR_FOCUS_PRESERVING_SURFACE_SELECTOR =
  ".tool-bar, .menu-bar, .patent-global-function-rail-slot, .status-bar, .assistant-side-panel, [data-editor-menu-owner]";

function isInsideTextProjectionSurface(
  target: EventTarget | null,
  activeEditorId: string,
): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest("[data-patent-text-projection]")?.getAttribute("data-patent-text-projection") ===
      activeEditorId &&
    !target.closest(TEXT_PROJECTION_EXCLUSION_SELECTOR) &&
    !isInsideTextSelectionGutter(target, activeEditorId) &&
    !isInsideActiveEditor(target, activeEditorId)
  );
}

function isInsideTextSelectionGutter(target: EventTarget | null, activeEditorId: string): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target
      .closest("[data-patent-selection-gutter]")
      ?.getAttribute("data-patent-selection-gutter") === activeEditorId
  );
}

export function usePatentEditorFocus({
  activeEditorId,
  enabled,
  commandBus,
}: {
  activeEditorId: string;
  enabled: boolean;
  commandBus: EditorCommandBus;
}) {
  const composing = useRef(false);
  const activeEditorIdRef = useRef(activeEditorId);
  const preservingSurfacePointerIdRef = useRef<number | null>(null);
  activeEditorIdRef.current = activeEditorId;
  const preserveSelectionForPointer = useCallback((pointerId: number) => {
    preservingSurfacePointerIdRef.current = pointerId;
  }, []);

  useEffect(() => {
    const onCompositionStart = () => {
      composing.current = true;
    };
    const onCompositionEnd = () => {
      composing.current = false;
    };
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !activeEditorId) return;
    let frame = 0;
    let request: RestoreRequest = {};
    let marginPointer: { pointerId: number; x: number; y: number; dragged: boolean } | null = null;
    const restore = (nextRequest: RestoreRequest) => {
      cancelAnimationFrame(frame);
      request = nextRequest;
      frame = requestAnimationFrame(() => {
        const switchingFromFindPanel =
          request.activeEditorChanged &&
          document.activeElement instanceof Element &&
          document.activeElement.closest(".find-replace-panel");
        const targetEditorId = activeEditorIdRef.current;
        const focusedPatentEditorId =
          document.activeElement instanceof Element
            ? document.activeElement
                .closest("[data-patent-editor-id]")
                ?.getAttribute("data-patent-editor-id")
            : null;
        const switchingFromAnotherPatentEditor =
          request.activeEditorChanged &&
          Boolean(focusedPatentEditorId) &&
          focusedPatentEditorId !== targetEditorId;
        if (
          composing.current ||
          (!switchingFromFindPanel &&
            !switchingFromAnotherPatentEditor &&
            !mayRestorePatentFocus(document.activeElement))
        )
          return;
        if (targetEditorId) {
          if (request.collapseSelection)
            commandBus.focus(targetEditorId, { collapseSelection: true });
          else commandBus.focus(targetEditorId);
        }
      });
    };
    const restoreWithoutCollapsing = () => {
      if (preservingSurfacePointerIdRef.current !== null) return;
      restore({});
    };
    const notePointerDown = (event: PointerEvent) => {
      const preservesEditorSelection =
        event.target instanceof Element &&
        event.target.closest(EDITOR_FOCUS_PRESERVING_SURFACE_SELECTOR);
      const isStatusBarInteraction =
        event.target instanceof Element && event.target.closest(".status-bar");
      preservingSurfacePointerIdRef.current = preservesEditorSelection ? event.pointerId : null;
      // Let conversation text use native selection without redirecting the drag to the patent.
      if (
        event.target instanceof Element &&
        event.target.closest(".text-polish-panel, .ai-correction-panel") &&
        !event.target.closest("button, input, textarea, select, a, label, [role='button']")
      )
        return;
      if (
        preservesEditorSelection &&
        !isStatusBarInteraction &&
        !(event.target instanceof Element && event.target.closest(TEMPORARY_FOCUS_SELECTOR))
      ) {
        event.preventDefault();
      }
      const targetEditorId = activeEditorIdRef.current;
      if (!targetEditorId || !isInsideTextProjectionSurface(event.target, targetEditorId)) {
        marginPointer = null;
        return;
      }
      event.preventDefault();
      marginPointer = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragged: false,
      };
      const anchor = { x: event.clientX, y: event.clientY };
      commandBus.setSelectionFromCoordinates(targetEditorId, anchor, anchor);
    };
    const notePointerMove = (event: PointerEvent) => {
      if (!marginPointer || marginPointer.pointerId !== event.pointerId) return;
      if (
        Math.abs(event.clientX - marginPointer.x) >= POINTER_DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - marginPointer.y) >= POINTER_DRAG_THRESHOLD_PX
      ) {
        marginPointer.dragged = true;
        const targetEditorId = activeEditorIdRef.current;
        if (targetEditorId) {
          commandBus.setSelectionFromCoordinates(
            targetEditorId,
            { x: marginPointer.x, y: marginPointer.y },
            { x: event.clientX, y: event.clientY },
          );
        }
      }
    };
    const restoreAfterPointerUp = (event: PointerEvent) => {
      const preservingSurfaceInteraction =
        preservingSurfacePointerIdRef.current === event.pointerId;
      preservingSurfacePointerIdRef.current = null;
      const marginInteraction = marginPointer?.pointerId === event.pointerId ? marginPointer : null;
      marginPointer = null;
      if (preservingSurfaceInteraction) return;
      const targetEditorId = activeEditorIdRef.current;
      if (marginInteraction && targetEditorId) {
        if (!marginInteraction.dragged) return;
        const anchor = { x: marginInteraction.x, y: marginInteraction.y };
        const head = { x: event.clientX, y: event.clientY };
        commandBus.setSelectionFromCoordinates(targetEditorId, anchor, head);
        return;
      }
      if (event.target instanceof Element && event.target.closest(".find-replace-panel")) return;
      if (targetEditorId && isInsideTextSelectionGutter(event.target, targetEditorId)) return;
      if (targetEditorId && isInsideActiveEditor(event.target, targetEditorId)) return;
      restore({ collapseSelection: true });
    };
    const clearMarginPointer = () => {
      marginPointer = null;
      preservingSurfacePointerIdRef.current = null;
    };
    restore({ activeEditorChanged: true });
    window.addEventListener("focus", restoreWithoutCollapsing);
    document.addEventListener("pointerdown", notePointerDown, true);
    document.addEventListener("pointermove", notePointerMove, true);
    document.addEventListener("pointerup", restoreAfterPointerUp, true);
    document.addEventListener("pointercancel", clearMarginPointer, true);
    document.addEventListener("focusout", restoreWithoutCollapsing, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("focus", restoreWithoutCollapsing);
      document.removeEventListener("pointerdown", notePointerDown, true);
      document.removeEventListener("pointermove", notePointerMove, true);
      document.removeEventListener("pointerup", restoreAfterPointerUp, true);
      document.removeEventListener("pointercancel", clearMarginPointer, true);
      document.removeEventListener("focusout", restoreWithoutCollapsing, true);
    };
  }, [activeEditorId, commandBus, enabled]);
  return preserveSelectionForPointer;
}
