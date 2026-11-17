import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { DetailViewImage, DetailViewMarks } from "./detail-view-layer";
import { drawingPreviewSource } from "./drawing-preview-source";
import type { DrawingView } from "./fixed-line-preview";

vi.mock("./fragmented-drawing-preview", () => ({
  FragmentedDrawingPreview: ({
    view,
    project,
  }: {
    view: DrawingView;
    project: { width: number; height: number };
  }) => (
    <output
      data-source-view={JSON.stringify(view)}
      data-source-width={project.width}
      data-source-height={project.height}
    />
  ),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("reuses the current detail source but loads its frozen asset after the drawing changes", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const detail = {
    ...project.detailViews![0]!,
    cadSource: {
      version: 1 as const, engine: "cadcraft" as const, engineVersion: "a".repeat(40),
      assetId: crypto.randomUUID(), baseAssetId: project.baseAssetId,
      width: project.width, height: project.height,
      mapping: { originX: 0, originY: 100, scale: 10 },
    },
  };
  const readDrawingSource = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("patentApi", { assets: { readDrawingSource } });
  const props = {
    detail, project, sessionId: "test-session",
    base: { source: drawingPreviewSource(new Uint8Array()), url: "test" },
    view: { x: 0, y: 0, width: 1000, height: 800 },
    left: 0, top: 0, unit: 1, onError: vi.fn(),
  };
  const { container, rerender } = render(<DetailViewImage {...props} />);
  expect(readDrawingSource).not.toHaveBeenCalled();
  expect(container.querySelector("output")).not.toBeNull();
  rerender(<DetailViewImage {...props} project={{ ...project, baseAssetId: crypto.randomUUID() }} />);
  expect(readDrawingSource).toHaveBeenCalledWith("test-session", project.baseAssetId);
  expect(container.querySelector("output")).toBeNull();
});

test("keeps a placed preview visible until the native detail checkpoint is painted", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: project.baseAssetId,
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1,
    objects: [{ id: project.detailViews![0]!.id, kind: "detail", body: ["1"] }],
  };
  const props = {
    project,
    detail: project.detailViews![0]!,
    base: { source: drawingPreviewSource(new Uint8Array()), url: "test" },
    view: { x: 0, y: 0, width: 1000, height: 800 },
    left: 0,
    top: 0,
    unit: 1,
    onError: vi.fn(),
  };
  const { container, rerender } = render(<DetailViewImage {...props} forcePreview />);
  expect(container.querySelector("[data-detail-image]")).not.toBeNull();
  expect(container.querySelector("[data-detail-image]")?.getAttribute("style")).toContain(
    "opacity: 1",
  );
  rerender(<DetailViewImage {...props} />);
  expect(container.querySelector("[data-detail-image]")).toBeNull();
});

test("frozen CAD details retain source dimensions after the live frame grows", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const detail = {
    ...project.detailViews![0]!,
    cadSource: {
      version: 1 as const,
      engine: "cadcraft" as const,
      engineVersion: "a".repeat(40),
      assetId: crypto.randomUUID(),
      baseAssetId: project.baseAssetId,
      width: 1000,
      height: 800,
      mapping: { originX: 0, originY: 100, scale: 10 },
    },
  };
  const { container } = render(
    <DetailViewImage
      detail={detail}
      project={{ ...project, width: 5000, height: 3000 }}
      base={{ source: drawingPreviewSource(new Uint8Array()), url: "test" }}
      view={{ x: 0, y: 0, width: 1000, height: 800 }}
      left={0}
      top={0}
      unit={1}
      onError={vi.fn()}
    />,
  );
  expect(container.querySelector("output")?.getAttribute("data-source-width")).toBe(
    String(1000 * (detail.sourceScale ?? 1)),
  );
  expect(container.querySelector("output")?.getAttribute("data-source-height")).toBe(
    String(800 * (detail.sourceScale ?? 1)),
  );
});

test("renders a detail inside its circle bounds while keeping source coordinates stable on zoom", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const detail = project.detailViews?.[0];
  if (!detail) throw new Error("Detail fixture is missing its first view.");
  const base = { source: drawingPreviewSource(new Uint8Array()), url: "test" };
  const props = { detail, project, base, top: 0, ghost: false, onError: vi.fn() };
  const { container, rerender } = render(
    <DetailViewImage
      {...props}
      view={{ x: 0, y: 0, width: 1000, height: 800 }}
      left={0}
      unit={1}
    />,
  );
  const image = container.querySelector<HTMLElement>("[data-detail-image]");
  if (!image) throw new Error("Detail image was not mounted.");
  const sourceView = () => {
    const value = container.querySelector("output")?.getAttribute("data-source-view");
    if (!value) throw new Error("Detail source view was not provided.");
    return JSON.parse(value);
  };
  const expected = {
    x: detail.source.x - detail.radius,
    y: detail.source.y - detail.radius,
    width: detail.radius * 2,
    height: detail.radius * 2,
  };
  expect(image.style.width).toBe(`${detail.radius * detail.ratio * 2}px`);
  expect(image.style.height).toBe(`${detail.radius * detail.ratio * 2}px`);
  expect(sourceView()).toEqual(expected);

  rerender(
    <DetailViewImage
      {...props}
      view={{ x: 250, y: 0, width: 500, height: 400 }}
      left={250}
      unit={0.5}
    />,
  );
  expect(image.style.width).toBe(`${detail.radius * detail.ratio * 4}px`);
  expect(sourceView()).toEqual(expected);
});

test("detail circles retain black one-pixel strokes at high zoom", () => {
  const detail = drawingProjectFixture("00000000-0000-4000-8000-000000000901").detailViews![0]!;
  const { container } = render(
    <svg role="img" aria-label="局部放大测试">
      <DetailViewMarks detail={detail} selected={false} part="content" unit={0.1} zoom={50} />
    </svg>,
  );
  const rings = [...container.querySelectorAll('circle[stroke="black"]')];
  expect(rings).toHaveLength(2);
  for (const ring of rings)
    expect(Number(ring.getAttribute("stroke-width"))).toBeGreaterThanOrEqual(0.1);
});
