import type { Page, TestInfo } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import sharp from "sharp";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function hoverRailHandle(page: Page, index = 0) {
  // Hover can replace the handle before Playwright finishes its stability check.
  // Sample its painted position, then move the background page pointer once.
  await page.screenshot();
  const handle = page
    .getByRole("button", { name: "展开功能栏", exact: true })
    .filter({ visible: true })
    .nth(index);
  if (!(await handle.count())) return;
  const bounds = await handle.boundingBox();
  if (bounds) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function createDocument(page: Page) {
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("编辑器布局矩阵验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const reminder = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await reminder.isVisible()) await reminder.click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.getByRole("textbox", { name: "编辑 说明书", exact: true }).evaluate((element) => {
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: [
        paragraph("技术领域"),
        ...Array.from({ length: 12 }, (_, i) =>
          paragraph(`本段${i + 1}涉及一种机械装置，包括底座、连接杆和支撑组件。`),
        ),
        paragraph("背景技术"),
        ...Array.from({ length: 12 }, (_, i) =>
          paragraph(`背景段${i + 1}用于验证缩放及连续滚动时的布局与阅读位置。`),
        ),
        paragraph("发明内容"),
        paragraph("附图说明"),
        paragraph("具体实施方式"),
        ...Array.from({ length: 35 }, (_, i) =>
          paragraph(`实施段${i + 1}：连接杆设置在底座上，支撑组件沿连接杆滑动，以便调整工作位置。`),
        ),
      ],
    });
  });
}

async function checkRails(page: Page, label: string, info: TestInfo) {
  // Hidden Electron windows defer compositor frames. Capture before measuring so
  // ResizeObserver/rAF-dependent layout has actually been painted.
  await page.screenshot();
  await page.waitForTimeout(100);
  const rails = page.locator('.patent-global-function-rail:not([aria-hidden="true"]):visible');
  for (let index = 0; index < (await rails.count()); index++) {
    const metrics = await rails.nth(index).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const toolbar = document.querySelector(".tool-bar")?.getBoundingClientRect();
      const footer = document.querySelector(".status-bar")?.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
        toolbar: toolbar?.bottom ?? 0,
        footer: footer?.top ?? innerHeight,
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
    expect.soft(metrics.left, `${label}: rail left`).toBeGreaterThanOrEqual(-1);
    expect.soft(metrics.right, `${label}: rail right`).toBeLessThanOrEqual(metrics.width + 1);
    expect
      .soft(metrics.top, `${label}: rail toolbar overlap`)
      .toBeGreaterThanOrEqual(metrics.toolbar);
    expect
      .soft(metrics.bottom, `${label}: rail footer overlap`)
      .toBeLessThanOrEqual(metrics.footer + 1);
    expect.soft(metrics.overflow, `${label}: rail internal clipping`).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: info.outputPath(`${label}.png`) });
}

