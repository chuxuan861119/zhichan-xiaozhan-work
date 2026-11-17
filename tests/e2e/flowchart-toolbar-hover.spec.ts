import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { expect, test } from "./helpers/workbench.js";

test("flowchart toolbar hover stays bounded and history icons work independently of fonts", async ({
  workbench,
}, info) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称" }).fill("流程图悬停回归");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  await openDrawingEntry(page, "插入流程图");
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().endsWith("/embed.html")).length)
    .toBe(1);
  const frame = page.frames().find((candidate) => candidate.url().endsWith("/embed.html"));
  if (!frame) throw new Error("Flowchart frame missing");
  await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  const toolbar = frame.getByRole("toolbar", { name: "流程图工具栏" });
  expect(await toolbar.locator(".patent-toolbar__button[title]").count()).toBe(0);
  for (const label of ["撤销", "重做"]) {
    const button = toolbar.getByRole("button", { name: label, exact: true });
    await expect(button.locator("svg")).toBeVisible();
    expect(await button.textContent()).toBe("");
  }
  for (const size of [
    { width: 1280, height: 800 },
    { width: 912, height: 472 },
  ]) {
    await page.setViewportSize(size);
    for (const label of ["工程列表", "流程图", "电路图"]) {
      const button = toolbar.getByRole("button", { name: label, exact: true });
      // Offscreen Electron misroutes pointer coordinates in custom-protocol child
      // frames. Exercise the same hover handlers without bringing a window forward.
      const tooltip = frame.getByRole("tooltip");
      await expect(async () => {
        if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
          await button.dispatchEvent("pointerenter");
        else await button.hover();
        // A delayed child-frame resize may legitimately cancel the first tooltip.
        await expect(tooltip).toHaveText(label, { timeout: 1500 });
      }).toPass({ timeout: 10000 });
      const bounds = await tooltip.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
      });
      expect(bounds.width).toBeLessThan(240);
      expect(bounds.height).toBeLessThan(60);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
      await expect(frame.locator(".geDiagramContainer")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`hover-${label}-${size.width}.png`) });
      if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
        await button.dispatchEvent("pointerleave");
      else await frame.locator(".geDiagramContainer").hover({ position: { x: 80, y: 80 } });
      await expect(tooltip).toHaveCount(0);
    }
  }
  const list = toolbar.getByRole("button", { name: "工程列表", exact: true });
  if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") await list.dispatchEvent("focus");
  else await list.focus();
  await expect(frame.getByRole("tooltip")).toHaveText("工程列表");
  if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
    await list.dispatchEvent("keydown", { key: "Escape" });
  else await list.press("Escape");
  await expect(frame.getByRole("tooltip")).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 900 });
  const activate = async (button: import("@playwright/test").Locator) => {
    await expect(button).toBeEnabled();
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
      await button.evaluate((element) => (element as HTMLElement).click());
    else await button.click();
  };
  await activate(frame.getByRole("button", { name: "基础流程", exact: true }));
  await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
  const undo = toolbar.getByRole("button", { name: "撤销", exact: true });
  const redo = toolbar.getByRole("button", { name: "重做", exact: true });
  await expect(undo).toBeEnabled();
  await activate(undo);
  await expect(redo).toBeEnabled();
  await activate(redo);
  await expect(undo).toBeEnabled();
});
