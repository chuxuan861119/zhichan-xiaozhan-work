import { useLayoutEffect, useRef } from "react";

export function useAssistantPanelBounds(dual: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = ref.current;
    if (!shell || !dual) return;
    const bodies = [...shell.querySelectorAll<HTMLElement>(".dual-document-pane__body")];
    const status = shell.querySelector<HTMLElement>(".status-bar");
    const measure = () => {
      const bounds = bodies
        .map((body) => body.getBoundingClientRect())
        .filter((rect) => rect.height > 0);
      if (!bounds.length) return;
      shell.style.setProperty(
        "--assistant-panel-top",
        `${Math.max(...bounds.map((rect) => rect.top)) + 16}px`,
      );
      const bottom = status?.getBoundingClientRect().top;
      if (bottom && bottom > 0) {
        shell.style.setProperty(
          "--assistant-panel-bottom",
          `${Math.max(0, window.innerHeight - bottom) + 16}px`,
        );
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of [shell, ...bodies, status].filter(
      (element): element is HTMLElement => !!element,
    ))
      observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      shell.style.removeProperty("--assistant-panel-top");
      shell.style.removeProperty("--assistant-panel-bottom");
    };
  });
  return ref;
}
