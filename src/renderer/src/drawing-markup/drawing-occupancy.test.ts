import { describe, expect, it } from "vitest";
import { cadFigureBounds, rasterFigureBounds, rasterInkBounds } from "./drawing-occupancy";

describe("figure bounds for patent-label arrangement", () => {
  it("maps visible CAD geometry to page units without including native label proxies", () => {
    const scene = {
      partial: false,
      entities: [
        { handle: "BODY", visible: true },
        { handle: "HIDDEN", visible: false },
        { handle: "LABEL", visible: true },
      ],
      primitives: [
        {
          handle: "BODY",
          kind: "polyline",
          points: [
            [10, 20],
            [30, 40],
          ],
        },
        { handle: "HIDDEN", kind: "polyline", points: [[-200, 400]] },
        { handle: "LABEL", kind: "polyline", points: [[-100, 500]] },
      ],
    };
    expect(
      cadFigureBounds(scene, { originX: 0, originY: 100, scale: 2 }, new Set(["LABEL"])),
    ).toEqual({ left: 20, top: 120, right: 60, bottom: 160 });
  });

  it("refuses a partial or unbounded CAD scene instead of guessing the figure", () => {
    const scene = {
      partial: true,
      entities: [],
      primitives: [
        {
          handle: "A",
          kind: "polyline",
          points: [
            [0, 0],
            [10, 10],
          ],
        },
      ],
    };
    const mapping = { originX: 0, originY: 0, scale: 1 };
    expect(cadFigureBounds(scene, mapping, new Set())).toBeNull();
    expect(
      cadFigureBounds(
        {
          ...scene,
          partial: false,
          primitives: [
            {
              handle: "A",
              kind: "ray",
              points: [
                [0, 0],
                [1, 0],
              ],
            },
          ],
        },
        mapping,
        new Set(),
      ),
    ).toBeNull();
  });

  it("finds visible ink within an image's white margin", () => {
    const rgba = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    for (let y = 2; y <= 6; y++)
      for (let x = 3; x <= 7; x++) {
        const index = (y * 10 + x) * 4;
        rgba[index] = 20;
        rgba[index + 1] = 20;
        rgba[index + 2] = 20;
      }
    expect(rasterInkBounds(rgba, 10, 10, 1000, 800)).toEqual({
      left: 300,
      top: 160,
      right: 800,
      bottom: 560,
    });
  });

  it("uses visible ink rather than the automatic full-sheet fragment", () => {
    const project = {
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
          holes: [],
        },
      ],
    };
    const ink = { left: 220, top: 260, right: 720, bottom: 470 };
    expect(rasterFigureBounds(project, ink)).toEqual(ink);
    const fragment = project.baseFragments[0];
    if (!fragment) throw new Error("缺少图纸片段");
    expect(
      rasterFigureBounds(
        {
          ...project,
          baseFragments: [{ ...fragment, offset: { x: 30, y: 40 }, scale: 2 }],
        },
        ink,
      ),
    ).toEqual({ left: 470, top: 560, right: 1470, bottom: 980 });
    const rotated = rasterFigureBounds(
      { ...project, baseFragments: [{ ...fragment, rotation: 90, offset: { x: 1000, y: 0 } }] },
      ink,
    );
    expect(rotated?.left).toBeCloseTo(530);
    expect(rotated?.top).toBeCloseTo(220);
    expect(rotated?.right).toBeCloseTo(740);
    expect(rotated?.bottom).toBeCloseTo(720);
    expect(rasterFigureBounds(project, null)).toBeNull();
  });
});
