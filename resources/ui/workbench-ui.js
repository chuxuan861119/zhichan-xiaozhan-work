/* Shared paint-only motion for bundled editors. Editing and focus stay immediate. */
(() => {
  const fixedDurations = Object.freeze({
    panel: 400,
    dropdown: 260,
    libraryEditor: 260,
    functionRail: 600,
    windowsContentEdit: 650,
    workspacePhase: 200,
    tableSection: 320,
    tabDragReturn: 200,
    tabDragSettle: 160,
  });
  const panelDuration = fixedDurations.panel;
  const motionDuration = () => panelDuration;
  const dropdownDuration = () => fixedDurations.dropdown;
  const reduced = () =>
    document.documentElement.dataset.reducedMotion === "true" ||
    document.documentElement.dataset.motionDisabled === "true" ||
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const animations = new WeakMap();
  function paint(element, open, menu = false, resumed = null) {
    const previous = animations.get(element);
    const current = resumed || (previous ? getComputedStyle(element) : null);
    const opacity = current?.opacity || (open ? "0" : element.style.opacity || "1");
    const closedClip = "inset(-32px -32px 100% -32px)";
    const openClip = "inset(-32px -32px -32px -32px)";
    const paintedClip = current?.clipPath || element.style.clipPath;
    const fromClip =
      paintedClip && paintedClip !== "none"
        ? paintedClip
        : current && Number(opacity) > 0
          ? openClip
          : open
            ? closedClip
            : openClip;
    previous?.cancel();
    if (reduced() || !element.animate) return;
    const duration = menu
      ? dropdownDuration(element.getBoundingClientRect().height, fromClip, open)
      : panelDuration;
    const frames = menu
      ? open
        ? [
            { opacity, clipPath: fromClip },
            { opacity: 1, clipPath: openClip, offset: 0.9999 },
            { opacity: 1, clipPath: "none" },
          ]
        : [
            { opacity, clipPath: fromClip },
            { opacity: 0, clipPath: closedClip },
          ]
      : [{ opacity }, { opacity: open ? 1 : 0 }];
    const animation = element.animate(frames, { duration, easing: "ease-in-out", fill: "both" });
    animations.set(element, animation);
    animation.onfinish = () => {
      if (animations.get(element) === animation) {
        animations.delete(element);
        if (!open) element.style.opacity = "0";
        animation.cancel();
      }
    };
    return duration;
  }
  function observe({
    selector,
    menuSelector = "[role='menu'],.mxPopupMenu,.contexify,[class*='dropdown']",
  }) {
    const records = new Map();
    let frame = 0;
    let disposed = false;
    const visible = (element) => {
      if (
        !element.isConnected ||
        element.closest("[hidden],.hidden") ||
        [...element.classList].some((name) => name.includes("Dialog-module_hide__"))
      )
        return false;
      if (element.style.opacity === "0") return false;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    };
    const clearGhost = (record) => {
      clearTimeout(record.timer);
      record.ghost?.remove();
      record.ghost = null;
    };
    const exit = (element, record) => {
      clearGhost(record);
      const current =
        animations.has(element) && element.isConnected ? getComputedStyle(element) : null;
      const opacity = current?.opacity || "1";
      const clipPath = current?.clipPath || "none";
      animations.get(element)?.cancel();
      if (reduced() || !record.bounds?.width || !record.bounds?.height) return;
      const ghost = element.cloneNode(true);
      // A retained picture must never load frames, submit forms, or receive input.
      for (const frame of ghost.querySelectorAll("iframe,script")) frame.remove();
      for (const node of [ghost, ...ghost.querySelectorAll("[id]")]) node.removeAttribute("id");
      ghost.removeAttribute("hidden");
      ghost.classList.remove("hidden");
      for (const name of [...ghost.classList]) {
        if (name.includes("Dialog-module_hide__")) ghost.classList.remove(name);
      }
      ghost.dataset.workbenchPaint = "exit";
      ghost.inert = true;
      ghost.setAttribute("aria-hidden", "true");
      const rect = record.bounds;
      Object.assign(ghost.style, {
        position: "fixed",
        inset: "auto",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        maxWidth: "none",
        maxHeight: "none",
        margin: "0",
        transform: "none",
        visibility: "visible",
        display: record.display,
        opacity,
        clipPath,
        pointerEvents: "none",
        zIndex: "20000",
      });
      const context = document.createElement("div");
      context.className = record.parentClass || "";
      context.classList.remove("hidden");
      context.style.setProperty("display", "contents", "important");
      context.appendChild(ghost);
      document.body.appendChild(context);
      record.ghost = context;
      const duration = paint(ghost, false, record.menu) || panelDuration;
      record.timer = setTimeout(() => clearGhost(record), duration + 20);
    };
    const sample = () => {
      frame = 0;
      if (disposed) return;

      for (const [element, record] of records) {
        if (record.visible && visible(element)) {
          record.bounds = element.getBoundingClientRect();
          record.parentClass = element.parentElement?.className || "";
          record.display = getComputedStyle(element).display;
        }
      }
    };
    const scan = () => {
      if (disposed) return;
      for (const element of document.querySelectorAll(selector)) {
        if (element.closest("[data-workbench-paint]") || element.parentElement?.closest(selector))
          continue;
        if (!records.has(element))
          records.set(element, {
            visible: false,
            menu: element.matches(menuSelector),
            ghost: null,
          });
      }
      for (const [element, record] of records) {
        const shown = visible(element);
        if (shown && !record.visible) {
          const exiting = record.ghost?.querySelector('[data-workbench-paint="exit"]');
          const style = exiting ? getComputedStyle(exiting) : null;
          const resumed =
            style && Number(style.opacity) > 0
              ? { opacity: style.opacity, clipPath: style.clipPath }
              : null;
          clearGhost(record);
          record.bounds = element.getBoundingClientRect();
          record.parentClass = element.parentElement?.className || "";
          record.display = getComputedStyle(element).display;
          paint(element, true, record.menu, resumed);
        } else if (!shown && record.visible) exit(element, record);
        record.visible = shown;
        if (!element.isConnected && !record.ghost) records.delete(element);
        if (reduced()) clearGhost(record);
      }
      if (!frame) frame = requestAnimationFrame(sample);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sample);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    const preference = new MutationObserver(scan);
    preference.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion-disabled", "data-reduced-motion"],
    });
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    media?.addEventListener?.("change", scan);
    scan();
    return () => {
      disposed = true;
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
      preference.disconnect();
      cancelAnimationFrame(frame);
      media?.removeEventListener?.("change", scan);
      for (const [element, record] of records) {
        animations.get(element)?.cancel();
        clearGhost(record);
      }
      records.clear();
    };
  }
  const replacements = new WeakMap();
  function replaceContent(element, update, old = element.firstElementChild) {
    const previous = replacements.get(element);
    if (previous) {
      clearTimeout(previous.timer);
      previous.ghost.remove();
    }
    if (old && !reduced() && old.animate) {
      const bounds = old.getBoundingClientRect();
      const opacity = getComputedStyle(old).opacity;
      const ghost = old.cloneNode(true);
      ghost.dataset.workbenchPaint = "exit";
      ghost.inert = true;
      ghost.setAttribute("aria-hidden", "true");
      for (const node of [ghost, ...ghost.querySelectorAll("[id]")]) node.removeAttribute("id");
      Object.assign(ghost.style, {
        position: "fixed",
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        margin: "0",
        pointerEvents: "none",
        zIndex: "70",
        opacity,
      });
      document.body.appendChild(ghost);
      paint(ghost, false);
      const timer = setTimeout(() => {
        ghost.remove();
        replacements.delete(element);
      }, panelDuration + 20);
      replacements.set(element, { ghost, timer });
    }
    update();
    const next = [...element.children].find(
      (child) => !child.hidden && !child.classList.contains("hidden"),
    );
    if (old === element) paint(element, true);
    else if (next) paint(next, true);
  }
  const collapses = new WeakMap();
  function collapse(element, open) {
    element.dataset.workbenchExpanded = String(open);
    const previous = collapses.get(element);
    const overflow = previous?.workbenchOverflow ?? element.style.overflow;
    const opacity = previous ? getComputedStyle(element).opacity : open ? 0 : 1;
    const start = previous
      ? element.getBoundingClientRect().height
      : open
        ? 0
        : element.getBoundingClientRect().height;
    previous?.cancel();
    element.classList.remove("hidden");
    element.inert = !open;
    if (reduced() || !element.animate) {
      element.classList.toggle("hidden", !open);
      element.style.overflow = overflow;
      collapses.delete(element);
      return;
    }
    const targetHeight = open ? element.scrollHeight : 0;
    const duration = motionDuration(targetHeight - start);
    const animation = element.animate(
      [
        { height: `${start}px`, opacity },
        { height: `${targetHeight}px`, opacity: open ? 1 : 0 },
      ],
      { duration, easing: "ease-in-out", fill: "both" },
    );
    animation.workbenchOverflow = overflow;
    element.style.overflow = "hidden";
    collapses.set(element, animation);
    animation.onfinish = () => {
      if (collapses.get(element) !== animation) return;
      element.classList.toggle("hidden", !open);
      element.style.overflow = overflow;
      collapses.delete(element);
      animation.cancel();
    };
  }
  window.workbenchUi = {
    paint,
    observe,
    replaceContent,
    collapse,
    panelDuration,
    prefersReducedMotion: reduced,
    motionDuration,
    dropdownDuration,
    fixedDurations,
  };
})();
