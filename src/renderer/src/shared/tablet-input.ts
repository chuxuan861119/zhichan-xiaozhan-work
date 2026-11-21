export function isTabletInteraction(): boolean {
  return document.documentElement.dataset.deviceForm === "tablet";
}

export function isTextEntry(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.matches("textarea, [contenteditable='true'], math-field")) return true;
  return (
    element instanceof HTMLInputElement &&
    ![
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "color",
      "range",
      "hidden",
    ].includes(element.type)
  );
}

export function blurTabletInputForNavigation(): void {
  if (isTabletInteraction() && isTextEntry(document.activeElement)) document.activeElement.blur();
}

/** Keep native scrolling/selection; opening the IME requires a completed single-finger tap. */
export function installTabletTouchInput(): () => void {
  type TouchInput = {
    element: HTMLElement;
    mode: string;
    id: number;
    x: number;
    y: number;
    moved: boolean;
    started: number;
  };
  let pending: TouchInput | null = null;
  let scrolling: { id: number; x: number; y: number; input: HTMLElement } | null = null;
  const contacts = new Set<number>();
  let rejected: HTMLElement | null = null;
  const restore = (tap: boolean) => {
    const intent = pending;
    pending = null;
    if (!intent) return;
    const { element, mode } = intent;
    // A native pointerdown may have focused the field with inputmode=none.
    // Refocus only on a tap, so changing inputmode cannot open the IME during scroll.
    if (document.activeElement === element) element.blur();
    element.inputMode = tap && element.hasAttribute("data-patent-editor-id") ? "text" : mode;
    if (tap && element.isConnected) element.focus({ preventScroll: true });
    else rejected = element;
  };
  const down = (event: PointerEvent) => {
    if (!isTabletInteraction() || event.pointerType !== "touch") return;
    rejected = null;
    contacts.add(event.pointerId);
    if (contacts.size === 1 && isTextEntry(document.activeElement)) {
      scrolling = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        input: document.activeElement,
      };
    }
    if (contacts.size > 1) {
      if (pending) pending.moved = true;
      return;
    }
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("input, textarea, [contenteditable='true']")
        : null;
    if (!isTextEntry(element) || element.matches(":disabled, [readonly]")) return;
    // Preserve an ongoing native edit/composition and its selection handles.
    if (document.activeElement === element && element.inputMode !== "none") return;
    const patent = element.hasAttribute("data-patent-editor-id");
    if (element.inputMode === "none" && !patent) return;
    pending = {
      element,
      mode: element.inputMode,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      started: Date.now(),
    };
    element.inputMode = "none";
  };
  const move = (event: PointerEvent) => {
    if (
      scrolling?.id === event.pointerId &&
      Math.hypot(event.clientX - scrolling.x, event.clientY - scrolling.y) >= 8
    ) {
      if (document.activeElement === scrolling.input) scrolling.input.blur();
      scrolling = null;
    }
    if (
      pending?.id === event.pointerId &&
      Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= 8
    )
      pending.moved = true;
  };
  const up = (event: PointerEvent) => {
    move(event);
    contacts.delete(event.pointerId);
    if (scrolling?.id === event.pointerId) scrolling = null;
    if (pending?.id !== event.pointerId) return;
    restore(
      event.type === "pointerup" &&
        !pending.moved &&
        contacts.size === 0 &&
        Date.now() - pending.started < 500 &&
        !event.defaultPrevented,
    );
  };
  const click = (event: MouseEvent) => {
    if (
      event.detail > 0 &&
      rejected &&
      event.target instanceof Node &&
      rejected.contains(event.target)
    )
      event.preventDefault();
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("click", click, true);
  return () => {
    if (pending) pending.element.inputMode = pending.mode;
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("click", click, true);
  };
}
