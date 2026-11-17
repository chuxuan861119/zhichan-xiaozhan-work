import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DRAWING_TILE_RASTER_MAX_DIMENSION,
  DRAWING_TILE_RASTER_MAX_PIXELS,
  type DrawingTileIndex,
  intersects,
  tilePreviewStrokes,
} from "../../../shared/drawing-markup/tiles";
import { cadRasterSize, type DrawingView, previewGeometry } from "./fixed-line-preview";
import { imageUrl } from "./render";
import type { DrawingPreviewProps } from "./vector-drawing-preview";

export type TiledDrawingSource = {
  sessionId: string;
  assetId: string;
  index: DrawingTileIndex;
  overviewUrl: string;
};
type Frame = {
  identity: string;
  url: string;
  region: DrawingView;
  bytes: number;
  image: HTMLImageElement;
};
type Cached = {
  identity: string;
  refs: number;
  used: number;
  reserve: number;
  frame?: Frame;
  promise: Promise<Frame>;
  start: (() => void) | undefined;
  cancel: () => void;
};
const frames = new Map<string, Cached>();
const viewportAreas = new Map<object, number>();
let running = 0,
  clock = 0;
export const TILED_PREVIEW_MAX_BYTES = 192 * 1024 * 1024;
const MAX_BYTES = TILED_PREVIEW_MAX_BYTES; // Encoded PNG, decoded pixels and in-flight reservations.
const frameEntries = new WeakMap<Frame, Cached>();
const consumers = new Map<string, number>();
const notifications = new Set<() => void>();
const failures = new Map<
  string,
  {
    attempts: number;
    blocked: boolean;
    terminal: boolean;
    reported: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  }
