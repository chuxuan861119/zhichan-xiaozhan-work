import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("patent-scoped clipboard pastes whole CAD content across drawings without changing source or history", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  const title = "跨图纸复制验收";
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(title);
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true }),
    canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
  const ready = () => expect(panel).toHaveAttribute("data-cad-ready", "true", { timeout: 60_000 });
  const settled = () =>
    expect(ws).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
  const count = async () => {
    await canvas.press("ControlOrMeta+a");
    return Number(
      (await panel.getByRole("group", { name: "修改" }).locator("legend").innerText()).match(
        /\d+/,
      )?.[0] ?? 0,
    );
  };
  await ready();
  const source = await ws.locator(".drawing-project-row").first().getAttribute("data-project-id");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 180, y: 360 } });
  await canvas.click({ position: { x: 330, y: 360 } });
  await canvas.click({ position: { x: 330, y: 480 } });
  await canvas.press("Enter");
  await settled();
  await panel.getByRole("button", { name: "圆", exact: true }).click();
  await canvas.click({ position: { x: 220, y: 420 } });
  await canvas.click({ position: { x: 250, y: 420 } });
  await canvas.press("Escape");
  await settled();
  await expect.poll(count).toBe(3);
  await canvas.press("ControlOrMeta+c");
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(ws.locator(".drawing-project-row")).toHaveCount(2);
  await ready();
  const target = await ws.locator(".drawing-project-row").last().getAttribute("data-project-id");
  expect(target).not.toBe(source);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 500, y: 420 } });
  await canvas.click({ position: { x: 650, y: 420 } });
  await canvas.press("Enter");
  await settled();
  await page.evaluate(() => {
    const probe = window as unknown as { pasteTransfers: boolean[] };
    probe.pasteTransfers = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      if (args[0]?.method === "editPaste") probe.pasteTransfers.push(!!args[0].args[0].bytes);
      return original.apply(this, args);
    } as Worker["postMessage"];
  });
  await canvas.press("ControlOrMeta+v");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 420, { steps: 20 });
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  await canvas.click({ position: { x: 300, y: 420 } });
  await settled();
  await expect.poll(count).toBe(4);
  await canvas.press("ControlOrMeta+z");
  await settled();
  await expect.poll(count).toBe(1);
  await canvas.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  await settled();
  await expect.poll(count).toBe(4);
  await canvas.press("ControlOrMeta+v");
  await canvas.click({ position: { x: 400, y: 580 } });
  await settled();
  await expect.poll(count).toBe(7);
  expect(
    await page.evaluate(() => (window as unknown as { pasteTransfers: boolean[] }).pasteTransfers),
  ).toEqual([true, false]);
  await canvas.press("ControlOrMeta+z");
  await settled();
  await expect.poll(count).toBe(4);
  await canvas.press("ControlOrMeta+v");
  await canvas.press("Escape");
  await expect.poll(count).toBe(4);
  await ws.locator(`[data-project-id="${source}"] .drawing-project-name`).click();
  await ready();
  await expect.poll(count).toBe(3);
  await canvas.press("Delete");
  await settled();
  await expect.poll(count).toBe(0);
  await ws.locator(`[data-project-id="${target}"] .drawing-project-name`).click();
  await ready();
  await canvas.press("ControlOrMeta+v");
  await canvas.click({ position: { x: 300, y: 580 } });
  await settled();
  await expect.poll(count).toBe(7);
  const file = join(workbench.root, "cross-drawing.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
  await page.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(page.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const runtime = join(process.cwd(), "resources/cadcraft/wasm");
  const { initSync, CadcraftSession } = await import(
    pathToFileURL(join(runtime, "cadcraft.js")).href
  );
  initSync({ module: await readFile(join(runtime, "cadcraft_bg.wasm")) });
  const kernel = new CadcraftSession();
  try {
    kernel.load_dxf(await readFile(file));
    expect(JSON.parse(kernel.scene()).entityCount).toBe(7);
  } finally {
    kernel.free();
  }
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await app.close();
  const again = await workbench.launch(),
    reopened = await again.firstWindow();
  await dismissWorkbenchWelcome(reopened);
  const reminder = reopened.getByRole("button", { name: "稍后设置", exact: true });
  if (await reminder.isVisible()) await reminder.click();
  await reopened.getByText(title, { exact: true }).first().dblclick();
  await reopened.getByRole("button", { name: "插入", exact: true }).click();
  await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await reopened.locator(`[data-project-id="${target}"] .drawing-project-name`).click();
  const targetCanvas = reopened.getByRole("application", { name: "CAD标号画布", exact: true });
  const reopenedPanel = reopened.getByRole("region", { name: "CAD实体编辑", exact: true });
  await expect(reopenedPanel).toHaveAttribute("data-cad-ready", "true", { timeout: 60_000 });
  const rail = reopened.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await rail.isVisible()) await rail.click();
  await targetCanvas.press("ControlOrMeta+a");
  await expect(reopenedPanel.getByRole("group", { name: "修改" }).locator("legend")).toContainText(
    "7",
  );
});
