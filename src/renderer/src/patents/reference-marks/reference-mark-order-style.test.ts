import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(
  "src/renderer/src/patents/reference-marks/reference-mark-order.css",
  "utf8",
);

test("number handles stay visually still on pointer hover", () => {
  expect(css).toMatch(/\.reference-mark-panel__drag-handle\s*\{[^}]*transition:\s*none;[^}]*\}/su);
  expect(css).not.toMatch(/\.reference-mark-panel__drag-handle:not\(:disabled\):hover/su);
});

test("other number handles cannot be hovered during a drag", () => {
  expect(css).toMatch(
    /html\[data-reference-mark-dragging="true"\][^{]*\.reference-mark-panel__drag-handle\s*\{[^}]*pointer-events:\s*none;[^}]*\}/su,
  );
});