test("all book surfaces keep a usable rail through tab changes and short windows", async ({
  workbench,
}, info) => {
  test.setTimeout(300_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  for (const [width, height] of [
    [1093, 574],
    [1280, 680],
    [1050, 700],
    [1450, 700],
    [1920, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const book of ["权利要求书", "说明书", "说明书附图", "说明书摘要", "摘要附图"]) {
      await page.getByRole("tab", { name: book, exact: true }).click();
      await page.waitForTimeout(260);
      const handle = page
        .getByRole("button", { name: "展开功能栏", exact: true })
        .filter({ visible: true });
      if (await handle.count()) await hoverRailHandle(page);
      await expect(page.getByRole("complementary", { name: /全局功能栏$/ })).toHaveCount(1);
      await checkRails(page, `book-${width}-${book}`, info);
      const close = page.getByRole("button", { name: "收起功能栏", exact: true });
      if (await close.isVisible()) await close.click();
      await page.mouse.move(600, 60);
    }
  }
});

test("drawing books share dual-pane zoom limits when switched from text", async ({
  workbench,
}, info) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
  await page.getByRole("menuitem", { name: "权／说", exact: true }).click();
  await page.setViewportSize({ width: 1400, height: 800 });
  const pane = page.getByRole("region", { name: "右侧文档", exact: true });
  for (const book of ["说明书附图", "摘要附图", "说明书摘要", "说明书"]) {
    await pane.getByRole("button", { name: "切换右侧文档", exact: true }).last().click();
    await page
      .getByRole("dialog", { name: "切换右侧文档" })
      .getByRole("button", { name: book, exact: true })
      .click();
    await pane.dispatchEvent("pointerdown");
    for (let step = 0; step < 20; step++) await page.keyboard.press("Control+=");
    await page.waitForTimeout(260);
    await page.screenshot({ path: info.outputPath(`dual-${book}.png`) });
    expect
      .soft(
        await pane
          .locator(".editor-workspace")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
        `${book}: clipped page`,
      )
      .toBeLessThanOrEqual(1);
    await checkRails(page, `dual-drawing-${book}`, info);
  }
});

test("CAD workspace shell stays inside short laptop windows", async ({ workbench }, info) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await expect(workspace).toBeVisible();
  const drawing = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await workspace.getByLabel("选择图纸文件").setInputFiles({
    name: "布局测试.png",
    mimeType: "image/png",
    buffer: drawing,
  });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(canvas).toBeVisible();
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: info.outputPath(`cad-${size.width}.png`) });
    const bounds = await workspace.boundingBox();
    if (!bounds) throw new Error("CAD workspace has no visible bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height + 1);
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("CAD canvas has no visible bounds");
    expect(canvasBounds.width).toBeGreaterThan(0);
    expect(canvasBounds.height).toBeGreaterThan(0);
    await checkRails(page, `cad-rail-${size.width}`, info);
  }
});

test("a description submenu keeps the narrow floating rail open while its help is used", async ({
  workbench,
}, info) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await page.setViewportSize({ width: 1050, height: 850 });
  await page.screenshot();
  await page.waitForTimeout(200);
  await hoverRailHandle(page);
  await expect(page.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeVisible();
  await page.locator(".claims-description-tool__toggle:visible").click();
  await page.locator(".claims-description-menu .claims-description-tool__invention-action").hover();
  await page.screenshot();
  await expect(page.locator(".claims-description-menu")).toBeVisible();
  const help = page.getByRole("dialog", { name: "发明内容说明", exact: true });
  await expect(help).toBeVisible();
  await help.getByRole("switch").click();
  await page.screenshot();
  await page.waitForTimeout(250);
  await expect(help).toBeVisible();
  await expect(page.getByRole("complementary", { name: "权利要求书全局功能栏" })).toBeVisible();
  await checkRails(page, "narrow-menu-help", info);
});

test("dual columns keep the native viewport at its origin after returning from settings", async ({
  workbench,
}, info) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await page.setViewportSize({ width: 1800, height: 650 });
  await page.screenshot();
  const viewport = page.locator(".editor-workspace.has-dual-column-surface:visible");
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "显示偏好", exact: true }).click();
  await page.getByRole("combobox", { name: "菜单与工具栏大小", exact: true }).selectOption("85");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.screenshot({ path: info.outputPath("return-settings.png") });
  await page.waitForTimeout(100);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await checkRails(page, "return-settings-rail", info);
});

