import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CadDrawingPreview } from "./cad-drawing-preview";
import { sharedCadSvgPreviewClient } from "./cad-svg-preview-client";
import { drawingPreviewSource } from "./drawing-preview-source";
import { cadRasterSize, type DrawingView, MAX_CAD_PREVIEW_PIXELS } from "./fixed-line-preview";

const captured = vi.hoisted(() => ({ svg: "" }));
vi.mock("./render", () => ({
  imageUrl: vi.fn((bytes: Uint8Array) => {
    captured.svg = new TextDecoder().decode(bytes);
    return `blob:test-${Math.random()}`;
  }),
}));
let bytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800"><path d="M0 0L1000 800" stroke="black"/></svg>',
);
const view: DrawingView = { x: 0, y: 0, width: 1080, height: 864 };
let resize: (entries: unknown[]) => void;
let decode: ReturnType<typeof vi.fn>;
let createdImages: Array<{ src: string }>;
function setup() {
  bytes = bytes.slice();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resize) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  decode = vi.fn(() => Promise.resolve());
  createdImages = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;

      constructor() {
        createdImages.push(this);
      }
    },
  );
  vi.stubGlobal("URL", { revokeObjectURL: vi.fn() });
}
async function measure(width: number, height: number) {
  await act(async () => resize([{ contentRect: { width, height } }]));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("builds an uncached CAD preview through the background SVG client", async () => {
  setup();
  const prepare = vi.spyOn(sharedCadSvgPreviewClient, "prepare").mockResolvedValue({
    supportsScreenStrokes: true,
  });
  const renderSvg = vi
    .spyOn(sharedCadSvgPreviewClient, "render")
    .mockResolvedValue(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
    );
  render(<Preview />);
  await measure(900, 700);
  expect(prepare).toHaveBeenCalled();
  expect(renderSvg).toHaveBeenCalled();
  expect(screen.getByAltText("图纸底图")).toBeTruthy();
});

it("renders a high-zoom local SVG at screen resolution instead of source-unit resolution", () => {
  const raster = cadRasterSize({ x: 0, y: 0, width: 4, height: 3 }, 900, 2);
  expect(raster.width).toBeLessThanOrEqual(4096);
  expect(raster.height).toBeLessThanOrEqual(4096);
  expect(raster.width * raster.height).toBeLessThanOrEqual(MAX_CAD_PREVIEW_PIXELS);
  expect(cadRasterSize({ x: 0, y: 0, width: 2, height: 1 }, 500, 1)).toEqual({
    width: 1000,
    height: 500,
  });
});

it("does not force a full-window raster when the actual viewport needs fewer pixels", async () => {
  setup();
  render(<Preview />);
  await measure(900, 700);
  expect(captured.svg).toMatch(/width="811"/u);
  expect(captured.svg).not.toMatch(/width="1800"/u);
});

it("uses a local high zoom viewport and reuses it for nearby panning", async () => {
  setup();
  const camera = { x: 500.25, y: 400, width: 1.08, height: 0.864 };
  const { container, rerender } = render(<Preview camera={camera} />);
  await measure(900, 700);
  expect(
    container.querySelector("[data-preview-region]")?.getAttribute("data-preview-region"),
  ).toBe("local");
  const count = decode.mock.calls.length;
  const picture = screen.getByAltText("图纸底图");
  expect(Number.parseFloat(picture.style.width)).toBeLessThan(900 * 6);
  rerender(<Preview camera={{ ...camera, x: 500.35 }} />);
  await act(async () => {});
  expect(decode).toHaveBeenCalledTimes(count);
});

it.each([false, true])(
  "keeps consecutive pans in place while replacement tiles decode (transformed source: %s)",
  async (transformed) => {
    setup();
    const sourceBytes = transformed
      ? new TextEncoder().encode(
          new TextDecoder().decode(bytes).replace("<path", '<path transform="scale(1)"'),
        )
      : bytes;
    const camera = { x: 500.25, y: 400, width: 1.08, height: 0.864 };
    const { container, rerender } = render(<Preview camera={camera} sourceBytes={sourceBytes} />);
    await measure(900, 700);
    const picture = screen.getByAltText("图纸底图");
    const originalUrl = picture.getAttribute("src");
    const left = Number.parseFloat(picture.style.left);
    const top = Number.parseFloat(picture.style.top);
    const scale = Math.min(900 / camera.width, 700 / camera.height);
    const tileOrigin = () => {
      const svg = new DOMParser().parseFromString(captured.svg, "image/svg+xml");
      return svg.documentElement.getAttribute("viewBox")?.split(" ").map(Number) ?? [];
    };
    const originalTile = tileOrigin();
    const landmarkX = left + (500.75 - (originalTile[0] ?? 0)) * scale;
    const landmarkY = top + (400.2 - (originalTile[1] ?? 0)) * scale;
    const completions: Array<() => void> = [];
    decode.mockImplementation(() => new Promise<void>((resolve) => completions.push(resolve)));
    const assertPosition = (dx: number, dy: number) => {
      expect(picture.getAttribute("src")).toBe(originalUrl);
      expect(Number.parseFloat(picture.style.left)).toBeCloseTo(left - dx * scale);
      expect(Number.parseFloat(picture.style.top)).toBeCloseTo(top - dy * scale);
    };
    rerender(
      <Preview
        sourceBytes={sourceBytes}
        camera={{ ...camera, x: camera.x + 5, y: camera.y + 5 }}
      />,
    );
    expect(container.querySelector("[data-render-state]")?.getAttribute("data-render-state")).toBe(
      "pending",
    );
    assertPosition(5, 5);
    rerender(
      <Preview
        sourceBytes={sourceBytes}
        camera={{ ...camera, x: camera.x + 9, y: camera.y - 5 }}
      />,
    );
    assertPosition(9, -5);
    await act(async () => {});
    expect(completions).toHaveLength(1);
    await act(async () => completions[0]?.());
    expect(container.querySelector("[data-render-state]")?.getAttribute("data-render-state")).toBe(
      "ready",
    );
    expect(picture.getAttribute("src")).not.toBe(originalUrl);
    const finalTile = tileOrigin();
    expect(
      Number.parseFloat(picture.style.left) + (500.75 - (finalTile[0] ?? 0)) * scale,
    ).toBeCloseTo(landmarkX - 9 * scale);
    expect(
      Number.parseFloat(picture.style.top) + (400.2 - (finalTile[1] ?? 0)) * scale,
    ).toBeCloseTo(landmarkY + 5 * scale);
  },
);

it("decodes the local high-zoom SVG at a sufficient raster size", async () => {
  setup();
  render(<Preview camera={{ x: 500.25, y: 400, width: 1.08, height: 0.864 }} />);
  await measure(900, 700);
  const width = Number(captured.svg.match(/width="(\d+)"/u)?.[1]);
  const height = Number(captured.svg.match(/height="(\d+)"/u)?.[1]);
  expect(width).toBeGreaterThanOrEqual(900);
  expect(width * height).toBeLessThanOrEqual(MAX_CAD_PREVIEW_PIXELS);
});

it("limits the high-zoom tile pixel budget", () => {
  const raster = cadRasterSize(
    { x: 0, y: 0, width: 11.71875, height: 6.52734375 },
    810,
    1.5,
    4096,
    MAX_CAD_PREVIEW_PIXELS,
  );
  expect(raster.width * raster.height).toBeLessThanOrEqual(MAX_CAD_PREVIEW_PIXELS);
});
function Preview({
  width = 1000,
  height = 800,
  camera = view,
  sourceBytes = bytes,
}: {
  width?: number;
  height?: number;
  camera?: DrawingView;
  sourceBytes?: Uint8Array;
}) {
  const [ready, setReady] = useState(false);
  return (
    <>
      <output aria-label="ready">{String(ready)}</output>
      <CadDrawingPreview
        source={drawingPreviewSource(sourceBytes)}
        sourceKind="dwg"
        pageNumber={1}
        width={width}
        height={height}
        view={camera}
        onPending={() => setReady(false)}
        onPainted={() => setReady(true)}
        onError={(message) => {
          throw Error(message);
        }}
      />
    </>
  );
}
it("retains the decoded CAD when the workspace is hidden and returns at the same size", async () => {
  setup();
  const { container } = render(<Preview />);
  await measure(900, 700);
  expect(screen.getByLabelText("ready").textContent).toBe("true");
  const url = container.querySelector("img")!.src;
  const count = decode.mock.calls.length;
  for (let i = 0; i < 3; i++) {
    await measure(0, 0);
    await measure(900, 700);
    expect(screen.getByLabelText("ready").textContent).toBe("true");
  }
  expect(container.querySelector("img")!.src).toBe(url);
  expect(decode).toHaveBeenCalledTimes(count);
});
it("reports each completed replacement even when its zoom and ready flag are unchanged", async () => {
  setup();
  const { rerender } = render(<Preview />);
  await measure(900, 700);
  rerender(
    <Preview width={2000} height={1600} camera={{ x: 0, y: 0, width: 2160, height: 1728 }} />,
  );
  await act(async () => {});
  expect(screen.getByLabelText("ready").textContent).toBe("true");
});

it("keeps tools ready and the previous frame visible while a zoom is decoding", async () => {
  setup();
  vi.useFakeTimers();
  const transformed = new TextEncoder().encode(
    new TextDecoder().decode(bytes).replace("<path", '<path transform="scale(1)"'),
  );
  const { container, rerender } = render(<Preview sourceBytes={transformed} />);
  await measure(900, 700);
  const previous = screen.getByAltText("图纸底图").getAttribute("src");
  const previousWidth = Number.parseFloat(screen.getByAltText("图纸底图").style.width);
  let finish = () => {};
  decode.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  rerender(<Preview sourceBytes={transformed} camera={{ ...view, width: 540, height: 432 }} />);
  expect(container.querySelector("[data-render-state]")?.getAttribute("data-render-state")).toBe(
    "pending",
  );
  expect(screen.getByLabelText("ready").textContent).toBe("true");
  expect(screen.getByAltText("图纸底图").getAttribute("src")).toBe(previous);
  expect(Number.parseFloat(screen.getByAltText("图纸底图").style.width)).toBeCloseTo(
    previousWidth * 2,
  );
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(previous);
  expect(decode).toHaveBeenCalledTimes(1);
  rerender(
    <Preview sourceBytes={transformed} camera={{ x: 270, y: 216, width: 270, height: 216 }} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(119);
  });
  expect(decode).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(decode).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  await act(async () => {});
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(previous);
  expect(container.querySelector("[data-render-state]")?.getAttribute("data-render-state")).toBe(
    "ready",
  );
  expect(screen.getByAltText("图纸底图").getAttribute("src")).not.toBe(previous);
});

