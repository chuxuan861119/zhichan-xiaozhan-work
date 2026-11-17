import { expect, test } from "vitest";
import { supportsCadAppearance } from "./cad-appearance-support";

test("ordinary and composite geometry supports all three properties together", () => {
  for (const type of ["Line", "Polyline", "Circle", "Arc", "Ellipse", "Spline", "Insert"])
    for (const key of ["color", "lineweight", "linetype"])
      expect(supportsCadAppearance({ handle: "1", layer: "0", type }, key)).toBe(true);
});

test("text, fills and masks expose only meaningful appearance controls", () => {
  for (const type of ["Text", "MText", "Solid", "Trace"]) {
    const entity = { handle: "1", layer: "0", type };
    expect(supportsCadAppearance(entity, "color")).toBe(true);
    expect(supportsCadAppearance(entity, "lineweight")).toBe(false);
    expect(supportsCadAppearance(entity, "linetype")).toBe(false);
  }
  const hatch = { handle: "1", layer: "0", type: "Hatch" };
  expect(supportsCadAppearance(hatch, "lineweight")).toBe(true);
  expect(supportsCadAppearance(hatch, "linetype")).toBe(false);
  expect(
    supportsCadAppearance(
      { ...hatch, geometry: { type: "Hatch", ...{ solid: true } } },
      "lineweight",
    ),
  ).toBe(false);
  expect(supportsCadAppearance({ ...hatch, type: "Wipeout" }, "color")).toBe(false);
  expect(supportsCadAppearance({ ...hatch, locked: true }, "color")).toBe(false);
});
