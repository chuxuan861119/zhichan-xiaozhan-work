import { type RefObject, useEffect, useRef } from "react";
import { focusableElements, isVisibleControl } from "./focusable-elements";
import { useEditorSessionVisible } from "./editor-session-scope";

type UseModalDialogOptions = {
  open: boolean;
  active?: boolean;
  escapeEnabled?: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
};

const modalStack: symbol[] = [];

export function useModalDialog({
  open,
  active = true,
  escapeEnabled = true,
  onClose,
  containerRef,
  initialFocusRef,
}: UseModalDialogOptions): void {
  const sessionVisible = useEditorSessionVisible();
  open = open && sessionVisible;
  const activeRef = useRef(active);
  const escapeEnabledRef = useRef(escapeEnabled);
  const closeRef = useRef(onClose);
  activeRef.current = active;
  escapeEnabledRef.current = escapeEnabled;
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const modalToken = Symbol("modal-dialog");
    modalStack.push(modalToken);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement
        ? document.activeElement
        : null;
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      const container = containerRef.current;
      const target =
        (initialFocusRef?.current && isVisibleControl(initialFocusRef.current)
          ? initialFocusRef.current
          : undefined) ??
        (container ? focusableElements(container)[0] : undefined) ??
        container;
      target?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current || modalStack.at(-1) !== modalToken || event.isComposing) return;
      if (event.key === "Escape") {
        if (!escapeEnabledRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !container.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !container.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      mounted = false;
      document.removeEventListener("keydown", handleKeyDown, true);
      const stackIndex = modalStack.lastIndexOf(modalToken);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      // Restore keyboard focus without scrolling the document (or its virtual columns).
      if (previouslyFocused instanceof HTMLElement && isVisibleControl(previouslyFocused))
        previouslyFocused.focus({ preventScroll: true });
    };
  }, [containerRef, initialFocusRef, open]);
}