>();
class TileReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
export function tiledPreviewCacheStats() {
  return {
    running,
    entries: frames.size,
    reservedBytes: [...frames.values()].reduce((n, e) => n + e.reserve, 0),
    queued: [...frames.values()].filter((e) => e.start !== undefined).length,
    leased: [...frames.values()].filter((e) => e.refs > 0).length,
  };
}
function pump() {
  for (const entry of frames.values())
    if (running < 2 && entry.refs > 0 && entry.start && !failures.get(entry.identity)?.blocked) {
      const start = entry.start;
      entry.start = undefined;
      running++;
      start();
    }
}
function destroy(key: string, entry: Cached) {
  frames.delete(key);
  entry.cancel();
  if (entry.frame) {
    entry.frame.image.src = "";
    URL.revokeObjectURL(entry.frame.url);
  }
}
function acquire(identity: string, key: string, reserve: number, create: () => Promise<Frame>) {
  if (failures.get(identity)?.blocked) return null;
  let entry = frames.get(key);
  if (!entry) {
    let allocated = [...frames.values()].reduce((n, e) => n + e.reserve, 0);
    for (const [k, e] of [...frames].sort((a, b) => a[1].used - b[1].used)) {
      if (allocated + reserve <= MAX_BYTES) break;
      if (e.refs === 0 && e.start === undefined) {
        allocated -= e.reserve;
        destroy(k, e);
      }
    }
    if (allocated + reserve > MAX_BYTES) return null;
    let cancelled = false,
      reject!: (error: unknown) => void,
      resolve!: (value: Frame) => void;
    const promise = new Promise<Frame>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    const next: Cached = {
      identity,
      refs: 0,
      used: 0,
      reserve,
      promise,
      start: () => {
        void create()
          .then(
            (frame) => {
              if (cancelled) {
                frame.image.src = "";
                URL.revokeObjectURL(frame.url);
                return;
              }
              next.frame = frame;
              const failure = failures.get(identity);
              if (failure && !failure.terminal) {
                if (failure.timer) clearTimeout(failure.timer);
                failures.delete(identity);
              }
              next.reserve = frame.bytes;
              frameEntries.set(frame, next);
              resolve(frame);
            },
            (error) => {
              if (!cancelled) {
                frames.delete(key);
                const attempts = (failures.get(identity)?.attempts ?? 0) + 1;
                const previous = failures.get(identity);
                if (previous?.timer) clearTimeout(previous.timer);
                const terminal =
                  !(error instanceof TileReadError && error.retryable) || attempts >= 3;
                const failure = {
                  attempts,
                  blocked: true,
                  terminal,
                  reported: previous?.reported ?? false,
                  timer: undefined as ReturnType<typeof setTimeout> | undefined,
                };
                failures.set(identity, failure);
                if (!terminal)
                  failure.timer = setTimeout(() => {
                    failure.blocked = false;
                    pump();
                    notifications.forEach((notify) => {
                      notify();
                    });
                  }, attempts * 500);
                else
                  for (const [queuedKey, queued] of frames)
                    if (queued.identity === identity && queued.start) destroy(queuedKey, queued);
                reject(error);
              }
            },
          )
          .finally(() => {
            running--;
            pump();
            notifications.forEach((notify) => {
              notify();
            });
          });
      },
      cancel: () => {
        cancelled = true;
        reject(new DOMException("Cancelled", "AbortError"));
      },
    };
    frames.set(key, next);
    entry = next;
  }
  entry.refs++;
  entry.used = ++clock;
  const held = entry;
  let released = false;
  pump();
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs === 0 && held.start) destroy(key, held);
      // A finite idle cache is shared between the main view and detail views.
    },
  };
}
async function decodeTile(
  source: TiledDrawingSource,
  id: string,
  region: DrawingView,
  raster: { width: number; height: number },
  reference: number,
  displayDensity: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const actualDensity = Math.min(raster.width / region.width, raster.height / region.height);
  const response = await window.patentApi.assets.readDrawingTile(
    source.sessionId,
    source.assetId,
    id,
    {
      region,
      width: raster.width,
      height: raster.height,
      ...tilePreviewStrokes(actualDensity, displayDensity, reference * dpr, dpr),
    },
  );
  if (!response.ok)
    throw new TileReadError(
      response.error.message,
      response.error.code === "OPERATION_IN_PROGRESS",
    );
  const url = imageUrl(response.value, "image/png"),
    image = new Image();
  image.src = url;
  try {
    await image.decode();
    return {
      identity: JSON.stringify([source.sessionId, source.assetId]),
      url,
      image,
      region,
      bytes: raster.width * raster.height * 4 + response.value.length,
    };
  } catch (error) {
    image.src = "";
    URL.revokeObjectURL(url);
    throw error;
  }
}
export function TiledDrawingPreview(props: DrawingPreviewProps & { tiled: TiledDrawingSource }) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visibleArea, setVisibleArea] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(new Map<string, Frame>());
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([props.tiled.sessionId, props.tiled.assetId]);
  const viewport = props.viewportSize ?? size;
  const consumer = useRef({}).current;
  const g = previewGeometry(props, props.view, viewport.width, viewport.height, 1);
  const factor = props.width / props.tiled.index.width;
  const factorY = props.height / props.tiled.index.height;
  const reference =
    factor *
    (props.strokeReferenceScale ??
      Math.min(viewport.width / (props.width * 1.08), viewport.height / (props.height * 1.08)));
  const density = Math.max(
    0.001,
    2 **
      (Math.ceil(
        2 * Math.log2((props.strokeScale ?? g.scale) * factor * (window.devicePixelRatio || 1)),
      ) /
        2),
  );
  const visible = {
      x: g.visible.x / factor,
      y: g.visible.y / factorY,
      width: g.visible.width / factor,
      height: g.visible.height / factorY,
    },
    overscan = {
      x: visible.x - 192 / density,
      y: visible.y - 192 / density,
      width: visible.width + 384 / density,
      height: visible.height + 384 / density,
    };
  const tiles = (visibleArea === 0 ? [] : props.tiled.index.tiles)
    .filter((t) => intersects(t.core, overscan))
    .sort((a, b) => Number(intersects(b.core, visible)) - Number(intersects(a.core, visible)));
  const crops = tiles.map((tile) => {
    // Align crops to a stable grid; ordinary movement reuses the retained frame.
    const cell = 128 / density;
    const x = Math.max(tile.render.x, Math.floor(overscan.x / cell) * cell),
      y = Math.max(tile.render.y, Math.floor(overscan.y / cell) * cell);
    const region = {
      x,
      y,
      width: Math.max(
        0.001,
        Math.min(
          tile.render.x + tile.render.width,
          Math.ceil((overscan.x + overscan.width) / cell) * cell,
        ) - x,
      ),
      height: Math.max(
        0.001,
        Math.min(
          tile.render.y + tile.render.height,
          Math.ceil((overscan.y + overscan.height) / cell) * cell,
        ) - y,
      ),
    };
    return { tile, region };
  });
  const totalArea = crops.reduce((n, r) => n + r.region.width * r.region.height, 0);
  const area = visibleArea ?? Math.max(1, viewport.width * viewport.height);
  const allAreas = [...viewportAreas.values()].reduce((n, value) => n + value, 0);
  const share = area / Math.max(1, area, allAreas);
  const requests = crops.map(({ tile, region }) => {
    // Share by the actual viewport area, rather than shrinking the main view
    // equally for every small detail. Keep room for old/new frames and reservations.
    const pixels = Math.max(
      1024,
      Math.floor(
        ((MAX_BYTES / (8 * 3)) * share * region.width * region.height) / Math.max(1e-12, totalArea),
      ),
    );
    const raster = cadRasterSize(
      region,
      density,
      1,
      DRAWING_TILE_RASTER_MAX_DIMENSION,
      Math.min(DRAWING_TILE_RASTER_MAX_PIXELS, pixels),
    );
    const key = JSON.stringify([
      props.tiled.sessionId,
      props.tiled.assetId,
      tile.id,
      region,
      raster,
      reference,
      density,
    ]);
    return { tile, region, raster, key };
  });
  const requestKey = JSON.stringify(requests.map((r) => r.key));
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-observe after viewport resize even when its intersection ratio remains one.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setVisibleArea(entry.intersectionRect.width * entry.intersectionRect.height);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, [viewport.width, viewport.height]);
  useLayoutEffect(() => {
    viewportAreas.set(consumer, area);
    notifications.forEach((notify) => {
      notify();
    });
    return () => {
      viewportAreas.delete(consumer);
      notifications.forEach((notify) => {
        notify();
      });
    };
  }, [consumer, area]);
  useEffect(() => {
    if (props.viewportSize) return;
    const observer = new ResizeObserver(([e]) => {
      if (e && e.contentRect.width && e.contentRect.height)
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
    });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, [props.viewportSize]);
  useEffect(() => {
    const notify = () => setRevision((n) => n + 1);
    notifications.add(notify);
    consumers.set(identity, (consumers.get(identity) ?? 0) + 1);
    return () => {
      notifications.delete(notify);
      const remaining = (consumers.get(identity) ?? 1) - 1;
      if (remaining) consumers.set(identity, remaining);
      else {
        consumers.delete(identity);
        const failure = failures.get(identity);
        if (failure?.timer) clearTimeout(failure.timer);
        failures.delete(identity);
        for (const [key, entry] of frames)
          if (key.startsWith(identity.slice(0, -1) + ",")) destroy(key, entry);
      }
    };
  }, [identity]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: requestKey covers the visible tile set.
  useLayoutEffect(() => {
    const held = [...loaded]
      .filter(([id]) => tiles.some((t) => t.id === id))
      .map(([, frame]) => frameEntries.get(frame))
      .filter((e) => e !== undefined);
    held.forEach((e) => {
      e.refs++;
      e.used = ++clock;
    });
    return () =>
      held.forEach((e) => {
        e.refs--;
      });
  }, [loaded, requestKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: requestKey represents the exact decode inputs.
  useEffect(() => {
    let cancelled = false;
    setLoaded(
      (prev) => new Map([...prev].filter(([id]) => requests.some((r) => r.tile.id === id))),
    );
    const leases = requests.map((r) => {
      const lease = acquire(
        identity,
        r.key,
        r.raster.width * r.raster.height * 8 + 128 * 1024,
        () => decodeTile(props.tiled, r.tile.id, r.region, r.raster, reference, density),
      );
      if (lease)
        void lease.promise.then(
          (frame) => {
            if (!cancelled)
              setLoaded((prev) =>
                prev.get(r.tile.id) === frame ? prev : new Map(prev).set(r.tile.id, frame),
              );
          },
          (error) => {
            const failure = failures.get(identity);
            if (
              !cancelled &&
              error?.name !== "AbortError" &&
              failure?.terminal &&
              !failure.reported
            ) {
              failure.reported = true;
              latest.current.onError(error instanceof Error ? error.message : "图纸显示失败。");
            }
          },
        );
      return lease;
    });
    return () => {
      cancelled = true;
      leases.forEach((l) => {
        l?.release();
      });
    };
  }, [requestKey, revision]);
  useLayoutEffect(() => {
    if (viewport.width && viewport.height) latest.current.onPainted(props.view, true);
  }, [props.view, viewport.width, viewport.height]);
  return (
    <div
      ref={host}
      className="drawing-vector-preview"
      data-render-state="ready"
      data-drawing-tiles={props.tiled.index.tiles.length}
      data-drawing-frames={
        [...loaded.values()].filter((frame) => frame.identity === identity).length
      }
    >
      <img
        src={props.tiled.overviewUrl}
        alt="图纸总览"
        draggable={false}
        style={{
          position: "absolute",
          maxWidth: "none",
          left: g.offsetX,
          top: g.offsetY,
          width: props.width * g.scale,
          height: props.height * g.scale,
        }}
      />
      {tiles.map((tile) => {
        const frame = loaded.get(tile.id);
        if (!frame || frame.identity !== identity) return null;
        const c = tile.core,
          r = frame.region;
        return (
          <div
            key={tile.id}
            style={{
              position: "absolute",
              overflow: "hidden",
              left: g.offsetX + c.x * factor * g.scale,
              top: g.offsetY + c.y * factorY * g.scale,
              width: c.width * factor * g.scale,
              height: c.height * factorY * g.scale,
            }}
          >
            <img
              src={frame.url}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                maxWidth: "none",
                left: (r.x - c.x) * factor * g.scale,
                top: (r.y - c.y) * factorY * g.scale,
                width: r.width * factor * g.scale,
                height: r.height * factorY * g.scale,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
