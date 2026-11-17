import { prefersReducedMotion } from "../shared/motion-preference";
import { workspaceMotionTiming } from "../shared/spatial-motion";

const DOCUMENT_STRUCTURE_RULER_ENTRY_KEYFRAMES = [
  { transform: "translateX(calc(100% + var(--document-structure-ruler-gap)))" },
  { transform: "translateX(0)" },
];

const activeRulerEntryAnimations = new WeakMap<HTMLElement, Animation>();

function motionDisabled(): boolean {
  return prefersReducedMotion() || document.documentElement.dataset.reducedMotion === "true";
}

export function animateDocumentStructureRulerEntry(
  ruler: HTMLElement | null | undefined,
): Animation | undefined {
  if (!ruler || typeof ruler.animate !== "function" || motionDisabled()) return undefined;
  activeRulerEntryAnimations.get(ruler)?.cancel();
  ruler.dataset.entryMotion = "true";
  const animation = ruler.animate(
    DOCUMENT_STRUCTURE_RULER_ENTRY_KEYFRAMES,
    workspaceMotionTiming(ruler),
  );
  activeRulerEntryAnimations.set(ruler, animation);
  const finish = () => {
    if (activeRulerEntryAnimations.get(ruler) !== animation) return;
    activeRulerEntryAnimations.delete(ruler);
    delete ruler.dataset.entryMotion;
  };
  animation.addEventListener?.("finish", finish, { once: true });
  animation.addEventListener?.("cancel", finish, { once: true });
  return animation;
}

export function animateVisibleDocumentStructureRulerEntries(
  root: ParentNode = document,
): Animation[] {
  if (motionDisabled()) return [];
  return visibleDocumentStructureRulers(root).flatMap((ruler) => {
    const animation = animateDocumentStructureRulerEntry(ruler);
    return animation ? [animation] : [];
  });
}

export function visibleDocumentStructureRulers(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".document-structure-ruler")].filter(
    (ruler) =>
      !ruler.closest('[hidden], [inert], .patent-book-transition-surface[data-active="false"]'),
  );
}
