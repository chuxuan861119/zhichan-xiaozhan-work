import "../../../src/renderer/src/automation-render";
import { renderDrawing } from "../../../src/renderer/src/drawing-markup/render";
import { cadSemanticKey } from "../../../src/shared/drawing-markup/cad-semantic-key";
import type { DrawingProject } from "../../../src/shared/drawing-markup/model";

async function probe(native: boolean, auto: boolean, overlay = false, automation = false) {
  const project = {
    projectId: "p",
    name: "图",
    sourceAssetId: "s",
    baseAssetId: "b",
    sourceKind: "dxf",
    pageNumber: 1,
    width: 100,
    height: 100,
    regions: [],
    warnings: [],
    revision: 1,
    annotations: [{ id: "a", text: "12", x: 80, y: 80, fontSize: 8, lineWidth: 1, points: [] }],
    cad: {
      version: 1,
      engine: "cadcraft",
      engineVersion: "0".repeat(40),
      assetId: "c",
      mapping: { originX: 0, originY: 100, scale: 1 },
      unified: 1,
      objects: [{ id: "a", kind: "label", label: ["A"] }],
    },
  } as DrawingProject;
  project.cad!.semanticKey = cadSemanticKey(project);
  if (overlay) {
    project.sourceKind = "image";
    project.cad!.overlayAssetId = "overlay";
    project.cad!.backgroundSize = [100, 100];
  }
  if (!native) {
    project.annotations[0]!.text = "13";
    project.cad!.objects = [];
    project.cad!.semanticKey = cadSemanticKey(project);
  }
  const region = {
    id: "r",
    name: "图1",
    kind: "rectangle" as const,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  };
  const bare = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="45" y="45" width="10" height="10" fill="black"/></svg>`;
  // CAD patent-preview SVG intentionally hides the native PW_LABEL proxy group.
  // The image composer must paint its semantic label once, including after CAD sync.
  const source = bare;
  const textCalls: string[] = [];
  const original = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
    textCalls.push(text);
    return original.call(this, text, ...args);
  };
  try {
    if (automation) {
      const encoded = btoa(source);
      const result = await window.automationRender({
        kind: "drawing",
        source: encoded,
        mediaType: "image/svg+xml",
        project,
        region,
        widthMm: 120,
        dpi: 300,
        autoAdjustLabelSize: auto,
        ...(overlay ? { frozenCadSources: { overlay: encoded } } : {}),
      });
      if ("error" in result) throw new Error(result.error);
      return { calls: textCalls, bytes: atob(result.data).length };
    }
    const result = await renderDrawing(
      project,
      region,
      new TextEncoder().encode(source),
      "image/svg+xml",
      120,
      300,
      {
        autoAdjustLabelSize: auto,
        nativeLabelsRemoved: auto,
        ...(overlay
          ? {
              readCadDetail: async () => new TextEncoder().encode(bare),
              ...(auto ? { labelFreeCadOverlay: new TextEncoder().encode(bare) } : {}),
            }
          : {}),
      },
    );
    return { calls: textCalls, bytes: result.bytes.byteLength };
  } finally {
    CanvasRenderingContext2D.prototype.fillText = original;
  }
}

(window as unknown as { nativeLabelProbe: typeof probe }).nativeLabelProbe = probe;

async function viewportProbe(mode: "native" | "clipped" | "image" | "overlay", auto: boolean) {
  const project = {
    width: 100,
    height: 100,
    sourceKind: mode === "image" || mode === "overlay" ? "image" : "dxf",
    annotations: [],
    detailViews: [],
    cad: {
      unified: 1,
      mapping: { originX: 0, originY: 100, scale: 1 },
      ...(mode === "overlay" ? { overlayAssetId: "overlay" } : {}),
    },
    ...(mode === "clipped"
      ? {
          baseFragments: [
            {
              id: "clip",
              offset: { x: 0, y: 0 },
              holes: [],
              clips: [
                [
                  { x: 0, y: 0 },
                  { x: 100, y: 0 },
                  { x: 100, y: 100 },
                  { x: 0, y: 100 },
                ],
              ],
            },
          ],
        }
      : {}),
  } as unknown as DrawingProject;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="10 20 100 100">${[
    [-20, 50],
    [120, 50],
    [50, -20],
    [50, 120],
    [50, 50],
  ]
    .map(([x, y]) => `<rect x="${x! + 5}" y="${y! + 15}" width="10" height="10" fill="black"/>`)
    .join("")}</svg>`;
  const bytes = new TextEncoder().encode(svg);
  const rendered = await renderDrawing(
    project,
    {
      id: "r",
      name: "r",
      kind: "rectangle",
      points: [
        { x: -40, y: -40 },
        { x: 140, y: -40 },
        { x: 140, y: 140 },
        { x: -40, y: 140 },
      ],
    },
    bytes,
    "image/svg+xml",
    120,
    300,
    { autoAdjustLabelSize: auto, readCadDetail: async () => bytes },
  );
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(rendered.bytes)], { type: "image/jpeg" }),
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const seen = new Uint8Array(canvas.width * canvas.height);
  let components = 0;
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || data[i * 4]! > 128) continue;
    const queue = [i];
    seen[i] = 1;
    for (let j = 0; j < queue.length; j++) {
      const p = queue[j]!;
      for (const q of [
        p - canvas.width,
        p + canvas.width,
        ...(p % canvas.width ? [p - 1] : []),
        ...(p % canvas.width < canvas.width - 1 ? [p + 1] : []),
      ]) {
        if (q >= 0 && q < seen.length && !seen[q] && data[q * 4]! < 128) {
          seen[q] = 1;
          queue.push(q);
        }
      }
    }
    if (queue.length > 20) components++;
  }
  return components;
}
(window as unknown as { viewportProbe: typeof viewportProbe }).viewportProbe = viewportProbe;
