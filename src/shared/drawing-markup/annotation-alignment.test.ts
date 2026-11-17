import { describe, expect, it } from "vitest";
import { alignSelectedAnnotations, snapLabelToAnnotations } from "./annotation-alignment.js";
import { leaderPoints, placeLabel } from "./label-layout.js";
import type { DrawingAnnotation } from "./model.js";

function mark(id: string, x: number, y: number): DrawingAnnotation {
  return {
    id,
    text: id,
    x,
    y,
    fontSize: 20,
    lineWidth: 1,
    points: [
      { x: x - 40, y: y + 60 },
      { x, y },
    ],
  };
}

describe("placing labels with alignment guides", () => {
  it("snaps the text center independently to nearby vertical and horizontal labels", () => {
    const existing = [mark("above", 100, 40), mark("left", 40, 100)];
    const draft = placeLabel({ x: 10, y: 20 }, { x: 104, y: 115 }, "3", 20, 1);
    expect(draft.x).toBe(104);
    expect(draft.y).toBe(100);
    const result = snapLabelToAnnotations(draft, existing, 6);
    expect([result.label.x, result.label.y]).toEqual([100, 100]);
    expect(result.guides).toEqual([
      { axis: "vertical", from: { x: 100, y: 40 }, to: { x: 100, y: 100 } },
      { axis: "horizontal", from: { x: 40, y: 100 }, to: { x: 100, y: 100 } },
    ]);
    expect(result.label.points[0]).toEqual({ x: 10, y: 20 });
    expect(result.label.points).toEqual(leaderPoints(result.label));
    expect(draft.x).toBe(104);
    expect(existing[0]?.x).toBe(100);
  });

  it("uses the nearest eligible reference and leaves a label outside the screen threshold free", () => {
    const draft = placeLabel({ x: 0, y: 0 }, { x: 106, y: 115 }, "4", 20, 1);
    const near = snapLabelToAnnotations(draft, [mark("far", 100, 20), mark("near", 105, 40)], 3);
    expect(near.label.x).toBe(105);
    expect(near.guides[0]?.from).toEqual({ x: 105, y: 40 });
    const free = snapLabelToAnnotations(draft, [mark("far", 100, 20)], 3);
    expect(free.label.x).toBe(draft.x);
    expect(free.guides).toEqual([]);
  });
});

