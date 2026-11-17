// @vitest-environment node
import { readFileSync } from "node:fs";

test("hides the divider above an editing reference mark without removing its card border", () => {
  const css = readFileSync(
    "src/renderer/src/patents/function-rail/function-rail-appearance.css",
    "utf8",
  );

  expect(css).toMatch(
    /\.reference-mark-panel__rows > div:not\(\.is-editing\):has\(\+ \.is-editing\)[^{]*\{[^}]*border-bottom-color:\s*transparent;/su,
  );
  expect(css).toMatch(
    /\.reference-mark-panel__columns:has\(\+ \.reference-mark-panel__rows > \.is-editing:first-child\)[^{]*\{[^}]*border-bottom-color:\s*transparent;/su,
  );
  expect(css).toMatch(
    /\.reference-mark-panel__rows > div\.is-editing\s*\{[^}]*border:\s*1px solid var\(--editor-display-panel-line,/su,
  );
});
