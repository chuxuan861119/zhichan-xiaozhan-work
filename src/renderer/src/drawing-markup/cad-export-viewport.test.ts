import { expect, test } from "vitest";
import { cadExportViewport } from "./cad-export-viewport";

test("export viewport retains negative coordinates and nonzero native SVG origins", () => {
  const svg =
    '<svg width="2000" height="1600" viewBox="10 20 1000 800"><path d="M-100 -100L1100 900"/></svg>';
  const bytes = new TextEncoder().encode(svg);
  const result = new TextDecoder().decode(
    cadExportViewport(
      bytes,
      { width: 2000, height: 1600 },
      { x: -200, y: -200, width: 2400, height: 2000 },
    ),
  );
  expect(result).toContain('viewBox="-90 -80 1200 1000"');
  expect(result).toContain('width="2000" height="1667"');
  expect(result).toContain('<path d="M-100 -100L1100 900"/>');
  expect(new TextDecoder().decode(bytes)).toBe(svg);
});

test("invalid native frames fail instead of publishing incomplete output", () => {
  expect(() =>
    cadExportViewport(
      new TextEncoder().encode('<svg viewBox="0 0 0 10"/>'),
      { width: 100, height: 100 },
      { x: 0, y: 0, width: 10, height: 10 },
    ),
  ).toThrow("坐标无效");
});
