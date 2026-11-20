import { Component, type RefObject } from "react";
import { UI_MOTION_DURATION_MS, UI_MOTION_EASING } from "../app/ui-motion";
import type { DesignWorkflowStep } from "./design-workflow";

type Props = {
  root: RefObject<HTMLElement | null>;
  step: DesignWorkflowStep;
  compact: boolean;
  enabled: boolean;
  reducedMotion: boolean;
};
type Snapshot = { bounds: DOMRect; backgroundColor: string; color: string; focused: boolean };

/** Capture the visible control before React hides it, including its in-flight position. */
export class DesignStepMotion extends Component<Props, object, Snapshot | null> {
  private animation: Animation | undefined;

  private anchor(compact: boolean) {
    return this.props.root.current?.querySelector<HTMLElement>(
      compact
        ? ".klecks-panels__workflow"
        : '.design-workspace-shell__steps [aria-selected="true"]',
    );
  }

  override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (!this.props.enabled || previous.step === this.props.step) return null;
    if (previous.compact === this.props.compact && !this.animation) return null;
    const source = this.anchor(previous.compact);
    const style = source && getComputedStyle(source);
    return source && style
      ? {
          bounds: source.getBoundingClientRect(),
          backgroundColor: style.backgroundColor,
          color: style.color,
          focused: source === source.ownerDocument.activeElement,
        }
      : null;
  }

  override componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    if (!snapshot) return;
    this.animation?.cancel();
    this.animation = undefined;
    const target = this.anchor(this.props.compact);
    if (!target) return;
    if (snapshot.focused) target.focus({ preventScroll: true });
    if (this.props.reducedMotion || typeof target.animate !== "function") return;
    const from = snapshot.bounds;
    const to = target.getBoundingClientRect();
    if (!from.width || !from.height || !to.width || !to.height) return;
    const style = getComputedStyle(target);
    const animation = target.animate(
      [
        {
          transformOrigin: "top left",
          zIndex: 46,
          backgroundColor: snapshot.backgroundColor,
          color: snapshot.color,
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        {
          transformOrigin: "top left",
          transform: "none",
          backgroundColor: style.backgroundColor,
          color: style.color,
          zIndex: 46,
        },
      ],
      { duration: UI_MOTION_DURATION_MS, easing: UI_MOTION_EASING },
    );
    this.animation = animation;
    animation.onfinish = () => {
      if (this.animation === animation) this.animation = undefined;
    };
  }

  override componentWillUnmount() {
    this.animation?.cancel();
  }

  override render() {
    return null;
  }
}
