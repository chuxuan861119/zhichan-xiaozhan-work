import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { UI_MOTION_DURATION_MS, UI_MOTION_EASING } from "../../app/ui-motion";

/** Folding changes presentation only: mounted fields keep their local feedback and saved drafts. */
export function BriefDisclosure({
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  expanded: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !content.current) return;
    const from = element.getBoundingClientRect().height;
    animation.current?.cancel();
    animation.current = null;
    const to = expanded ? content.current.scrollHeight : 0;
    element.style.height = expanded ? "auto" : "0px";
    if (
      mounted.current &&
      typeof element.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      const active = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: UI_MOTION_DURATION_MS,
        easing: UI_MOTION_EASING,
      });
      animation.current = active;
      void active.finished
        .then(() => {
          if (animation.current === active) animation.current = null;
        })
        .catch(() => {});
    }
    mounted.current = true;
  }, [expanded]);
  useLayoutEffect(
    () => () => {
      animation.current?.cancel();
    },
    [],
  );
  return (
    <section className="design-patent-workbench__collapsible-section design-brief-disclosure">
      <button
        type="button"
        aria-label={title}
        aria-expanded={expanded}
        aria-controls={id}
        aria-describedby={`${id}-summary`}
        onClick={onToggle}
      >
        <span>{title}</span>
        <span id={`${id}-summary`} className="design-brief-disclosure__status">
          {summary}
        </span>
        <span className="design-brief-disclosure__action" aria-hidden="true">
          {expanded ? "收起" : "展开"}
        </span>
      </button>
      <div
        id={id}
        ref={body}
        className="design-brief-disclosure__body"
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded || undefined}
      >
        <div ref={content} className="design-brief-disclosure__clip">
          <div className="design-brief-disclosure__fields">{children}</div>
        </div>
      </div>
    </section>
  );
}
