import { type ReactNode, useLayoutEffect, useRef } from "react";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";

/** Preserve the iframe browsing context and canvas history when changing layout. */
export function PersistentWorkspace({
  children,
  hostKey,
  visible,
  className,
  onActivate,
  readOnly = false,
}: {
  readOnly?: boolean;
  onActivate?(): void;
  children: ReactNode;
  hostKey: string | null;
  visible: boolean;
  className: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useSpatialViewMotion(root, `${visible}:${hostKey}`);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const target = hostKey
      ? [...document.querySelectorAll<HTMLElement>("[data-workspace-tool-host]")].find(
          (node) => node.dataset.workspaceToolHost === hostKey,
        )
      : null;
    if (!target) {
      element.removeAttribute("style");
      return;
    }
    const measure = () => {
      const frame = target.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      const scaleX = parent.width / element.parentElement!.clientWidth || 1;
      const scaleY = parent.height / element.parentElement!.clientHeight || 1;
      Object.assign(element.style, {
        position: "absolute",
        left: `${(frame.left - parent.left) / scaleX}px`,
        top: `${(frame.top - parent.top) / scaleY}px`,
        width: `${frame.width / scaleX}px`,
        height: `${frame.height / scaleY}px`,
        zIndex: "1",
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    observer.observe(element.parentElement!);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  return (
    <div
      ref={root}
      className={className}
      hidden={!visible}
      inert={readOnly || undefined}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      {children}
    </div>
  );
}
