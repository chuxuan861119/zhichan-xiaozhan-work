import { useEffect, useRef } from "react";

const fields =
  "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]";
const contexts =
  "summary,[aria-haspopup],[role=menu],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],dialog,[role=dialog],[role=tab],[data-klecks-size-edit],.klecks-panels__layers button,.klecks-panels__layers input,.klecks-panels__layers select";

function visible(element: Element): boolean {
  if (!element.isConnected || element.closest("[hidden],details:not([open]) > :not(summary)"))
    return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
  }
  return true;
}
export function klecksFocusField(target: Element): Element | null {
  const field = target.closest(fields) ?? target.closest("label")?.control;
  return field?.matches(fields) ? field : null;
}

/** Native focus remains with text, menus and dialogs; mouse-only chrome returns to the canvas. */
export function bindKlecksCanvasFocus(root: HTMLElement, focusCanvas: () => void) {
  const doc = root.ownerDocument,
    win = doc.defaultView!;
  let scheduled = 0;
  const active = () => visible(root);
  const overlay = () =>
    [
      ...doc.querySelectorAll(
        "dialog[open],[role=dialog],[role=alertdialog],[role=menu],.klecks-status-dock details[open]",
      ),
      ...root.querySelectorAll("details[open]"),
    ].some(visible);
  const owns = (target: Element) => {
    const workspace = root.closest(".design-workspace-shell");
    return (
      root.contains(target) ||
      !!target.closest(".status-bar__design-editor") ||
      (!!workspace?.contains(target) && !target.closest(".design-workspace-shell__steps"))
    );
  };
  const targetOf = (event: Event) => (event.target instanceof Element ? event.target : null);
  const later = (callback: () => void) => {
    win.cancelAnimationFrame(scheduled);
    scheduled = win.requestAnimationFrame(() => {
      scheduled = 0;
      if (active() && !overlay()) callback();
    });
  };
  const down = (event: PointerEvent) => {
    const target = targetOf(event);
    if (
      event.button !== 0 ||
      !target ||
      !active() ||
      !owns(target) ||
      overlay() ||
      klecksFocusField(target) ||
      target.closest(contexts)
    )
      return;
    // Keep an unfinished canvas gesture from being cancelled by a blank-area blur.
    event.preventDefault();
  };
  const click = (event: MouseEvent) => {
    const target = targetOf(event);
    if (
      !target ||
      !active() ||
      !owns(target) ||
      klecksFocusField(target) ||
      target.closest(contexts)
    )
      return;
    // Preserve Tab/Space activation in the chrome; only mouse activation needs returning.
    if (event.detail === 0 && target.closest("button,input[type=checkbox],input[type=radio],a"))
      return;
    later(focusCanvas);
  };
  const key = (event: KeyboardEvent) => {
    const target = targetOf(event);
    if (
      !target ||
      !active() ||
      !owns(target) ||
      target.closest("[data-klecks-size-edit]") ||
      event.isComposing ||
      event.keyCode === 229 ||
      !["Enter", "Escape"].includes(event.key)
    )
      return;
    const field = klecksFocusField(target);
    if (field)
      later(() => {
        if (doc.activeElement === field) return;
        if (field.getAttribute("aria-invalid") === "true") {
          if (field instanceof HTMLElement) field.focus({ preventScroll: true });
        } else focusCanvas();
      });
    else if (event.key === "Escape" && target.closest(contexts)) later(focusCanvas);
  };
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("click", click);
  doc.addEventListener("keydown", key, true);
  return () => {
    win.cancelAnimationFrame(scheduled);
    doc.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("click", click);
    doc.removeEventListener("keydown", key, true);
  };
}

export function KlecksCanvasFocus({ onFocus }: { onFocus?: (() => void) | undefined }) {
  const anchor = useRef<HTMLSpanElement>(null),
    latest = useRef(onFocus);
  const enabled = !!onFocus;
  latest.current = onFocus;
  useEffect(() => {
    const root = anchor.current?.parentElement;
    if (root && enabled) return bindKlecksCanvasFocus(root, () => latest.current?.());
  }, [enabled]);
  return <span ref={anchor} style={{ display: "none" }} aria-hidden="true" />;
}
