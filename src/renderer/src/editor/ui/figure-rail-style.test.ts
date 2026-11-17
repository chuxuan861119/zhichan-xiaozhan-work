import { readFileSync } from "node:fs";

test("image alignment and layout buttons share table settings selected styling", () => {
  const css = readFileSync("src/renderer/src/editor/editor.css", "utf8");
  expect(css).toMatch(
    /\.table-rail-panel__button\.is-active,\s*\.figure-rail-panel__alignments button\[aria-pressed="true"\],\s*\.figure-rail-panel__actions button\[aria-pressed="true"\]\s*\{\s*color: #2563eb;\s*background: #eaf2fb;\s*border-color: #a9c5e8;\s*box-shadow: 0 1px 2px rgb\(37 99 235 \/ 6%\);\s*font-weight: 600;/,
  );
  const appCss = readFileSync("src/renderer/src/app/app.css", "utf8");
  expect(appCss).not.toContain('.figure-rail-panel__actions button[aria-pressed="true"]');
});
