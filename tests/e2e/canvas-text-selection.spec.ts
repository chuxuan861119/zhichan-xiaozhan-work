import { readFile } from "node:fs/promises";
import { chromium, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function preparePatent(page: Page) {
  // Exercise the real app DOM with current source styles, including when a developer
  // runs this regression against an existing build while the HMR instance is open.
  for (const path of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/drawing-markup/drawing-workspace.css",
  ]) {
    await page.addStyleTag({ content: await readFile(path, "utf8") });
  }
  await page.setViewportSize({ width: 1800, height: 1000 });
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
  }
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称", exact: true }).fill("画布拖动选字回归");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}

async function dragBlankTo(page: Page, surface: Locator, destination: Locator) {
  await expect(surface).toBeVisible();
  await expect(destination).toBeVisible();
  const source = await surface.boundingBox();
  const target = await destination.boundingBox();
  if (!source || !target) throw new Error("Missing drag bounds");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  // Start below the empty-state hint, in the actual non-editable blank canvas.
  await page.mouse.move(source.x + source.width * 0.65, source.y + source.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
}

async function dragText(page: Page, element: Locator, value: string) {
  await element.click({ trial: true });
  // Measure actual characters rather than assuming a font width or paragraph indent.
  const points = await element.evaluate((element, value) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(value) ?? -1;
      if (start < 0) continue;
      const point = (offset: number) => {
        const range = document.createRange();
        range.setStart(node as Text, start + offset);
        range.setEnd(node as Text, start + offset + 1);
        const box = range.getBoundingClientRect();
        return { x: box.x + 1, y: box.y + box.height / 2 };
      };
      return { from: point(0), to: point(Math.min(value.length - 1, 6)) };
    }
    throw new Error("The intended selectable text is not rendered");
  }, value);
  const hit = await page.evaluate((point) => {
    const element = document.elementFromPoint(point.x, point.y);
    return (
      element && {
        tag: element.tagName,
        className: element.className,
        userSelect: getComputedStyle(element).userSelect,
      }
    );
  }, points.from);
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 4 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.length, JSON.stringify({ value, hit })).toBeGreaterThan(0);
  expect(value).toContain(selected);
}

test("blank drawing books do not select menus, toolbar labels or the function rail", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await preparePatent(page);
    for (const name of ["说明书附图", "摘要附图"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      const surface =
        name === "说明书附图"
          ? page.getByRole("main", { name: "说明书附图页面", exact: true })
          : page.getByRole("main", { name: "摘要附图编辑器", exact: true });
      await test.step(`${name}: blank to menu`, async () => {
        await dragBlankTo(page, surface, page.getByRole("button", { name: "编辑", exact: true }));
      });
      await test.step(`${name}: blank to rail`, async () => {
        await dragBlankTo(
          page,
          surface,
          page.locator(".patent-global-function-rail__body:visible").first(),
        );
      });
    }
  } finally {
    await application.close();
  }
});

test("the empty CAD stage cannot start native text selection across the app", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await preparePatent(page);
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
    await dragBlankTo(
      page,
      workspace.locator(".drawing-stage"),
      page.getByRole("button", { name: "编辑", exact: true }),
    );
    await dragBlankTo(
      page,
      workspace.locator(".drawing-stage"),
      workspace.locator(".patent-global-function-rail__body"),
    );
    await dragBlankTo(
      page,
      workspace.locator(".drawing-sources"),
      page.getByRole("button", { name: "编辑", exact: true }),
    );
  } finally {
    await application.close();
  }
});

test("all text books still support deliberate drag selection", async ({ workbench }) => {
  test.setTimeout(120_000);
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await preparePatent(page);
    for (const name of ["权利要求书", "说明书", "说明书摘要"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      const editor = page.getByRole("textbox", { name: `编辑 ${name}`, exact: true });
      await editor.fill("正常正文仍然可以拖动选择文字。");
      await expect(editor).toContainText("正常正文仍然可以拖动选择文字。");
      await dragText(
        page,
        editor.locator("p").filter({ hasText: "正常正文仍然可以拖动选择文字。" }).first(),
        "正常正文仍然可以拖动选择文字。",
      );
    }
  } finally {
    await application.close();
  }
});

test("shared interface chrome is unselectable without disabling copyable content and fields", async () => {
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const css = (
      await Promise.all([
        readFile("src/renderer/src/app/app.css", "utf8"),
        readFile("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8"),
      ])
    ).join("\n");
    await page.setContent(`<style>${css}</style>
      <nav class="menu-bar"><span id="menu-label">工具菜单</span><input id="menu-field" value="查找文字" /></nav>
      <div class="tool-bar"><span id="tool-label">字号</span></div>
      <div class="patent-tabs"><span id="tab-label">专利标签</span></div>
      <aside class="patent-book-tools">
        <h3 id="rail-label">附图标记</h3><button id="action">插入附图</button>
        <p id="ai-result">可复制的检查结果和说明文字</p>
      </aside>
      <div class="drawing-workbench"><textarea id="explanation-field">附图说明仍然可以编辑和复制</textarea></div>
      <section class="drawing-workspace"><input id="cad-field" value="标号内容" />
        <p class="drawing-feedback" id="feedback">可复制的导入检查信息</p></section>
      <section class="snapshot-book-preview"><p id="snapshot">可复制的历史正文</p></section>
      <p class="settings-storage-path" id="path">D:/library</p>
      <div class="reference-mark-panel__row-activation-area" id="keyword">支撑部件</div>
      <h2><button class="patent-list-title-button" id="library-title">专利库内容标题</button></h2>
      <p id="legal">可复制的使用协议</p>`);
    for (const selector of ["#menu-label", "#tool-label", "#tab-label", "#rail-label", "#action"]) {
      await expect(page.locator(selector)).toHaveCSS("user-select", "none");
    }
    for (const selector of [
      "#ai-result",
      "#snapshot",
      "#path",
      "#keyword",
      "#legal",
      "#feedback",
      "#library-title",
    ]) {
      expect(
        await page.locator(selector).evaluate((element) => getComputedStyle(element).userSelect),
      ).not.toBe("none");
    }
    for (const selector of ["#menu-field", "#explanation-field", "#cad-field"]) {
      const input = page.locator(selector);
      await expect(input).toHaveCSS("user-select", "text");
      await input.focus();
      await input.press("Control+a");
      expect(
        await input.evaluate((element) => {
          const field = element as HTMLInputElement | HTMLTextAreaElement;
          return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
        }),
      ).toBe(await input.inputValue());
    }
  } finally {
    await browser.close();
  }
});
