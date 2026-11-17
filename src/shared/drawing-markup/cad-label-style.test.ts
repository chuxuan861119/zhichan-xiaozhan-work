import { expect, test } from "vitest";
import { cadLabelLineweight, cadLabelOutputWidth, cadLabelScreenWidth } from "./cad-label-style.js";
import type { DrawingProject } from "./model.js";

test("one physical leader weight is used at screen and export DPI, independent of old drawing-unit widths", () => {
  const p = { cad: { objects: [] } } as unknown as DrawingProject;
  expect(cadLabelLineweight(p, { id: "a" })).toBe(0.3);
  expect(cadLabelScreenWidth(0.3)).toBeCloseTo((0.3 * 96) / 25.4);
  expect(cadLabelOutputWidth(0.3, 96, 1)).toBeCloseTo(cadLabelScreenWidth(0.3));
  expect(cadLabelOutputWidth(0.3, 600, 1)).toBeCloseTo((cadLabelScreenWidth(0.3) * 600) / 96);
});
test("explicit native lineweight survives drawing coordinate rebasing and hairlines remain visible", () => {
  const p = {
    cad: {
      objects: [
        {
          id: "a",
          kind: "label",
          appearance: { label: { lineweight: 0.7, lineWidthAtEdit: 5.4 } },
        },
      ],
    },
  } as unknown as DrawingProject;
  expect(cadLabelLineweight(p, { id: "a" })).toBe(0.7);
  expect(cadLabelOutputWidth(0, 300, 1)).toBe(1);
});
