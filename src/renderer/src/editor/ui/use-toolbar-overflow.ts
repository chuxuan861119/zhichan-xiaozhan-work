import { type RefObject, useLayoutEffect, useState } from "react";

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
      const requiredWidth = () => {
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
        return (
          children.reduce((sum, child) => {
            const css = getComputedStyle(child);
            return (
              sum +
              Math.max(child.offsetWidth, child.scrollWidth) +
              (child === more
                ? 0
                : (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0))
            );
          }, 0) +
          Math.max(0, children.length - 1) * (parseFloat(style.columnGap) || 0) +
          (parseFloat(style.paddingLeft) || 0) +
          (parseFloat(style.paddingRight) || 0)
        );
      };
      try {
        if (more) more.style.display = "none";
        if (requiredWidth() > toolbar.clientWidth) {
          if (more) more.style.display = "grid";
          for (const button of collapseOrder) {
            button.dataset.overflowHidden = "true";
            button
              .closest<HTMLElement>(".ai-experimental-entry")
              ?.setAttribute("data-overflow-hidden", "true");
            const label = button.getAttribute("aria-label");
            if (label) hidden.unshift(label);
            syncSeparators();
            if (requiredWidth() <= toolbar.clientWidth) break;
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
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
      window.removeEventListener("resize", measure);
      toolbar.querySelectorAll("[data-overflow-hidden]").forEach((item) => {
        item.removeAttribute("data-overflow-hidden");
      });
    };
  }, [ref, enabled]);
  return overflow;
}
