import { readFileSync } from "node:fs";

test("CAD label tool shares neutral and pressed colors with other tools", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");

  expect(css).toMatch(
    /\.drawing-toolbar > button\.drawing-tool-button\s*\{[^}]*background:\s*#f1f1f3;/su,
  );
  expect(css).toMatch(
    /button\.drawing-tool-button\[aria-pressed="true"\]\s*\{[^}]*color:\s*#194f88;[^}]*background:\s*#d6e5f8;/su,
  );
  expect(css).not.toContain('button[data-drawing-tool="label"][aria-pressed="true"]');
  expect(css).not.toContain('drawing-tool-button:not([data-drawing-tool="label"])');
});