test("toolbar display preferences leave the page, ruler and rail inside the editor viewport", async ({
  workbench,
}, info) => {
  test.setTimeout(180_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createDocument(page);
  for (const mode of ["single", "columns", "dual"] as const) {
    if (mode === "columns")
      await page.getByRole("button", { name: "双列显示", exact: true }).click();
    if (mode === "dual") {
      await page.getByRole("button", { name: "双列显示", exact: true }).click();
      await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
      await page.getByRole("menuitem", { name: "权／说", exact: true }).click();
    }
    await page.setViewportSize({ width: mode === "columns" ? 1800 : 1200, height: 650 });
    for (const scale of [85, 100, 110, 125]) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "显示偏好", exact: true }).click();
      await page
        .getByRole("combobox", { name: "菜单与工具栏大小", exact: true })
        .selectOption(String(scale));
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--settings-ui-scale"),
          ),
        )
        .toBe(String(scale / 100));
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.screenshot();
      const workspaces = page.locator(".editor-workspace:visible");
      for (const workspace of await workspaces.all()) {
        const bounds = await workspace.boundingBox();
        const toolbar = await page.locator(".tool-bar").boundingBox();
        if (!bounds || !toolbar) throw new Error("missing editor or toolbar bounds");
        expect(bounds.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(650);
      }
      const toggles = page
        .getByRole("button", { name: "展开功能栏", exact: true })
        .filter({ visible: true });
      if (await toggles.count()) await hoverRailHandle(page, (await toggles.count()) - 1);
      await checkRails(page, `ui-${mode}-${scale}`, info);
      const close = page
        .getByRole("button", { name: "收起功能栏", exact: true })
        .filter({ visible: true });
      if (await close.count()) await close.last().click();
    }
  }
});

for (const mode of ["single", "columns", "dual"] as const) {
  test(`layout matrix: ${mode} resize zoom and overlay controls`, async ({ workbench }, info) => {
    test.setTimeout(180_000);
    const app = await workbench.launchAllowMultipleInstances();
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 2200, height: 1000 });
    await createDocument(page);
    if (mode === "columns") {
      await page.getByRole("button", { name: "双列显示", exact: true }).click();
      await expect(page.locator(".dual-column-layout")).toBeVisible();
    } else if (mode === "dual") {
      await page.getByRole("button", { name: "打开常用双文档搭配" }).click();
      await page.getByRole("menuitem", { name: "权／说", exact: true }).click();
      await expect(page.locator(".dual-document-pane")).toHaveCount(2);
    }
    const sizes =
      mode === "columns"
        ? [
            { width: 2200, height: 1100 },
            { width: 1800, height: 700 },
            { width: 2400, height: 900 },
          ]
        : [
            { width: 1920, height: 1080 },
            { width: 1280, height: 700 },
            { width: 1600, height: 900 },
          ];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const zoom of ["reset", "small", "max"] as const) {
        await page.getByRole("button", { name: /缩放 .*点击重置/ }).click();
        if (zoom === "small") {
          for (let step = 0; step < 5; step++) await page.keyboard.press("Control+-");
        } else if (zoom === "max") {
          for (let step = 0; step < 25; step++) await page.keyboard.press("Control+=");
        }
        // Allow the size observers and exit transitions to finish before measuring.
        await page.waitForTimeout(240);
        const label = `${mode}-${size.width}x${size.height}-${zoom}`;
        await checkRails(page, label, info);
        if (mode !== "single") {
          const viewports = page.locator(".editor-workspace:visible");
          for (let index = 0; index < (await viewports.count()); index++) {
            expect
              .soft(
                await viewports
                  .nth(index)
                  .evaluate((element) => element.scrollWidth - element.clientWidth),
                `${label}: horizontal overflow`,
              )
              .toBeLessThanOrEqual(1);
          }
        }
        const toggles = page
          .getByRole("button", { name: "展开功能栏", exact: true })
          .filter({ visible: true });
        for (let index = 0; index < (await toggles.count()); index++) {
          await hoverRailHandle(page, index);
          await page.waitForTimeout(200);
          await checkRails(page, `${label}-overlay-${index}`, info);
          const close = page
            .getByRole("button", { name: "收起功能栏", exact: true })
            .filter({ visible: true });
          if (await close.count()) await close.last().click();
          await page.mouse.move(600, 60);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}
