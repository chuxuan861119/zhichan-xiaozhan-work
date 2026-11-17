import { renderDrawing } from "../../../src/renderer/src/drawing-markup/render";
import { drawingProjectFixture } from "../../../src/shared/drawing-markup/test-fixture";

export async function probe(
  auto: boolean,
  factor: number,
  margin: number,
  dpi: number,
  raster: boolean,
  hairline = false,
  partial = false,
  edgeLabels = false,
  edgeDetails = false,
) {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  project.sourceKind = raster ? "image" : "dwg";
  project.width = project.height = 1000 * factor;
  delete project.baseFragments;
  project.detailViews = [];
  if (edgeDetails) {
    project.detailViews = drawingProjectFixture(project.baseAssetId).detailViews!.map((d) => ({
      ...d,
      marker: { x: 999, y: 1 },
      title: { x: 500, y: 999 },
    }));
  }
  project.annotations = [
    {
      id: "label",
      text: "12",
      x: 420 * factor,
      y: 160 * factor,
      fontSize: 60 * factor,
      lineWidth: 1,
      points: [
        { x: 350 * factor, y: 240 * factor },
        { x: 390 * factor, y: 160 * factor },
      ],
    },
  ];
  const edge = margin * factor;
  if (edgeLabels) {
    project.annotations = [
      { ...project.annotations[0]!, x: 420, y: 1, text: "23" },
      { ...project.annotations[0]!, id: "right", x: 999, y: 160, text: "222" },
      { ...project.annotations[0]!, id: "outside", x: 1100, y: 160, text: "OUTSIDE" },
    ];
  }
  const region = {
    id: "crop",
    name: "图1",
    kind: "rectangle" as const,
    points: [
      { x: edge, y: edge },
      { x: 1000 * factor - edge, y: edge },
      { x: 1000 * factor - edge, y: 1000 * factor - edge },
      { x: edge, y: 1000 * factor - edge },
    ],
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${project.width}" height="${project.height}" viewBox="0 0 1000 1000"><rect x="250" y="250" width="500" height="400" fill="none" stroke="black" stroke-width="2"/><circle cx="500" cy="450" r="100" fill="none" stroke="black" stroke-width="2"/></svg>`;
  if (partial) {
    region.points = [
      { x: 200 * factor, y: 100 * factor },
      { x: 600 * factor, y: 100 * factor },
      { x: 600 * factor, y: 400 * factor },
      { x: 200 * factor, y: 400 * factor },
    ];
  }
  const inputSvg = hairline ? svg.replaceAll('stroke-width="2"', 'stroke-width="0.08"') : svg;
  let bytes = new TextEncoder().encode(inputSvg);
  if (raster) {
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([inputSvg], { type: "image/svg+xml" }));
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1000 * factor;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    URL.revokeObjectURL(image.src);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  const before = JSON.stringify(project);
  const labels: { font: number; line: number; scale: number; inside: boolean; text: string }[] = [];
  const original = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
    const m = this.measureText(text);
    const t = this.getTransform();
    labels.push({
      text,
      inside:
        (x - m.actualBoundingBoxLeft) * t.a + t.e >= 0 &&
        (x + m.actualBoundingBoxRight) * t.a + t.e <= this.canvas.width &&
        (y - m.actualBoundingBoxAscent) * t.d + t.f >= 0 &&
        (y + m.actualBoundingBoxDescent) * t.d + t.f <= this.canvas.height,
      font: Number(this.font.match(/([\d.]+)px/)?.[1]),
      line: this.lineWidth,
      scale: this.getTransform().a,
    });
    return original.call(this, text, x, y);
  };
  try {
    const result = await renderDrawing(
      project,
      region,
      bytes,
      raster ? "image/png" : "image/svg+xml",
      120,
      dpi,
      { autoAdjustLabelSize: auto },
    );
    const image = new Image();
    image.src = URL.createObjectURL(
      new Blob([Uint8Array.from(result.bytes)], { type: "image/jpeg" }),
    );
    await image.decode();
    document.body.replaceChildren(image);
    const sample = document.createElement("canvas");
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const ctx = sample.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const row = ctx.getImageData(
      Math.floor(sample.width * 0.85),
      Math.floor(sample.height * 0.5),
      Math.floor(sample.width * 0.15),
      1,
    ).data;
    let darkestEdge = 255;
    let darkPixels = 0;
    for (let i = 0; i < row.length; i += 4) {
      darkestEdge = Math.min(darkestEdge, row[i]!);
      if (row[i]! < 100) darkPixels++;
    }
    image.style.width = "600px";
    return {
      labels,
      darkestEdge,
      darkPixels,
      width: result.width,
      height: result.height,
      decodedWidth: image.naturalWidth,
      unchanged: JSON.stringify(project) === before,
    };
  } finally {
    CanvasRenderingContext2D.prototype.fillText = original;
  }
}
Object.assign(window, { autoLabelProbe: probe });

export async function probeNativeStrokeWeights(dpi: number) {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000902");
  project.sourceKind = "dwg";
  project.width = project.height = 400;
  project.annotations = [];
  project.detailViews = [];
  delete project.baseFragments;
  const region = {
    id: "native-strokes",
    name: "图1",
    kind: "rectangle" as const,
    points: [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 400 },
      { x: 0, y: 400 },
    ],
  };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" data-cad-stroke-unit="0.069333" viewBox="0 0 400 400" width="400" height="400">' +
    '<rect x="20" y="20" width="360" height="360" fill="none" stroke="#cccccc" stroke-width="0.069333"/>' +
    '<path d="M40 120H360" fill="none" stroke="#000000" stroke-width="0.069333"/>' +
    '<path d="M40 280H360" fill="none" stroke="#000000" stroke-width="0.138666"/></svg>';
  const result = await renderDrawing(
    project,
    region,
    new TextEncoder().encode(svg),
    "image/svg+xml",
    120,
    dpi,
  );
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(result.bytes)], { type: "image/jpeg" }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(Math.floor(canvas.width / 2), 0, 1, canvas.height).data;
    const runs: number[] = [];
    const ink: number[] = [];
    let count = 0;
    for (let y = Math.floor(canvas.height * 0.15); y < canvas.height * 0.85; y++) {
      if (pixels[y * 4]! < 128) count++;
      else if (count) {
        runs.push(count);
        let darkness = 0;
        for (let row = Math.max(0, y - count - 3); row < Math.min(canvas.height, y + 3); row++)
          darkness += 255 - pixels[row * 4]!;
        ink.push(darkness);
        count = 0;
      }
    }
    return { runs, ink, width: result.width, height: result.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
Object.assign(window, { nativeStrokeProbe: probeNativeStrokeWeights });
