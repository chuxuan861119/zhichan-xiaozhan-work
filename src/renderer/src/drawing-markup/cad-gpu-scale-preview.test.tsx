import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { CadGpuScalePreview } from "./cad-gpu-scale-preview";
import type { CadScene } from "./cadcraft-client";

const gpu = vi.hoisted(() => ({ draw: vi.fn(() => true), dispose: vi.fn() }));
vi.mock("./cad-preview-gpu", () => ({
  previewMesh: () => ({ vertices: new Float32Array(), origin: [0, 0], fallback: [] }),
  createPreviewGpu: () => gpu,
}));
const scene = { entities: [], primitives: [] } as unknown as CadScene;
const project = {
  ...drawingProjectFixture("base"),
  cad: {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "test",
    assetId: "cad",
    unified: 1 as const,
    mapping: { originX: 0, originY: 0, scale: 1 },
    objects: [],
  },
};
const handles = Array.from({ length: 64 }, (_, i) => String(i));
beforeEach(() => {
  gpu.draw.mockReset().mockReturnValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "DOMMatrix",
    class {
      multiply() {
        return this;
      }
      translate() {
        return this;
      }
    },
  );
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (SVGSVGElement.prototype as unknown as { getScreenCTM?: unknown }).getScreenCTM;
});

function mount(platform: string) {
  vi.stubGlobal("documentFontPlatform", platform);
  const fallback = vi.fn(() => <g data-full-fallback="true" />);
  const Fallback = fallback;
  const result = render(
    <div className="drawing-viewport">
      <svg role="application">
        <CadGpuScalePreview
          scene={scene}
          handles={handles}
          project={project}
          factor={1}
          base={[0, 0]}
        >
          <Fallback />
        </CadGpuScalePreview>
      </svg>
    </div>,
  );
  return { ...result, fallback };
}

test("Mac avoids constructing the dense fallback before a successful GPU draw", () => {
  const { container, fallback } = mount("MacIntel");
  expect(gpu.draw).toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
  expect(
    container.querySelector("[data-cad-gpu-preview]")?.getAttribute("data-cad-affine-preview"),
  ).toBe("true");
});

test("Mac displays all fallback content if GPU initialization cannot draw", () => {
  gpu.draw.mockReturnValue(false);
  const { container } = mount("MacIntel");
  expect(container.querySelector("[data-full-fallback]")).not.toBeNull();
});

test("Mac restores all fallback content immediately on context loss", () => {
  const { container, fallback } = mount("MacIntel");
  act(() => container.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost")));
  expect(fallback).toHaveBeenCalled();
  expect(container.querySelector("[data-full-fallback]")).not.toBeNull();
});

test("Windows retains its existing initial fallback behavior", () => {
  const { fallback } = mount("Win32");
  expect(fallback).toHaveBeenCalled();
});
