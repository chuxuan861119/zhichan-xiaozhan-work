import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DrawingPoint } from "../../../shared/drawing-markup/model";

/** A live checkpoint is static between commands; keep cursor/preview paints
 * from rasterizing its entire drawing on the interactive SVG's layer. */
export function CadSceneSurface({
  canvas,
  viewBox,
  children,
}: {
  canvas: RefObject<SVGSVGElement | null>;
  viewBox: string;
  children: ReactNode;
}) {
  const surface = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const source = canvas.current;
    const target = surface.current;
    if (!source || !target) return;
    const sync = () => {
      target.setAttribute("viewBox", source.getAttribute("viewBox") ?? viewBox);
      target.style.transform = source.style.transform;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(source, { attributes: true, attributeFilter: ["viewBox", "style"] });
    return () => observer.disconnect();
  }, [canvas, viewBox]);
  return (
    <svg
      ref={surface}
      viewBox={viewBox}
      data-cad-scene-surface="true"
      aria-hidden="true"
      style={{ pointerEvents: "none" }}
    >
      {children}
    </svg>
  );
}

/** Keep a rigid preview on its own compositor layer. SVG group transforms
 * otherwise rasterize every selected stroke again for every pointer sample. */
export function CadAffineSurface({
  children,
  delta,
  rotation,
  reflection,
  enabled,
}: {
  children: ReactNode;
  delta?: DrawingPoint | undefined;
  rotation?: { base: DrawingPoint; angle: number } | undefined;
  reflection?: { base: DrawingPoint; angle: number } | undefined;
  enabled: boolean;
}) {
  const anchor = useRef<SVGGElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const [canvas, setCanvas] = useState<SVGSVGElement | null>(null);
  useLayoutEffect(() => {
    const root = anchor.current?.closest<SVGSVGElement>('svg[role="application"]');
    setCanvas(enabled && root?.parentElement?.classList.contains("drawing-viewport") ? root : null);
  }, [enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Numeric transform values determine the complete observer closure; callers recreate the wrapper objects on pointer frames.
  useLayoutEffect(() => {
    if (!canvas || !overlay.current) return;
    const update = () => {
      const target = overlay.current;
      const matrix = canvas.getScreenCTM();
      const parent = canvas.parentElement;
      if (!target || !matrix || !parent) return;
      target.setAttribute("viewBox", canvas.getAttribute("viewBox") ?? "");
      const rect = parent.getBoundingClientRect();
      let a = 1,
        b = 0,
        c = 0,
        d = 1,
        x = 0,
        y = 0;
      if (delta) {
        x = matrix.a * delta.x + matrix.c * delta.y;
        y = matrix.b * delta.x + matrix.d * delta.y;
      } else if (rotation || reflection) {
        const operation = (rotation ?? reflection)!;
        const angle = (operation.angle * Math.PI) / 180;
        a = d = Math.cos(angle);
        b = Math.sin(angle);
        c = -b;
        if (reflection) {
          d = -a;
          c = b;
        }
        const cx = matrix.a * operation.base.x + matrix.c * operation.base.y + matrix.e - rect.left;
        const cy = matrix.b * operation.base.x + matrix.d * operation.base.y + matrix.f - rect.top;
        x = cx - a * cx - c * cy;
        y = cy - b * cx - d * cy;
      }
      target.style.transform = `matrix(${a},${b},${c},${d},${x},${y}) ${canvas.style.transform}`;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(canvas, { attributes: true, attributeFilter: ["viewBox", "style"] });
    const resize = new ResizeObserver(update);
    resize.observe(canvas);
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  }, [
    canvas,
    delta?.x,
    delta?.y,
    rotation?.angle,
    rotation?.base.x,
    rotation?.base.y,
    reflection?.angle,
    reflection?.base.x,
    reflection?.base.y,
  ]);
  const transform = delta
    ? `translate(${delta.x} ${delta.y})`
    : rotation
      ? `rotate(${rotation.angle} ${rotation.base.x} ${rotation.base.y})`
      : reflection
        ? `translate(${reflection.base.x} ${reflection.base.y}) rotate(${reflection.angle / 2}) scale(1 -1) rotate(${-reflection.angle / 2}) translate(${-reflection.base.x} ${-reflection.base.y})`
        : undefined;
  return (
    <>
      <g ref={anchor}>{!canvas && <g transform={transform}>{children}</g>}</g>
      {canvas?.parentElement &&
        createPortal(
          <svg
            ref={overlay}
            className="cad-gesture-preview"
            data-cad-composited-preview="true"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              overflow: "visible",
              pointerEvents: "none",
              transformOrigin: "0 0",
              willChange: "transform",
            }}
          >
            {children}
          </svg>,
          canvas.parentElement,
        )}
    </>
  );
}
