import { expect, test } from "./helpers/workbench.js";

test("editor colors apply without document or layout changes, including AI and dual columns", async ({
  workbench,
}, info) => {
  test.setTimeout(300_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 940 });
  const welcome = page.getByRole("dialog", { name: /欢迎使用/u });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称" }).fill("配色隔离测试");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await expect(editor).toBeVisible();
  const content = await editor.innerHTML();
  const box = await editor.boundingBox();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "显示偏好", exact: true }).click();
  await expect(settings.locator('input[type="color"]')).toHaveCount(0);
  await expect(settings.getByLabel("页面颜色色值", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "页面颜色", exact: true }).click();
  await settings
    .getByRole("group", { name: "页面颜色可用颜色" })
    .getByRole("button", { name: "米白", exact: true })
    .click();
  await expect(settings.getByLabel("页面颜色", { exact: true })).toHaveAttribute(
    "data-color",
    "#faf4e6",
  );
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(settings.getByRole("group", { name: "页面颜色可用颜色" })).toBeVisible();
  await page.keyboard.press("Escape");
  await settings.getByRole("button", { name: "取消调整", exact: true }).click();
  await settings.getByRole("button", { name: "雾蓝", exact: true }).click();
  await settings.getByRole("button", { name: "应用配色", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--editor-display-canvas"),
      ),
    )
    .toBe("#ced7e3");
  for (const size of [
    { width: 850, height: 700 },
    { width: 1093, height: 574 },
    { width: 1500, height: 940 },
  ]) {
    await page.setViewportSize(size);
    await settings.evaluate((dialog) => {
      for (const element of dialog.querySelectorAll("*")) element.scrollTop = 0;
    });
    const layout = await settings.locator(".editor-color-workspace").evaluate((element) => {
      const preview = element.querySelector(".editor-color-preview")!.getBoundingClientRect();
      const controls = element.querySelector(".editor-color-controls")!.getBoundingClientRect();
      return {
        width: element.closest(".display-preferences")!.clientWidth,
        stacked: controls.top >= preview.bottom,
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.stacked).toBe(layout.width <= 620);
    expect(
      await settings
        .locator(".settings-workspace-content")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`settings-${size.width}.png`) });
    for (const label of ["页面颜色", "空背景颜色", "功能栏颜色"]) {
      const trigger = settings.getByRole("button", { name: label, exact: true });
      await trigger.click();
      const palette = settings.getByRole("group", { name: `${label}可用颜色` });
      await expect(palette).toBeVisible();
      const bounds = await palette.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
      const visibleArea = await settings.locator(".settings-workspace-content").boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(visibleArea!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(visibleArea!.y + visibleArea!.height);
      const contentSize = await palette.evaluate((element) => {
        let top = 0;
        let bottom = window.innerHeight;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
            const rect = parent.getBoundingClientRect();
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
        }
        return {
          needed: element.scrollHeight,
          visible: element.clientHeight,
          available: bottom - top,
        };
      });
      if (contentSize.needed + 18 <= contentSize.available) {
        expect(contentSize.visible).toBeGreaterThanOrEqual(contentSize.needed);
      }
      await page.screenshot({ path: info.outputPath(`palette-${label}-${size.width}.png`) });
      const swatches = palette.locator(".editor-color-picker__grid button");
      expect(await swatches.count()).toBeLessThanOrEqual(24);
      const rows = await swatches.evaluateAll(
        (buttons) =>
          new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
      );
      expect(rows).toBe(2);
      await swatches.first().click();
      await expect(palette).toBeVisible();
      const plane = palette.getByRole("slider", { name: "可用色域" });
      await plane.press("ArrowRight");
      const planeBox = await plane.boundingBox();
      if (!planeBox) throw new Error("Color gamut is not visible");
      await page.mouse.move(planeBox.x + planeBox.width * 0.2, planeBox.y + planeBox.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(planeBox.x + planeBox.width * 0.7, planeBox.y + planeBox.height * 0.6, {
        steps: 3,
      });
      await page.mouse.up();
      await plane.press("ArrowRight");
      await palette.getByRole("slider", { name: "色相" }).press("ArrowRight");
      await expect(settings.getByRole("alert")).toHaveCount(0);
      await expect(palette.getByLabel("当前色值")).toHaveValue(/^#[0-9A-F]{6}$/);
      await page.screenshot({ path: info.outputPath(`gamut-${label}-${size.width}.png`) });
      const customBounds = await palette.boundingBox();
      if (!customBounds || !visibleArea) throw new Error("Missing palette bounds");
      expect(customBounds.y).toBeGreaterThanOrEqual(visibleArea.y);
      expect(customBounds.y + customBounds.height).toBeLessThanOrEqual(
        visibleArea.y + visibleArea.height,
      );
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "取消调整", exact: true }).click();
    }
  }
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(editor).toBeVisible();
  expect(await editor.innerHTML()).toBe(content);
  const afterBox = await editor.boundingBox();
  expect(afterBox?.width).toBe(box?.width);
  expect(afterBox?.height).toBe(box?.height);
  await expect(page.locator(".editor-workspace").filter({ visible: true }).first()).toHaveCSS(
    "background-color",
    "rgb(206, 215, 227)",
  );
  await expect(page.locator(".patent-book-rich-text").filter({ visible: true }).first()).toHaveCSS(
    "background-color",
    "rgb(240, 244, 250)",
  );
  await page.screenshot({ path: info.outputPath("mist-blue-editor.png") });
  await expect(
    page
      .locator(".patent-global-function-rail .compact-tool-actions")
      .filter({ visible: true })
      .first(),
  ).toHaveCSS("background-color", "rgb(247, 249, 252)");
  for (const [name, selector] of [
    ["AI 纠错", ".ai-correction-panel"],
    ["小栈AI助手", ".text-polish-panel"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).first().click();
    const panel = page.locator(selector);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("background-color", "rgb(247, 249, 252)");
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
    await panel.getByRole("button", { name: /关闭/ }).first().click();
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "显示偏好", exact: true }).click();
  await settings.getByRole("button", { name: "浅竹绿", exact: true }).click();
  await settings.getByRole("button", { name: "应用配色", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-display-page")),
    )
    .toBe("#eef5eb");
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.locator(".patent-book-rich-text").filter({ visible: true }).first()).toHaveCSS(
    "background-color",
    "rgb(238, 245, 235)",
  );
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".patent-book-rich-text").filter({ visible: true }).first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(page.locator(".dual-column-layout")).toBeVisible();
  await expect(page.locator(".dual-column-paper-background").first()).toHaveCSS(
    "background-color",
    "rgb(238, 245, 235)",
  );
  await page.screenshot({ path: info.outputPath("dual-columns.png") });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await page.getByRole("button", { name: "同屏双显", exact: true }).click();
  await expect(page.locator(".dual-document-pane")).toHaveCount(2);
  await page
    .locator(".dual-document-pane")
    .nth(1)
    .getByRole("button", { name: "说明书", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
  for (const paper of await page
    .locator(".patent-book-rich-text")
    .filter({ visible: true })
    .all()) {
    await expect(paper).toHaveCSS("background-color", "rgb(238, 245, 235)");
  }
  await expect(page.locator('.dual-document-pane[data-active="true"]')).toHaveCSS(
    "background-color",
    "rgb(207, 218, 203)",
  );
  const inactivePane = page.locator('.dual-document-pane[data-active="false"]');
  await expect(inactivePane).toHaveCSS("background-color", "rgb(174, 183, 171)");
  const canvases = await page
    .locator(".dual-document-pane")
    .evaluateAll((panes) => panes.map((pane) => getComputedStyle(pane).backgroundColor));
  expect(canvases[0]).not.toBe(canvases[1]);
  await page.screenshot({ path: info.outputPath("dual-documents.png") });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-display-page")),
    )
    .toBe("#eef5eb");
});
