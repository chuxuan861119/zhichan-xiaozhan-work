import { prefersReducedMotion as isMotionReduced } from "./motion-preference";
import { FIXED_MOTION_DURATIONS } from "./spatial-motion";

const CLOSED_CLIP = "inset(-32px -32px 100% -32px)";
const OPEN_CLIP = "inset(-32px -32px -32px -32px)";
export const DROPDOWN_MOTION_TIMING = {
  duration: FIXED_MOTION_DURATIONS.dropdown,
  easing: "ease-in-out",
} as const;
export const DROPDOWN_MOTION_RETENTION_MS = DROPDOWN_MOTION_TIMING.duration + 20;

export function createDropdownMotion() {
  let target: HTMLElement | undefined;
  let animation: Animation | undefined;
  const dispose = () => {
    animation?.cancel();
    animation = undefined;
    target = undefined;
  };
  return {
    update(element: HTMLElement | undefined, open: boolean) {
      const closedClip =
        element &&
        getComputedStyle(element).getPropertyValue?.("--dropdown-open-direction").trim() === "up"
          ? "inset(100% -32px -32px -32px)"
          : CLOSED_CLIP;
      const continuing = element === target && animation !== undefined;
      const current = continuing && element ? getComputedStyle(element) : undefined;
      const from = {
        opacity: current?.opacity ?? (open ? "0" : "1"),
        clipPath:
          current && current.clipPath !== "none"
            ? current.clipPath
            : open && !continuing
              ? closedClip
              : OPEN_CLIP,
      };
      dispose();
      target = element;
      if (!element) return undefined;
      const timing = {
        duration: window.workbenchUi.dropdownDuration(
          element.getBoundingClientRect().height,
          from.clipPath,
          open,
        ),
        easing: "ease-in-out",
      };
      if (
        !element ||
        typeof element.animate !== "function" ||
        document.documentElement.dataset.reducedMotion === "true" ||
        isMotionReduced()
      )
        return timing.duration;
      animation = element.animate(
        open
          ? [
              from,
              { opacity: 1, clipPath: OPEN_CLIP, offset: 0.9999 },
              // Remove clipping at rest so nested menus can extend beyond their parent.
              { opacity: 1, clipPath: "none" },
            ]
          : [from, { opacity: 0, clipPath: closedClip }],
        {
          ...timing,
          fill: "both",
        },
      );
      return timing.duration;
    },
    dispose,
  };
}

export function findDropdownSurface(presence: HTMLElement | null): HTMLElement | undefined {
  for (const child of presence?.children ?? []) {
    if (!(child instanceof HTMLElement)) continue;
    if (
      child.matches(
        '[role="menu"], .color-palette, .custom-color-popup, .insert-table-popover, .dual-document-pane__switcher-popover, .claims-description-menu, .editor-color-picker__palette, .library-selection-actions',
      )
    )
      return child;
    if (child.matches(".flowchart-project-menu-layer"))
      return child.querySelector<HTMLElement>('[role="menu"]') ?? undefined;
  }
  return undefined;
}
