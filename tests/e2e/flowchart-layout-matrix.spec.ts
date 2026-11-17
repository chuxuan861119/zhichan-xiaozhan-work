import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { expect, test } from "./helpers/workbench.js";

test("flowchart editor keeps its canvas and export controls usable on short displays", async ({
  workbench,
}, info) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("textbox", { name: "专利名称" }).fill("流程图布局检查");
  await create.getByRole("radio", { name: "发明", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  await openDrawingEntry(page, "插入流程图");
  await expect
    .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
    .toBe(1);
  const frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
  if (!frame) throw new Error("Flowchart frame missing");
  await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "基础流程", exact: true }).click();
  for (const size of [
    { width: 912, height: 472 },
    { width: 1093, height: 574 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: info.outputPath(`flowchart-${size.width}.png`) });
    const canvas = await frame.locator(".geDiagramContainer").boundingBox();
    if (!canvas) throw new Error("Flowchart canvas missing");
    expect(canvas.width).toBeGreaterThan(100);
    expect(canvas.height).toBeGreaterThan(100);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(size.width + 1);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(size.height + 1);
    await frame.getByRole("button", { name: "导出至电脑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导出至电脑", exact: true });
    await expect(dialog).toBeVisible();
    const action = dialog.getByRole("button", { name: "确认导出", exact: true });
    const actionBox = await action.boundingBox();
    if (!actionBox) throw new Error("Export action missing");
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(size.height);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
});
