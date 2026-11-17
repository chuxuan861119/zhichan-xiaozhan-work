import { describe, expect, test } from "vitest";
import { resizedImageWidth, rotateImage, rotateImagePreservingSize } from "./image-transform";

describe("image transforms", () => {
  test("preserves image dimensions across all four quarter turns", () => {
    let geometry = { rotationDeg: 0 as 0 | 90 | 180 | 270, widthMm: 80 };
    for (const width of [50, 80, 50, 80]) {
      const next = rotateImagePreservingSize(geometry, 1.6, "right");
      if (!next) throw new Error("unexpected size limit");
      expect(next.widthMm).toBeCloseTo(width);
      geometry = next;
    }
    expect(geometry.rotationDeg).toBe(0);
    expect(rotateImagePreservingSize({ rotationDeg: 0, widthMm: 160 }, 0.5, "right")).toBeNull();
  });
  test("rotates only in quarter turns", () => {
    expect(rotateImage(270, "right")).toBe(0);
    expect(rotateImage(0, "left")).toBe(270);
  });

  test("resizes from the three supported corners and clamps the result", () => {
    expect(
      resizedImageWidth(
        { corner: "top-left", startX: 100, startWidthMm: 80, pointerId: 1, scale: 1 },
        62,
      ),
    ).toBe(90.05);
    expect(
      resizedImageWidth(
        { corner: "bottom-right", startX: 100, startWidthMm: 164, pointerId: 1, scale: 1 },
        200,
      ),
    ).toBe(165);
  });
});
