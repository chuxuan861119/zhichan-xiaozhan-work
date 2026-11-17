import { expect, test } from "vitest";
import { baseFragments } from "../../../shared/drawing-markup/base-fragments";
import { drawingProjectFixture } from "../../../shared/drawing-markup/test-fixture";
import { drawingFitBounds, drawingPaperBounds } from "./drawing-paper";

test("fit includes native CAD outside every edge without changing the saved coordinate frame", () => {
  const project = drawingProjectFixture("source");
  const before = structuredClone(project);
  const native = { x: -2000, y: -3000, width: 6000, height: 8000 };
  const fit = drawingFitBounds(project, native);
  expect(fit.x).toBeLessThan(native.x);
  expect(fit.y).toBeLessThan(native.y);
  expect(fit.x + fit.width).toBeGreaterThan(native.x + native.width);
  expect(fit.y + fit.height).toBeGreaterThan(native.y + native.height);
  expect(project).toEqual(before);
  expect(drawingFitBounds(project, { x: 0, y: 0, width: NaN, height: 1 })).toEqual(drawingFitBounds(project));
});

test("paper follows moved and pasted fragments in every direction without changing the source", () => {
  const project = drawingProjectFixture("source");
  const original = structuredClone(project);
  const fragment = baseFragments(project)[0]!;
  const moved = {
    ...project,
    baseFragments: [
      { ...fragment, offset: { x: -3000, y: -2000 } },
      { ...fragment, id: "copy", offset: { x: 4000, y: 5000 }, scale: 2 },
    ],
  };
  const paper = drawingPaperBounds(moved);
  expect(paper.x).toBeLessThanOrEqual(-3000);
  expect(paper.y).toBeLessThanOrEqual(-2000);
  expect(paper.x + paper.width).toBeGreaterThanOrEqual(4000 + project.width * 2);
  expect(paper.y + paper.height).toBeGreaterThanOrEqual(5000 + project.height * 2);
  expect(project).toEqual(original);
});

test("paper includes the source circle, leader and long detail title", () => {
  const project = drawingProjectFixture("source");
  const detail = project.detailViews![0]!;
  detail.source = { x: -3000, y: -2000 };
  detail.marker = { x: 6000, y: 5000 };
  detail.label = "ABCDEFGHIJKLMNOPQRST";
  detail.title = { x: -4000, y: 100 };
  const paper = drawingPaperBounds(project);
  expect(paper.x).toBeLessThan(-4000 - detail.fontSize * 2);
  expect(paper.y).toBeLessThanOrEqual(-2000 - detail.radius);
  expect(paper.x + paper.width).toBeGreaterThan(6000);
  expect(paper.y + paper.height).toBeGreaterThan(5000);
});

test("fit includes moved content and ignores hidden detail markers", () => {
  const project = drawingProjectFixture("source");
  const d = project.detailViews![0]!;
  d.marker = { x: 5000, y: -4000 };
  expect(drawingFitBounds(project).y).toBeLessThan(-4000);
  d.markerHidden = true;
  expect(drawingFitBounds(project).y).toBeGreaterThan(-1000);
  project.baseFragments![0]!.offset = { x: 8000, y: 0 };
  const box = drawingFitBounds(project);
  expect(box.x + box.width).toBeGreaterThan(9000);
});

test("fit respects the zoom floor for a tiny remaining fragment", () => {
  const project = drawingProjectFixture("source");
  project.annotations = [];
  project.detailViews = [];
  project.baseFragments = [
    {
      id: "tiny",
      offset: { x: 0, y: 0 },
      clips: [
        [
          { x: 500, y: 400 },
          { x: 500.001, y: 400 },
          { x: 500.001, y: 400.001 },
          { x: 500, y: 400.001 },
        ],
      ],
      holes: [],
    },
  ];
  const fit = drawingFitBounds(project);
  expect(fit.width).toBeGreaterThanOrEqual(1.08);
  expect(fit.x + fit.width / 2).toBeCloseTo(500.0005);
});
