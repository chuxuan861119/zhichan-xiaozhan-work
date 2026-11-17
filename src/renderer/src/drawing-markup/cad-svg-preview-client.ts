import { type DrawingSize, type PreviewGeometry, sharedSvgPreview } from "./fixed-line-preview";

export type CadSvgPreviewRequest = {
  id: number;
  kind: "prepare" | "render";
  sourceId: number;
  bytes?: Uint8Array;
  project: DrawingSize;
  geometry?: PreviewGeometry;
  screenStrokes?: boolean;
  screenPixelScale?: number;
  screenStrokeWidth?: number;
};
type WorkerResponse = {
  id: number;
  supportsScreenStrokes?: boolean;
  bytes?: Uint8Array;
  blob?: Blob;
  error?: string;
  needsSource?: boolean;
};

/** The worker owns the costly XML parse and per-viewport SVG serialization. */
export class CadSvgPreviewClient {
  private worker: Worker | null | undefined;
  private nextRequest = 0;
  private nextSource = 0;
  private sources = new WeakMap<Uint8Array, number>();
  private preparations = new WeakMap<
    Uint8Array,
    Map<string, Promise<{ supportsScreenStrokes: boolean }>>
  >();
  private renderQueue: Promise<void> = Promise.resolve();
  private pending = new Map<
    number,
    { resolve(value: WorkerResponse): void; reject(error: Error): void }
  >();

  private sourceId(bytes: Uint8Array) {
    let id = this.sources.get(bytes);
    if (!id) {
      id = ++this.nextSource;
      this.sources.set(bytes, id);
    }
    return id;
  }

  private getWorker() {
    if (this.worker !== undefined) return this.worker;
    try {
      this.worker = new Worker(new URL("./cad-svg-preview.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response);
      };
      this.worker.onerror = () => {
        for (const pending of this.pending.values())
          pending.reject(new Error("CAD preview worker stopped"));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private request(request: Omit<CadSvgPreviewRequest, "id">): Promise<WorkerResponse> | null {
    const worker = this.getWorker();
    if (!worker) return null;
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({
          ...request,
          id,
        } satisfies CadSvgPreviewRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("CAD preview request failed"));
      }
    });
  }

  prepare(bytes: Uint8Array, project: DrawingSize) {
    let variants = this.preparations.get(bytes);
    if (!variants) {
      variants = new Map();
      this.preparations.set(bytes, variants);
    }
    const key = `${project.width}:${project.height}`;
    let prepared = variants.get(key);
    if (!prepared) {
      prepared = this.prepareSource(bytes, project);
      variants.set(key, prepared);
      if (variants.size > 8) variants.delete(variants.keys().next().value!);
      void prepared.catch(() => {
        if (variants.get(key) === prepared) variants.delete(key);
      });
    }
    return prepared;
  }

  private async prepareSource(bytes: Uint8Array, project: DrawingSize) {
    try {
      const response = await this.request({
        kind: "prepare",
        bytes,
        project,
        sourceId: this.sourceId(bytes),
      });
      if (response?.supportsScreenStrokes !== undefined)
        return { supportsScreenStrokes: response.supportsScreenStrokes };
    } catch {
      // A worker failure must not make an existing drawing unreadable.
    }
    return { supportsScreenStrokes: sharedSvgPreview(bytes, project).supportsScreenStrokes };
  }

  render(
    bytes: Uint8Array,
    project: DrawingSize,
    geometry: PreviewGeometry,
    screenStrokes: boolean,
    screenPixelScale: number,
    screenStrokeWidth?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array | Blob> {
    // A single worker is serial already. Queue here so cancelled viewport jobs
    // are discarded before copying data or spending time serializing old views.
    const task = this.renderQueue.then(() =>
      this.renderViewport(
        bytes,
        project,
        geometry,
        screenStrokes,
        screenPixelScale,
        screenStrokeWidth,
        signal,
      ),
    );
    // Failure belongs to the caller; it must not prevent the next viewport.
    this.renderQueue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async renderViewport(
    bytes: Uint8Array,
    project: DrawingSize,
    geometry: PreviewGeometry,
    screenStrokes: boolean,
    screenPixelScale: number,
    screenStrokeWidth?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array | Blob> {
    signal?.throwIfAborted();
    try {
      const request = {
        kind: "render" as const,
        sourceId: this.sourceId(bytes),
        project,
        geometry,
        screenStrokes,
        screenPixelScale,
        ...(screenStrokeWidth === undefined ? {} : { screenStrokeWidth }),
      };
      let response = await this.request(request);
      signal?.throwIfAborted();
      // The worker keeps a bounded cache. Restore only when an older source
      // was evicted, never copy the entire source for ordinary viewport changes.
      if (response?.needsSource) response = await this.request({ ...request, bytes });
      signal?.throwIfAborted();
      if (response?.blob) return response.blob;
      if (response?.bytes) return response.bytes;
    } catch {
      signal?.throwIfAborted();
      // Fall back only when the background path is unavailable or failed.
    }
    const svg = sharedSvgPreview(bytes, project)(
      geometry,
      screenStrokes,
      screenPixelScale,
      screenStrokeWidth,
    );
    return new TextEncoder().encode(svg);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error("CAD preview closed"));
    this.pending.clear();
  }
}

export const sharedCadSvgPreviewClient = new CadSvgPreviewClient();
