import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import {
  createDetailView,
  detailLeader,
  detailRatioText,
  nextDetailLabel,
  parseDetailRatio,
  resizeDetail,
} from "./detail-view.js";
import { leaderPoints } from "./label-layout.js";
import { DrawingProjectSchema } from "./model.js";
import { drawingProjectFixture } from "./test-fixture.js";

test("detail ratio describes geometry and rejects invalid input", () => {
  expect(parseDetailRatio("2:1")).toBe(2);
  expect(parseDetailRatio("1：2")).toBe(0.5);
  expect(parseDetailRatio("2.5")).toBe(2.5);
  for (const input of ["0:1", "1:0", "abc", "Infinity", "1000:1"])
    expect(parseDetailRatio(input)).toBeNull();
});
test("letters increment beyond Z and skip occupied names", () => {
  expect(nextDetailLabel("A", ["B", "C"])).toBe("D");
  expect(nextDetailLabel("Z", [])).toBe("AA");
  expect(nextDetailLabel("细节9", [])).toBe("细节10");
});
test("long numeric detail names advance without losing precision or looping on collisions", () => {
  const name = "A9007199254740992";
  expect(nextDetailLabel(name, [])).toBe("A9007199254740993");
  // A controlled timeout catches a non-advancing generator without hanging the suite.
  expect(
    runInNewContext(
      `(${nextDetailLabel.toString()})(name, occupied)`,
      {
        name,
        occupied: [name, "A9007199254740993", "A9007199254740994"],
      },
      { timeout: 200 },
    ),
  ).toBe("A9007199254740995");
});
test("generated detail names stay unique within the supported 100 character limit", () => {
  const previous = "Z".repeat(100);
  const occupied = [previous];
  for (let i = 0; i < 100; i++) {
    const name = nextDetailLabel(previous, occupied);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(occupied).not.toContain(name);
    occupied.push(name);
  }
});
test("detail survives serialization with independent source snapshot and scaling", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const detail = createDetailView(
    project,
    { x: 300, y: 300 },
    40,
    { x: 700, y: 200 },
    "A",
    2,
    12,
    1,
    "detail1",
  );
  expect(detail.fragments).toEqual(project.baseFragments);
  expect(detail.fragments).not.toBe(project.baseFragments);
  const changed = resizeDetail(detail, 3);
  expect(changed.radius * changed.ratio).toBe(120);
  expect(changed.source).toEqual(detail.source);
  expect(changed.title.y).toBeLessThan(changed.center.y - 120);
  const next = { ...project, detailViews: [changed] };
  expect(DrawingProjectSchema.parse(JSON.parse(JSON.stringify(next)))).toEqual(next);
  expect(DrawingProjectSchema.safeParse({ ...next, detailViews: [changed, changed] }).success).toBe(
    false,
  );
});

test("detail letters use the numeric leader endpoint and displayed ratio never quantizes geometry", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  const d = createDetailView(
    project,
    { x: 300, y: 300 },
    40,
    { x: 700, y: 200 },
    "A",
    2.34567,
    12,
    1,
    "a",
  );
  const points = detailLeader(d);
  expect(points).toHaveLength(2);
  expect(points).toEqual(
    leaderPoints({
      text: d.label,
      fontSize: d.fontSize,
      x: d.marker.x,
      y: d.marker.y,
      points: [points[0]!, d.marker],
    }),
  );
  expect(detailRatioText(d.ratio)).toBe("2.3:1");
  expect(d.ratio).toBe(2.34567);
  expect(detailRatioText(2.36)).toBe("2.4:1");
});
test("displayed ratios round to one decimal while fractional input retains full precision", () => {
  expect(detailRatioText(1.25)).toBe("1.3:1");
  expect(detailRatioText(2)).toBe("2:1");
  for (const value of [0.1, 1.25, 2 / 3, 2.34567, 100])
    expect(parseDetailRatio(`${value}:1`)).toBe(value);
});
test("nested details snapshot the displayed parent scale and survive parent removal", () => {
  const project = drawingProjectFixture("00000000-0000-4000-8000-000000000901");
  project.detailViews = [];
  const a = createDetailView(
    project,
    { x: 300, y: 300 },
    50,
    { x: 700, y: 200 },
    "A",
    2,
    12,
    1,
    "a",
  );
  project.detailViews = [a];
  const b = createDetailView(
    project,
    { x: 700, y: 200 },
    30,
    { x: 900, y: 500 },
    "B",
    3,
    12,
    1,
    "b",
  );
  expect(b.sourceScale).toBe(2);
  expect(b.fragments[0]!.offset).toEqual({ x: 100, y: -400 });
  expect(b.fragments[0]!.clips.length).toBeGreaterThan(a.fragments[0]!.clips.length);
  project.detailViews = [b];
  const c = createDetailView(
    project,
    { x: 900, y: 500 },
    20,
    { x: 200, y: 700 },
    "C",
    4,
    12,
    1,
    "c",
  );
  expect(c.sourceScale).toBe(6);
  expect(c.fragments[0]!.offset).toEqual({ x: -900, y: -1300 });
  const saved = DrawingProjectSchema.parse(
    JSON.parse(JSON.stringify({ ...project, detailViews: [b, c] })),
  );
  expect(saved.detailViews).toEqual([b, c]);
});
