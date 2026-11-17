import { createBlankPatent } from "./defaults.js";
import { CanonicalPatentSchema } from "./model.js";

test("accepts and preserves an editable drawing project with annotations and a saved freehand region", () => {
  const project = {
    projectId: "00000000-0000-4000-8000-000000000801",
    name: "图纸工作稿",
    sourceAssetId: "00000000-0000-4000-8000-000000000802",
    baseAssetId: "00000000-0000-4000-8000-000000000802",
    sourceKind: "image",
    pageNumber: 1,
    width: 1000,
    height: 800,
    annotations: [
      {
        id: "mark-1",
        text: "12",
        x: 150,
        y: 100,
        fontSize: 20,
        lineWidth: 1.5,
        points: [
          { x: 70, y: 170 },
          { x: 120, y: 100 },
        ],
      },
    ],
    regions: [
      {
        id: "region-1",
        name: "图1",
        points: [
          { x: 0, y: 0 },
          { x: 300, y: 0 },
          { x: 200, y: 200 },
        ],
        kind: "lasso",
      },
    ],
    warnings: [],
    revision: 0,
  };
  const asset = {
    assetId: project.sourceAssetId,
    kind: "image",
    originalName: "source.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 1000,
    heightPx: 800,
    previewByteLength: 10,
    previewSha256: "B".repeat(64),
  };
  const result = CanonicalPatentSchema.safeParse({
    ...createBlankPatent({ patentType: "utility-model", name: null }),
    assets: [asset],
    drawingProjects: [project],
  });
  expect(result.success).toBe(true);
  if (result.success)
    expect((result.data as unknown as { drawingProjects: unknown[] }).drawingProjects).toEqual([
      project,
    ]);
});
