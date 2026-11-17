import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/workbench.js";

async function createTestPatent(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("工具栏拖拽验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
}

async function dragEntry(page: Page, source: Locator, side: "left" | "right"): Promise<void> {
  await source.hover();
  const sourceRect = await source.boundingBox();
  const region = await page.getByTestId("patent-workspace-drop-region").boundingBox();
  if (!sourceRect || !region) throw new Error("Missing source or drop region");
  await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    region.x + region.width * (side === "left" ? 0.25 : 0.75),
    region.y + region.height * 0.4,
    { steps: 12 },
  );
  await expect(page.getByTestId(`workspace-tab-drop-${side}`)).toBeVisible();
  await page.mouse.up();
}

for (const [label, side, tool, mode] of [
  ["CAD标号", "right", "CAD标号", null],
  ["插入流程图", "left", "流程图 / 电路图", "flowchart"],
  ["电路图", "right", "流程图 / 电路图", "circuit"],
] as const) {
  test(`drags toolbar ${label} into ${side} pane`, async ({ workbench }) => {
    const application = await workbench.launchAllowMultipleInstances();
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1000 });
    await createTestPatent(page);
    await dragEntry(
      page,
      page
        .getByRole("toolbar", { name: "常用工具" })
        .getByRole("button", { name: label, exact: true }),
      side,
    );
    const toolPane = page.getByRole("region", {
      name: side === "left" ? "左侧文档" : "右侧文档",
      exact: true,
    });
    const otherPane = page.getByRole("region", {
      name: side === "left" ? "右侧文档" : "左侧文档",
      exact: true,
    });
    await expect(toolPane).toHaveAttribute("data-active", "true");
    await expect(
      toolPane
        .getByRole("button", { name: side === "left" ? "切换左侧文档" : "切换右侧文档" })
        .first(),
    ).toContainText(tool);
    await expect(otherPane.locator(".tiptap").first()).toBeVisible();
    if (mode) {
      await expect(page.getByTitle("流程图编辑器")).toBeVisible();
      const frame = page
        .frameLocator('iframe[title="流程图编辑器"]')
        .frameLocator('iframe[title="draw.io"]');
      // Both modes must load the actual offline editor, not merely an empty tool host.
      await expect(frame.locator(".geDiagramContainer")).toBeVisible();
      await expect(
        frame.getByRole("button", { name: mode === "circuit" ? "电路图" : "流程图", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    } else {
      await expect(page.getByRole("region", { name: "CAD标号", exact: true })).toBeVisible();
    }
    await application.close();
  });
}

test("drags a collapsed toolbar CAD entry and closes its overflow menu", async ({ workbench }) => {
  const application = await workbench.launchAllowMultipleInstances();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1000, height: 1000 });
  await createTestPatent(page);
  await page.getByRole("button", { name: "更多工具", exact: true }).click();
  const menu = page.getByRole("menu", { name: "更多编辑工具" });
  await dragEntry(page, menu.getByRole("menuitem", { name: "CAD标号", exact: true }), "right");
  await expect(page.getByRole("region", { name: "右侧文档", exact: true })).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByRole("region", { name: "CAD标号", exact: true })).toBeVisible();
  await expect(menu).toBeHidden();
  await application.close();
});
