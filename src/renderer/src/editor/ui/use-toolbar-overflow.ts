import { type RefObject, useLayoutEffect, useState } from "react";
import { isTabletPortrait } from "../../shared/use-tablet-portrait";

/** Collapse a suffix without moving controls or touching editor DOM. */
export function useToolbarOverflow(ref: RefObject<HTMLElement | null>, enabled: boolean): string[] {
  const [overflow, setOverflow] = useState<string[]>([]);
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar) return;
    const measure = () => {
      toolbar.querySelectorAll("[data-overflow-hidden]").forEach((item) => {
        item.removeAttribute("data-overflow-hidden");
      });
      if (!enabled || !toolbar.clientWidth) {
        setOverflow((previous) => (previous.length ? [] : previous));
        return;
      }
      const groups = [
        ...toolbar.querySelectorAll<HTMLElement>(
          ".tool-group.optional-tools, .diagram-entry-group",
        ),
      ];
      const buttons = groups.flatMap((group) => [
        ...group.querySelectorAll<HTMLButtonElement>(
          "button[aria-label]:not(.ai-experimental-badge)",
        ),
      ]);
      // Keep a fixed prefix: selection and command availability must not move
      // controls between the toolbar and the more menu.
      const collapseOrder = [...buttons].reverse();
      const more = toolbar.querySelector<HTMLElement>(".more-tools");
      const hidden: string[] = [];
      const syncSeparators = () => {
        for (const group of groups) {
          const children = [...group.children] as HTMLElement[];
          const isVisibleButton = (child: HTMLElement) =>
            (child.tagName === "BUTTON" || child.classList.contains("ai-experimental-entry")) &&
            !child.hasAttribute("data-overflow-hidden");
          const empty = !children.some(isVisibleButton);
          group.toggleAttribute("data-overflow-hidden", empty);
          const separator = group.previousElementSibling;
          if (separator?.classList.contains("tool-separator"))
            separator.toggleAttribute("data-overflow-hidden", empty);
          children
            .filter((child) => child.classList.contains("tool-separator"))
            .forEach((separator) => {
              separator.toggleAttribute(
                "data-overflow-hidden",
                !children.slice(children.indexOf(separator) + 1).some(isVisibleButton),
              );
            });
        }
      };
      const fitsToolbar = () => {
        const style = getComputedStyle(toolbar);
        const layoutItems = (parent: Element): HTMLElement[] =>
          [...parent.children].flatMap((child) => {
            if (!(child instanceof HTMLElement) || child.hidden) return [];
            const css = getComputedStyle(child);
            if (css.display === "none" || css.position === "absolute" || css.position === "fixed")
              return [];
            return css.display === "contents" ? layoutItems(child) : [child];
          });
        const children = layoutItems(toolbar);
        const widths = children.map((child) => {
          const css = getComputedStyle(child);
          return (
            Math.max(child.offsetWidth, child.scrollWidth) +
            (child === more
              ? 0
              : (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0))
          );
        });
        const gap = parseFloat(style.columnGap) || 0;
        const available =
          toolbar.clientWidth -
          (parseFloat(style.paddingLeft) || 0) -
          (parseFloat(style.paddingRight) || 0);
        if (!isTabletPortrait())
          return (
            widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap <=
            available
          );
        let rows = 1,
          used = 0;
        for (const width of widths) {
          if (width > available) return false;
          if (used > 0 && used + gap + width > available) {
            rows++;
            used = width;
          } else used += (used > 0 ? gap : 0) + width;
        }
        return rows <= 2;
      };
      try {
        if (more) more.style.display = "none";
        if (!fitsToolbar()) {
          if (more) more.style.display = "grid";
          for (const button of collapseOrder) {
            button.dataset.overflowHidden = "true";
            button
              .closest<HTMLElement>(".ai-experimental-entry")
              ?.setAttribute("data-overflow-hidden", "true");
            const label = button.getAttribute("aria-label");
            if (label) hidden.unshift(label);
            syncSeparators();
            if (fitsToolbar()) break;
          }
        }
        setOverflow((previous) => (previous.join("\0") === hidden.join("\0") ? previous : hidden));
      } finally {
        if (more) more.style.removeProperty("display");
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    const mutations = new MutationObserver(measure);
    mutations.observe(toolbar, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    document.fonts?.addEventListener("loadingdone", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("workbench-tablet-metrics", measure);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("workbench-tablet-metrics", measure);
      toolbar.querySelectorAll("[data-overflow-hidden]").forEach((item) => {
        item.removeAttribute("data-overflow-hidden");
      });
    };
  }, [ref, enabled]);
  return overflow;
}
