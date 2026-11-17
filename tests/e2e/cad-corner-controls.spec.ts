import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("one-click rectangle corners expose live radius and asymmetric chamfer grips", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill("角控制点验收");
  await create.getByRole("radio", { name: "实用新型", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
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
  const panel = page.getByRole("region", { name: "CAD实体编辑" }),
    canvas = ws.getByRole("application", { name: "CAD标号画布" });
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 200, y: 200 } });
  await canvas.click({ position: { x: 450, y: 400 } });
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await panel.getByRole("button", { name: "圆角", exact: true }).click();
  await page.getByRole("dialog", { name: "圆角设置" }).getByRole("spinbutton").fill("20");
  await page.getByRole("dialog", { name: "圆角设置" }).getByRole("spinbutton").press("Enter");
  await canvas.hover({ position: { x: 450, y: 200 } });
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(1);
  await canvas.click({ position: { x: 450, y: 200 } });
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(1);
  async function drag(index: number, dx: number, dy: number) {
    const grip = canvas.locator(`[data-cad-corner-grip="${index}"]`);
    const box = (await grip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
  }
  await drag(0, -35, 35);
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(1);
  await panel.getByRole("button", { name: "圆角选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "倒角", exact: true }).click();
  await canvas.click({ position: { x: 450, y: 400 } });
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(3);
  const side = canvas.locator('[data-cad-corner-grip="2"]');
  const stationary = [await side.getAttribute("cx"), await side.getAttribute("cy")];
  const first = canvas.locator('[data-cad-corner-grip="1"]');
  const bx = (await first.boundingBox())!,
    cb = (await canvas.boundingBox())!;
  await drag(
    1,
    (bx.x + bx.width / 2 - cb.x - 450) * 1.4,
    (bx.y + bx.height / 2 - cb.y - 400) * 1.4,
  );
  expect(Number(await side.getAttribute("cx"))).toBeCloseTo(Number(stationary[0]), 6);
  expect(Number(await side.getAttribute("cy"))).toBeCloseTo(Number(stationary[1]), 6);
  await drag(0, -12, -12);
  await expect(canvas.locator("[data-cad-corner-grip]")).toHaveCount(3);
  await page.screenshot({ path: "test-results/cad-corner-controls.png" });
  const output = join(workbench.root, "corners.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, output);
  await page.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(ws.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(await readFile(output, "utf8")).toContain("LWPOLYLINE");
  const saved = await readFile(output);
  const grip = (await canvas.locator('[data-cad-corner-grip="0"]').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40, grip.y - 40, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const cancelOutput = join(workbench.root, "cancelled.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, cancelOutput);
  await page.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await expect
    .poll(async () => {
      try {
        return (await readFile(cancelOutput)).length;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThan(0);
  initSync({
    module: await readFile(join(process.cwd(), "resources/cadcraft/wasm/cadcraft_bg.wasm")),
  });
  function inspect(bytes: Uint8Array): {entities:{geometry:unknown}[]} {
    const kernel = new CadcraftSession();
    try {
      kernel.load_dxf(bytes);
      return JSON.parse(kernel.scene()) as {entities:{geometry:unknown}[]};
    } finally {
      kernel.free();
    }
  }
  expect(inspect(await readFile(cancelOutput)).entities.map((e) => e.geometry)).toEqual(
    inspect(saved).entities.map((e) => e.geometry),
  );
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await app.close();
  const again = await workbench.launch(),
    reopened = await again.firstWindow();
  await dismissWorkbenchWelcome(reopened);
  const safety = reopened.getByRole("button", { name: "稍后设置", exact: true });
  if (await safety.isVisible()) await safety.click();
  await reopened.getByText("角控制点验收", { exact: true }).first().dblclick();
  await reopened.getByRole("button", { name: "插入", exact: true }).click();
  await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const openAgain = reopened.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if ((await openAgain.isVisible()) && (await openAgain.getAttribute("aria-expanded")) !== "true")
    await openAgain.click();
  const closeSafety = reopened.getByRole("button", { name: "暂时关闭数据安全提示", exact: true });
  if (await closeSafety.isVisible()) await closeSafety.click();
  const restoreOutput = join(workbench.root, "restored.dxf");
  await again.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, restoreOutput);
  await reopened.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(reopened.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const restored = inspect(await readFile(restoreOutput));
  expect(restored.entities.map(e=>e.geometry)).toEqual(inspect(saved).entities.map(e=>e.geometry));
  await expect(reopened.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
