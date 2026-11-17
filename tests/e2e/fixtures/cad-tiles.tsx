import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DetailViewImage } from "../../../src/renderer/src/drawing-markup/detail-view-layer";
import type { DrawingView } from "../../../src/renderer/src/drawing-markup/fixed-line-preview";
import { renderDrawing } from "../../../src/renderer/src/drawing-markup/render";
import { tiledPreviewCacheStats } from "../../../src/renderer/src/drawing-markup/tiled-drawing-preview";
import { VectorDrawingPreview } from "../../../src/renderer/src/drawing-markup/vector-drawing-preview";
import { createDetailView } from "../../../src/shared/drawing-markup/detail-view";
import { drawingProjectFixture } from "../../../src/shared/drawing-markup/test-fixture";
import type { DrawingTileIndex } from "../../../src/shared/drawing-markup/tiles";
import {
  type DrawingTileRaster,
  prepareTileRasterSvg,
} from "../../../src/shared/drawing-markup/tiles";

const encode = (s: string) => new TextEncoder().encode(s);
const body =
  '<rect width="1000000" height="800000" fill="white"/><path d="M0 400000H1000000 M500000 0V800000" stroke="black" stroke-width="1000"/><circle cx="500000" cy="400000" r="130000" fill="none" stroke="black" stroke-width="800"/><path d="M400000 200000C800000 0 200000 800000 700000 600000" fill="none" stroke="black" stroke-width="800"/>';
const full = encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000000 800000">${body}</svg>`,
);
const index: DrawingTileIndex = {
  version: 1,
  width: 1000,
  height: 800,
  tier: "large",
  primitives: 4,
  tiles: [],
};
const data = new Map<string, Uint8Array>();
for (let row = 0; row < 2; row++)
  for (let col = 0; col < 2; col++) {
    const x = col * 500,
      y = row * 400,
      left = Math.max(0, x - 8),
      top = Math.max(0, y - 8),
      right = Math.min(1000, x + 508),
      bottom = Math.min(800, y + 408);
    const id = `tile-${index.tiles.length}`,
      render = { x: left, y: top, width: right - left, height: bottom - top };
    const bytes = encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${render.width}" height="${render.height}" viewBox="${left * 1000} ${top * 1000} ${render.width * 1000} ${render.height * 1000}">${body}</svg>`,
    );
    data.set(id, bytes);
    index.tiles.push({
      id,
      core: { x, y, width: 500, height: 400 },
      render,
      byteLength: bytes.length,
      sha256: "A".repeat(64),
    });
  }
const overviewUrl = URL.createObjectURL(new Blob([full], { type: "image/svg+xml" }));
const tiled = { sessionId: "test", assetId: "tiles", index, overviewUrl };
let fail = false,
  busy = 0,
  requests: string[] = [],
  active = 0,
  maxActive = 0;
(window as unknown as { patentApi: unknown }).patentApi = {
  assets: {
    readDrawingTile: async (
      _session: string,
      _asset: string,
      id: string,
      raster?: DrawingTileRaster,
    ) => {
      requests.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (fail) return { ok: false, error: { code: "CAD_TILES_INVALID", message: "图纸块损坏" } };
      if (busy-- > 0)
        return { ok: false, error: { code: "OPERATION_IN_PROGRESS", message: "图纸读取繁忙" } };
      if (!raster) return { ok: true, value: data.get(id)! };
      const url = URL.createObjectURL(
        new Blob([prepareTileRasterSvg(data.get(id)!, index, raster)], { type: "image/svg+xml" }),
      );
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = raster.width;
        canvas.height = raster.height;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), "image/png"),
        );
        canvas.width = canvas.height = 0;
        return { ok: true, value: new Uint8Array(await blob.arrayBuffer()) };
      } finally {
        image.src = "";
        URL.revokeObjectURL(url);
      }
    },
  },
};
let root = createRoot(document.getElementById("root")!);
const project = {
  ...drawingProjectFixture("tiles"),
  sourceKind: "dwg" as const,
  baseFragments: undefined,
  annotations: [],
  detailViews: [],
};
const errors: string[] = [];
const base = { bytes: encode(JSON.stringify(index)), url: overviewUrl, tiled };
const probe = {
  render(view: DrawingView, ratio = 2) {
    const detail = createDetailView(
      project,
      { x: 500, y: 400 },
      80,
      { x: 750, y: 550 },
      "A",
      ratio,
      12,
      0.3,
      "detail",
    );
    flushSync(() =>
      root.render(
        <>
          <VectorDrawingPreview
            bytes={base.bytes}
            tiled={tiled}
            sourceKind="dwg"
            pageNumber={1}
            width={1000}
            height={800}
            view={view}
            onPending={() => {}}
            onPainted={() => {}}
            onError={(e) => errors.push(e)}
          />
          <DetailViewImage
            detail={detail}
            project={project}
            base={base}
            view={view}
            left={view.x}
            top={view.y}
            unit={view.width / 900}
            onError={(e) => errors.push(e)}
          />
        </>,
      ),
    );
  },
  stats: () => ({
    requests: [...requests],
    maxActive,
    errors: [...errors],
    cache: tiledPreviewCacheStats(),
  }),
  async output(useTiles: boolean, dpi: number, complex = false) {
    requests = [];
    const edited = complex
      ? {
          ...project,
          baseFragments: drawingProjectFixture("tiles").baseFragments,
          detailViews: [
            createDetailView(
              project,
              { x: 500, y: 400 },
              80,
              { x: 750, y: 550 },
              "A",
              2,
              12,
              0.3,
              "detail",
            ),
          ],
        }
      : project;
    const region = {
      id: "region",
      name: "图1",
      kind: "rectangle" as const,
      points: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 800 },
        { x: 0, y: 800 },
      ],
    };
    const result = await renderDrawing(
      edited,
      region,
      useTiles ? base.bytes : full,
      useTiles ? "application/vnd.zxw.cad-tiles+zip" : "image/svg+xml",
      100,
      dpi,
      useTiles ? { tiled } : {},
    );
    return Array.from(result.bytes);
  },
  corrupt: () => {
    fail = true;
  },
  busy: (count: number) => {
    busy = count;
  },
  reopen: () => {
    fail = false;
    busy = 0;
    root = createRoot(document.getElementById("root")!);
    probe.render({ x: 0, y: 0, width: 1000, height: 800 });
  },
  close: () => {
    flushSync(() => root.unmount());
  },
};
(window as unknown as { cadTilesProbe: typeof probe }).cadTilesProbe = probe;
probe.render({ x: 0, y: 0, width: 1000, height: 800 });
