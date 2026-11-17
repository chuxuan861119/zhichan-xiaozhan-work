// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { baseFragments, rotateBase } from "../../../shared/drawing-markup/base-fragments";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { DetailViewImage } from "./detail-view-layer";
import { drawingPreviewSource } from "./drawing-preview-source";
import { FragmentedDrawingPreview } from "./fragmented-drawing-preview";
import type { DrawingPreviewProps } from "./vector-drawing-preview";

const calls = vi.hoisted(() => ({ mount: vi.fn(), paint: vi.fn(), props: [] as number[] }));
vi.mock("./vector-drawing-preview", () => ({
  VectorDrawingPreview: (p: DrawingPreviewProps) => {
    calls.props.push(p.strokeScale ?? 0);
    const callback = useRef(p.onPainted);
    callback.current = p.onPainted;
    useLayoutEffect(() => {
      calls.mount();
    }, []);
    useLayoutEffect(() => {
      calls.paint(p.view);
      callback.current(p.view);
    }, [p.view]);
    return <img alt="retained vector" />;
  },
}));
afterEach(() => {
  cleanup();
  calls.props.length = 0;
  vi.unstubAllGlobals();
});
it("keeps an unchanged CAD fragment painted while only annotations change", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 1000, height: 800 } }]);
      }
      disconnect() {}
    },
  );
  const project = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000901"),
    sourceKind: "dwg" as const,
  };
  const props = {
    project,
    fragments: baseFragments(project),
    base: { source: drawingPreviewSource(new Uint8Array()), url: "test" },
    view: { x: 0, y: 0, width: 1000, height: 800 },
    onError: vi.fn(),
  };
  const { rerender } = render(<FragmentedDrawingPreview {...props} />);
  await act(async () => {});
  const renders = calls.props.length;
  rerender(
    <FragmentedDrawingPreview
      {...props}
      project={{
        ...project,
        annotations: project.annotations.map((annotation) => ({ ...annotation, text: "13" })),
      }}
    />,
  );
  expect(calls.props).toHaveLength(renders);
});
it("retains the original vector and selected source viewport throughout rotation", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 1000, height: 800 } }]);
      }
      disconnect() {}
    },
  );
  calls.mount.mockClear();
  calls.paint.mockClear();
  const project = { width: 1000, height: 800, sourceKind: "dwg", pageNumber: 1 } as DrawingProject;
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const base = { source: drawingPreviewSource(new Uint8Array()), url: "test" };
  const selection = [
    { x: 100, y: 100 },
    { x: 400, y: 100 },
    { x: 400, y: 400 },
    { x: 100, y: 400 },
  ];
  const props = { project, view, base, onError: vi.fn() };
  const { container, rerender } = render(
    <FragmentedDrawingPreview {...props} fragments={baseFragments(project)} />,
  );
  const original = container.querySelector("img");
  await act(async () =>
    rerender(
      <FragmentedDrawingPreview
        {...props}
        fragments={rotateBase(project, selection, { x: 250, y: 250 }, 1, "rotation")}
      />,
    ),
  );
  const paints = calls.paint.mock.calls.length;
  for (const angle of [20, 45, 90, 135, -45]) {
    await act(async () =>
      rerender(
        <FragmentedDrawingPreview
          {...props}
          fragments={rotateBase(project, selection, { x: 250, y: 250 }, angle, "rotation")}
        />,
      ),
    );
  }
  expect(original?.isConnected).toBe(true);
  expect(calls.mount).toHaveBeenCalledTimes(2);
  expect(calls.paint).toHaveBeenCalledTimes(paints);
  const closeView = { x: 245, y: 245, width: 10, height: 8 };
  await act(async () =>
    rerender(
      <FragmentedDrawingPreview
        {...props}
        view={closeView}
        interactiveTransform
        fragments={rotateBase(project, selection, { x: 250, y: 250 }, 1, "rotation")}
      />,
    ),
  );
  const closePaints = calls.paint.mock.calls.length;
  await act(async () =>
    rerender(
      <FragmentedDrawingPreview
        {...props}
        view={closeView}
        interactiveTransform
        fragments={rotateBase(project, selection, { x: 250, y: 250 }, 90, "rotation")}
      />,
    ),
  );
  expect(calls.paint).toHaveBeenCalledTimes(closePaints);
  await act(async () =>
    rerender(
      <FragmentedDrawingPreview
        {...props}
        view={closeView}
        fragments={rotateBase(project, selection, { x: 250, y: 250 }, 90, "rotation")}
      />,
    ),
  );
  // Both fragments replace their old full-source frames with bounded high-zoom tiles.
  expect(calls.paint).toHaveBeenCalledTimes(closePaints + 2);
});

it("updates the CAD viewport synchronously without a second scale transform", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 1000, height: 800 } }]);
      }
      disconnect() {}
    },
  );
  const project = { width: 1000, height: 800, sourceKind: "dwg", pageNumber: 1 } as DrawingProject;
  const base = { source: drawingPreviewSource(new Uint8Array()), url: "test" };
  const props = {
    project,
    base,
    fragments: baseFragments(project),
    onError: vi.fn(),
  };
  const { container, rerender } = render(
    <FragmentedDrawingPreview {...props} view={{ x: 0, y: 0, width: 1000, height: 800 }} />,
  );
  await act(async () => {});
  const inner = container.querySelector("[data-base-fragment] > div > div") as HTMLDivElement;
  const initialWidth = inner.style.width;
  rerender(
    <FragmentedDrawingPreview {...props} view={{ x: 250, y: 200, width: 500, height: 400 }} />,
  );
  expect(parseFloat(inner.style.width)).toBe(parseFloat(initialWidth) * 2);
  expect(inner.style.transform).toContain("scale(1)");
});

