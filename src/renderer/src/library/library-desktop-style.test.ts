import { readFileSync } from "node:fs";

const css = readFileSync("src/renderer/src/library/library-desktop.css", "utf8");

test("shares the list selection style between select-all, row checkboxes, and selection buttons", () => {
  expect(css).toMatch(
    /\.library-shell\s+:is\(\s*\.patent-list-select,\s*\.patent-list-row \.patent-export-checkbox,\s*\.patent-list-columns \.patent-export-checkbox\s*\)\s*\{[^}]*appearance:\s*none;[^}]*border:\s*1px solid #adbcd0;[^}]*border-radius:\s*5px;/su,
  );
});

test("preserves visible checked, mixed, and keyboard-focus states for list checkboxes", () => {
  expect(css).toMatch(/\.patent-export-checkbox:is\(:checked, :indeterminate\)\s*\{/u);
  expect(css).toMatch(/\.patent-export-checkbox:checked::after\s*\{/u);
  expect(css).toMatch(/\.patent-export-checkbox:indeterminate::after\s*\{/u);
  expect(css).toMatch(/\.patent-export-checkbox:focus-visible\s*\{/u);
});