it("scales a CAD frame continuously without decoding another SVG at each zoom", async () => {
  setup();
  const { rerender } = render(<Preview />);
  await measure(900, 700);
  const image = screen.getByAltText("图纸底图");
  const source = image.getAttribute("src"),
    count = decode.mock.calls.length;
  const initialWidth = parseFloat((image as HTMLImageElement).style.width);
  for (const scale of [1.05, 1.1, 1.2, 2, 4]) {
    rerender(
      <Preview camera={{ ...view, width: view.width / scale, height: view.height / scale }} />,
    );
    expect(parseFloat((image as HTMLImageElement).style.width)).toBeCloseTo(initialWidth * scale);
    expect(image.getAttribute("src")).toBe(source);
    expect(screen.getByLabelText("ready").textContent).toBe("true");
  }
  expect(decode).toHaveBeenCalledTimes(count);
});

it("cancels a deferred zoom on reversal and unmount without releasing the painted frame", async () => {
  setup();
  vi.useFakeTimers();
  const sourceBytes = new TextEncoder().encode(
    new TextDecoder().decode(bytes).replace("<path", '<path transform="scale(1)"'),
  );
  const { rerender, unmount } = render(<Preview sourceBytes={sourceBytes} />);
  await measure(900, 700);
  const original = screen.getByAltText("图纸底图").getAttribute("src");
  const zoomed = { x: 270, y: 216, width: 270, height: 216 };
  rerender(<Preview sourceBytes={sourceBytes} camera={zoomed} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60);
  });
  rerender(<Preview sourceBytes={sourceBytes} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(decode).toHaveBeenCalledTimes(1);
  expect(screen.getByAltText("图纸底图").getAttribute("src")).toBe(original);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original);
  rerender(<Preview sourceBytes={sourceBytes} camera={zoomed} />);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(decode).toHaveBeenCalledTimes(1);
});

