import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD accepts two-click and drag windows without stealing grips or additive selection", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const settle = async () => {
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 60_000 },
    );
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
  };
  await settle();
  for (const x of [150, 350]) {
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await canvas.click({ position: { x, y: 150 } });
    await canvas.click({ position: { x: x + 100, y: 200 } });
    await canvas.press("Enter");
    await settle();
  }
  const box = await canvas.boundingBox();
  if (!box) throw new Error("CAD canvas missing");
  const hover = async (x: number, y: number) => page.mouse.move(box.x + x, box.y + y);
  const window = canvas.locator('[data-cad-preview="window"] polygon');
  const count = (n: number) => workspace.getByText(`已选择 ${n} 个对象。`, { exact: true });
  // Release and move back-to-back: the first corner must survive capture loss,
  // a pending worker pick and the next animation frame.
  for (let attempt = 0; attempt < 8; attempt++) {
    await hover(100, 100);
    await page.mouse.down();
    await Promise.all([page.mouse.up(), hover(300, 230)]);
    await expect(window).toBeVisible();
    await hover(320, 250);
    await expect(window).toBeVisible();
    await canvas.press("Escape");
    await expect(window).toHaveCount(0);
  }
  // A release can contain cursor displacement without a held-button move.
  // That remains a first-corner click, not a completed drag window.
  const input = await page.context().newCDPSession(page);
  // A genuine held-button move can still be click jitter: time and distance
  // must both qualify before release is allowed to finish the window.
  for (const [seconds, dx, dy] of [
    [0.08, 12, 8],
    [0.2, 5, 0],
  ]) {
    await hover(100, 100);
    // Let the preceding Escape/hover frame settle before injecting this gesture.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const timestamp = (Date.now() - 1000) / 1000;
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x + 100,
      y: box.y + 100,
      button: "left",
      buttons: 1,
      clickCount: 1,
      timestamp,
    });
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x + 100 + dx!,
      y: box.y + 100 + dy!,
      buttons: 1,
      timestamp: timestamp + seconds!,
    });
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + 100 + dx!,
      y: box.y + 100 + dy!,
      button: "left",
      buttons: 0,
      clickCount: 1,
      timestamp: timestamp + seconds! + 0.01,
    });
    await hover(300, 230);
    await expect(window, `held ${seconds}s, displacement ${dx},${dy}`).toBeVisible();
    await canvas.click({ position: { x: 300, y: 230 } });
    await expect(count(1)).toBeVisible();
    await canvas.press("Escape");
  }
  for (const releasedMove of [false, true]) {
    await hover(100, 100);
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x + 100,
      y: box.y + 100,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    if (releasedMove)
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x + 108,
        y: box.y + 105,
        buttons: 0,
      });
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + 108,
      y: box.y + 105,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await hover(300, 230);
    await expect(window).toBeVisible();
    await canvas.click({ position: { x: 300, y: 230 } });
    await expect(count(1)).toBeVisible();
    await canvas.press("Escape");
  }
  await input.detach();
  await canvas.click({ position: { x: 100, y: 100 } });
  await hover(300, 230);
  await expect(window).toHaveClass("cad-window-contained");
  await canvas.click({ position: { x: 300, y: 230 } });
  await expect(count(1)).toBeVisible();
  await expect(window).toHaveCount(0);

  // The second corner may be on a selected endpoint; it must not grab that grip.
  await canvas.click({ position: { x: 300, y: 230 } });
  await hover(150, 150);
  await expect(window).toBeVisible();
  await canvas.click({ position: { x: 150, y: 150 } });
  await expect(window).toHaveCount(0);
  await expect(count(1)).toBeVisible();

  await canvas.click({ position: { x: 300, y: 100 } });
  await hover(500, 230);
  await expect(window).toBeVisible();
  await canvas.click({ position: { x: 500, y: 230 } });
  await expect(count(2)).toBeVisible();
  await canvas.click({ position: { x: 100, y: 300 } });
  await hover(300, 400);
  await expect(window).toBeVisible();
  await canvas.press("Escape");
  await expect(window).toHaveCount(0);
  await expect(panel.getByText("2 个对象已选中", { exact: true })).toBeVisible();

  // Right-to-left includes an intersecting segment, left-to-right requires containment.
  await canvas.press("Escape");
  await canvas.click({ position: { x: 200, y: 155 } });
  await hover(100, 220);
  await expect(window).toHaveClass("cad-window-crossing");
  await canvas.click({ position: { x: 100, y: 220 } });
  await expect(count(1)).toBeVisible();
  await canvas.press("Escape");
  await canvas.click({ position: { x: 100, y: 155 } });
  await hover(200, 220);
  await expect(window).toHaveClass("cad-window-contained");
  await canvas.click({ position: { x: 200, y: 220 } });
  await expect(
    workspace.getByText("点击或框选追加选择，Shift 移除选择；Esc 清除选择。", { exact: true }),
  ).toBeVisible();
  await expect(canvas.locator('g[pointer-events="none"][stroke="#007aff"] circle')).toHaveCount(0);

  await hover(100, 100);
  await page.mouse.down();
  // Intentional hold distinguishes a drag from two-corner click selection.
  await page.waitForTimeout(140);
  await hover(300, 230);
  await expect(window).toBeVisible();
  await page.mouse.up();
  await expect(count(1)).toBeVisible();
  await expect(window).toHaveCount(0);
  // Reusing the corner rapidly emits a native double-click; the next window must survive it.
  await canvas.click({ position: { x: 300, y: 230 } });
  await canvas.dispatchEvent("dblclick");
  await hover(100, 100);
  await expect(window).toBeVisible();
  await canvas.click({ position: { x: 100, y: 100 } });
  await expect(count(1)).toBeVisible();
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  await workspace.getByRole("button", { name: "取消", exact: true }).click();
  await expect(canvas.locator(".cad-control-points")).toHaveCount(0);
  await workspace.getByRole("button", { name: "圈选对象", exact: true }).click();
  await hover(100, 100);
  await page.mouse.down();
  for (const [x, y] of [[280,100],[300,150],[300,230],[200,260],[100,230],[100,100]])
    await hover(x!, y!);
  await page.mouse.up();
  await expect(count(1)).toBeVisible();
  await expect(canvas.locator(".cad-control-points")).toHaveCount(1);
  await workspace.getByRole("button", { name: "取消", exact: true }).click();
  await expect(canvas.locator(".cad-control-points")).toHaveCount(0);
  // Export an inactive drawing while a new, empty drawing is active.
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await settle();
  for (const format of ["dxf", "dwg"] as const) {
    const file = join(workbench.root, `sidebar-export.${format}`);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, file);
    await workspace.locator(".drawing-project-row").first().getByRole("button", {name: /更多操作/}).click();
    await page.getByRole("menuitem", {name: "导出CAD", exact: true}).click();
    await page.getByRole("dialog", {name: "导出CAD", exact: true}).getByRole("button", {name: `导出 ${format.toUpperCase()}`, exact: true}).click();
    await expect(workspace.getByText(`已导出 ${format.toUpperCase()} 图纸。`, {exact:true})).toBeVisible({timeout:60_000});
    const bytes = await readFile(file);
    if (format === "dxf") expect(bytes.toString()).toMatch(/\bLINE\b/);
    else expect(bytes.subarray(0,6).toString()).toMatch(/^AC10\d\d$/);
  }
  await workspace.getByLabel("选择图纸文件").setInputFiles(join(workbench.root, "sidebar-export.dwg"));
  await settle();
  await canvas.press("ControlOrMeta+a");
  await expect(count(2)).toBeVisible({timeout:60_000});
  const dense = "0\nSECTION\n2\nENTITIES\n" + Array.from({length:101}, (_, i) =>
    `0\nLINE\n5\n${(256+i).toString(16)}\n8\n0\n10\n0\n20\n${i*10}\n11\n1000\n21\n${i*10}\n`).join("") + "0\nENDSEC\n0\nEOF\n";
  await workspace.getByLabel("选择图纸文件").setInputFiles({name:"grip-limit.dxf",mimeType:"application/dxf",buffer:Buffer.from(dense)});
  await expect(workspace.getByRole("button",{name:"grip-limit.dxf",exact:true})).toHaveAttribute("aria-pressed","true",{timeout:60_000});
  await settle();
  await canvas.press("ControlOrMeta+a");
  await expect(count(101)).toBeVisible({timeout:60_000});
  await expect(canvas.locator(".cad-control-points")).toHaveCount(0);
  await expect(canvas.locator(".cad-selection-overlay path").first()).toBeAttached();
});
