import { Component, createRef, type ReactNode } from "react";
import { prefersReducedMotion } from "../shared/motion-preference";
import { SPATIAL_MOTION_RETENTION_MS, spatialMotionTiming } from "../shared/spatial-motion";

type Props = Readonly<{ viewKey: string; children: ReactNode }>;
type Paint = { element: HTMLElement; scroll: Array<[Element, number, number]> };

/** Keep outgoing paint until the new editor is visible, without retaining a second live editor. */
export class TemplateViewTransition extends Component<Props> {
  private content = createRef<HTMLDivElement>();
  private overlay = createRef<HTMLDivElement>();
  private animations: Animation[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  override getSnapshotBeforeUpdate(previous: Props): Paint | null {
    const content = this.content.current;
    if (
      previous.viewKey === this.props.viewKey ||
      !content ||
      prefersReducedMotion() ||
      typeof content.animate !== "function"
    )
      return null;
    const element = content.cloneNode(true) as HTMLElement;
    const source = [content, ...content.querySelectorAll("*")];
    const copied = [element, ...element.querySelectorAll("*")];
    const scroll: Paint["scroll"] = [];
    source.forEach((node, index) => {
      const clone = copied[index];
      if (!clone) return;
      clone.removeAttribute("id");
      if (clone.hasAttribute("contenteditable")) clone.setAttribute("contenteditable", "false");
      if (node.scrollTop || node.scrollLeft) scroll.push([clone, node.scrollTop, node.scrollLeft]);
    });
    for (const embedded of element.querySelectorAll("iframe,script")) embedded.remove();
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
    return { element, scroll };
  }

  override componentDidUpdate(previous: Props, _state: unknown, snapshot: Paint | null) {
    if (previous.viewKey === this.props.viewKey) return;
    this.clear();
    const content = this.content.current;
    const overlay = this.overlay.current;
    if (!snapshot || !content || !overlay) return;
    overlay.append(snapshot.element);
    for (const [element, top, left] of snapshot.scroll) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    this.animations = [
      snapshot.element.animate(
        [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(-6px)" },
        ],
        { ...spatialMotionTiming(6), fill: "forwards" },
      ),
      // The new paper stays opaque beneath the old paint; fading both exposes a blank viewport.
      content.animate(
        [{ transform: "translateY(6px)" }, { transform: "translateY(0)" }],
        spatialMotionTiming(6),
      ),
    ];
    this.timer = setTimeout(() => this.clear(), SPATIAL_MOTION_RETENTION_MS);
  }

  override componentWillUnmount() {
    this.clear();
  }

  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.overlay.current?.replaceChildren();
  }

  override render() {
    return (
      <div
        className="template-view-transition"
        style={{ position: "relative", height: "100%", minHeight: 0, overflow: "hidden" }}
      >
        <div
          ref={this.content}
          className="template-view-transition__content"
          style={{ height: "100%", minHeight: 0 }}
        >
          {this.props.children}
        </div>
        <div
          ref={this.overlay}
          className="template-view-transition__outgoing"
          aria-hidden="true"
          inert
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
      </div>
    );
  }
}