describe("organizing selected labels", () => {
  const picture = { left: 0, top: 0, right: 600, bottom: 500 };

  it("distributes label boxes at equal visible gaps around their anchors", () => {
    const marks = [mark("1", 110, 100), mark("22", 290, 130), mark("333", 470, 160)];
    const result = alignSelectedAnnotations(
      marks,
      new Set(marks.map((a) => a.id)),
      "horizontal",
      picture,
    );
    if (!result) throw new Error("标号应能在图纸中排列");
    const sorted = [...result].sort((a, b) => a.x - b.x);
    const halfWidth = (a: DrawingAnnotation) =>
      Math.max(
        0.35,
        [...a.text].reduce((width, character) => width + (/^[0-9]$/.test(character) ? 0.7 : 1), 0) /
          2,
      ) * a.fontSize;
    const gaps = sorted
      .slice(1)
      .map((a, index) => a.x - halfWidth(a) - (sorted[index]!.x + halfWidth(sorted[index]!)));
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 5);
    expect(sorted[0]!.x - halfWidth(sorted[0]!)).toBeGreaterThan(picture.left);
    expect(sorted.at(-1)!.x + halfWidth(sorted.at(-1)!)).toBeLessThan(picture.right);
    expect(result.map((a) => a.y)).toEqual([result[0]!.y, result[0]!.y, result[0]!.y]);
    expect(result.map((a) => a.points[0])).toEqual(marks.map((a) => a.points[0]));
  });

  it("keeps a local group visible instead of spreading it across huge CAD bounds", () => {
    const marks = [mark("1", 200, 220), mark("2", 260, 245), mark("3", 320, 270)];
    const result = alignSelectedAnnotations(
      marks,
      new Set(marks.map((item) => item.id)),
      "horizontal",
      { left: 0, top: 0, right: 10000, bottom: 8000 },
    );
    if (!result) throw new Error("局部标号应能排列");
    const positions = result.map((item) => item.x).sort((a, b) => a - b);
    expect(positions[0]).toBeGreaterThan(150);
    expect(positions[2]).toBeLessThan(400);
    expect(positions[1]! - positions[0]!).toBeCloseTo(positions[2]! - positions[1]!, 5);
  });

  it("places a horizontal group outside the occupied figure instead of across its strokes", () => {
    const marks = [mark("13", 280, 130), mark("14", 370, 140), mark("15", 460, 150)];
    const figure = { left: 100, top: 100, right: 700, bottom: 500 };
    const result = alignSelectedAnnotations(
      marks,
      new Set(marks.map((item) => item.id)),
      "horizontal",
      { left: 0, top: -100, right: 900, bottom: 700 },
      { figure },
    );
    if (!result) throw new Error("图形外有足够空间");
    expect(result.every((item) => item.y + item.fontSize * 0.55 < figure.top)).toBe(true);
    const first = result[0];
    if (!first) throw new Error("缺少已整理标号");
    expect(figure.top - first.y - first.fontSize * 0.55).toBeCloseTo(first.fontSize * 4, 5);
    expect(new Set(result.map((item) => item.y)).size).toBe(1);
  });

  it("keeps labels close to the figure even when their previous text is far away", () => {
    const first = { ...mark("1", 2400, 140), points: [{ x: 300, y: 220 }, { x: 2400, y: 140 }] };
    const second = { ...mark("2", 2500, 150), points: [{ x: 400, y: 260 }, { x: 2500, y: 150 }] };
    const figure = { left: 100, top: 100, right: 700, bottom: 500 };
    const result = alignSelectedAnnotations(
      [first, second], new Set(["1", "2"]), "horizontal",
      { left: -1000, top: -1000, right: 4000, bottom: 2000 }, { figure },
    );
    if (!result) throw new Error("图形边缘应有整理空间");
    expect(result.every((item) => item.x > figure.left - 40 && item.x < figure.right + 40)).toBe(true);
    expect(result.every((item) => item.y > 0 && item.y < figure.top)).toBe(true);
  });

  it("uses the other side when the preferred outside row has no room", () => {
    const marks = [mark("1", 250, 120), mark("2", 350, 140)];
    const figure = { left: 100, top: 10, right: 700, bottom: 450 };
    const result = alignSelectedAnnotations(
      marks,
      new Set(["1", "2"]),
      "horizontal",
      { left: 0, top: 0, right: 900, bottom: 700 },
      { figure },
    );
    if (!result) throw new Error("图形下方有足够空间");
    expect(result.every((item) => item.y - item.fontSize * 0.55 > figure.bottom)).toBe(true);
  });

  it("leaves all labels untouched if neither outside side fits", () => {
    const marks = [mark("1", 250, 120), mark("2", 350, 140)];
    expect(
      alignSelectedAnnotations(
        marks,
        new Set(["1", "2"]),
        "horizontal",
        { left: 0, top: 0, right: 900, bottom: 700 },
        { figure: { left: 100, top: 0, right: 700, bottom: 700 } },
      ),
    ).toBeNull();
    expect(marks.map((item) => [item.x, item.y])).toEqual([[250, 120], [350, 140]]);
  });

  it("routes to the opposite side when a leader would run through an existing number", () => {
    const first = { ...mark("1", 200, 140), points: [{ x: 200, y: 220 }, { x: 200, y: 140 }] };
    const second = { ...mark("2", 300, 140), points: [{ x: 300, y: 220 }, { x: 300, y: 140 }] };
    const existing = { ...mark("other", 200, 150), text: "99", points: [] };
    const result = alignSelectedAnnotations(
      [first, second, existing],
      new Set(["1", "2"]),
      "horizontal",
      { left: 0, top: 0, right: 900, bottom: 700 },
      { figure: { left: 100, top: 100, right: 700, bottom: 500 } },
    );
    if (!result) throw new Error("图形下方可用");
    expect(result[0]!.y).toBeGreaterThan(500);
    expect(result[1]!.y).toBeGreaterThan(500);
    expect(result[2]).toBe(existing);
  });

  it("treats a leader ending on another leader as a crossing", () => {
    const first = { ...mark("1", 200, 140), points: [{ x: 200, y: 220 }, { x: 200, y: 140 }] };
    const second = { ...mark("2", 300, 140), points: [{ x: 300, y: 220 }, { x: 300, y: 140 }] };
    const existing = { ...mark("other", 800, 600), points: [{ x: 150, y: 150 }, { x: 200, y: 150 }] };
    const result = alignSelectedAnnotations(
      [first, second, existing], new Set(["1", "2"]), "horizontal",
      { left: 0, top: 0, right: 900, bottom: 700 },
      { figure: { left: 100, top: 100, right: 700, bottom: 500 } },
    );
    if (!result) throw new Error("图形下方可用");
    expect(result[0]!.y).toBeGreaterThan(500);
  });

  it("orders by leader anchors before distributing vertically, avoiding crossed leaders", () => {
    const high = {
      ...mark("high", 50, 400),
      points: [
        { x: 170, y: 100 },
        { x: 50, y: 400 },
      ],
    };
    const mid = {
      ...mark("mid", 60, 100),
      points: [
        { x: 180, y: 250 },
        { x: 60, y: 100 },
      ],
    };
    const low = {
      ...mark("low", 70, 200),
      points: [
        { x: 190, y: 400 },
        { x: 70, y: 200 },
      ],
    };
    const result = alignSelectedAnnotations(
      [low, high, mid],
      new Set(["high", "mid", "low"]),
      "vertical",
      picture,
    );
    if (!result) throw new Error("标号应能在图纸中排列");
    const byId = new Map(result.map((a) => [a.id, a]));
    expect(byId.get("high")!.y).toBeLessThan(byId.get("mid")!.y);
    expect(byId.get("mid")!.y).toBeLessThan(byId.get("low")!.y);
    const positions = ["high", "mid", "low"].map((id) => byId.get(id)!.y);
    expect(positions[1]! - positions[0]!).toBeCloseTo(positions[2]! - positions[1]!, 5);
    expect(new Set(result.map((a) => a.x)).size).toBe(1);
    expect(result.map((a) => a.points[0])).toEqual([low, high, mid].map((a) => a.points[0]));
  });

  it("does not move any label when equal spacing cannot fit without overlap", () => {
    const marks = [mark("long-one", 10, 50), mark("long-two", 20, 70), mark("long-three", 30, 90)];
    expect(
      alignSelectedAnnotations(marks, new Set(marks.map((a) => a.id)), "horizontal", {
        left: 0,
        top: 0,
        right: 90,
        bottom: 100,
      }),
    ).toBeNull();
    expect(marks.map((a) => [a.x, a.y])).toEqual([
      [10, 50],
      [20, 70],
      [30, 90],
    ]);
  });

  it("reserves full character width for Chinese label text", () => {
    const first = { ...mark("a", 25, 30), text: "汉汉汉" };
    const second = { ...mark("b", 85, 30), text: "字字字" };
    expect(
      alignSelectedAnnotations([first, second], new Set(["a", "b"]), "horizontal", {
        left: 0,
        top: 0,
        right: 115,
        bottom: 100,
      }),
    ).toBeNull();
  });

  it("leaves the drawing unchanged when every row crosses an existing leader", () => {
    const first = {
      ...mark("a", 450, 250),
      points: [
        { x: 400, y: 250 },
        { x: 450, y: 250 },
      ],
    };
    const second = {
      ...mark("b", 520, 250),
      points: [
        { x: 500, y: 300 },
        { x: 520, y: 250 },
      ],
    };
    const barrier = {
      ...mark("barrier", 415, 500),
      points: [
        { x: 415, y: 0 },
        { x: 415, y: 500 },
      ],
    };
    const source = [first, second, barrier];
    expect(alignSelectedAnnotations(source, new Set(["a", "b"]), "horizontal", picture)).toBeNull();
    expect(source[0]).toBe(first);
    expect(source[2]).toBe(barrier);
  });

  it("also checks bends in an existing leader, not only its last segment", () => {
    const first = {
      ...mark("a", 450, 250),
      points: [
        { x: 400, y: 250 },
        { x: 450, y: 250 },
      ],
    };
    const second = {
      ...mark("b", 520, 250),
      points: [
        { x: 500, y: 300 },
        { x: 520, y: 250 },
      ],
    };
    const barrier = {
      ...mark("barrier", 500, 500),
      points: [
        { x: 415, y: 0 },
        { x: 415, y: 500 },
        { x: 500, y: 500 },
      ],
    };
    expect(
      alignSelectedAnnotations(
        [first, second, barrier],
        new Set(["a", "b"]),
        "horizontal",
        picture,
      ),
    ).toBeNull();
  });

  it("moves the row away from a collinear leader overlap", () => {
    const first = {
      ...mark("a", 450, 250),
      points: [
        { x: 400, y: 250 },
        { x: 450, y: 250 },
      ],
    };
    const second = {
      ...mark("b", 520, 250),
      points: [
        { x: 500, y: 300 },
        { x: 520, y: 250 },
      ],
    };
    const existing = {
      ...mark("existing", 300, 250),
      points: [
        { x: 405, y: 250 },
        { x: 420, y: 250 },
      ],
    };
    const result = alignSelectedAnnotations(
      [first, second, existing],
      new Set(["a", "b"]),
      "horizontal",
      picture,
    );
    if (!result) throw new Error("另一条对齐线应当可用");
    expect(result[0]!.y).not.toBe(250);
    expect(result[0]!.y).toBe(result[1]!.y);
  });

  it("does not send a conflicting row to a distant CAD boundary", () => {
    const first = { ...mark("a", 450, 250), points: [{ x: 400, y: 250 }, { x: 450, y: 250 }] };
    const second = { ...mark("b", 520, 250), points: [{ x: 500, y: 300 }, { x: 520, y: 250 }] };
    const existing = {
      ...mark("existing", 300, 250),
      points: [{ x: 405, y: 250 }, { x: 420, y: 250 }],
    };
    const result = alignSelectedAnnotations(
      [first, second, existing],
      new Set(["a", "b"]),
      "horizontal",
      { left: 0, top: 0, right: 10000, bottom: 8000 },
    );
    if (!result) throw new Error("应能在附近找到无冲突的行");
    expect(result[0]!.y).toBeGreaterThan(150);
    expect(result[0]!.y).toBeLessThan(350);
  });

  it("keeps leader anchors and unselected labels while arranging a horizontal row", () => {
    const first = mark("a", 100, 80),
      second = mark("b", 200, 120),
      untouched = mark("c", 300, 200);
    const result = alignSelectedAnnotations(
      [first, second, untouched],
      new Set(["a", "b"]),
      "horizontal",
      { left: 0, top: 0, right: 400, bottom: 300 },
    );
    if (!result) throw new Error("标号应能在图纸中排列");
    const [alignedFirst, alignedSecond] = result;
    if (!alignedFirst || !alignedSecond) throw new Error("对齐结果缺少标号");
    expect(alignedFirst.x).toBeLessThan(alignedSecond.x);
    expect(alignedFirst.y).toBe(alignedSecond.y);
    expect([result[2]!.x, result[2]!.y]).toEqual([300, 200]);
    expect(alignedFirst.points[0]).toEqual(first.points[0]);
    expect(alignedSecond.points[0]).toEqual(second.points[0]);
    expect(alignedFirst.points).toEqual(leaderPoints(alignedFirst));
    expect(alignedSecond.points).toEqual(leaderPoints(alignedSecond));
    expect(result[2]).toBe(untouched);
  });

  it("arranges a vertical column and does nothing for fewer than two labels", () => {
    const first = mark("a", 80, 100),
      second = mark("b", 120, 200);
    const source = [first, second];
    const picture = { left: 0, top: 0, right: 200, bottom: 300 };
    const result = alignSelectedAnnotations(source, new Set(["a", "b"]), "vertical", picture);
    if (!result) throw new Error("标号应能在图纸中排列");
    expect(result[0]!.x).toBe(result[1]!.x);
    expect(result[0]!.y).toBeLessThan(result[1]!.y);
    expect(alignSelectedAnnotations(source, new Set(["a"]), "vertical", picture)).toBe(source);
  });
});
