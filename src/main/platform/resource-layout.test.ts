import { join } from "node:path";
import { drawingRuntimeRoot } from "./resource-layout.js";

test("GUI and automation use installed resources even when Harmony reports unpackaged", () => {
  for (const platform of ["openharmony", "ohos", "darwin", "win32"]) {
    expect(drawingRuntimeRoot(true, platform, "/installed", "/checkout")).toBe(
      join("/installed", "resources", "drawing-converter"),
    );
  }
  expect(drawingRuntimeRoot(false, "ohos", "/installed", "/checkout")).toBe(
    join("/installed", "resources", "drawing-converter"),
  );
  expect(drawingRuntimeRoot(false, "darwin", "/installed", "/checkout")).toBe(
    join("/checkout", "resources", "drawing-converter"),
  );
});
