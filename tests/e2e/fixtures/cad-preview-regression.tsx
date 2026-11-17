import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CadDrawingPreview } from "../../../src/renderer/src/drawing-markup/cad-drawing-preview";
import { drawingPreviewSource } from "../../../src/renderer/src/drawing-markup/drawing-preview-source";
import { DetailViewImage } from "../../../src/renderer/src/drawing-markup/detail-view-layer";
import type { DrawingView } from "../../../src/renderer/src/drawing-markup/fixed-line-preview";
import { renderDrawing } from "../../../src/renderer/src/drawing-markup/render";
import { createDetailView } from "../../../src/shared/drawing-markup/detail-view";
import { drawingProjectFixture } from "../../../src/shared/drawing-markup/test-fixture";

const project = {
  ...drawingProjectFixture("source"),
  baseFragments: undefined,
  detailViews: [],
  width: 2000,
  height: 1600,
  sourceKind: "dwg" as const,
};
const bytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 800000"><path stroke="black" stroke-width="1000" d="M100000 400000H900000"/></svg>',
);
const base = { source: drawingPreviewSource(bytes), url: URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" })) };
const root = createRoot(document.getElementById("root")!);
const panBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800"><g transform="scale(1)"><circle cx="500.5" cy="400.4" r="0.04" fill="black"/></g></svg>',
);
const panSource = drawingPreviewSource(panBytes);
const center = { x: 1000, y: 800 };
function detail(ratio: number, nested: boolean) {
  const parent = createDetailView(project, center, 80, center, "A", 6, 12, 0.3, "a");
  return createDetailView(
    nested ? { ...project, detailViews: [parent] } : project,
    center,
    80,
    center,
    "B",
    ratio,
    12,
    0.3,
    "b",
  );
}
window.cadProbe = {
  pan(view: DrawingView) {
    flushSync(() =>
      root.render(
        <CadDrawingPreview
          source={panSource}
          sourceKind="dwg"
          pageNumber={1}
          width={1000}
          height={800}
          view={view}
          onPending={() => {}}
          onPainted={() => {}}
          onError={(message) => {
            throw Error(message);
          }}
        />,
      ),
    );
  },
  render(zoom: number, ratio: number, nested = false) {
    const scale = 0.4375 * zoom;
    const view = {
      x: 1000 - 1000 / zoom,
      y: 800 - 800 / zoom,
      width: 2000 / zoom,
      height: 1600 / zoom,
    };
    flushSync(() =>
      root.render(
        <DetailViewImage
          detail={detail(ratio, nested)}
          project={project}
          base={base}
          view={view}
          left={1000 - 450 / scale}
          top={800 - 350 / scale}
          unit={1 / scale}
          onError={(message) => {
            throw Error(message);
          }}
        />,
      ),
    );
  },
  async circle(ratio: number) {
    const d = { ...detail(ratio, false), markerHidden: true, titleHidden: true };
    const span = 100 * ratio;
    const result = await renderDrawing(
      { ...project, detailViews: [d], annotations: [] },
      {
        id: "circle",
        name: "",
        kind: "rectangle",
        points: [
          { x: 1000 - span, y: 800 - span },
          { x: 1000 + span, y: 800 - span },
          { x: 1000 + span, y: 800 + span },
          { x: 1000 - span, y: 800 + span },
        ],
      },
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 800000"/>',
      ),
      "image/svg+xml",
      100,
      300,
    );
    return Array.from(result.bytes);
  },
  async output(ratio: number, nested = false, crop = 1) {
    const result = await renderDrawing(
      { ...project, detailViews: [detail(ratio, nested)], annotations: [] },
      {
        id: "region",
        name: "",
        kind: "rectangle",
        points: [
          { x: 1000 - 1000 / crop, y: 800 - 800 / crop },
          { x: 1000 + 1000 / crop, y: 800 - 800 / crop },
          { x: 1000 + 1000 / crop, y: 800 + 800 / crop },
          { x: 1000 - 1000 / crop, y: 800 + 800 / crop },
        ],
      },
      bytes,
      "image/svg+xml",
      100,
      300,
    );
    return Array.from(result.bytes);
  },
};

declare global {
  interface Window {
    cadProbe: {
      pan(view: DrawingView): void;
      render(zoom: number, ratio: number, nested?: boolean): void;
      circle(ratio: number): Promise<number[]>;
      output(ratio: number, nested?: boolean, crop?: number): Promise<number[]>;
    };
  }
}