it("generates detail vectors at the enlarged display scale", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 1000, height: 800 } }]);
      }
      disconnect() {}
    },
  );
  const project = { width: 1000, height: 800, sourceKind: "dwg", pageNumber: 1 } as DrawingProject;
  const base = { source: drawingPreviewSource(new Uint8Array()), url: "test" };
  const props = { project, base, fragments: baseFragments(project), onError: vi.fn() };
  render(
    <FragmentedDrawingPreview {...props} view={{ x: 400, y: 320, width: 200, height: 160 }} />,
  );
  await act(async () => {});
  expect(calls.props.at(-1)).toBeCloseTo(5, 4);
});

it("renders sub-unit source viewports used by deeply zoomed details", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 1000, height: 800 } }]);
      }
      disconnect() {}
    },
  );
  const project = { width: 1000, height: 800, sourceKind: "dwg", pageNumber: 1 } as DrawingProject;
  expect(() =>
    render(
      <FragmentedDrawingPreview
        project={project}
        base={{ source: drawingPreviewSource(new Uint8Array()), url: "test" }}
        fragments={baseFragments(project)}
        view={{ x: 499.9, y: 399.9, width: 0.2, height: 0.16 }}
        onError={vi.fn()}
      />,
    ),
  ).not.toThrow();
});

it("keeps a detail source landmark centered when zoom outpaces resize measurements", () => {
  const callbacks: ((entries: unknown[]) => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: unknown[]) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const detail = project.detailViews?.[0];
  if (!detail) throw Error("Detail fixture missing");
  const props = {
    project,
    detail,
    base: { source: drawingPreviewSource(new Uint8Array()), url: "test" },
    onError: vi.fn(),
  };
  const { container, rerender } = render(
    <DetailViewImage
      {...props}
      view={{ x: 0, y: 0, width: 1000, height: 800 }}
      left={0}
      top={0}
      unit={1}
    />,
  );
  const diameter = detail.radius * detail.ratio * 2;
  act(() =>
    callbacks.forEach((callback) => {
      callback([{ contentRect: { width: diameter, height: diameter } }]);
    }),
  );
  const assertLandmark = (left: number, top: number, unit: number) => {
    const outer = container.querySelector<HTMLElement>("[data-detail-image]");
    const frame = outer?.querySelector<HTMLElement>('[data-base-fragment="original"] > div > div');
    const image = frame?.querySelector<HTMLElement>("img");
    if (!outer || !frame || !image) throw Error("Detail image missing");
    const scale = Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    const x =
      (parseFloat(outer.style.left) || 0) +
      parseFloat(frame.style.left) +
      (parseFloat(image.style.left) +
        (detail.source.x / project.width) * parseFloat(image.style.width)) *
        scale;
    const y =
      (parseFloat(outer.style.top) || 0) +
      parseFloat(frame.style.top) +
      (parseFloat(image.style.top) +
        (detail.source.y / project.height) * parseFloat(image.style.height)) *
        scale;
    expect(x).toBeCloseTo((detail.center.x - left) / unit, 6);
    expect(y).toBeCloseTo((detail.center.y - top) / unit, 6);
  };
  assertLandmark(0, 0, 1);
  // Cross the circle/viewport surface boundary in both directions, including a frame rebase.
  for (const unit of [0.95, 0.8, 0.5, 0.18, 0.17, 0.001, 0.17, 0.18, 0.75, 1, 1.1]) {
    rerender(
      <DetailViewImage
        {...props}
        view={{ x: 200, y: 80, width: 1000 * unit, height: 800 * unit }}
        left={200}
        top={80}
        unit={unit}
      />,
    );
    assertLandmark(200, 80, unit);
    act(() =>
      callbacks.forEach((callback) => {
        callback([{ contentRect: { width: diameter / unit, height: diameter / unit } }]);
      }),
    );
    assertLandmark(200, 80, unit);
  }
});

it("updates PDF pixel density during zoom without scaling fixed-width strokes", () => {
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect() {}
    },
  );
  calls.paint.mockClear();
  const project = {
    ...drawingProjectFixture("00000000-0000-4000-8000-000000000901"),
    sourceKind: "pdf" as const,
  };
  const props = {
    project,
    fragments: baseFragments(project),
    base: { source: drawingPreviewSource(new Uint8Array()), url: "test" },
    view: { x: 260, y: 260, width: 80, height: 80 },
    onError: vi.fn(),
  };
  const { container, rerender } = render(
    <FragmentedDrawingPreview {...props} viewportSize={{ width: 160, height: 160 }} />,
  );
  const frame = container.querySelector<HTMLElement>('[data-base-fragment="original"] > div > div');
  if (!frame) throw Error("PDF frame missing");
  const width = frame.style.width;
  const paints = calls.paint.mock.calls.length;
  for (const size of [180, 200, 180, 160]) {
    rerender(<FragmentedDrawingPreview {...props} viewportSize={{ width: size, height: size }} />);
    expect(parseFloat(frame.style.width)).toBe(parseFloat(width) * size / 160);
    expect(frame.style.transform).toContain("scale(1)");
  }
  expect(observe).not.toHaveBeenCalled();
  expect(calls.paint).toHaveBeenCalledTimes(paints);
  rerender(<FragmentedDrawingPreview {...props} viewportSize={{ width: 800, height: 800 }} />);
  expect(parseFloat(frame.style.width)).toBe(parseFloat(width) * 5);
  expect(frame.style.transform).toContain("scale(1)");
});
