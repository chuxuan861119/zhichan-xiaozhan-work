import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const shared = `/@fs${new URL("../../src/shared/document/", import.meta.url).pathname}`;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

test("merged column geometry survives editing and reload in the browser", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const result = await page.evaluate(async (shared) => {
      const { tableRegressionDocument } = await import(`${shared}table-regression-fixture.ts`);
      const { createBlankBookDocument } = await import(`${shared}defaults.ts`);
      const { canonicalToTiptap, tiptapToPatentBookDocument } = await import(
        "/src/editor/model-adapter.ts"
      );
      const { createPatentExtensions } = await import("/src/editor/extensions.ts");
      const { document: fixture } = tableRegressionDocument();
      const base = { ...createBlankBookDocument("回归"), content: fixture.content };
      const mount = document.createElement("div");
      document.body.append(mount);
      const editor = new window.resizeTestEditor.constructor({
        element: mount,
        extensions: createPatentExtensions(),
        content: canonicalToTiptap(base),
      });
      try {
        const widths = () =>
          [...editor.view.dom.querySelectorAll("col")].map(
            (col) => col.getBoundingClientRect().width,
          );
        const before = widths();
        editor.commands.setTextSelection(4);
        editor.commands.insertContent("测试");
        const saved = tiptapToPatentBookDocument(editor.getJSON(), base, new Set());
        if (!saved.ok) throw new Error(JSON.stringify(saved));
        const afterEdit = widths();
        editor.commands.setContent(canonicalToTiptap(saved.value));
        const reloaded = tiptapToPatentBookDocument(editor.getJSON(), saved.value, new Set());
        return {
          before,
          afterEdit,
          afterReload: widths(),
          saved: saved.value.content,
          reloaded: reloaded.ok ? reloaded.value.content : reloaded,
        };
      } finally {
        editor.destroy();
        mount.remove();
      }
    }, shared);
    assert.deepEqual(result.afterEdit, result.before);
    assert.deepEqual(result.afterReload, result.before);
    assert.deepEqual(result.reloaded, result.saved);
    assert.ok(result.before[0] < result.before[1] && result.before[1] < result.before[2]);
  } finally {
    await browser.close();
  }
});

test("new and toggled headers agree visually and deletion clears the selected state", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const result = await page.evaluate(async () => {
      const { insertPatentTable, runTableCommand } = await import(
        "/src/editor/table/table-commands.ts"
      );
      const { inspectTableSelection } = await import("/src/editor/table/table-selection.ts");
      const editor = window.resizeTestEditor;
      editor.commands.setContent("<p></p>");
      insertPatentTable(editor, { rows: 3, columns: 2, headerRowCount: 1, layoutMode: "fit-page" });
      const firstPosition = () => {
        let pos;
        editor.state.doc.descendants((node, p) => {
          if (pos === undefined && ["tableCell", "tableHeader"].includes(node.type.name)) pos = p;
        });
        return pos;
      };
      editor.commands.setTextSelection(firstPosition() + 2);
      editor.commands.insertContent("原文");
      const style = () => {
        const cell = editor.view.dom.querySelector("th,td");
        const p = cell.querySelector("p");
        return {
          align: getComputedStyle(p).textAlign,
          vertical: getComputedStyle(cell).verticalAlign,
          bold: getComputedStyle(p).fontWeight,
        };
      };
      const created = style();
      runTableCommand(editor, "toggle-header-row");
      const disabled = style();
      runTableCommand(editor, "toggle-header-row");
      const enabled = style();
      runTableCommand(editor, "delete-row");
      const deleted = inspectTableSelection(editor).firstRowHeader;
      editor.commands.undo();
      const restored = inspectTableSelection(editor).firstRowHeader;
      return { created, disabled, enabled, deleted, restored };
    });
    assert.deepEqual(result.created, result.enabled);
    assert.equal(result.created.align, "center");
    assert.equal(result.created.vertical, "middle");
    assert.equal(result.created.bold, "700");
    assert.equal(result.disabled.bold, "400");
    assert.equal(result.deleted, false);
    assert.equal(result.restored, true);
  } finally {
    await browser.close();
  }
});
