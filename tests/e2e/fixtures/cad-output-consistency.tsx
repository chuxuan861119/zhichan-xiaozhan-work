import "../../../src/renderer/src/automation-render";
import { renderDrawing } from "../../../src/renderer/src/drawing-markup/render";
import { drawingProjectFixture } from "../../../src/shared/drawing-markup/test-fixture";
import { createBlankPatent } from "../../../src/shared/patent/defaults";
import { fitInsertedFigures } from "../../../src/shared/patent/figure-insertion-size";

async function probe(
  tall: boolean,
  labelScale = 1,
  dpi = 300,
  overlap = false,
  automation = false,
) {
  const patent = createBlankPatent({ patentType: "invention", name: "CAD尺寸回归" });
  const page = patent.books.find((book) => book.kind === "description-drawings")!.document.page;
  const assetId = "00000000-0000-4000-8000-000000000901";
  const project = drawingProjectFixture(assetId);
  project.sourceKind = "dwg";
  project.width = 1000;
  project.height = tall ? 4000 : 800;
  delete project.baseFragments;
  project.detailViews = [];
  project.annotations = [
    { id: "one", text: "12", x: 350, y: 120, fontSize: 12, lineWidth: 1, points: [] },
    {
      id: "two",
      text: "13",
      x: overlap ? 366 : 650,
      y: 120,
      fontSize: 12,
      lineWidth: 1,
      points: [],
    },
  ];
  const region = {
    id: "all",
    name: "图1",
    kind: "rectangle" as const,
    points: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: project.height },
      { x: 0, y: project.height },
    ],
  };
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${project.height}"><rect x="200" y="100" width="600" height="${project.height - 200}" fill="none" stroke="black" stroke-width="2"/></svg>`;
  const bytes = new TextEncoder().encode(source);
  const before = JSON.stringify(project);
  let lastFontPixels = 0;
  const original = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
    lastFontPixels = Number(this.font.match(/([\d.]+)px/)?.[1]) * this.getTransform().a;
    return original.call(this, text, x, y);
  };
  try {
    const options = { autoAdjustLabelSize: true, autoLabelScale: labelScale, fitToPage: page };
    const rendered = automation
      ? await window.automationRender({
          kind: "drawing",
          source: btoa(source),
          mediaType: "image/svg+xml",
          project,
          region,
          widthMm: 120,
          dpi: dpi as 300 | 600,
          ...options,
        })
      : await renderDrawing(project, region, bytes, "image/svg+xml", 120, dpi, options);
    if ("error" in rendered) throw new Error(rendered.error);
    const physicalWidth =
      (rendered as { widthMm?: number; outputWidthMm?: number }).widthMm ??
      (rendered as { outputWidthMm?: number }).outputWidthMm ??
      120;
    const asset = {
      assetId,
      kind: "image" as const,
      extension: "jpg" as const,
      originalName: "cad.jpg",
      mediaType: "image/jpeg",
      widthPx: rendered.width,
      heightPx: rendered.height,
      byteLength: 1,
      sha256: "a".repeat(64),
      previewByteLength: 1,
      previewSha256: "a".repeat(64),
    };
    const figure = {
      figureId: "00000000-0000-4000-8000-000000000902",
      assetId,
      widthMm: physicalWidth,
    };
    const [fitted] = fitInsertedFigures(patent, [figure], [asset], false, [figure.figureId]);
    return {
      error: null,
      unchanged: JSON.stringify(project) === before,
      widthMm: fitted!.widthMm,
      renderedWidthMm: physicalWidth,
      heightMm: (fitted!.widthMm * rendered.height) / rendered.width,
      fontMm: (lastFontPixels * fitted!.widthMm) / rendered.width,
    };
  } catch (error) {
    return { error: (error as Error).message, unchanged: JSON.stringify(project) === before };
  } finally {
    CanvasRenderingContext2D.prototype.fillText = original;
  }
}
Object.assign(window, { cadOutputConsistencyProbe: probe });
