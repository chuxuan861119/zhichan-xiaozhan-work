import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

test("table alignment overrides existing paragraph styles in the rendered editor", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const results = await page.evaluate(async () => {
      const { setSelectedCellAttribute } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      const results = [];
      for (const initial of ["left", "center", "right", "justify"]) {
        editor.commands.setContent(
          `<table><tr><td><p style="text-align:${initial}">sample</p></td></tr></table>`,
        );
        let position;
        editor.state.doc.descendants((node, offset) => {
          if (node.type.name === "paragraph" && node.textContent === "sample")
            position = offset + 1;
        });
        editor.commands.setTextSelection(position);
        for (const wanted of ["left", "center", "right"]) {
          const ok = setSelectedCellAttribute(editor, "horizontalAlignment", wanted);
          const cell = editor.view.dom.querySelector("td");
          const paragraph = cell.querySelector("p");
          results.push({
            initial,
            wanted,
            ok,
            cell: cell.dataset.horizontalAlignment,
            actual: getComputedStyle(paragraph).textAlign,
          });
        }
      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.ok, true);
      assert.equal(result.cell, result.wanted);
      assert.equal(result.actual, result.wanted, JSON.stringify(result));
    }
  } finally {
    await browser.close();
  }
});
