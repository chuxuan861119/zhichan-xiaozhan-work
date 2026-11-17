let nextScrollbarId = 0;

/** Native Chromium scrolling chrome, kept separate from the stationary two-column slices. */
export function createColumnScrollbar(parent: HTMLElement, onScroll: (position: number) => void) {
  const originalId = parent.id;
  if (!originalId) parent.id = `dual-column-scroll-target-${++nextScrollbarId}`;
  const element = document.createElement("div");
  element.className = "dual-column-scrollbar";
  element.tabIndex = 0;
  element.setAttribute("role", "scrollbar");
  element.setAttribute("aria-label", "双列文档滚动位置");
  element.setAttribute("aria-orientation", "vertical");
  element.setAttribute("aria-controls", parent.id);
  element.setAttribute("aria-valuemin", "0");
  const space = document.createElement("div");
  space.setAttribute("aria-hidden", "true");
  element.append(space);
  parent.append(element);
  let height = 0;
  let synchronized = 0;
  let extent = -1;
  const scroll = () => {
    // A scroll event is also queued by assigning scrollTop. Do not let that
    // feedback cancel an in-flight smooth wheel/ruler animation.
    if (Math.abs(element.scrollTop - synchronized) < 1) return;
    synchronized = element.scrollTop;
    onScroll(synchronized);
  };
  element.addEventListener("scroll", scroll);
  return {
    measure(bounds: { top: number; right: number; height: number; gutter: number }) {
      height = bounds.height;
      const width = Math.max(16, bounds.gutter);
      element.style.top = `${bounds.top}px`;
      element.style.left = `${bounds.right - width}px`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    },
    update(max: number, position: number) {
      const nextExtent = height + max;
      if (nextExtent !== extent) {
        space.style.height = `${nextExtent}px`;
        extent = nextExtent;
      }
      // Avoid a synchronous layout read after every frame's style writes.
      synchronized = Math.round(position);
      element.scrollTop = synchronized;
      element.setAttribute("aria-valuemax", String(max));
      element.setAttribute("aria-valuenow", String(position));
    },
    destroy() {
      element.removeEventListener("scroll", scroll);
      element.remove();
      if (!originalId) parent.removeAttribute("id");
    },
  };
}
