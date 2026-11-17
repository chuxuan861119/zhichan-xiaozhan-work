import { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CadDraftingAids } from "../../../src/renderer/src/drawing-markup/cad-drafting-aids";
import { CadDrawingPreview } from "../../../src/renderer/src/drawing-markup/cad-drawing-preview";
import type { CadScene } from "../../../src/renderer/src/drawing-markup/cadcraft-client";
import { drawingPreviewSource } from "../../../src/renderer/src/drawing-markup/drawing-preview-source";
import type { DrawingView } from "../../../src/renderer/src/drawing-markup/fixed-line-preview";
import {
  PanPreviewSurface,
  type PanPreviewSurfaceHandle,
} from "../../../src/renderer/src/drawing-markup/pan-preview-surface";

const scene: CadScene = {
  revision: 1,
  entityCount: 24000,
  selection: [],
  bounds: null,
  svgFrame: { origin: [0, 0], width: 2000, height: 1200 },
  entities: Array.from({ length: 24000 }, (_, i) => {
    const x = (i % 200) * 10,
      y = Math.floor(i / 200) * 10;
    return {
      handle: String(i),
      type: "Line",
      layer: "0",
      grips: [
        [x, y],
        [x + 3, y + 2],
        [x + 6, y + 4],
      ],
      geometry: { type: "line", a: { x, y }, b: { x: x + 6, y: y + 4 } },
    };
  }),
  primitives: Array.from({ length: 24000 }, (_, i) => {
    const x = (i % 200) * 10,
      y = Math.floor(i / 200) * 10;
    return {
      handle: String(i),
      kind: "polyline",
      points: [
        [x, y],
        [x + 6, y + 4],
      ],
    };
  }),
};
const aids = new CadDraftingAids();

const paths = Array.from({ length: 24000 }, (_, i) => {
  const x = (i % 200) * 10,
    y = Math.floor(i / 200) * 10;
  return `<path class="C1" d="M${x} ${y}l6 4l-4 3"/>`;
}).join("");
const bytes = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1200"><style>.C1 {stroke: #000000; stroke-width: 1; stroke-opacity: 1; fill: none; fill-opacity: 1;}</style>${paths}</svg>`,
);
const source = drawingPreviewSource(bytes);
const surface = createRef<PanPreviewSurfaceHandle>();
const originalPost = Worker.prototype.postMessage;
const metrics = { sourceBytes: bytes.byteLength, posts: 0, copiedBytes: 0, postMs: 0 };
Worker.prototype.postMessage = function (message, ...rest) {
  const start = performance.now();
  const result = Reflect.apply(originalPost, this, [message, ...rest]);
  metrics.posts++;
  metrics.copiedBytes += message.bytes?.byteLength ?? 0;
  metrics.postMs += performance.now() - start;
  return result;
};
const initial = { x: 0, y: 0, width: 2000, height: 1200 };
let camera = initial;
let update = (_view: DrawingView) => {};
function Fixture() {
  const [view, setView] = useState(initial);
  update = setView;
  return (
    <PanPreviewSurface ref={surface} view={view} imageCoverage composited>
      {(frame) => (
        <CadDrawingPreview
          source={source}
          sourceKind="dwg"
          pageNumber={1}
          width={2000}
          height={1200}
          view={frame.view}
          infinite
          onPending={() => {}}
          onPainted={() => {}}
          onError={(message) => {
            throw Error(message);
          }}
        />
      )}
    </PanPreviewSurface>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
window.cadDisplayProbe = {
  metrics,
  begin() {
    surface.current!.begin();
  },
  move(x: number, y: number) {
    const scale = Math.min(1000 / camera.width, 600 / camera.height);
    surface.current!.move({ ...camera, x: camera.x - x / scale, y: camera.y - y / scale }, x, y);
  },
  end(x: number, y: number) {
    const scale = Math.min(1000 / camera.width, 600 / camera.height);
    camera = { ...camera, x: camera.x - x / scale, y: camera.y - y / scale };
    surface.current!.settle(camera);
    update(camera);
  },
  zoom(factor: number) {
    const width = 2000 / factor,
      height = 1200 / factor;
    camera = {
      x: camera.x + (camera.width - width) / 2,
      y: camera.y + (camera.height - height) / 2,
      width,
      height,
    };
    update(camera);
  },
  snap(i: number) {
    return aids.resolve({ x: 1000 + i / 10, y: 600 + i / 20 }, scene, 1, {
      hover: true,
      anchor: { x: 900, y: 500 },
      tangent: true,
    });
  },
};
declare global {
  interface Window {
    cadDisplayProbe: {
      metrics: typeof metrics;
      begin(): void;
      move(x: number, y: number): void;
      end(x: number, y: number): void;
      zoom(factor: number): void;
      snap(i: number): unknown;
    };
  }
}
