import { PdfPreviewCache, type PreviewSession } from "./pdf-preview-cache";

const project = { width: 1600, height: 1200 };
const view = { x: -64, y: -48, width: 1728, height: 1296 };

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

test("fractional viewports keep bitmap pixels at their exact CSS scale", async () => {
  const canvas = document.createElement("canvas");
  const cache = new PdfPreviewCache(canvas,
    { render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), close: async () => {} },
    project, { width: 173.4, height: 143.7 }, vi.fn(), vi.fn());
  try {
    cache.update(view);
    await vi.waitFor(() => expect(canvas.dataset.fallbackReady).toBe("true"));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    expect(parseFloat(canvas.style.width)).toBeCloseTo(canvas.width / ratio);
    expect(parseFloat(canvas.style.height)).toBeCloseTo(canvas.height / ratio);
  } finally { cache.dispose(); }
});

test("panning keeps an in-flight PDF render and displays its fallback at the latest position", async () => {
  const jobs: { finish(): void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const session: PreviewSession = {
    render: () => {
      let finish = () => {};
      const promise = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const cancel = vi.fn();
      jobs.push({ finish, cancel });
      return { promise, cancel };
    },
    close: async () => {},
  };
  const canvas = document.createElement("canvas");
  const painted = vi.fn();
  const cache = new PdfPreviewCache(
    canvas,
    session,
    project,
    { width: 800, height: 600 },
    painted,
    vi.fn(),
  );
  cache.update(view);
  const moved = { ...view, x: 200 };
  cache.update(moved);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.cancel).not.toHaveBeenCalled();
  jobs[0]!.finish();
  await vi.waitFor(() => expect(painted).toHaveBeenLastCalledWith(moved, false));
  expect(canvas.dataset.fallbackReady).toBe("true");
  cache.update({ ...moved, x: 400 });
  expect(jobs[1]!.cancel).not.toHaveBeenCalled();
  cache.dispose();
  expect(jobs[1]!.cancel).toHaveBeenCalledOnce();
  jobs[1]!.finish();
});

test("repeated forward and reverse pans reuse cached PDF tiles without source rendering", async () => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const canvas = document.createElement("canvas");
  const painted = vi.fn();
  const cache = new PdfPreviewCache(
    canvas,
    { render, close: async () => {} },
    project,
    { width: 800, height: 600 },
    painted,
    vi.fn(),
  );
  cache.update(view);
  await vi.waitFor(() => expect(painted).toHaveBeenLastCalledWith(view, true));
  const count = render.mock.calls.length;
  for (const x of [0, 100, -100, 0, view.x]) cache.update({ ...view, x });
  expect(render).toHaveBeenCalledTimes(count);
  expect(painted.mock.lastCall?.[1]).toBe(true);
  expect(Number(canvas.dataset.cachedTiles)).toBeLessThanOrEqual(32);
  cache.dispose();
});

test("wide viewports stop prefetching at the cache budget instead of evicting and repainting forever", async () => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const canvas = document.createElement("canvas");
  const cache = new PdfPreviewCache(
    canvas,
    { render, close: async () => {} },
    { width: 100000, height: 100000 },
    { width: 8192, height: 80 },
    vi.fn(),
    vi.fn(),
  );
  try {
    cache.update({ x: 50000, y: 50000, width: 1000, height: 100 });
    await vi.waitFor(() => expect(Number(canvas.dataset.cachedTiles)).toBe(32));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(render).toHaveBeenCalledTimes(33);
  } finally {
    cache.dispose();
  }
});

test("high zoom fallback composition stays inside the bounded surface", async () => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const cache = new PdfPreviewCache(
    canvas,
    { render, close: async () => {} },
    project,
    { width: 1400, height: 1000 },
    vi.fn(),
    vi.fn(),
  );
  try {
    cache.update({ x: 700, y: 500, width: 16, height: 12 });
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalled());
    const draws = vi.mocked(context.drawImage).mock.calls;
    const crop = draws.find((args) => args.length === 9)!;
    expect(crop).toBeDefined();
    // The destination is the surface, rather than a 140000px whole-page bitmap.
    expect(crop[5]).toBe(0);
    expect(crop[6]).toBe(0);
    expect(crop[7]).toBe(canvas.width);
    expect(crop[8]).toBe(canvas.height);
    expect(Number(crop[3])).toBeLessThan(project.width);
    expect(Number(crop[4])).toBeLessThan(project.height);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_000_000);
  } finally {
    cache.dispose();
  }
});

test("buffer padding does not change PDF stroke zoom", async () => {
  const geometries: { zoom: number }[] = [];
  const canvas = document.createElement("canvas");
  const cache = new PdfPreviewCache(
    canvas,
    {
      render: (_canvas, geometry) => {
        geometries.push(geometry);
        return { promise: Promise.resolve(), cancel: vi.fn() };
      },
      close: async () => {},
    },
    project,
    { width: 1200, height: 900 },
    vi.fn(),
    vi.fn(),
    0.5,
  );
  try {
    cache.update({ x: 500, y: 500, width: 300, height: 225 });
    await vi.waitFor(() => expect(geometries.length).toBeGreaterThan(1));
    expect(geometries[1]!.zoom).toBe(8);
  } finally {
    cache.dispose();
  }
});

test("resizing a detail surface immediately repositions its retained PDF fallback", async () => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const canvas = document.createElement("canvas");
  const painted = vi.fn();
  const cache = new PdfPreviewCache(
    canvas,
    { render, close: async () => {} },
    project,
    { width: 800, height: 600 },
    painted,
    vi.fn(),
  );
  try {
    cache.update(view);
    await vi.waitFor(() => expect(painted).toHaveBeenLastCalledWith(view, true));
    const context = canvas.getContext("2d")!;
    const fallback = vi.mocked(context.drawImage).mock.calls.find((args) => args.length === 9)?.[0];
    vi.mocked(context.drawImage).mockClear();
    const resizedView = { x: 400, y: 300, width: 640, height: 400 };
    cache.update(resizedView, { width: 640, height: 400 });
    // No source render has to finish before the new surface gets a correctly mapped bitmap.
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(400);
    expect(context.drawImage).toHaveBeenCalledWith(fallback, 800, 600, 1280, 800, 0, 0, 640, 400);
    expect(painted).toHaveBeenLastCalledWith(resizedView, false);
    cache.update(view, { width: 0, height: 0 });
    expect(canvas.width).toBe(640);
    expect(painted).toHaveBeenLastCalledWith(resizedView, false);
    await vi.waitFor(() => expect(painted).toHaveBeenLastCalledWith(resizedView, true));
  } finally {
    cache.dispose();
  }
});

test("fractional fallback dimensions do not shift the source when magnified", async () => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw Error("PDF context missing");
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const cache = new PdfPreviewCache(
    canvas,
    { render, close: async () => {} },
    { width: 1600, height: 1280 },
    { width: 800, height: 600 },
    vi.fn(),
    vi.fn(),
  );
  try {
    cache.update({ x: 400, y: 300, width: 800, height: 600 });
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalled());
    const fallback = vi.mocked(context.drawImage).mock.calls.find((args) => args.length === 9);
    if (!fallback) throw Error("PDF fallback missing");
    const scale = Math.sqrt(8_000_000 / (1600 * 1280));
    expect(fallback[1]).toBeCloseTo(400 * scale, 6);
    expect(fallback[2]).toBeCloseTo(300 * scale, 6);
    expect(fallback[3]).toBeCloseTo(800 * scale, 6);
    expect(fallback[4]).toBeCloseTo(600 * scale, 6);
  } finally {
    cache.dispose();
  }
});
