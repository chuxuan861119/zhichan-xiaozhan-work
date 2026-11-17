import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/table-resize.html", import.meta.url).pathname;
const url = `${process.env.TABLE_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

for (const alignment of ["left", "center", "right"])
  test(`narrow table aligns ${alignment} inside the page`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (alignment) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.view.dom.style.width = "640px";
        editor.commands.setContent(
          '<table data-layout-mode="fixed" data-column-widths-mm="30,30"><tr><td>甲</td><td>乙</td></tr></table><p></p>',
        );
        editor.commands.setTextSelection(4);
        runTableCommand(editor, `align-table-${alignment}`);
        // Assert the final layout, not the translated first frame of the transition.
        await Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => animation.id === "table-layout-motion")
            .map((animation) => animation.finished),
        );
        const table = editor.view.dom.querySelector("table").getBoundingClientRect();
        const paper = editor.view.dom.getBoundingClientRect();
        return {
          left: table.left - paper.left,
          right: paper.right - table.right,
          overflow: table.width > paper.width,
        };
      }, alignment);
      assert.ok(!result.overflow);
      if (alignment === "left") assert.ok(Math.abs(result.left) < 2, JSON.stringify(result));
      if (alignment === "right") assert.ok(Math.abs(result.right) < 2, JSON.stringify(result));
      if (alignment === "center")
        assert.ok(Math.abs(result.left - result.right) < 2, JSON.stringify(result));
    } finally {
      await browser.close();
    }
  });

for (const zoom of [0.75, 1, 1.5])
  test(`table width actions and automatic arrangement work at zoom ${zoom}`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (zoom) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.view.dom.style.width = "640px";
        editor.view.dom.style.zoom = String(zoom);
        editor.commands.setContent(
          '<table><tr data-row-height-mm="40" data-row-height-rule="exact"><td>编号</td><td>测试</td><td></td></tr></table><p></p>',
        );
        editor.commands.setTextSelection(4);
        const table = editor.view.dom.querySelector("table");
        const initial = table.offsetWidth;
        const minimumOK = runTableCommand(editor, "auto-fit-content");
        const minimum = table.offsetWidth;
        const pageOK = runTableCommand(editor, "fit-page");
        const pageWidth = table.offsetWidth;
        const before = JSON.stringify(editor.getJSON());
        const organized = runTableCommand(editor, "auto-arrange");
        const organizedWidth = table.offsetWidth;
        const rowHeight = editor.state.doc.firstChild.firstChild.attrs.rowHeightMm;
        const unchangedText =
          editor.getText().includes("编号") && editor.getText().includes("测试");
        editor.commands.undo();
        return {
          minimumOK,
          minimum,
          initial,
          pageOK,
          pageWidth,
          organized,
          organizedWidth,
          rowHeight,
          unchangedText,
          restored: before === JSON.stringify(editor.getJSON()),
          overflow: table.parentElement.scrollWidth > table.parentElement.clientWidth,
        };
      }, zoom);
      assert.ok(result.minimumOK && result.minimum < result.initial / 2, JSON.stringify(result));
      assert.ok(result.pageOK && Math.abs(result.pageWidth - 640) < 2, JSON.stringify(result));
      assert.ok(
        result.organized && result.organizedWidth < result.initial / 2,
        JSON.stringify(result),
      );
      assert.equal(result.rowHeight, null);
      assert.ok(
        result.unchangedText && result.restored && !result.overflow,
        JSON.stringify(result),
      );
    } finally {
      await browser.close();
    }
  });

test("fixed fractional column widths do not create a horizontal scrollbar", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const result = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.view.dom.style.width = "554.1px";
      const widths = [
        13.3976, 13.7035, 14.0094, 13.3976, 13.7035, 13.3976, 17.4967, 16.8849, 16.8849, 13.7035,
      ];
      editor.commands.setContent(
        `<table data-layout-mode="fixed" data-column-widths-mm="${widths.join(",")}"><tr>${widths.map(() => "<td></td>").join("")}</tr></table><p></p>`,
      );
      const wrapper = editor.view.dom.querySelector(".tableWrapper");
      const samples = [{ client: wrapper.clientWidth, scroll: wrapper.scrollWidth }];
      editor.commands.setTextSelection(4);
      for (let i = 0; i < 3; i++) {
        runTableCommand(editor, "add-column-after");
        samples.push({ client: wrapper.clientWidth, scroll: wrapper.scrollWidth });
        await new Promise((resolve) => setTimeout(resolve, 350));
        samples.push({ client: wrapper.clientWidth, scroll: wrapper.scrollWidth });
      }
      return samples;
    });
    for (const sample of result) assert.equal(sample.scroll, sample.client, JSON.stringify(result));
  } finally {
    await browser.close();
  }
});

for (const alignment of ["left", "center", "right"])
  for (const deleting of [false, true])
    test(`column ${deleting ? "shrink" : "growth"} preserves geometry for ${alignment} alignment`, async () => {
      const browser = await chromium.launch({ headless: true, channel: "msedge" });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction(() => window.resizeTestEditor);
        const result = await page.evaluate(
          async ({ alignment, deleting }) => {
            const { prepareTableInsertionAnimation, prepareTableDeletionAnimation } = await import(
              "/src/editor/table/table-insertion-animation.ts"
            );
            const editor = window.resizeTestEditor;
            editor.commands.setContent(
              deleting
                ? "<table><tr><td>A</td><td>B</td><td>C</td></tr></table><p></p>"
                : "<table><tr><td>A</td><td>B</td></tr></table><p></p>",
            );
            editor.commands.setTextSelection(4);
            const table = editor.view.dom.querySelector("table");
            const place = (width) => {
              table.style.width = width + "px";
              table.style.minWidth = "0";
              table.style.marginLeft = alignment === "left" ? "0" : "auto";
              table.style.marginRight = alignment === "right" ? "0" : "auto";
              table.querySelectorAll("col").forEach((col) => {
                col.style.width = "100px";
              });
            };
            place(deleting ? 300 : 200);
            const old = table.getBoundingClientRect();
            const boundary = table.rows[0].cells[0].getBoundingClientRect().right;
            const oldAfterLeft = table.rows[0].cells[deleting ? 2 : 1].getBoundingClientRect().left;
            const animate = deleting
              ? prepareTableDeletionAnimation(editor, 0, "column", 1, 2)
              : prepareTableInsertionAnimation(editor, 0, "column", 1);
            if (deleting) {
              editor.commands.setTextSelection(9);
              editor.commands.deleteColumn();
            } else editor.commands.addColumnAfter();
            place(deleting ? 200 : 300);
            const final = table.getBoundingClientRect();
            const finalBoundary =
              table.rows[0].cells[deleting ? 1 : 2].getBoundingClientRect().left;
            animate();
            document.getAnimations().forEach((a) => {
              a.pause();
              a.currentTime = 0;
            });
            const before = document.querySelector('[data-table-insertion-slice="before"]');
            const after = document.querySelector('[data-table-insertion-slice="after"]');
            const initial = {
              left: before.getBoundingClientRect().left,
              boundary: after.querySelector("tr").cells[2].getBoundingClientRect().left,
            };
            document.getAnimations().forEach((a) => {
              a.currentTime = 319.99;
            });
            return {
              ...initial,
              expectedLeft: old.left,
              expectedBoundary: deleting ? oldAfterLeft : boundary,
              endLeft: before.getBoundingClientRect().left,
              finalLeft: final.left,
              endBoundary: after.querySelector("tr").cells[2].getBoundingClientRect().left,
              finalBoundary,
            };
          },
          { alignment, deleting },
        );
        assert.ok(Math.abs(result.left - result.expectedLeft) < 1, JSON.stringify(result));
        assert.ok(Math.abs(result.boundary - result.expectedBoundary) < 1, JSON.stringify(result));
        assert.ok(Math.abs(result.endLeft - result.finalLeft) < 1, JSON.stringify(result));
        assert.ok(Math.abs(result.endBoundary - result.finalBoundary) < 1, JSON.stringify(result));
      } finally {
        await browser.close();
      }
    });

for (const axis of ["row", "column"])
  for (const index of [0, 1, 2])
    test(`delete ${axis} ${index} collapses smoothly and supports undo`, async () => {
      const browser = await chromium.launch({ headless: true, channel: "msedge" });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction(() => window.resizeTestEditor);
        const result = await page.evaluate(
          async ({ axis, index }) => {
            const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
            const editor = window.resizeTestEditor;
            editor.commands.setContent(
              `<table>${Array.from({ length: 3 }, (_, r) => `<tr>${Array.from({ length: 3 }, (_, c) => `<td>${r}:${c}</td>`).join("")}</tr>`).join("")}</table><p>后文</p>`,
            );
            let position;
            editor.state.doc.descendants((node, pos) => {
              if (
                node.type.name === "tableCell" &&
                node.textContent === (axis === "row" ? `${index}:0` : `0:${index}`)
              )
                position = pos;
            });
            editor.commands.setTextSelection(position + 2);
            const before = editor.getText();
            const original = document.querySelector(".ProseMirror table");
            const oldBox = original.getBoundingClientRect();
            const tracks = axis === "row" ? original.rows : original.querySelectorAll("col");
            const removed = tracks[index].getBoundingClientRect();
            const start = axis === "row" ? removed.top : removed.left;
            const end = axis === "row" ? removed.bottom : removed.right;
            runTableCommand(editor, `delete-${axis}`);
            const saved = JSON.stringify(editor.getJSON());
            const layer = document.querySelector(".table-insertion-paint");
            const layerClip = getComputedStyle(layer)
              .clipPath.match(/[\d.]+/g)
              .map(Number);
            const visibleBottom =
              layer.getBoundingClientRect().bottom - (layerClip[2] ?? layerClip[0]);
            const animations = document
              .getAnimations()
              .filter((a) => a.id.startsWith("table-insert-") || a.id.startsWith("table-delete-"));
            const read = (time) => {
              animations.forEach((a) => {
                a.pause();
                a.currentTime = time;
              });
              const slice = document.querySelector('[data-table-insertion-slice="inserted"]');
              const v = getComputedStyle(slice)
                .clipPath.match(/[\d.]+/g)
                .map(Number);
              const top = v[0],
                right = v[1] ?? top,
                bottom = v[2] ?? top,
                left = v[3] ?? right;
              const rect = slice.getBoundingClientRect();
              const before = document.querySelector(
                '[data-table-insertion-slice="before"] tr:first-child td',
              );
              const after = document.querySelector(
                '[data-table-insertion-slice="after"] tr:last-child td:last-child',
              );
              return {
                extent: axis === "row" ? rect.height - top - bottom : rect.width - left - right,
                beforeEdge:
                  axis === "row"
                    ? before.getBoundingClientRect().bottom
                    : before.getBoundingClientRect().right,
                afterEdge:
                  axis === "row"
                    ? after.getBoundingClientRect().top
                    : after.getBoundingClientRect().left,
              };
            };
            const initial = read(0),
              middle = read(160),
              final = read(319);
            animations.forEach((a) => {
              a.finish();
            });
            await new Promise(requestAnimationFrame);
            const table = document.querySelector(".ProseMirror table");
            const count = axis === "row" ? table.rows.length : table.rows[0].cells.length;
            const unchanged = saved === JSON.stringify(editor.getJSON());
            const cleanup = document.querySelectorAll(".table-insertion-paint").length;
            editor.commands.undo();
            return {
              initial,
              middle,
              final,
              count,
              unchanged,
              cleanup,
              restored: before === editor.getText(),
              start,
              end,
              visibleBottom,
              oldBottom: oldBox.bottom,
            };
          },
          { axis, index },
        );
        assert.ok(
          Math.abs(result.initial.extent - (result.end - result.start)) < 1,
          JSON.stringify(result),
        );
        assert.ok(
          result.middle.extent > 0 && result.middle.extent < result.initial.extent,
          JSON.stringify(result),
        );
        assert.ok(result.final.extent < 1, JSON.stringify(result));
        assert.ok(result.visibleBottom >= result.oldBottom - 1, JSON.stringify(result));
        if (index === 1) {
          assert.ok(Math.abs(result.initial.afterEdge - result.end) < 1, JSON.stringify(result));
          assert.ok(result.middle.afterEdge < result.initial.afterEdge, JSON.stringify(result));
          if (axis === "column") {
            assert.ok(
              Math.abs(result.initial.beforeEdge - result.start) < 1,
              JSON.stringify(result),
            );
            assert.ok(result.middle.beforeEdge > result.initial.beforeEdge, JSON.stringify(result));
          }
        }
        assert.equal(result.count, 2);
        assert.equal(result.cleanup, 0);
        assert.equal(result.unchanged, true);
        assert.equal(result.restored, true);
      } finally {
        await browser.close();
      }
    });

for (const axis of ["row", "column"])
  test(`delete ${axis} handles multi-selection, repetition, interruption and reduced motion`, async () => {
    const browser = await chromium.launch({ headless: true, channel: "msedge" });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const results = await page.evaluate(async (axis) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        const results = [];
        for (const mode of ["multi", "repeat", "undo", "scroll", "merged"]) {
          const rows = Array.from(
            { length: 4 },
            (_, r) =>
              `<tr>${Array.from({ length: 4 }, (_, c) => `<td>${r}:${c}</td>`).join("")}</tr>`,
          );
          if (mode === "merged") rows[0] = '<tr><td colspan="4">合并</td></tr>';
          editor.commands.setContent(`<table>${rows.join("")}</table><p>后文</p>`);
          const positions = {};
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name === "tableCell") positions[node.textContent] = pos;
          });
          const anchor = positions[mode === "merged" ? "1:0" : "0:0"];
          const head = mode === "multi" ? positions[axis === "row" ? "1:0" : "0:1"] : anchor;
          editor.commands.setCellSelection({ anchorCell: anchor, headCell: head });
          runTableCommand(editor, `delete-${axis}`);
          const first = document
            .getAnimations()
            .filter((a) => a.id.startsWith("table-insert-") || a.id.startsWith("table-delete-"));
          first.forEach((a) => {
            a.pause();
            a.currentTime = 160;
          });
          if (mode === "repeat") runTableCommand(editor, `delete-${axis}`);
          if (mode === "undo") editor.commands.undo();
          if (mode === "scroll") window.dispatchEvent(new Event("scroll"));
          const table = document.querySelector(".ProseMirror table");
          results.push({
            mode,
            count: axis === "row" ? table.rows.length : table.querySelectorAll("col").length,
            oldCancelled: first.every((a) => a.playState === "idle"),
            active: document.querySelectorAll(".table-insertion-paint").length,
            border: getComputedStyle(table).borderCollapse,
            span: table.rows[0].cells[0].colSpan,
          });
        }
        return results;
      }, axis);
      for (const result of results) {
        assert.equal(result.border, "collapse");
        assert.equal(
          result.count,
          result.mode === "undo" ? 4 : ["multi", "repeat"].includes(result.mode) ? 2 : 3,
          JSON.stringify(result),
        );
        if (["repeat", "undo", "scroll"].includes(result.mode))
          assert.equal(result.oldCancelled, true);
        if (["undo", "scroll"].includes(result.mode)) assert.equal(result.active, 0);
        if (result.mode === "merged") assert.equal(result.span, axis === "column" ? 3 : 4);
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await page.evaluate(async (axis) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.commands.setContent(
          "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table><p></p>",
        );
        editor.commands.setTextSelection(4);
        runTableCommand(editor, `delete-${axis}`);
        return document.querySelectorAll(".table-insertion-paint").length;
      }, axis);
      assert.equal(reduced, 0);
    } finally {
      await browser.close();
    }
  });

test("large-table insertion copies only bounded paint styles", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const result = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.commands.setContent(
        `<table>${`<tr>${"<td><p>文字</p></td>".repeat(8)}</tr>`.repeat(18)}</table><p></p>`,
      );
      editor.commands.setTextSelection(4);
      runTableCommand(editor, "add-row-after");
      const layer = document.querySelector(".table-insertion-paint");
      return {
        maxStyleLength: Math.max(
          ...Array.from(layer.querySelectorAll("[style]"), (el) => el.style.cssText.length),
        ),
        widgets: layer.querySelectorAll(".ProseMirror-widget").length,
      };
    });
    assert.ok(result.maxStyleLength < 5000, `unbounded style snapshot: ${result.maxStyleLength}`);
    assert.equal(result.widgets, 0);
  } finally {
    await browser.close();
  }
});

test("table insertion uses a visibly paced expansion", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const timings = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.commands.setContent(
        "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
      );
      editor.commands.setTextSelection(4);
      runTableCommand(editor, "add-row-after");
      return document
        .getAnimations()
        .filter((animation) => animation.id.startsWith("table-insert-"))
        .map((animation) => animation.effect.getTiming());
    });

    assert.ok(timings.length > 0, "insertion must create visible animations");
    assert.ok(timings.every((timing) => timing.duration === 320));
    assert.ok(timings.every((timing) => timing.easing === "cubic-bezier(0.4, 0, 0.2, 1)"));
  } finally {
    await browser.close();
  }
});

test("column insertion compresses both sides from their existing positions", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const samples = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.commands.setContent(
        "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
      );
      editor.commands.setTextSelection(4);
      const oldFirst = document.querySelector("table tr:first-child td:first-child");
      const oldBoundary = oldFirst.getBoundingClientRect().right;
      runTableCommand(editor, "add-column-after");
      const animations = document
        .getAnimations()
        .filter((animation) => animation.id.startsWith("table-insert-"));
      const measure = (time) => {
        animations.forEach((animation) => {
          animation.pause();
          animation.currentTime = time;
        });
        const beforeCell = document.querySelector(
          '[data-table-insertion-slice="before"] tr:first-child td:first-child',
        );
        const afterCell = document.querySelector(
          '[data-table-insertion-slice="after"] tr:first-child td:last-child',
        );
        const finalCells = document.querySelectorAll(".ProseMirror table tr:first-child td");
        return {
          beforeRight: beforeCell.getBoundingClientRect().right,
          afterLeft: afterCell.getBoundingClientRect().left,
          finalBeforeRight: finalCells[0].getBoundingClientRect().right,
          finalAfterLeft: finalCells[2].getBoundingClientRect().left,
        };
      };
      return { oldBoundary, initial: measure(0), middle: measure(160) };
    });

    assert.ok(
      Math.abs(samples.initial.beforeRight - samples.oldBoundary) < 1,
      JSON.stringify(samples),
    );
    assert.ok(
      Math.abs(samples.initial.afterLeft - samples.oldBoundary) < 1,
      JSON.stringify(samples),
    );
    assert.ok(
      samples.middle.beforeRight < samples.oldBoundary &&
        samples.middle.beforeRight > samples.middle.finalBeforeRight,
      JSON.stringify(samples),
    );
    assert.ok(
      samples.middle.afterLeft > samples.oldBoundary &&
        samples.middle.afterLeft < samples.middle.finalAfterLeft,
      JSON.stringify(samples),
    );
  } finally {
    await browser.close();
  }
});

for (const ending of ["scroll", "resize", "pointer", "finish", "destroy"])
  test(`insertion paint is removed on ${ending}`, async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: "msedge",
    });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (ending) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.commands.setTextSelection(4);
        runTableCommand(editor, "add-row-after");
        const table = editor.view.dom.querySelector("table");
        const json = JSON.stringify(editor.getJSON());
        const initial = document.querySelectorAll(".table-insertion-paint").length;
        if (ending === "scroll" || ending === "resize") window.dispatchEvent(new Event(ending));
        if (ending === "pointer") editor.view.dom.dispatchEvent(new PointerEvent("pointerdown"));
        if (ending === "destroy") editor.destroy();
        if (ending === "finish") await new Promise((resolve) => setTimeout(resolve, 380));
        return {
          initial,
          remaining: document.querySelectorAll(".table-insertion-paint").length,
          animations: table.getAnimations().length,
          unchanged: ending === "destroy" || json === JSON.stringify(editor.getJSON()),
        };
      }, ending);
      assert.deepEqual(result, {
        initial: 1,
        remaining: 0,
        animations: 0,
        unchanged: true,
      });
    } finally {
      await browser.close();
    }
  });

test("insertion keeps collapsed borders throughout the animation", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const modes = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      const result = [];
      for (const command of [
        "add-row-before",
        "add-row-after",
        "add-column-before",
        "add-column-after",
      ]) {
        editor.commands.setContent(
          "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
        );
        editor.commands.setTextSelection(4);
        runTableCommand(editor, command);
        const animations = document.getAnimations().filter((a) => a.id.startsWith("table-insert-"));
        for (const time of [0, 60, 120, 239]) {
          animations.forEach((a) => {
            a.pause();
            a.currentTime = time;
          });
          result.push(
            ...Array.from(
              document.querySelectorAll("table"),
              (t) => getComputedStyle(t).borderCollapse,
            ),
          );
        }
        editor.commands.undo();
      }
      return result;
    });
    assert.ok(
      modes.every((mode) => mode === "collapse"),
      modes.join(","),
    );
  } finally {
    await browser.close();
  }
});

test("compact row insertion never creates a vertical table scrollbar", async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.resizeTestEditor);
    const samples = await page.evaluate(async () => {
      const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
      const editor = window.resizeTestEditor;
      editor.view.dom.style.width = "554px";
      const cell =
        '<td data-padding-top-mm="1" data-padding-bottom-mm="1"><p data-line-height="1"></p></td>';
      editor.commands.setContent(`<table>${`<tr>${cell.repeat(5)}</tr>`.repeat(7)}</table><p></p>`);
      editor.commands.setTextSelection(4);
      runTableCommand(editor, "add-row-after");
      const wrapper = editor.view.dom.querySelector(".tableWrapper");
      const result = [];
      for (let i = 0; i < 25; i++) {
        await new Promise(requestAnimationFrame);
        result.push({
          height: wrapper.clientHeight,
          scroll: wrapper.scrollHeight,
        });
      }
      return result;
    });
    assert.ok(
      samples.every((s) => s.scroll <= s.height),
      JSON.stringify(samples),
    );
  } finally {
    await browser.close();
  }
});

for (const mode of ["undo", "repeat", "reduced", "merged"])
  test(`insertion animation safely handles ${mode}`, async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: "msedge",
    });
    try {
      const page = await browser.newPage({
        reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
      });
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (mode) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.commands.setContent(
          mode === "merged"
            ? '<table><tr><td colspan="2">合并</td></tr><tr><td>甲</td><td>乙</td></tr></table><p></p>'
            : "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
        );
        let pos;
        editor.state.doc.descendants((node, at) => {
          if (node.type.name === "tableCell" && node.textContent === "甲") pos = at;
        });
        editor.commands.setTextSelection(pos + 2);
        runTableCommand(editor, "add-column-after");
        const first = document.getAnimations().filter((a) => a.id.startsWith("table-insert-"));
        if (mode !== "reduced") {
          editor.view.dom.dispatchEvent(
            new CustomEvent("table-insertion-preview", {
              detail: "add-row-after",
            }),
          );
          if (!document.querySelector(".table-insert-guide").hidden)
            throw new Error("preview must stay hidden during insertion");
        }
        for (const a of first) {
          a.pause();
          a.currentTime = 65;
        }
        if (mode === "undo") editor.commands.undo();
        if (mode === "repeat") runTableCommand(editor, "add-column-after");
        if (mode === "merged")
          document.getAnimations().forEach((a) => {
            a.finish();
          });
        return {
          initial: first.length,
          active: document.getAnimations().filter((a) => a.id.startsWith("table-insert-")).length,
          oldCancelled: first.every((a) => a.playState === "idle"),
          columns: document.querySelector("table").rows[1].cells.length,
          mergedSpan: document.querySelector("table").rows[0].cells[0].colSpan,
          text: editor.getText(),
        };
      }, mode);
      if (mode === "undo") {
        assert.equal(result.active, 0);
        assert.equal(result.columns, 2);
      }
      if (mode === "repeat") {
        assert.ok(result.oldCancelled);
        assert.ok(result.active > 0);
        assert.equal(result.columns, 4);
      }
      if (mode === "reduced") {
        assert.equal(result.initial, 0);
        assert.equal(result.columns, 3);
      }
      if (mode === "merged") {
        assert.equal(result.mergedSpan, 3);
        assert.equal(result.columns, 3);
        assert.ok(result.text.includes("合并"));
      }
    } finally {
      await browser.close();
    }
  });

for (const command of ["add-row-before", "add-row-after", "add-column-before", "add-column-after"])
  test(`${command} expands from zero without changing saved dimensions`, async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: "msedge",
    });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      const result = await page.evaluate(async (command) => {
        const { runTableCommand } = await import("/src/editor/table/table-commands.ts");
        const editor = window.resizeTestEditor;
        editor.commands.setContent(
          "<p>前文</p><table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p>后文</p>",
        );
        let pos;
        editor.state.doc.descendants((node, at) => {
          if (pos === undefined && node.type.name === "tableCell") pos = at;
        });
        editor.commands.setTextSelection(pos + 2);
        runTableCommand(editor, command);
        const animations = document.getAnimations().filter((a) => a.id.startsWith("table-insert-"));
        for (const a of animations) {
          a.pause();
          a.currentTime = 0;
        }
        const row = command.includes("row");
        const index = command.endsWith("before") ? 0 : 1;
        const cell = document.querySelector("table").rows[row ? index : 0].cells[row ? 0 : index];
        const size = () => {
          const slice = document.querySelector('[data-table-insertion-slice="inserted"]');
          const rect = slice.getBoundingClientRect();
          const shorthand = getComputedStyle(slice)
            .clipPath.match(/[\d.]+/g)
            .map(Number);
          const values =
            shorthand.length === 1
              ? shorthand.repeat(4)
              : shorthand.length === 2
                ? [shorthand[0], shorthand[1], shorthand[0], shorthand[1]]
                : shorthand.length === 3
                  ? [shorthand[0], shorthand[1], shorthand[2], shorthand[1]]
                  : shorthand;
          return row ? rect.height - values[0] - values[2] : rect.width - values[1] - values[3];
        };
        const initial = size();
        const saved = editor.getJSON();
        for (const a of animations) a.currentTime = 100;
        const middle = size();
        const cells = row
          ? [...document.querySelector("table").rows].map((r) => r.cells[0])
          : [...document.querySelector("table").rows[0].cells];
        const boxes = cells.map((c) => c.getBoundingClientRect());
        const gaps = boxes
          .slice(1)
          .map((b, i) => Math.abs(row ? b.top - boxes[i].bottom : b.left - boxes[i].right));
        for (const a of animations) a.finish();
        const final = row
          ? cell.getBoundingClientRect().height
          : cell.getBoundingClientRect().width;
        return {
          count: animations.length,
          initial,
          middle,
          final,
          gaps,
          saved,
          after: editor.getJSON(),
        };
      }, command);
      assert.ok(result.count > 0, "insertion must animate");
      assert.ok(result.initial < 1, `initial size ${result.initial}`);
      assert.ok(result.middle > result.initial && result.middle < result.final);
      assert.ok(
        result.gaps.every((gap) => gap < 2),
        `animation must stay connected: ${result.gaps}`,
      );
      assert.deepEqual(result.after, result.saved);
      await page.evaluate(() => window.resizeTestEditor.commands.undo());
      assert.equal(await page.locator("tr").count(), 2);
      assert.equal(await page.locator("tr:first-child td").count(), 2);
    } finally {
      await browser.close();
    }
  });

for (const zoom of [0.75, 1, 1.5])
  test(`hover insertion at zoom ${zoom}`, async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: "msedge",
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => window.resizeTestEditor);
      await page.evaluate((zoom) => {
        document.querySelector("#editor").style.cssText = `padding:64px;zoom:${zoom}`;
        window.resizeTestEditor.commands.setContent(
          "<p>前文</p><table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table><p></p>",
        );
      }, zoom);
      const button = page.locator(".table-insert-handle");
      for (const axis of ["row", "column"]) {
        const table = await page.locator("table").boundingBox();
        const cell = await page
          .locator("tr")
          .nth(axis === "row" ? 1 : 0)
          .locator("td")
          .nth(axis === "column" ? 1 : 0)
          .boundingBox();
        await page.mouse.move(
          axis === "row" ? table.x - 20 : cell.x,
          axis === "row" ? cell.y : table.y - 20,
        );
        await button.waitFor({ state: "visible" });
        assert.equal(await button.getAttribute("aria-label"), axis === "row" ? "插入行" : "插入列");
        await button.click();
        assert.equal(
          await page
            .locator(axis === "row" ? ".ProseMirror tr" : ".ProseMirror tr:first-child td")
            .count(),
          3,
        );
        await page.evaluate(() => window.resizeTestEditor.commands.undo());
        assert.equal(await page.locator(axis === "row" ? "tr" : "tr:first-child td").count(), 2);
      }
      await page.locator("td").first().hover();
      assert.equal(await button.isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
