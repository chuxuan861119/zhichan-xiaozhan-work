import type { Page } from "@playwright/test";
import sharp from "sharp";
import {
  enterDualView,
  expect,
  expectActivePane,
  selectDualPane,
  test,
} from "./helpers/workbench.js";

async function create(page: Page) {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("工作区回归");
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}
async function point(page: Page, x: number, y: number) {
  return page.getByLabel("CAD标号画布").evaluate(
    (element, p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function click(page: Page, x: number, y: number) {
  const q = await point(page, x, y);
  await page.mouse.click(q.x, q.y);
}
async function rectangle(page: Page, x: number, y: number, r: number, b: number) {
  const start = await point(page, x, y),
    end = await point(page, r, b);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}
test("CAD transforms and split workspaces remain operable", async ({ workbench }) => {
  test.setTimeout(180000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await create(page);
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("slider", { name: "标号字号" })).toHaveCount(0);
  await expect(workspace.getByLabel("旋转角度")).toHaveCount(0);
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="100" y="100" width="400" height="300" fill="none" stroke="black" stroke-width="3"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "test.png", mimeType: "image/png", buffer: png });
  await rectangle(page, 50, 50, 600, 450);
  await expect(workspace.getByRole("slider", { name: "标号字号" })).toHaveCount(0);
  await expect(workspace.getByLabel("选区标号字号")).toHaveCount(0);
  await expect(workspace.getByRole("slider", { name: "旋转选区" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(workspace.getByLabel("旋转角度")).toHaveCount(0);
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  await click(page, 200, 200);
  await click(page, 400, 150);
  await page.keyboard.press("Escape");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await expect(workspace.locator("[data-leader-dot]")).toHaveCount(0);
  await page.getByLabel("CAD标号画布").focus();
  await page.keyboard.press("Control+a");
  await expect(workspace.locator("[data-selected-annotation-count]")).toContainText("1");
  await page.keyboard.press("Escape");
  await workspace.getByRole("button", { name: "框选编号" }).click();
  await rectangle(page, 50, 50, 600, 450);
  await expect(workspace.locator("[data-selected-annotation-count]")).toContainText("1");
  await page.keyboard.press("Escape");
  await rectangle(page, 50, 50, 600, 450);
  await expect(workspace.getByRole("slider", { name: "标号字号" })).toBeVisible();
  await expect(workspace.getByLabel("选区标号字号")).toBeVisible();
  await expect(workspace.getByLabel("旋转角度")).toHaveCount(0);
  await workspace.locator("[data-annotation] text").click();
  await expect(workspace.locator("[data-region-outline]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await rectangle(page, 50, 50, 600, 450);
  const before = await workspace.locator("[data-annotation] text").getAttribute("font-size");
  const h = await workspace.locator('[data-region-handle="ne"]').boundingBox();
  if (!h) throw new Error("no resize handle");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 80, h.y - 30, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await workspace.locator("[data-annotation] text").getAttribute("font-size")),
    )
    .toBeGreaterThan(Number(before));
  const resized = await workspace.locator("[data-annotation] text").getAttribute("font-size");
  await page.getByLabel("CAD标号画布").focus();
  await page.keyboard.press("Control+z");
  await expect(workspace.locator("[data-annotation] text")).toHaveAttribute("font-size", before!);
  await page.keyboard.press("Control+y");
  await expect(workspace.locator("[data-annotation] text")).toHaveAttribute("font-size", resized!);
  await rectangle(page, 0, 0, 900, 650);
  await page.keyboard.press("Delete");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
  await expect(preview.getByAltText("取图导出预览")).toBeVisible();
  expect(
    await preview.getByAltText("取图导出预览").evaluate(async (image) => {
      const bytes = new Uint8Array(
        await (await fetch((image as HTMLImageElement).src)).arrayBuffer(),
      );
      return [...bytes.slice(0, 3)];
    }),
  ).toEqual([255, 216, 255]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "同屏双显", exact: true }).click();
  const left = page.getByRole("region", { name: "左侧文档", exact: true });
  const right = page.getByRole("region", { name: "右侧文档", exact: true });
  await expect(workspace).toBeVisible();
  await right.getByRole("button", { name: "流程图 / 电路图", exact: true }).click();
  await expect(page.getByRole("main", { name: "流程图编辑工作区" })).toBeVisible();
  await expect
    .poll(() => page.frames().some((frame) => frame.url().endsWith("/embed.html")))
    .toBe(true);
  const diagramFrame = page.frames().find((frame) => frame.url().endsWith("/embed.html"))!;
  await diagramFrame.evaluate(() => {
    document.documentElement.dataset.workspaceToken = "preserved";
  });
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await workspace.getByLabel("CAD标号画布").focus();
  await expect(left).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Control+s");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.unmaximize();
  });
  await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toHaveCount(0);
  await expect(workspace).toBeVisible();
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  expect(await diagramFrame.evaluate(() => document.documentElement.dataset.workspaceToken)).toBe(
    "preserved",
  );
  await app.close();
});

test("keeps the CAD preview dialog on top of the neighbouring pane and blocks clicks behind it", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await create(page);
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  const png = await sharp(
    Buffer.from(
      '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="250" y="200" width="200" height="200" fill="black"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "双屏弹窗.png", mimeType: "image/png", buffer: png });
  await rectangle(page, 100, 100, 800, 600);

  // 进双屏后 CAD 面板被绝对定位成 z-index:1 的窗格，弹窗必须挂到 body 才能盖住另一侧功能栏。
  await enterDualView(page);
  await expect(workspace).toBeVisible();
  const right = page.getByRole("region", { name: "右侧文档", exact: true });
  await selectDualPane(page, "left");
  await expectActivePane(page, "left");
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
  await expect(preview).toBeVisible();
  const overlay = page.locator(".standard-dialog-overlay");
  expect(await overlay.evaluate((element) => element.parentElement === document.body)).toBe(true);

  const header = await right.locator(".dual-document-pane__header").boundingBox();
  const pane = await right.boundingBox();
  if (!header || !pane) throw new Error("缺少右侧窗格几何信息");
  for (const probe of [
    { x: header.x + header.width / 2, y: header.y + header.height / 2, point: "另一侧表头" },
    { x: pane.x + pane.width / 2, y: pane.y + pane.height * 0.75, point: "另一侧正文" },
  ]) {
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        overlay: Boolean(element?.closest(".standard-dialog-overlay")),
        otherPane: Boolean(element?.closest('[data-pane="right"]')),
      };
    }, probe);
    expect({ point: probe.point, ...hit }).toEqual({
      point: probe.point,
      overlay: true,
      otherPane: false,
    });
  }

  await app.close();
});

test("restoring the native window refits the single page after dual and column modes", async ({
  workbench,
}) => {
  test.setTimeout(120000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await create(page);
  for (const mode of ["同屏双显", "双列显示"]) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(
      page.locator(mode === "同屏双显" ? ".dual-document-workspace" : ".dual-column-layout"),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
    await expect(page.locator(".dual-column-layout, .dual-document-workspace")).toHaveCount(0);
    const frame = page
      .locator(".patent-page-with-rail > .patent-page-zoom-frame")
      .filter({ visible: true });
    await expect
      .poll(() => frame.evaluate((e) => e.getBoundingClientRect().width))
      .toBeGreaterThan(550);
  }
  await app.close();
});
