import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const stylesheets = [
  "app/app.css",
  "editor/editor.css",
  "editor/ui/editor-context-menus.css",
  "editor/ui/text-color-picker.css",
  "editor/ui/paste-formatting-options.css",
  "drawing-markup/drawing-workspace.css",
  "exports/print-center.css",
  "flowcharts/flowchart.css",
  "ipc-data-center/ipc-data-center.css",
  "legislation/legislation-dialog.css",
  "library/import-notice.css",
  "patents/claims-description-menu.css",
  "patents/ruler-navigation-popover.css",
  "settings/editor-color-settings.css",
  "shared/clear-format-help.css",
  "shared/quick-check-help.css",
  "shared/standard-dialog.css",
  "shared/tool-action-tooltips.css",
  "shared/user-guide-dialog.css",
  "writing-guidance/writing-guidance.css",
];
const css = (
  await Promise.all(
    stylesheets.map((file) =>
      readFile(new URL(`../../src/renderer/src/${file}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");
const surfaces = [
  "library-import-menu__panel",
  "docx-import-dialog",
  "patent-tabs__overflow-menu",
  "file-menu",
  "file-menu format-submenu",
  "patent-split-controls__menu",
  "dual-document-pane__switcher-popover",
  "patent-book-tabs__auxiliary-menu",
  "patent-book-tabs__auxiliary-action-menu",
  "toolbar-import-menu",
  "toolbar-export-menu",
  "color-palette",
  "toolbar-overflow-menu",
  "insert-table-popover",
  "patent-card-menu-panel",
  "patent-illustrated-hover__popover",
  "template-catalog-card__overflow-menu",
  "feedback-dialog",
  "application-settings-dialog__surface",
  "close-dialog",
  "snapshot-content-preview__surface",
  "template-dialog",
  "shortcut-settings-dialog__surface",
  "ai-settings-dialog",
  "ai-model-editor",
  "patdoc-import-success",
  "editor-menu-surface editor-selection-menu",
  "editor-menu-surface editor-context-menu",
  "paste-formatting-options",
  "ruler-navigation-popover",
  "claims-description-tool__panel claims-description-menu",
  "drawing-style-popover",
  "drawing-figure-hover-preview",
  "flowchart-project-menu",
  "editor-color-picker__palette",
  "tool-action-tooltip",
  "clear-format-help",
  "quick-check-help",
  "writing-guidance-card",
  "standard-dialog legislation-dialog",
  "standard-dialog import-notice",
  "standard-dialog user-guide-window",
  "ipc-data-center-window",
  "assistant-side-panel",
  "data-safety-guide",
  "standard-dialog",
];

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 800, height: 650 },
]) {
  test(`window shells share editor corners and preserve embedded layouts (${viewport.width}px)`, async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport });
      await page.setContent(
        `<style>${css}</style><div class="standard-dialog-overlay" id="host"></div>`,
      );
      const results = await page.evaluate((classes) => {
        const host = document.getElementById("host");
        const corners = (node) => {
          const s = getComputedStyle(node);
          return [
            s.borderTopLeftRadius,
            s.borderTopRightRadius,
            s.borderBottomLeftRadius,
            s.borderBottomRightRadius,
          ];
        };
        const all = classes.map((className) => {
          const node = document.createElement("div");
          node.className = className;
          host.append(node);
          return { className, corners: corners(node) };
        });
        const editor = document.createElement("div");
        editor.className = "patent-book-editor";
        host.append(editor);
        const embedded = [];
        for (const [parentClass, childClass] of [
          ["snapshot-content-preview--embedded", "snapshot-content-preview__surface"],
          ["shortcut-settings-dialog--embedded", "shortcut-settings-dialog__surface"],
          ["template-dialog--embedded", "template-dialog"],
          ["ai-model-editor--embedded", "ai-model-editor"],
        ]) {
          const parent = document.createElement("div");
          parent.className = parentClass;
          const node = document.createElement("div");
          node.className = childClass;
          if (
            parentClass === "template-dialog--embedded" ||
            parentClass === "ai-model-editor--embedded"
          )
            node.classList.add(parentClass);
          parent.append(node);
          host.append(parent);
          embedded.push({ className: parentClass, corners: corners(node) });
        }
        const swatch = document.createElement("button");
        swatch.className = "color-swatch";
        host.append(swatch);
        return { all, editor: corners(editor), embedded, swatch: corners(swatch) };
      }, surfaces);
      assert.deepEqual(results.editor, Array(4).fill("12px"));
      for (const result of results.all)
        assert.deepEqual(result.corners, results.editor, result.className);
      for (const result of results.embedded)
        assert.deepEqual(result.corners, Array(4).fill("0px"), result.className);
      assert.deepEqual(results.swatch, Array(4).fill("4px"));
    } finally {
      await browser.close();
    }
  });
}

test("color palette clips edge backgrounds and retains scrolling and focus", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent(`<style>${css}</style><div class="text-color-picker"><section class="color-palette text-color-palette" style="top:20px;left:20px;max-height:150px">
      <button class="color-palette-automatic"><span class="color-swatch"></span>自动</button>
      ${Array.from({ length: 12 }, (_, i) => `<div style="height:30px"><button class="color-swatch" aria-label="颜色${i}"></button></div>`).join("")}
      <label class="color-palette-custom">其他颜色<input class="color-control" type="color" value="#ffff00"></label>
    </section></div>`);
    const palette = page.locator(".color-palette");
    for (const selector of [".color-swatch", ".color-control"]) {
      for (const node of await palette.locator(selector).all()) {
        assert.equal(
          await node.evaluate((element) => getComputedStyle(element).borderRadius),
          "4px",
        );
      }
    }
    for (const selector of [".color-palette-automatic", ".color-palette-custom"]) {
      assert.equal(
        await palette
          .locator(selector)
          .evaluate((element) => getComputedStyle(element).borderRadius),
        "6px",
      );
    }
    assert.deepEqual(
      await palette.evaluate((node) => ({
        radius: getComputedStyle(node).borderRadius,
        overflowY: getComputedStyle(node).overflowY,
        scrollable: node.scrollHeight > node.clientHeight,
      })),
      { radius: "12px", overflowY: "auto", scrollable: true },
    );
    await page.getByRole("button", { name: "颜色0", exact: true }).focus();
    assert.equal(
      await page
        .getByRole("button", { name: "颜色0", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await palette.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    assert.ok(await palette.evaluate((node) => node.scrollTop > 0));
    const box = await palette.boundingBox();
    assert.equal(
      await page.evaluate(
        ({ x, y }) => Boolean(document.elementFromPoint(x + 1, y + 1)?.closest(".color-palette")),
        box,
      ),
      false,
    );
  } finally {
    await browser.close();
  }
});
