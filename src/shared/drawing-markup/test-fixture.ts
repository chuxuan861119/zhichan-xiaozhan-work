import { createDetailView } from "./detail-view.js";
import type { DrawingProject } from "./model.js";
export function drawingProjectFixture(assetId: string): DrawingProject {
  const project: DrawingProject = {
    projectId: "00000000-0000-4000-8000-000000000801",
    name: "图纸工作稿",
    sourceAssetId: assetId,
    baseAssetId: assetId,
    sourceKind: "image",
    pageNumber: 1,
    width: 1000,
    height: 800,
    baseFragments: [
      {
        id: "original",
        offset: { x: 0, y: 0 },
        clips: [
          [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
            { x: 1000, y: 800 },
            { x: 0, y: 800 },
          ],
        ],
        holes: [
          [
            { x: 10, y: 10 },
            { x: 100, y: 10 },
            { x: 100, y: 90 },
            { x: 10, y: 90 },
          ],
        ],
      },
      {
        id: "moved-copy",
        offset: { x: 240, y: 80 },
        clips: [
          [
            { x: 10, y: 10 },
            { x: 100, y: 10 },
            { x: 100, y: 90 },
            { x: 10, y: 90 },
          ],
        ],
        holes: [],
      },
    ],
    annotations: [
      {
        id: "a1",
        text: "12",
        x: 200,
        y: 100,
        fontSize: 20,
        lineWidth: 1,
        points: [
          { x: 100, y: 200 },
          { x: 160, y: 100 },
        ],
      },
    ],
    regions: [
      {
        id: "r1",
        name: "图1",
        kind: "rectangle",
        points: [
          { x: 0, y: 0 },
          { x: 500, y: 0 },
          { x: 500, y: 500 },
          { x: 0, y: 500 },
        ],
      },
    ],
    warnings: [],
    revision: 0,
  };
  project.detailViews = [
    createDetailView(
      project,
      { x: 300, y: 300 },
      40,
      { x: 700, y: 200 },
      "A",
      2,
      12,
      1,
      "detail-fixture",
    ),
  ];
  project.detailViews.push(
    createDetailView(
      project,
      { x: 700, y: 200 },
      20,
      { x: 900, y: 500 },
      "B",
      3,
      12,
      1,
      "nested-detail-fixture",
    ),
  );
  project.detailViews[1]!.markerHidden = true;
  return project;
}
