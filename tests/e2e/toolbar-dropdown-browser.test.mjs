import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const load = (file) => readFile(new URL(`../../src/renderer/src/${file}`, import.meta.url), "utf8");
const [appCss, menuCss, dropdownCss, colorCss] = await Promise.all([
  load("app/app.css"),
  load("editor/ui/editor-context-menus.css"),
  load("editor/ui/toolbar-dropdowns.css"),
  load("editor/ui/text-color-picker.css"),
]);

for (const fontSize of [13, 18, 24]) {
  test(`file menus keep each label on one line at ${fontSize}px`, async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setContent(`<style>${dropdownCss}\n${appCss}</style><div class="tool-bar">
        <div class="toolbar-import-picker"><button class="tool-button">导入</button>
          <div class="toolbar-import-menu" role="menu" style="font-size:${fontSize}px">
            <button role="menuitem" style="font:inherit">导入 DOCX</button>
            <button role="menuitem" style="font:inherit">导入 PATDOC</button>
          </div></div>
        <div class="toolbar-export-picker" style="margin-left:320px"><button class="tool-button">导出</button>
          <div class="toolbar-export-menu" role="menu" style="font-size:${fontSize}px">
            <button role="menuitem" style="font:inherit">导出 DOCX</button>
            <button role="menuitem" style="font:inherit">导出 PDF</button>
            <button role="menuitem" style="font:inherit">导出整件专利（PATDOC）</button>
          </div></div></div>`);
      for (const name of ["toolbar-import-menu", "toolbar-export-menu"]) {
        const menu = page.locator(`.${name}`);
        const rect = await menu.boundingBox();
        const buttons = await menu.locator("button").all();
        const toolbarBox = await page.locator(".tool-bar").boundingBox();
        const anchorBox = await menu.locator("..").boundingBox();
        assert.ok(Math.abs(rect.y - (toolbarBox.y + toolbarBox.height)) < 1);
        assert.ok(Math.abs(rect.x - anchorBox.x) < 1);
        let previousBottom = rect.y;
        for (const button of buttons) {
          const result = await button.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const text = range.getBoundingClientRect(),
              box = node.getBoundingClientRect();
            return {
              lines: range.getClientRects().length,
              textRight: text.right,
              textBottom: text.bottom,
              right: box.right,
              bottom: box.bottom,
              top: box.top,
            };
          });
          assert.equal(result.lines, 1);
          assert.ok(result.textRight <= result.right);
          assert.ok(result.textBottom <= result.bottom);
          assert.ok(result.bottom <= rect.y + rect.height);
          assert.ok(result.top >= previousBottom);
          previousBottom = result.bottom;
        }
        assert.ok(rect.y >= (await menu.locator("..").boundingBox()).y + 30);
      }
    } finally {
      await browser.close();
    }
  });
}

test("toolbar and selection controls open their options below and preserve selection behavior", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setContent(`<style>${appCss}\n${menuCss}\n${dropdownCss}</style>
      <div class="tool-bar" style="margin:30px;gap:30px">
        <select class="style-select" aria-label="段落样式"><option value="paragraph">正文</option><option value="1" selected>标题 1</option><option value="2">标题 2</option></select>
        <select class="font-select" aria-label="字体"><option value="SimSun">宋体</option></select>
        <select class="size-select" aria-label="字号"><option value="10.5">五号</option><option value="12" selected>小四</option><option value="14">四号</option></select>
      </div>
      <div class="editor-menu-surface editor-mini-row" style="margin:100px 30px;padding:10px;width:max-content">
        <select aria-label="选区字体"><option value="mixed" selected>混合字体</option><option value="SimSun">宋体</option></select>
        <select aria-label="选区字号"><option value="mixed" selected>混合字号</option><option value="14">四号</option></select>
      </div>`);
    for (const name of ["段落样式", "字体", "字号", "选区字体", "选区字号"]) {
      const select = page.getByRole("combobox", { name, exact: true });
      const before = await select.inputValue();
      await select.click();
      const control = await select.boundingBox();
      const option = await select.locator("option").first().boundingBox();
      const toolbarBox = await page.locator(".tool-bar").boundingBox();
      const expectedTop = name.startsWith("选区")
        ? control.y + control.height + 4
        : toolbarBox.y + toolbarBox.height;
      assert.ok(Math.abs(option.y - 5 - expectedTop) < 1, `${name} aligns with its lower edge`);
      assert.ok(Math.abs(option.x - control.x) < 12);
      assert.equal(
        await select.evaluate((node) => getComputedStyle(node, "::picker(select)").borderRadius),
        "12px",
      );
      if (!name.startsWith("选区")) {
        assert.equal(
          await select
            .locator("option:checked")
            .evaluate((option) => getComputedStyle(option, "::checkmark").display),
          "none",
          `${name} does not show a selected-option checkmark`,
        );
      }
      await page.keyboard.press("Escape");
      assert.equal(await select.inputValue(), before);
      await select.click();
      const last = select.locator("option").last();
      const expected = await last.getAttribute("value");
      await last.click();
      assert.equal(await select.inputValue(), expected);
      assert.equal(await select.evaluate((node) => node.matches(":open")), false);
    }
    const size = page.getByRole("combobox", { name: "字号", exact: true });
    await size.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert.equal(await size.inputValue(), "12");
  } finally {
    await browser.close();
  }
});

test("wrapped color palettes and more tools align at different toolbar widths", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [500, 900]) {
      await page.setContent(`<style>${appCss}\n${colorCss}\n${dropdownCss}</style>
        <div class="tool-bar" style="margin:30px;width:${width}px;gap:30px">
          <fieldset class="color-picker text-color-picker" style="width:45px;height:30px">
            <button>颜色</button>
            <div class="spatial-presence"><div class="color-palette">颜色选项</div></div>
          </fieldset>
          <button class="tool-button more-tools" style="display:flex">更多工具</button>
          <div class="spatial-presence"><div class="toolbar-overflow-menu"><button>插入表格</button></div></div>
        </div>`);
      await page.locator(".color-palette").evaluate((palette) => {
        const toolbar = palette.closest(".tool-bar").getBoundingClientRect();
        const component = palette.closest(".color-picker").getBoundingClientRect();
        palette.style.top = `${toolbar.bottom}px`;
        palette.style.left = `${component.left}px`;
      });
      const toolbar = await page.locator(".tool-bar").boundingBox();
      for (const [menuName, anchorName] of [
        [".color-palette", ".color-picker"],
        [".toolbar-overflow-menu", ".more-tools"],
      ]) {
        const menu = await page.locator(menuName).boundingBox();
        const anchor = await page.locator(anchorName).boundingBox();
        assert.ok(Math.abs(menu.y - toolbar.y - toolbar.height) < 1, menuName);
        assert.ok(Math.abs(menu.x - anchor.x) < 1, menuName);
      }
    }
  } finally {
    await browser.close();
  }
});