it("retains the painted drawing until a replacement checkpoint has decoded", async () => {
  setup();
  const { rerender } = render(<Preview />);
  await measure(900, 700);
  const previous = screen.getByAltText("图纸底图").getAttribute("src");
  let finish = () => {};
  decode.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  rerender(<Preview sourceBytes={bytes.slice()} />);
  expect(screen.getByLabelText("ready").textContent).toBe("false");
  expect(screen.getByAltText("图纸底图").getAttribute("src")).toBe(previous);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(previous);
  await act(async () => {});
  expect(decode).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  await act(async () => {});
  expect(screen.getByLabelText("ready").textContent).toBe("true");
  expect(screen.getByAltText("图纸底图").getAttribute("src")).not.toBe(previous);
});

it("aborts the previous SVG decode when a new viewport replaces it", async () => {
  setup();
  decode.mockImplementation(() => new Promise<void>(() => {}));
  const { rerender } = render(<Preview />);
  await measure(900, 700);
  expect(createdImages).toHaveLength(1);
  const previous = createdImages[0]!;
  rerender(<Preview camera={{ x: 500.25, y: 400, width: 1.08, height: 0.864 }} />);
  expect(createdImages).toHaveLength(2);
  expect(previous.src).toBe("");
});

it("reuses a decoded offscreen CAD region immediately when returning to it", async () => {
  setup();
  const sourceBytes = bytes.slice();
  const camera = { x: 500.25, y: 400, width: 1.08, height: 0.864 };
  const { container, rerender } = render(<Preview camera={camera} sourceBytes={sourceBytes} />);
  await measure(900, 700);
  const original = screen.getByAltText("图纸底图").getAttribute("src");
  const originalLeft = screen.getByAltText("图纸底图").style.left;
  rerender(<Preview camera={{ ...camera, x: camera.x + 3 }} sourceBytes={sourceBytes} />);
  await act(async () => {});
  const count = decode.mock.calls.length;
  expect(screen.getByAltText("图纸底图").getAttribute("src")).not.toBe(original);
  rerender(<Preview camera={camera} sourceBytes={sourceBytes} />);
  expect(screen.getByAltText("图纸底图").getAttribute("src")).toBe(original);
  expect(screen.getByAltText("图纸底图").style.left).toBe(originalLeft);
  expect(container.querySelector("[data-render-state]")?.getAttribute("data-render-state")).toBe(
    "ready",
  );
  expect(decode).toHaveBeenCalledTimes(count);
});

it("mounts a retained source with tools ready without another decode", async () => {
  setup();
  const sourceBytes = bytes.slice();
  const first = render(<Preview sourceBytes={sourceBytes} />);
  await measure(900, 700);
  const src = screen.getByAltText("图纸底图").getAttribute("src");
  const count = decode.mock.calls.length;
  first.unmount();
  render(<Preview sourceBytes={sourceBytes} />);
  await measure(900, 700);
  expect(screen.getByAltText("图纸底图").getAttribute("src")).toBe(src);
  expect(screen.getByLabelText("ready").textContent).toBe("true");
  expect(decode).toHaveBeenCalledTimes(count);
});
