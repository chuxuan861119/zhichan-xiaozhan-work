import type {
  PageViewport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type PdfPreviewZoom =
  | { mode: "fit-page" | "fit-width" }
  | { mode: "percent"; value: number };

export type PdfPageRenderRequest = {
  pageNumber: number;
  zoom: PdfPreviewZoom;
  container: {
    width: number;
    height: number;
  };
};

export type PdfPageRenderResult = {
  pageNumber: number;
  totalPages: number;
  scale: number;
  width: number;
  height: number;
  viewport: PageViewport;
};

export class PdfPreviewError extends Error {
  override readonly name = "PdfPreviewError";
}

export type PdfPageRenderer = {
  open(bytes: Uint8Array): Promise<{ totalPages: number }>;
  render(canvas: HTMLCanvasElement, request: PdfPageRenderRequest): Promise<PdfPageRenderResult>;
  close(): void;
};

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfJsModulePromise;
}

function configureWorker(pdfjs: PdfJsModule): void {
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRenderingCancelled(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" || error.message === "cancelled")
  );
}

function destroyLoadingTask(task: PDFDocumentLoadingTask | undefined): void {
  if (!task) return;
  void task.destroy();
}

class PdfPageRendererController implements PdfPageRenderer {
  #loadingTask: PDFDocumentLoadingTask | undefined;
  #document: PDFDocumentProxy | undefined;
  #renderTask: RenderTask | undefined;
  #renderGeneration = 0;

  async open(bytes: Uint8Array): Promise<{ totalPages: number }> {
    this.close();
    const pdfjs = await loadPdfJs();
    configureWorker(pdfjs);
    const loadingTask = pdfjs.getDocument({
      data: Uint8Array.from(bytes),
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
      useWorkerFetch: false,
    });
    this.#loadingTask = loadingTask;

    try {
      const document = await loadingTask.promise;
      if (this.#loadingTask !== loadingTask) {
        destroyLoadingTask(loadingTask);
        throw new PdfPreviewError("PDF 预览已被替换。");
      }
      this.#document = document;
      return { totalPages: document.numPages };
    } catch (error) {
      if (error instanceof PdfPreviewError) throw error;
      if (this.#loadingTask === loadingTask) this.close();
      else destroyLoadingTask(loadingTask);
      throw new PdfPreviewError("PDF 预览加载失败。");
    }
  }

  async render(
    canvas: HTMLCanvasElement,
    request: PdfPageRenderRequest,
  ): Promise<PdfPageRenderResult> {
    const document = this.#document;
    if (!document) throw new PdfPreviewError("PDF 预览尚未加载。");
    if (!Number.isInteger(request.pageNumber) || request.pageNumber < 1) {
      throw new PdfPreviewError("页码无效。");
    }
    if (request.pageNumber > document.numPages) {
      throw new PdfPreviewError("页码超过 PDF 总页数。");
    }

    this.#cancelRenderTask();
    this.#renderGeneration += 1;
    const generation = this.#renderGeneration;
    const page = await document.getPage(request.pageNumber);
    if (generation !== this.#renderGeneration) {
      throw new PdfPreviewError("PDF 页面渲染已取消。");
    }

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = this.#resolveScale(baseViewport, request.zoom, request.container);
    const viewport = page.getViewport({ scale });
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new PdfPreviewError("无法创建 PDF 预览画布。");

    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    canvas.width = Math.max(1, Math.round(viewport.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(viewport.height * devicePixelRatio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const renderTask = page.render({
      canvas: null,
      canvasContext,
      transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      viewport,
    });
    this.#renderTask = renderTask;
    try {
      await renderTask.promise;
      if (generation !== this.#renderGeneration) {
        throw new PdfPreviewError("PDF 页面渲染已取消。");
      }
      return {
        pageNumber: request.pageNumber,
        totalPages: document.numPages,
        scale,
        width,
        height,
        viewport,
      };
    } catch (error) {
      if (error instanceof PdfPreviewError) throw error;
      if (isRenderingCancelled(error)) {
        throw new PdfPreviewError("PDF 页面渲染已取消。");
      }
      throw new PdfPreviewError("PDF 页面渲染失败。");
    } finally {
      if (this.#renderTask === renderTask) this.#renderTask = undefined;
    }
  }

  close(): void {
    this.#renderGeneration += 1;
    this.#cancelRenderTask();
    destroyLoadingTask(this.#loadingTask);
    this.#document = undefined;
    this.#loadingTask = undefined;
  }

  #cancelRenderTask(): void {
    if (!this.#renderTask) return;
    this.#renderTask.cancel();
    this.#renderTask = undefined;
  }

  #resolveScale(
    baseViewport: Pick<PageViewport, "width" | "height">,
    zoom: PdfPreviewZoom,
    container: PdfPageRenderRequest["container"],
  ): number {
    if (zoom.mode === "percent") {
      // PDF points use 72 units per inch; editor layout uses 96 CSS pixels.
      return clamp(zoom.value / 100, 0.5, 2) * (96 / 72);
    }

    const widthRatio = container.width > 0 ? container.width / baseViewport.width : 1;
    if (zoom.mode === "fit-width") return widthRatio;
    const heightRatio = container.height > 0 ? container.height / baseViewport.height : 1;
    return Math.min(widthRatio, heightRatio);
  }
}

export function createPdfPageRenderer(): PdfPageRenderer {
  return new PdfPageRendererController();
}
