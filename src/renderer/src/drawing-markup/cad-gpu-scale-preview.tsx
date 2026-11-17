import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cadLabelScreenWidth } from "../../../shared/drawing-markup/cad-label-style";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { createPreviewGpu, previewMesh } from "./cad-preview-gpu";
import { CadPrimitiveBatch } from "./cad-primitive-highlight";
import type { CadScene } from "./cadcraft-client";
import { isMacPlatform } from "../../../shared/platform";
import { macCadMeshCache } from "./mac-cad-mesh-cache";

export function CadGpuScalePreview({
  children,
  scene,
  handles,
  project,
  factor,
  base,
  translation,
}: {
  children: ReactNode;
  scene: CadScene;
  handles: string[];
  project: DrawingProject;
  factor: number;
  base: [number, number];
  translation?: { x: number; y: number } | undefined;
}) {
  const anchor = useRef<SVGGElement>(null),
    surface = useRef<HTMLCanvasElement>(null);
  const [canvas, setCanvas] = useState<SVGSVGElement | null>(null);
  const [active, setActive] = useState(false);
  const [attemptedMesh, setAttemptedMesh] = useState<ReturnType<typeof previewMesh> | null>(null);
  const renderer = useRef<ReturnType<typeof createPreviewGpu> | null>(null);
  const strokeWidth = useMemo(() => {
    const labels = new Set(
      project.cad?.objects?.filter((o) => o.kind === "label").flatMap((o) => o.label ?? []),
    );
    const text = new Set(
      scene.entities.filter((e) => ["Text", "MText"].includes(e.type)).map((e) => e.handle),
    );
    return (p: CadScene["primitives"][number]) =>
      labels.has(p.handle)
        ? text.has(p.handle)
          ? Math.max(0.5, p.lineweight / 0.25)
          : cadLabelScreenWidth(p.lineweight)
        : 1.5;
  }, [project, scene]);
  const mesh = useMemo(() => {
    if (handles.length < 64 || !project.cad?.unified) return null;
    const selected = new Set(handles);
    try {
      const build = () => previewMesh(
        scene.primitives.filter((p) => selected.has(p.handle)),
        strokeWidth,
      );
      if (!isMacPlatform()) return build();
      const labels = project.cad.objects?.filter(o => o.kind === "label").flatMap(o => o.label ?? []) ?? [];
      return macCadMeshCache.get(scene, JSON.stringify([handles, labels]), build);
    } catch {
      return null;
    }
  }, [scene, handles, project, strokeWidth]);
  useLayoutEffect(() => {
    const root = anchor.current?.closest<SVGSVGElement>('svg[role="application"]');
    setCanvas(mesh && root?.parentElement?.classList.contains("drawing-viewport") ? root : null);
    if (isMacPlatform() && !root?.parentElement?.classList.contains("drawing-viewport")) setAttemptedMesh(mesh);
  }, [mesh]);
  useLayoutEffect(() => {
    if (!canvas || !surface.current || !mesh) return;
    const element = surface.current;
    const lost = () => {
      setActive(false);
    };
    element.addEventListener("webglcontextlost", lost);
    try {
      renderer.current = createPreviewGpu(element, mesh);
    } catch {
      renderer.current = null;
      setActive(false);
    }
    if (isMacPlatform()) setAttemptedMesh(mesh);
    return () => {
      element.removeEventListener("webglcontextlost", lost);
      renderer.current?.dispose();
      renderer.current = null;
      setActive(false);
    };
  }, [canvas, mesh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement mesh recreates the renderer and requires an immediate draw even with an unchanged camera.
  useLayoutEffect(() => {
    if (!canvas || !project.cad) return;
    const draw = () => {
      const screen = canvas.getScreenCTM(),
        parent = canvas.parentElement;
      if (!screen || !parent || !renderer.current || !project.cad) return;
      const rect = parent.getBoundingClientRect(),
        m = project.cad.mapping;
      const matrix = new DOMMatrix([1, 0, 0, 1, -rect.left, -rect.top])
        .multiply(screen)
        .multiply(
          new DOMMatrix([m.scale, 0, 0, -m.scale, -m.originX * m.scale, m.originY * m.scale]),
        )
        .multiply(
          new DOMMatrix([factor, 0, 0, factor, base[0] * (1 - factor), base[1] * (1 - factor)]),
        ).translate(translation?.x ?? 0, translation?.y ?? 0);
      setActive(
        renderer.current.draw(matrix, rect.width, rect.height, window.devicePixelRatio || 1),
      );
    };
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(canvas, { attributes: true, attributeFilter: ["viewBox", "style"] });
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  }, [canvas, mesh, factor, base[0], base[1], project, translation?.x, translation?.y]);
  return (
    <>
      <g ref={anchor}>
        {/* On Mac, try the layout-phase GPU draw before constructing a dense SVG
            fallback. Failure/context loss still paints the complete fallback. */}
        {!active && (!isMacPlatform() || !mesh || attemptedMesh === mesh) && children}
      </g>
      {active && mesh && project.cad && (
        <g
          data-cad-gpu-fallback={mesh.fallback.length}
          transform={`matrix(${project.cad.mapping.scale} 0 0 ${-project.cad.mapping.scale} ${-project.cad.mapping.originX * project.cad.mapping.scale} ${project.cad.mapping.originY * project.cad.mapping.scale})`}
        >
          <g
            transform={`translate(${base.join(" ")}) scale(${factor}) translate(${-base[0] + (translation?.x ?? 0)} ${-base[1] + (translation?.y ?? 0)})`}
          >
            <CadPrimitiveBatch primitives={mesh.fallback} strokeWidth={strokeWidth} />
          </g>
        </g>
      )}
      {canvas?.parentElement &&
        createPortal(
          <canvas
            ref={surface}
            data-cad-gpu-preview="scale"
            data-cad-affine-preview={active ? "true" : undefined}
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              visibility: active ? "visible" : "hidden",
            }}
          />,
          canvas.parentElement,
        )}
    </>
  );
}
