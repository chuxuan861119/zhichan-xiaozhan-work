const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjs);
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "pdf-worker-url" }));

import { createPdfPageRenderer, PdfPreviewError } from "./pdf-page-renderer";

type FakeRenderTask = {
  promise: Promise<void>;
  cancel: ReturnType<typeof vi.fn>;
};

type FakePage = {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  tasks: FakeRenderTask[];
};

function createCanvas(): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  const context = { clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(context);
  return { canvas, context };
}

function createRenderTask(): FakeRenderTask {
  let rejectRender: ((error: Error) => void) | undefined;
  const task: FakeRenderTask = {
    promise: new Promise<void>((resolve, reject) => {
      rejectRender = reject;
      queueMicrotask(resolve);
    }),
    cancel: vi.fn(() => {
      rejectRender?.(
        Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }),
      );
    }),
  };
  return task;
}

function createPendingRenderTask(): FakeRenderTask & {
  finish(): void;
  reject(error: Error): void;
} {
  let resolveRender: (() => void) | undefined;
  let rejectRender: ((error: Error) => void) | undefined;
  const task = {
    promise: new Promise<void>((resolve, reject) => {
      resolveRender = resolve;
      rejectRender = reject;
    }),
    cancel: vi.fn(() => {
      rejectRender?.(
        Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }),
      );
    }),
    finish: () => resolveRender?.(),
    reject: (error: Error) => rejectRender?.(error),
  };
  return task;
}

function createPage(width = 600, height = 800): FakePage {
  const page: FakePage = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
      scale,
    })),
    render: vi.fn(() => {
      const task = createRenderTask();
      page.tasks.push(task);
      return task;
    }),
    tasks: [],
  };
  return page;
}

function createPdf(pageCount: number, pageFactory = () => createPage()) {
  const pages = Array.from({ length: pageCount }, pageFactory);
  return {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
    destroy: vi.fn(),
    pages,
  };
}

function mockDocument(pdf: ReturnType<typeof createPdf>) {
  const loadingTask = {
    promise: Promise.resolve(pdf),
    destroy: vi.fn(),
  };
  pdfjs.getDocument.mockReturnValueOnce(loadingTask);
  return loadingTask;
}

beforeEach(() => {
  pdfjs.GlobalWorkerOptions.workerSrc = "";
  pdfjs.getDocument.mockReset();
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});

test("uses the bundled PDF.js worker and opens typed in-memory PDF bytes", async () => {
  const pdf = createPdf(7);
  const loadingTask = mockDocument(pdf);
  const renderer = createPdfPageRenderer();

  const result = await renderer.open(Uint8Array.from([37, 80, 68, 70]));

  expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("pdf-worker-url");
  expect(pdfjs.getDocument).toHaveBeenCalledWith({
    data: Uint8Array.from([37, 80, 68, 70]),
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
    useWorkerFetch: false,
  });
  expect(result).toEqual({ totalPages: 7 });
  expect(loadingTask.destroy).not.toHaveBeenCalled();
});

test("renders only the requested page with fit-to-page sizing and device pixel ratio", async () => {
  const pdf = createPdf(3, () => createPage(600, 800));
  mockDocument(pdf);
  const renderer = createPdfPageRenderer();
  await renderer.open(Uint8Array.from([1]));
  const { canvas, context } = createCanvas();

  const result = await renderer.render(canvas, {
    pageNumber: 2,
    zoom: { mode: "fit-page" },
    container: { width: 300, height: 500 },
  });

  expect(pdf.getPage).toHaveBeenCalledWith(2);
  expect(pdf.getPage).toHaveBeenCalledTimes(1);
  expect(pdf.pages[1]?.getViewport).toHaveBeenCalledWith({ scale: 0.5 });
  expect(pdf.pages[1]?.render).toHaveBeenCalledWith({
    canvas: null,
    canvasContext: context,
    transform: [2, 0, 0, 2, 0, 0],
    viewport: result.viewport,
  });
  expect(canvas.width).toBe(600);
  expect(canvas.height).toBe(800);
  expect(canvas.style.width).toBe("300px");
  expect(canvas.style.height).toBe("400px");
  expect(result).toMatchObject({
    pageNumber: 2,
    totalPages: 3,
    scale: 0.5,
    width: 300,
    height: 400,
  });
});

