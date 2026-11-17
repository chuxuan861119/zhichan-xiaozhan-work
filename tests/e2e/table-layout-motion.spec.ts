import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type {} from "@tiptap/extensions/undo-redo";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test.beforeEach(async ({ page }) => {
  await page.goto(`http://127.0.0.1:5173/@fs${resolve("tests/e2e/fixtures/table-resize.html")}`);
  await page.waitForFunction(() => "resizeTestEditor" in window);
});

test("table layout commands animate paint without changing text or undo results", async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const path = "/src/editor/table/table-commands.ts";
    const { runTableCommand } = await import(path);
    const editor = (window as unknown as { resizeTestEditor: Editor }).resizeTestEditor;
    const results = [];
    for (const command of [
      "align-table-center",
      "align-table-right",
      "align-table-left",
      "auto-fit-content",
      "fit-page",
      "auto-arrange",
      "fixed-width",
      "distribute-columns",
      "distribute-rows",
    ]) {
      editor.commands.setContent(
        '<table data-layout-mode="fixed" data-column-widths-mm="30,40"><tr><td>甲文字</td><td>乙文字</td></tr><tr><td>丙</td><td>丁</td></tr></table><p>后续正文</p>',
      );
      editor.commands.setTextSelection(4);
      if (command === "distribute-rows" || command === "distribute-columns") {
        const cells: number[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "tableCell") cells.push(pos);
        });
        const anchorCell = cells[0];
        const headCell = cells.at(-1);
        if (anchorCell === undefined || headCell === undefined)
          throw new Error("table cells missing");
        editor.commands.setCellSelection({ anchorCell, headCell });
      }
      const before = JSON.stringify(editor.getJSON());
      const text = editor.getText();
      const ok = runTableCommand(editor, command);
      const animations = document.getAnimations().filter((a) => a.id === "table-layout-motion");
      const timings = animations.map((a) => a.effect?.getTiming());
      const after = JSON.stringify(editor.getJSON());
      for (const animation of animations) animation.finish();
      await Promise.resolve();
      await Promise.resolve();
      const unchangedByPaint = after === JSON.stringify(editor.getJSON());
      editor.commands.undo();
      results.push({
        command,
        ok,
        timings,
        unchangedByPaint,
        textPreserved: text === editor.getText(),
        restored: before === JSON.stringify(editor.getJSON()),
        paintRemoved: !document.querySelector(".table-layout-paint"),
      });
    }
    return results;
  });
  for (const result of results) {
    expect(result.ok, result.command).toBe(true);
    expect(result.timings.length, result.command).toBeGreaterThan(0);
    expect(
      result.timings.every((timing) => timing?.duration === 400 && timing.easing === "ease-in-out"),
    ).toBe(true);
    expect(result.unchangedByPaint).toBe(true);
    expect(result.textPreserved).toBe(true);
    expect(result.restored, result.command).toBe(true);
    expect(result.paintRemoved).toBe(true);
  }
});

test("whole table insertion and deletion animate and editing cancels transient paint", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/editor/table/table-commands.ts";
    const { runTableCommand, insertPatentTable } = await import(path);
    const editor = (window as unknown as { resizeTestEditor: Editor }).resizeTestEditor;
    editor.commands.setContent("<p>正文</p>");
    editor.commands.setTextSelection(1);
    const inserted = insertPatentTable(editor, {
      rows: 2,
      columns: 2,
      headerRowCount: 0,
      layoutMode: "fit-page",
    });
    const insertMotion = document.getAnimations().some((a) => a.id === "table-layout-motion");
    editor.commands.setTextSelection(4);
    const removed = runTableCommand(editor, "delete-table");
    const deletionPaint = Boolean(document.querySelector(".table-layout-paint"));
    editor.commands.insertContent("新正文");
    const cancelled =
      !document.querySelector(".table-layout-paint") &&
      !document.getAnimations().some((a) => a.id === "table-layout-motion");
    return { inserted, insertMotion, removed, deletionPaint, cancelled, text: editor.getText() };
  });
  expect(result).toMatchObject({
    inserted: true,
    insertMotion: true,
    removed: true,
    deletionPaint: true,
    cancelled: true,
  });
  expect(result.text).toContain("新正文");
});

test("reduced motion performs table commands without paint overlays", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await page.evaluate(async () => {
    const path = "/src/editor/table/table-commands.ts";
    const { runTableCommand } = await import(path);
    const editor = (window as unknown as { resizeTestEditor: Editor }).resizeTestEditor;
    editor.commands.setTextSelection(4);
    return {
      ok: runTableCommand(editor, "align-table-center"),
      paint: document.querySelector(".table-layout-paint"),
      count: document.getAnimations().filter((a) => a.id === "table-layout-motion").length,
    };
  });
  expect(result).toEqual({ ok: true, paint: null, count: 0 });
});

test("merged and split cells use motion while undo restores their document", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/editor/table/table-commands.ts";
    const { runTableCommand } = await import(path);
    const editor = (window as unknown as { resizeTestEditor: Editor }).resizeTestEditor;
    editor.commands.setContent("<table><tr><td>甲</td><td>乙</td></tr></table><p></p>");
    await new Promise((resolve) => setTimeout(resolve, 550));
    const before = JSON.stringify(editor.getJSON());
    const cells: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cells.push(pos);
    });
    const anchorCell = cells[0];
    const headCell = cells[1];
    if (anchorCell === undefined || headCell === undefined) throw new Error("table cells missing");
    editor.commands.setCellSelection({ anchorCell, headCell });
    const merged = runTableCommand(editor, "merge-cells");
    const mergeMotion = document.getAnimations().some((a) => a.id === "table-layout-motion");
    const combined = JSON.stringify(editor.getJSON());
    await new Promise((resolve) => setTimeout(resolve, 550));
    const split = runTableCommand(editor, "split-cell");
    const splitMotion = document.getAnimations().some((a) => a.id === "table-layout-motion");
    editor.commands.undo();
    const restoredMerge = combined === JSON.stringify(editor.getJSON());
    editor.commands.undo();
    return {
      merged,
      mergeMotion,
      split,
      splitMotion,
      restoredMerge,
      restored: before === JSON.stringify(editor.getJSON()),
      paintRemoved: !document.querySelector(".table-layout-paint"),
    };
  });
  expect(result).toEqual({
    merged: true,
    mergeMotion: true,
    split: true,
    splitMotion: true,
    restoredMerge: true,
    restored: true,
    paintRemoved: true,
  });
});
