import {
  type DrawingSize,
  type DrawingView,
  type PreviewGeometry,
  previewGeometry,
} from "./fixed-line-preview";

export type RenderJob = { promise: Promise<unknown>; cancel(): void };
export type PreviewSession = {
  render(canvas: HTMLCanvasElement, geometry: PreviewGeometry): RenderJob;
  close(): Promise<unknown>;
};
const TILE = 1024;
const MAX_TILES = 32;

/** Source rendering is independent of pointer events. Only missing tiles enter the queue. */
export class PdfPreviewCache {
  private tiles = new Map<string, HTMLCanvasElement>();
  private fallback: HTMLCanvasElement | null = null;
  private fallbackScale = 1;
  private geometry: PreviewGeometry | null = null;
  private view: DrawingView | null = null;
  private generation = 0;
  private active: RenderJob | null = null;
  private pumping = false;
  private closed = false;
  private failed = false;
  private renders = 0;

  constructor(
    private target: HTMLCanvasElement,
    private session: PreviewSession,
    private project: DrawingSize,
    private size: DrawingSize,
    private painted: (view: DrawingView, ready: boolean) => void,
    private error: (message: string) => void,
    private strokeReferenceScale?: number | undefined,
  ) {}

  update(view: DrawingView, size: DrawingSize = this.size) {
    if (this.closed || this.failed || size.width <= 0 || size.height <= 0) return;
    this.size = size;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      2,
      Math.sqrt(8_000_000 / (this.size.width * this.size.height)),
      8192 / Math.max(this.size.width, this.size.height),
    );
    const g = previewGeometry(this.project, view, this.size.width, this.size.height, dpr);
    if (this.strokeReferenceScale) g.zoom = g.scale / dpr / this.strokeReferenceScale;
    if (this.geometry && (g.scale !== this.geometry.scale || g.zoom !== this.geometry.zoom)) {
      this.generation++;
      this.tiles.clear();
      // An obsolete zoom cannot supply useful tiles. Panning does not cancel work.
      if (this.fallback) this.active?.cancel();
    }
    this.geometry = g;
    this.view = view;
    this.draw();
    void this.pump();
  }

  private wanted(padding = 0) {
    const g = this.geometry!;
    const right = Math.ceil((this.project.width * g.scale) / TILE) - 1;
    const bottom = Math.ceil((this.project.height * g.scale) / TILE) - 1;
    const x0 = Math.max(0, Math.floor(-g.offsetX / TILE) - padding);
    const y0 = Math.max(0, Math.floor(-g.offsetY / TILE) - padding);
    const x1 = Math.min(right, Math.floor((g.width - g.offsetX - 1) / TILE) + padding);
    const y1 = Math.min(bottom, Math.floor((g.height - g.offsetY - 1) / TILE) + padding);
    const result: { key: string; x: number; y: number }[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) result.push({ key: `${x}:${y}`, x, y });
    return result;
  }

  private draw() {
    const g = this.geometry;
    if (!g || !this.view || !this.fallback || this.closed) return;
    const canvas = this.target;
    if (canvas.width !== g.width) canvas.width = g.width;
    if (canvas.height !== g.height) canvas.height = g.height;
    // Preserve the exact pixel scale when a fractional CSS viewport rounds to
    // integer bitmap dimensions. Stretching it back to 100% shifts landmarks,
    // especially when a detail's retained bitmap is subsequently magnified.
    const cssScale = Math.min(this.size.width / this.view.width, this.size.height / this.view.height);
    const pixelRatio = g.scale / cssScale;
    canvas.style.width = `${g.width / pixelRatio}px`;
    canvas.style.height = `${g.height / pixelRatio}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#e7ebf0";
    ctx.fillRect(0, 0, g.width, g.height);
    // Crop before scaling: a whole-page fallback at high zoom can otherwise create
    // a huge intermediate bitmap, even though only a small viewport is visible.
    const x = Math.max(0, g.offsetX),
      y = Math.max(0, g.offsetY);
    const right = Math.min(g.width, g.offsetX + this.project.width * g.scale);
    const bottom = Math.min(g.height, g.offsetY + this.project.height * g.scale);
    if (right > x && bottom > y) {
      // The bitmap includes ceil-rounded edge pixels; its source was drawn at
      // the exact scale. Treating that padding as source stretches it at high zoom.
      const sourceScale = this.fallbackScale / g.scale;
      ctx.drawImage(
        this.fallback,
        (x - g.offsetX) * sourceScale,
        (y - g.offsetY) * sourceScale,
        (right - x) * sourceScale,
        (bottom - y) * sourceScale,
        x,
        y,
        right - x,
        bottom - y,
      );
    }
    const visible = this.wanted();
    for (const { key, x, y } of visible) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      // Keep fractional tile edges aligned with the page, including at noninteger DPI.
      ctx.drawImage(tile, g.offsetX + x * TILE, g.offsetY + y * TILE);
      this.tiles.delete(key);
      this.tiles.set(key, tile);
    }
    canvas.dataset.sourceRenders = String(this.renders);
    canvas.dataset.cachedTiles = String(this.tiles.size);
    canvas.dataset.fallbackReady = "true";
    this.painted(
      this.view,
      visible.every(({ key }) => this.tiles.has(key)),
    );
  }

  private queue() {
    const unique = new Map<string, { key: string; x: number; y: number }>();
    for (const tile of [...this.wanted(), ...this.wanted(1)]) unique.set(tile.key, tile);
    return [...unique.values()].slice(0, MAX_TILES);
  }

  private async render(g: PreviewGeometry) {
    const canvas = document.createElement("canvas");
    canvas.width = g.width;
    canvas.height = g.height;
    this.renders++;
    const job = this.session.render(canvas, g);
    this.active = job;
    try {
      await job.promise;
    } finally {
      if (this.active === job) this.active = null;
    }
    return canvas;
  }

  private async pump() {
    if (this.pumping || this.closed || this.failed || !this.geometry) return;
    this.pumping = true;
    try {
      if (!this.fallback) {
        // A low-resolution centroid error becomes visible while tiles load at
        // high zoom. Keep a 2x fallback within the same 8 MP surface ceiling.
        const scale = Math.min(
          2,
          Math.sqrt(8_000_000 / (this.project.width * this.project.height)),
          8192 / Math.max(this.project.width, this.project.height),
        );
        this.fallback = await this.render({
          ...this.geometry,
          scale,
          zoom: 1,
          offsetX: 0,
          offsetY: 0,
          width: Math.max(1, Math.ceil(this.project.width * scale)),
          height: Math.max(1, Math.ceil(this.project.height * scale)),
          visible: { x: 0, y: 0, ...this.project },
        });
        this.fallbackScale = scale;
        this.draw();
      }
      while (!this.closed) {
        const tile = this.queue().find(({ key }) => !this.tiles.has(key));
        if (!tile) break;
        const generation = this.generation;
        const g = this.geometry!;
        try {
          const frame = await this.render({
            ...g,
            width: Math.min(TILE, Math.ceil(this.project.width * g.scale) - tile.x * TILE),
            height: Math.min(TILE, Math.ceil(this.project.height * g.scale) - tile.y * TILE),
            offsetX: -tile.x * TILE,
            offsetY: -tile.y * TILE,
          });
          if (this.closed) break;
          if (generation !== this.generation) continue;
          this.tiles.set(tile.key, frame);
          const protectedKeys = new Set(this.queue().map((entry) => entry.key));
          for (const key of this.tiles.keys()) {
            if (this.tiles.size <= MAX_TILES) break;
            if (!protectedKeys.has(key)) this.tiles.delete(key);
          }
          this.draw();
        } catch (error) {
          if (this.closed) break;
          if (generation === this.generation) throw error;
        }
        // Yield to input between tiles even when PDF.js resolves from its operator cache.
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      }
    } catch (error) {
      if (!this.closed) {
        this.failed = true;
        this.error(error instanceof Error ? error.message : "图纸显示失败。");
      }
    } finally {
      this.pumping = false;
    }
  }

  dispose() {
    this.closed = true;
    this.active?.cancel();
    this.tiles.clear();
    this.fallback = null;
  }
}
