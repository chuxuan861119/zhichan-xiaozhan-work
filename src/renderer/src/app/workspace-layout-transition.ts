import { prefersReducedMotion } from "../shared/motion-preference";
import { FIXED_MOTION_DURATIONS } from "../shared/spatial-motion";

export type WorkspaceLayoutTransitionDirection =
  | "enter-dual"
  | "enter-columns"
  | "exit-dual"
  | "exit-columns";

export type WorkspaceLayoutTransition = Readonly<{
  cancelled: boolean;
  commit(update: () => void, options?: Readonly<{ retainLayout?: boolean }>): Promise<void>;
  cancel(): void;
}>;

const ROOT_CLASS = "workspace-layout-view-transition";
const DIRECTION_CLASSES: readonly string[] = [
  "workspace-layout-view-transition-enter-dual",
  "workspace-layout-view-transition-enter-columns",
  "workspace-layout-view-transition-exit-dual",
  "workspace-layout-view-transition-exit-columns",
];

let activeTransition: WorkspaceLayoutTransition | null = null;

const RESTING_FRAME = { opacity: 1, transform: "translateY(0)" } as const;

function directionFrames(direction: WorkspaceLayoutTransitionDirection) {
  const entering = direction.startsWith("enter-");
  return {
    leave: [
      RESTING_FRAME,
      {
        opacity: 0,
        transform: entering ? "translateY(-5px)" : "translateY(7px)",
      },
    ],
    enter: [
      {
        opacity: 0,
        transform: entering ? "translateY(7px)" : "translateY(-5px)",
      },
      RESTING_FRAME,
    ],
  } satisfies Record<"leave" | "enter", [Keyframe, Keyframe]>;
}

function clearRootClasses(root: HTMLElement): void {
  root.classList.remove(ROOT_CLASS, ...DIRECTION_CLASSES);
}

export function beginWorkspaceLayoutTransition(
  direction: WorkspaceLayoutTransitionDirection,
): WorkspaceLayoutTransition {
  const initialStage = document.querySelector<HTMLElement>(".app-view-transition-stage");
  const currentStyle = initialStage ? getComputedStyle(initialStage) : null;
  const currentFrame =
    activeTransition && currentStyle
      ? {
          opacity: Number(currentStyle.opacity || 1),
          transform: currentStyle.transform === "none" ? "translateY(0)" : currentStyle.transform,
        }
      : RESTING_FRAME;
  activeTransition?.cancel();
  const root = document.documentElement;
  clearRootClasses(root);
  root.classList.add(ROOT_CLASS, `${ROOT_CLASS}-${direction}`);

  let cancelled = false;
  let committed = false;
  const motionEnabled = !prefersReducedMotion();
  const frames = directionFrames(direction);
  let leaveAnimation =
    motionEnabled && typeof initialStage?.animate === "function"
      ? initialStage.animate([currentFrame, frames.leave[1]], {
          duration: FIXED_MOTION_DURATIONS.workspacePhase,
          easing: "ease-in-out",
          fill: "forwards",
        })
      : null;
  let enterAnimation: Animation | null = null;
  const finish = () => {
    if (activeTransition !== transition) return;
    leaveAnimation?.cancel();
    enterAnimation?.cancel();
    leaveAnimation = null;
    enterAnimation = null;
    activeTransition = null;
    clearRootClasses(root);
  };
  const transition: WorkspaceLayoutTransition = {
    get cancelled() {
      return cancelled;
    },
    async commit(update, options) {
      if (cancelled || committed) return;
      committed = true;
      try {
        if (!options?.retainLayout) await leaveAnimation?.finished?.catch(() => undefined);
        if (cancelled) return;
        update();
        leaveAnimation?.cancel();
        leaveAnimation = null;
        const nextStage = document.querySelector<HTMLElement>(".app-view-transition-stage");
        enterAnimation =
          motionEnabled && typeof nextStage?.animate === "function"
            ? nextStage.animate(
                options?.retainLayout ? [currentFrame, RESTING_FRAME] : frames.enter,
                {
                  duration: FIXED_MOTION_DURATIONS.workspacePhase,
                  easing: "ease-in-out",
                  fill: "forwards",
                },
              )
            : null;
        await enterAnimation?.finished?.catch(() => undefined);
      } finally {
        finish();
      }
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      finish();
    },
  };
  activeTransition = transition;
  return transition;
}
