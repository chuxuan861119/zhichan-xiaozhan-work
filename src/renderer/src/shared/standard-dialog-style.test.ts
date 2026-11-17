import { readFileSync } from "node:fs";

const css = readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8");
const appCss = readFileSync("src/renderer/src/app/app.css", "utf8");

test("standalone settings style the icon button, not the clickable backdrop", () => {
  for (const file of ["ai-correction-settings-dialog", "shortcut-settings-dialog"]) {
    const source = readFileSync(`src/renderer/src/settings/${file}.tsx`, "utf8");
    expect(source).not.toMatch(/className="[^"]*backdrop[^"]*dialog-close-control/u);
    const controls = [
      ...source.matchAll(/<button\b(?:(?!<button)[\s\S])*?<DialogCloseIcon\s*\/>/gu),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const [control] of controls) expect(control).toContain("dialog-close-control");
  }
});

test("uses the patent editor's compact native surface metrics", () => {
  expect(css).toMatch(/--standard-dialog-radius:\s*var\(--ui-radius-window, 12px\);/u);
  expect(css).toMatch(/--standard-dialog-control-radius:\s*6px;/u);
  expect(css).toMatch(/--standard-dialog-control-height:\s*34px;/u);
  expect(css).toMatch(
    /\.standard-dialog\s*\{[^}]*border:\s*1px solid var\(--ui-window-border, #d5d9e0\);[^}]*border-radius:\s*var\(--standard-dialog-radius\);[^}]*box-shadow:\s*var\(--ui-shadow-dialog,/su,
  );
});

test("keeps the title and action bars white and compact", () => {
  expect(css).toMatch(
    /\.standard-dialog__header\s*\{[^}]*min-height:\s*54px;[^}]*background:\s*#fff;[^}]*border-bottom:/su,
  );
  expect(css).toMatch(
    /\.standard-dialog__footer\s*\{[^}]*min-height:\s*58px;[^}]*background:\s*#fff;[^}]*border-top:/su,
  );
});

test("uses editor-density footer controls with the existing project blue", () => {
  expect(css).toMatch(
    /\.standard-dialog__footer button\s*\{[^}]*min-height:\s*var\(--standard-dialog-control-height\);[^}]*border-radius:\s*var\(--standard-dialog-control-radius\);/su,
  );
  expect(css).toMatch(
    /\.standard-dialog__footer \.primary-button\s*\{[^}]*background:\s*#2563eb;[^}]*border-color:\s*#2563eb;/su,
  );
});

test("keeps the specialized settings workspace on the same native surface", () => {
  expect(appCss).toMatch(
    /\.application-settings-dialog__backdrop\s*\{[^}]*background:\s*rgb\(15 23 42 \/ 38%\);/su,
  );
  expect(appCss).toMatch(
    /\.application-settings-dialog__surface\s*\{[^}]*border:\s*1px solid var\(--ui-window-border, #d5d9e0\);[^}]*border-radius:\s*var\(--ui-radius-window, 12px\);[^}]*box-shadow:\s*var\(--ui-shadow-dialog,/su,
  );
  expect(appCss).toMatch(
    /\.application-settings-dialog__header\s*\{[^}]*min-height:\s*67px;[^}]*padding:\s*0 25px;[^}]*background:\s*#fff;/su,
  );
});

test("uses the project-blue keyboard focus treatment on dialog close controls", () => {
  expect(css).toMatch(
    /\.standard-dialog__close:focus-visible\s*\{[^}]*outline:\s*2px solid #bfdbfe;[^}]*outline-offset:\s*1px;/su,
  );
  expect(appCss).toMatch(
    /\.application-settings-dialog__header\s*>\s*button:focus-visible\s*\{[^}]*outline:\s*2px solid #bfdbfe;[^}]*outline-offset:\s*1px;/su,
  );
});

test("movable dialog title bars and their controls keep the normal arrow cursor", () => {
  const movableHeader =
    css.match(/\.standard-dialog--movable \.standard-dialog__header \{[^}]*\}/u)?.[0] ?? "";
  const sharedTitleBar =
    css.match(/\.standard-dialog \.dialog-titlebar--draggable \{[^}]*\}/u)?.[0] ?? "";
  const titleBarControls =
    css.match(
      /\.standard-dialog--movable \.standard-dialog__header button,[\s\S]*?__header select \{[^}]*\}/u,
    )?.[0] ?? "";

  expect(movableHeader).toContain("cursor: default");
  expect(sharedTitleBar).toContain("cursor: default");
  expect(titleBarControls).toContain("cursor: default");
  expect(`${movableHeader}${sharedTitleBar}${titleBarControls}`).not.toContain("cursor: move");
  expect(titleBarControls).not.toContain("cursor: pointer");
});
