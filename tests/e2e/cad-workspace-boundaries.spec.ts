import type { Page } from "@playwright/test";
import sharp from "sharp";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

// This acceptance suite must never activate a native verification window.
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function settle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    await new Promise(requestAnimationFrame);
  });
}

test("dual-view active tool fields remain visible without moving the canvas", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("CAD替换验收");
    await create.getByRole("radio", { name: "实用新型" }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", {
      name: "CAD标号",
      exact: true,
    });
    const buffer = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="100" y="100" width="220" height="140" fill="none" stroke="black" stroke-width="3"/><circle cx="700" cy="500" r="100" fill="none" stroke="black" stroke-width="3"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await workspace
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "替换测试.png", mimeType: "image/png", buffer });
    await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled();

    await settle(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "同屏双显", exact: true }).click();
    await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toBeVisible();
    const cad = page
      .getByRole("region", { name: "CAD标号", exact: true })
      .filter({ visible: true });
    await settle(page);
    const collapse = page.getByRole("button", { name: "收起功能栏", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await expect(cad.locator(".patent-global-function-rail-slot")).toHaveAttribute(
      "data-expanded",
      "false",
    );
    const before = await cad.locator(".drawing-viewport").boundingBox();
    await cad.getByRole("button", { name: "标号", exact: true }).click();
    await settle(page);
    const visibility = await cad.locator(".drawing-toolbar").evaluate((root) => {
      const bounds = root.getBoundingClientRect();
      const input = root.querySelector<HTMLInputElement>('input[aria-label="标号内容"]')!;
      const box = input.getBoundingClientRect();
      return {
        fits: box.left >= bounds.left && box.right <= bounds.right,
        focused: document.activeElement === input,
      };
    });
    expect(visibility).toEqual({ fits: true, focused: true });
    expect(await cad.locator(".drawing-viewport").boundingBox()).toEqual(before);
    await cad.getByLabel("标号内容", { exact: true }).fill("42");
    await page.getByRole("button", { name: "展开功能栏", exact: true }).click();
    await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
    await cad.getByRole("button", { name: "局部放大", exact: true }).click();
    await settle(page);
    await expect(cad.getByLabel("局部放大比例", { exact: true })).toHaveValue("2:1");
    const panel = await cad.locator(".cad-transient-window").boundingBox();
    const letter = await cad.getByLabel("局部放大字母", { exact: true }).boundingBox();
    expect(letter!.x).toBeGreaterThanOrEqual(panel!.x);
    expect(letter!.x + letter!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
    expect(await cad.locator(".drawing-viewport").boundingBox()).toEqual(before);
    await page.screenshot({
      path: testInfo.outputPath("dual-tool-options.png"),
    });
  } finally {
    await app.close();
  }
});

test("high-zoom crops remain valid and never shade the surrounding canvas", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("CAD替换验收");
    await create.getByRole("radio", { name: "实用新型" }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const workspace = page.getByRole("region", {
      name: "CAD标号",
      exact: true,
    });
    const buffer = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="100" y="100" width="220" height="140" fill="none" stroke="black" stroke-width="3"/><circle cx="700" cy="500" r="100" fill="none" stroke="black" stroke-width="3"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await workspace
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "替换测试.png", mimeType: "image/png", buffer });
    await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled();

    await settle(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    await workspace.getByRole("button", { name: "适合窗口", exact: true }).click();
    for (let i = 0; i < 45; i++) {
      await workspace
        .getByRole("button", { name: "放大图纸", exact: true })
        .evaluate((e) => (e as HTMLButtonElement).click());
      await page.waitForTimeout(35);
    }
    await settle(page);
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });

    const screen = await canvas.boundingBox();
    if (!screen) throw Error("missing canvas");
    await page.mouse.move(screen.x + screen.width * 0.3, screen.y + screen.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(screen.x + screen.width * 0.7, screen.y + screen.height * 0.7, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(workspace.locator("[data-region-outline]")).toHaveCount(1);
    await expect(workspace.locator("[data-region-shade]")).toHaveCount(0);
    await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeEnabled();
    await expect(workspace).not.toContainText("取图范围过小");
    await page.screenshot({ path: testInfo.outputPath("high-zoom-crop.png") });
  } finally {
    await app.close();
  }
});
