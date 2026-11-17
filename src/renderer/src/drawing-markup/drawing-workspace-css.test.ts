import { readFileSync } from "node:fs";

test("trim object selection uses a pickbox without drafting crosshairs", () => {
  const css=readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css","utf8");
  expect(css).toContain('[data-cad-object-cursor="true"]');
  const svg=readFileSync("src/renderer/src/drawing-markup/cursors/pickbox.svg","utf8");
  expect(svg).toContain('<rect x="29" y="29" width="7" height="7"');
  expect(svg).not.toContain("<path");
});

test("CAD cursor assets use longer thin crosses and reserve the unchanged pick box for idle selection", () => {
  const cursor = readFileSync("src/renderer/src/drawing-markup/cursors/select.svg", "utf8");
  expect(cursor).toContain('width="96" height="96" viewBox="0 0 96 96"');
  expect(cursor).toContain('d="M48.5 1V95M1 48.5H95"');
  expect(cursor).not.toMatch(/<rect\b/u);
  expect(cursor).toContain('stroke-width="0.75"');
  const idle = readFileSync("src/renderer/src/drawing-markup/cursors/select-idle.svg", "utf8");
  expect(idle).toContain('width="96" height="96" viewBox="0 0 96 96"');
  expect(idle).toContain('<rect x="45" y="45" width="7" height="7"');
  expect(idle).toContain('stroke-width="0.75"');
});

test("the idle pick-box override excludes panning and requires an idle CAD selection", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");
  expect(css).toMatch(
    /svg\[role="application"\]\[data-cad-pickbox="true"\]\[data-space-pan="false"\]:not\(\s*\[data-panning="true"\]\s*\)\s*\{[^}]*cursor:\s*url\("\.\/cursors\/select-idle\.svg"\) 48 48,/su,
  );
});

test("native CAD editing uses the plain custom cross and leaves panning cursors intact", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");
  expect(css).toMatch(
    /\.drawing-workspace\s+svg\[role="application"\]\[data-cad-editing="true"\]\[data-space-pan="false"\]:not\(\s*\[data-panning="true"\]\s*\)\s*\{[^}]*cursor:\s*url\("\.\/cursors\/select\.svg"\) 48 48,/su,
  );
});

test("floats the drawing import wait window over the canvas without eating pointers", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");

  // 只铺画布区且不吃指针事件，页头的“取消导入”才是唯一且始终可点的那颗按钮。
  expect(css).toMatch(
    /\.drawing-import-progress\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*pointer-events:\s*none;/su,
  );
  // 绝对定位需要画布区自己当基准。
  expect(css).toMatch(/\.drawing-stage\s*\{[^}]*position:\s*relative;/su);
  expect(css).toMatch(
    /\.drawing-import-progress__spinner\s*\{[^}]*animation:\s*drawing-import-spin 700ms linear infinite;/su,
  );
  expect(css).toMatch(/@keyframes drawing-import-spin\s*\{/su);
});

test("mounts the CAD markup function rail in the canvas grid cell without styling it", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");

  // 功能栏作用域与画布共用同一个网格单元（第 3 行 / 第 2 列），只铺画布、不吃指针事件。
  expect(css).toMatch(
    /\.drawing-workspace-content\s*>\s*\.patent-function-rail-scope\s*\{[^}]*grid-area:\s*3\s*\/\s*2;[^}]*pointer-events:\s*none;/su,
  );
  // 画布里的通用元素规则保持原作用范围，但必须把功能栏作用域整棵子树排除掉，
  // 否则会盖掉悬浮功能栏自己的外观。
  expect(css).toMatch(
    /\.drawing-workspace button:where\(:not\(\.patent-function-rail-scope \*\)\),/u,
  );
  expect(css).not.toMatch(/^\.drawing-workspace\s+(?:button|input|select|h3|label|p)\s*[,{]/mu);
  // 用 :where(:not(...)) 而不是 :not(...)：:where() 不贡献特异性，选择器仍是 (0,1,1)。
  expect(css).not.toMatch(/:not\(\.patent-function-rail-scope\)/u);
});

test("keeps the CAD canvas in the dedicated grid row when the function rail is mounted", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");

  // The rail is an additional direct grid child. Explicit rows prevent CSS grid auto-placement
  // from moving the status bar to an implicit row and collapsing the canvas to zero height.
  expect(css).toMatch(/\.drawing-header\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/su);
  expect(css).toMatch(/\.drawing-toolbar\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/su);
  expect(css).toMatch(/\.drawing-layout\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*3;/su);
  expect(css).toMatch(/\.drawing-status\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*4;/su);
});

test("keeps toolbar state changes from changing the canvas row geometry", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");

  // The toolbar is a fixed-height horizontal strip. Narrow windows scroll its
  // controls instead of wrapping them into a new line that pushes the canvas.
  expect(css).toMatch(
    /\.drawing-workspace-content\s*\{[^}]*grid-template-rows:\s*56px\s+56px\s+minmax\(0,\s*1fr\)\s+42px;/su,
  );
  expect(css).toMatch(
    /\.drawing-toolbar\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/su,
  );
  expect(css).toMatch(
    /\.drawing-toolbar:has\(\.drawing-more\[open\]\)[\s\S]*\.drawing-toolbar:has\(\.drawing-detail-settings\[open\]\)[\s\S]*overflow:\s*visible;/u,
  );
  expect(css).toMatch(
    /\.drawing-status\s*\{[^}]*grid-row:\s*4;[^}]*flex-wrap:\s*nowrap;[^}]*overflow:\s*hidden;/su,
  );
});

test("CAD detail controls use compact rail spacing with full-width fields and an inline defaults area", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");
  expect(css).toMatch(
    /\.cad-detail-controls\s*\{[^}]*display:\s*grid;[^}]*gap:\s*10px;[^}]*margin:\s*0 0 12px;/su,
  );
  expect(css).toMatch(
    /\.cad-detail-controls > label input\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/su,
  );
  expect(css).toMatch(
    /\.cad-detail-controls \.drawing-style-popover\s*\{[^}]*position:\s*static;[^}]*width:\s*auto;/su,
  );
});

test("detail actions and scale buttons form compact rows rather than full-width grid items", () => {
  const css = readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8");
  expect(css).toMatch(
    /\.cad-detail-controls \.drawing-detail-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/su,
  );
  expect(css).toMatch(
    /\.cad-detail-controls \.drawing-detail-scale\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/su,
  );
});