test("clamps percentage zoom to the supported 50 to 200 percent range", async () => {
  const pdf = createPdf(1, () => createPage(100, 200));
  mockDocument(pdf);
  const renderer = createPdfPageRenderer();
  await renderer.open(Uint8Array.from([1]));
  const { canvas } = createCanvas();

  await renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "percent", value: 250 },
    container: { width: 1000, height: 1000 },
  });

  expect(pdf.pages[0]?.getViewport).toHaveBeenCalledWith({ scale: 2 * (96 / 72) });
});

test("100 percent uses editor CSS pixels and fit page can shrink below 50 percent", async () => {
  const pdf = createPdf(1, () => createPage(600, 800));
  mockDocument(pdf);
  const renderer = createPdfPageRenderer();
  await renderer.open(Uint8Array.from([1]));
  const { canvas } = createCanvas();
  const full = await renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "percent", value: 100 },
    container: { width: 200, height: 250 },
  });
  expect(full.width).toBe(800);
  expect(full.height).toBe(1067);
  const fitted = await renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "fit-page" },
    container: { width: 200, height: 250 },
  });
  expect(fitted.width).toBeLessThanOrEqual(200);
  expect(fitted.height).toBeLessThanOrEqual(250);
  const widthFitted = await renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "fit-width" },
    container: { width: 900, height: 250 },
  });
  expect(widthFitted.width).toBe(900);
  expect(widthFitted.height).toBe(1200);
});

test("cancels in-flight page renders and destroys previous PDF resources", async () => {
  const firstPdf = createPdf(2, () => createPage(600, 800));
  const secondPdf = createPdf(1, () => createPage(300, 300));
  mockDocument(firstPdf);
  const renderer = createPdfPageRenderer();
  await renderer.open(Uint8Array.from([1]));
  const { canvas } = createCanvas();
  const pendingTask = createPendingRenderTask();
  firstPdf.pages[0]?.render.mockReturnValueOnce(pendingTask);
  const firstLoadingTask = pdfjs.getDocument.mock.results[0]?.value;

  const firstRender = renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "percent", value: 100 },
    container: { width: 1000, height: 1000 },
  });
  for (let attempt = 0; attempt < 10 && pendingTask.cancel.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }

  const secondLoadingTask = mockDocument(secondPdf);
  const openSecond = await renderer.open(Uint8Array.from([2]));

  await expect(firstRender).rejects.toBeInstanceOf(PdfPreviewError);
  expect(openSecond).toEqual({ totalPages: 1 });
  expect(pendingTask.cancel).toHaveBeenCalledOnce();
  expect(firstLoadingTask.destroy).toHaveBeenCalledOnce();
  expect(secondLoadingTask.destroy).not.toHaveBeenCalled();
});

test("releases loading tasks, PDFs, and render tasks on close", async () => {
  const pdf = createPdf(1, () => createPage(300, 300));
  const loadingTask = mockDocument(pdf);
  const renderer = createPdfPageRenderer();
  await renderer.open(Uint8Array.from([1]));
  const { canvas } = createCanvas();
  const pendingTask = createPendingRenderTask();
  pdf.pages[0]?.render.mockReturnValueOnce(pendingTask);
  const render = renderer.render(canvas, {
    pageNumber: 1,
    zoom: { mode: "percent", value: 100 },
    container: { width: 1000, height: 1000 },
  });
  await Promise.resolve();

  renderer.close();

  pendingTask.finish();
  await expect(render).rejects.toBeInstanceOf(PdfPreviewError);
  expect(pendingTask.cancel).toHaveBeenCalledOnce();
  expect(loadingTask.destroy).toHaveBeenCalledOnce();
});

test("reports invalid PDF bytes as a controlled preview error", async () => {
  const loadingTask = {
    promise: Promise.reject(new Error("Invalid PDF structure")),
    destroy: vi.fn(),
  };
  pdfjs.getDocument.mockReturnValueOnce(loadingTask);
  const renderer = createPdfPageRenderer();

  await expect(renderer.open(Uint8Array.from([0]))).rejects.toBeInstanceOf(PdfPreviewError);
  expect(loadingTask.destroy).toHaveBeenCalledOnce();
});
