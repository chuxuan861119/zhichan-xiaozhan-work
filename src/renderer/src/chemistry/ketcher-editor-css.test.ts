/// <reference types="node" />

import { readFileSync } from "node:fs";

test("lets bottom ring templates use the same native sizing as move canvas", () => {
  const css = readFileSync("src/renderer/src/chemistry/ketcher-editor.css", "utf8");

  expect(css).not.toMatch(
    /\.ketcher-template-toolbar \[data-testid\^="template-"\](?: > svg)? \{/u,
  );
});
