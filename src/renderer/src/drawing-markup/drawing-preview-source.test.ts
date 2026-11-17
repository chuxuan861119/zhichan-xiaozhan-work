import { expect, test } from "vitest";
import { drawingPreviewSource } from "./drawing-preview-source";

test("preview component props do not enumerate binary payload bytes", () => {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  const source = drawingPreviewSource(bytes);
  // React development performance tracks enumerate changed object props.
  // Binary payload must remain an opaque resource, not millions of properties.
  expect(Object.keys(source).length).toBe(0);
  expect(source.read()).toBe(bytes);
  expect(drawingPreviewSource(bytes)).toBe(source);
  expect(drawingPreviewSource(bytes.slice())).not.toBe(source);
});
