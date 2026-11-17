import { expect, test } from "vitest";
import { exportLabelFont, exportLeaderWidth } from "./export-label-style";

test("CAD uses light lettering at the same size and thinner leaders", () => {
  expect(exportLabelFont("dwg", 70)).toBe('300 70px "Segoe UI", Arial, sans-serif');
  expect(exportLeaderWidth("dwg", 0.25)).toBeCloseTo(0.18);
});
test("image and PDF output keep existing lettering and leaders", () => {
  for (const kind of ["image", "pdf"] as const) {
    expect(exportLabelFont(kind, 70)).toBe("400 70px Arial, sans-serif");
    expect(exportLeaderWidth(kind, 0.25)).toBe(0.25);
  }
});
