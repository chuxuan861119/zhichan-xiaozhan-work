import type { DrawingView } from "./fixed-line-preview";

export type CadPreviewRequest = {
  bytes: Uint8Array;
  width: number;
  height: number;
  region: DrawingView;
  scaleKey: number;
  screenStrokes: boolean;
  screenPixelScale: number;
  screenStrokeWidth?: number | undefined;
  rasterWidth: number;
  rasterHeight: number;
};
export type CadPreviewFrame = CadPreviewRequest & { url: string; key: string };
export type CadPreviewDecode = {
  url: string;
  image: { src: string };
  done: Promise<void>;
  encodedBytes: number;
  cancelled?: boolean;
  cancel?(): void;
};
type Entry = {
  request: CadPreviewRequest;
  key: string;
  refs: number;
  used: number;
  frame: CadPreviewFrame | null;
  resource: CadPreviewDecode | null;
  promise: Promise<CadPreviewFrame>;
  reject(error: unknown): void;
  destroyed: boolean;
};
type Limits = { pixels: number; encodedBytes: number; entries: number };

export function cadPreviewKey(request: CadPreviewRequest) {
  const r = request.region;
  return JSON.stringify([
    request.width,
    request.height,
    request.scaleKey,
    request.screenStrokes,
    request.screenPixelScale,
    request.screenStrokeWidth,
    r.x,
    r.y,
    r.width,
    r.height,
    request.rasterWidth,
    request.rasterHeight,
  ]);
}

/** Limits apply to additional, offscreen frames shared by all CAD preview consumers. */
export class CadPreviewCache {
  private sources = new WeakMap<Uint8Array, Map<string, Entry>>();
  private entries = new Set<Entry>();
  private frames = new WeakMap<CadPreviewFrame, Entry>();
  private clock = 0;
  private scheduled = false;
  private hits = 0;
  private decodes = 0;

  constructor(
    private limits: Limits = { pixels: 24_000_000, encodedBytes: 32_000_000, entries: 8 },
  ) {}

  find(request: CadPreviewRequest, visible: DrawingView): CadPreviewFrame | null {
    const source = this.sources.get(request.bytes);
    const exact = source?.get(cadPreviewKey(request));
    if (exact?.frame && !exact.destroyed) return exact.frame;
    // Reuse overlapping overscan as well as exact grid cells. Preserve density,
    // stroke treatment, and source dimensions; panning alone changes the origin.
    for (const entry of source?.values() ?? []) {
      const f = entry.frame;
      if (
        !f ||
        entry.destroyed ||
        f.width !== request.width ||
        f.height !== request.height ||
        f.scaleKey !== request.scaleKey ||
        f.screenStrokes !== request.screenStrokes ||
        f.screenPixelScale !== request.screenPixelScale ||
        f.screenStrokeWidth !== request.screenStrokeWidth ||
        f.rasterWidth !== request.rasterWidth ||
        f.rasterHeight !== request.rasterHeight ||
        f.region.width !== request.region.width ||
        f.region.height !== request.region.height
      )
        continue;
      if (
        f.region.x <= visible.x &&
        f.region.y <= visible.y &&
        f.region.x + f.region.width >= visible.x + visible.width &&
        f.region.y + f.region.height >= visible.y + visible.height
      )
        return f;
    }
    return null;
  }

  acquire(
    request: CadPreviewRequest,
    create: () => CadPreviewDecode,
    preferred?: CadPreviewFrame | null,
  ) {
    let source = this.sources.get(request.bytes);
    if (!source) {
      source = new Map();
      this.sources.set(request.bytes, source);
    }
    const key = cadPreviewKey(request);
    let entry = preferred ? this.frames.get(preferred) : source.get(key);
    if (entry?.destroyed || entry?.request.bytes !== request.bytes) entry = undefined;
    if (entry) {
      this.hits++;
      entry.refs++;
      entry.used = ++this.clock;
    } else {
      this.decodes++;
      let resolve = (_frame: CadPreviewFrame) => {};
      let reject = (_error: unknown) => {};
      const promise = new Promise<CadPreviewFrame>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      entry = {
        request,
        key,
        refs: 1,
        used: ++this.clock,
        frame: null,
        resource: null,
        promise,
        reject,
        destroyed: false,
      };
      source.set(key, entry);
      this.entries.add(entry);
      const created = entry;
      try {
        const resource = create();
        created.resource = resource;
        void resource.done.then(
          () => {
            if (created.destroyed) return;
            created.frame = { ...request, key, url: resource.url };
            this.frames.set(created.frame, created);
            resolve(created.frame);
            this.scheduleTrim();
          },
          (error) => {
            if (!created.destroyed) {
              this.destroy(created);
              reject(error);
            }
          },
        );
      } catch (error) {
        this.destroy(created);
        reject(error);
      }
    }
    const held = entry;
    let released = false;
    return {
      frame: held.frame,
      promise: held.promise,
      release: () => {
        if (released) return;
        released = true;
        this.release(held);
      },
    };
  }

  retain(frame: CadPreviewFrame) {
    const entry = this.frames.get(frame);
    if (!entry || entry.destroyed) return () => {};
    entry.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(entry);
    };
  }

  statistics() {
    const idle = [...this.entries].filter((e) => e.refs === 0 && e.frame);
    return {
      hits: this.hits,
      decodes: this.decodes,
      idleFrames: idle.length,
      idlePixels: idle.reduce((sum, e) => sum + e.request.rasterWidth * e.request.rasterHeight, 0),
      idleBytes: idle.reduce((sum, e) => sum + (e.resource?.encodedBytes ?? 0), 0),
    };
  }

  private release(entry: Entry) {
    if (entry.destroyed || entry.refs === 0) return;
    entry.refs--;
    entry.used = ++this.clock;
    if (entry.refs === 0 && !entry.frame) {
      this.destroy(entry);
      entry.reject(new DOMException("Preview request released", "AbortError"));
    }
    this.scheduleTrim();
  }

  private destroy(entry: Entry) {
    if (entry.destroyed) return;
    entry.destroyed = true;
    const source = this.sources.get(entry.request.bytes);
    if (source?.get(entry.key) === entry) source.delete(entry.key);
    this.entries.delete(entry);
    if (entry.resource) {
      entry.resource.cancelled = true;
      entry.resource.cancel?.();
      entry.resource.image.src = "";
      if (entry.resource.url) URL.revokeObjectURL(entry.resource.url);
    }
  }

  private scheduleTrim() {
    if (this.scheduled) return;
    this.scheduled = true;
    // DOM replacements and all consumers' layout leases commit before eviction.
    queueMicrotask(() => {
      this.scheduled = false;
      const idle = [...this.entries]
        .filter((e) => e.refs === 0 && e.frame)
        .sort((a, b) => a.used - b.used);
      let pixels = idle.reduce((sum, e) => sum + e.request.rasterWidth * e.request.rasterHeight, 0);
      let bytes = idle.reduce((sum, e) => sum + (e.resource?.encodedBytes ?? 0), 0);
      let count = idle.length;
      for (const entry of idle) {
        if (
          pixels <= this.limits.pixels &&
          bytes <= this.limits.encodedBytes &&
          count <= this.limits.entries
        )
          break;
        pixels -= entry.request.rasterWidth * entry.request.rasterHeight;
        bytes -= entry.resource?.encodedBytes ?? 0;
        count--;
        this.destroy(entry);
      }
    });
  }
}

export const sharedCadPreviewCache = new CadPreviewCache();
