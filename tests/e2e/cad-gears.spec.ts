import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("detail gear rejection allows immediate correction, undo, export and leaving CAD", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("齿轮越界恢复验收");
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
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = ws.getByRole("application", { name: "CAD标号画布" });
  const settled = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
  };
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 220, y: 220 } });
  await canvas.click({ position: { x: 280, y: 280 } });
  await settled();
  await panel.getByRole("button", { name: "局部放大", exact: true }).click();
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
  await canvas.click({ position: { x: 250, y: 250 } });
  await canvas.click({ position: { x: 310, y: 250 } });
  await canvas.click({ position: { x: 400, y: 150 } });
  await canvas.click({ position: { x: 600, y: 300 } });
  await expect(canvas.locator("[data-detail-radius-ghost]")).toHaveCount(0);
  await settled();
  await canvas.press("Escape");
  await canvas.locator('[data-detail-part="content"]').first().click();
  await page.getByRole("button", { name: "编辑图形", exact: true }).click();
  await expect(page.locator(".cad-detail-breadcrumb")).toBeVisible();
  await panel.getByRole("button", { name: "齿轮选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "外齿轮", exact: true }).click();
  await canvas.click({ position: { x: 600, y: 300 } });
  await canvas.click({ position: { x: 630, y: 300 } });
  // Native validation happens before the edit queue becomes pending. Wait for
  // the drawing tool to finish before trying to select the newly created gear.
  await expect(page.getByRole("region", { name: "外齿轮设置", exact: true })).toBeHidden();
  await settled();
  await canvas.click({ position: { x: 606.9, y: 300 } });
  const settings = page.getByRole("region", { name: "齿轮设置" });
  await expect(settings).toBeVisible();
  const original = await settings.getByRole("spinbutton", { name: "齿轮大小" }).inputValue();
  await settings.getByRole("spinbutton", { name: "齿轮大小" }).fill("10000");
  await settings.getByRole("button", { name: "应用", exact: true }).click();
  await expect(ws.locator(".cad-instruction-card")).toContainText("超出圆形范围");
  await settled();
  await expect(settings.getByRole("spinbutton", { name: "齿轮大小" })).toBeEnabled();
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  await settings.getByRole("spinbutton", { name: "齿轮大小" }).fill(String(Number(original) * 0.8));
  await settings.getByRole("button", { name: "应用", exact: true }).click();
  await settled();
  await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settled();
  await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await settled();
  await page.locator(".cad-detail-breadcrumb").getByRole("button", { name: "完成", exact: true }).click();
  const target = join(workbench.root, "detail-gears.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await ws.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(ws.getByText(/^已导出 DXF 图纸。/u)).toBeVisible({ timeout: 60_000 });
  expect(await readFile(target, "utf8")).toContain("PatentWorkbenchGear:1:");
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect(ws).toBeHidden();
});

test("patent gears create, edit, undo, cancel and coexist with ordinary drawing", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("齿轮示意图验收");
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
  await expect(panel.getByRole("button", { name: "齿轮选项", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  async function tool(name: string) {
    await panel.getByRole("button", { name: "齿轮选项", exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  }
  await tool("外齿轮");
  await page.getByRole("spinbutton", { name: /齿数/ }).fill("16");
  await page.getByRole("spinbutton", { name: /齿数/ }).press("Enter");
  await canvas.click({ position: { x: 240, y: 240 } });
  await canvas.hover({ position: { x: 320, y: 240 } });
  await expect(canvas.locator(".cad-gesture-preview polyline").first()).toBeVisible();
  await canvas.click({ position: { x: 320, y: 240 } });
  await expect(page.getByRole("region", { name: "外齿轮设置" })).toBeHidden();
  await canvas.click({ position: { x: 258.4, y: 240 } });
  const settings = page.getByRole("region", { name: "齿轮设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("spinbutton", { name: "齿轮齿数" })).toHaveValue("16");
  const size = await settings.getByRole("spinbutton", { name: "齿轮大小" }).inputValue();
  await settings.getByRole("spinbutton", { name: "齿轮齿数" }).fill("24");
  await settings.getByRole("button", { name: "应用", exact: true }).click();
  await expect(settings.getByRole("spinbutton", { name: "齿轮齿数" })).toHaveValue("24");
  await expect(settings.getByRole("spinbutton", { name: "齿轮大小" })).toHaveValue(size);
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await canvas.click({ position: { x: 258.4, y: 240 } });
  await expect(settings.getByRole("spinbutton", { name: "齿轮齿数" })).toHaveValue("16");
  await canvas.press("Escape");
  await tool("内齿圈");
  await expect(page.getByRole("checkbox", { name: "中心孔" })).toHaveCount(0);
  await canvas.click({ position: { x: 500, y: 240 } });
  await canvas.click({ position: { x: 560, y: 240 } });
  await canvas.click({ position: { x: 560, y: 240 } });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading")).toHaveCount(0);
  await expect(settings).toContainText("内齿圈设置");
  await canvas.press("Escape");
  await tool("齿条");
  await page.getByRole("spinbutton", { name: /齿数/ }).fill("10");
  await page.getByRole("spinbutton", { name: /齿数/ }).press("Enter");
  await canvas.hover({ position: { x: 210, y: 450 } });
  await page.mouse.down();
  // A deliberate hold distinguishes dragging from two-click drawing.
  await page.waitForTimeout(150);
  await canvas.hover({ position: { x: 430, y: 450 } });
  await expect(canvas.locator(".cad-gesture-preview polyline").first()).toBeVisible();
  await page.mouse.up();
  await canvas.click({ position: { x: 320, y: 467.6 } });
  await expect(settings).toBeVisible();
  await expect(settings).toContainText("齿条设置");
  await canvas.press("Escape");
  await canvas.click({ position: { x: 700, y: 450 }, button: "right" });
  await expect(page.getByRole("region", { name: "齿条设置", exact: true })).toBeVisible();
  await canvas.press("Escape");
  await tool("外齿轮");
  await canvas.click({ position: { x: 700, y: 450 } });
  await canvas.press("Escape");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 200, y: 550 } });
  await canvas.click({ position: { x: 400, y: 550 } });
  await canvas.press("Escape");
  await page.mouse.move(0, 0);
  async function dragParameterGrip(index: number, dx: number, dy: number) {
    const marker = canvas.locator(`[data-cad-gear-grip="${index}"]`);
    const box = await marker.boundingBox();
    if (!box) throw new Error(`Missing gear grip ${index}`);
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
    await expect(canvas.locator(".cad-gesture-preview [data-trim-context]")).toBeVisible();
    await page.mouse.up();
    await expect(workspace).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
  }
  // Each displayed control goes through the real drag/handoff/save path, not a direct native call.
  for (const [point, kind, teeth] of [
    [{ x: 258.4, y: 240 }, "external", 16],
    [{ x: 560, y: 240 }, "internal", 20],
    [{ x: 320, y: 467.6 }, "rack", 10],
  ] as const) {
    await canvas.press("Escape");
    await canvas.click({ position: point });
    await expect(settings).toBeVisible();
    await expect(canvas.locator("[data-cad-gear-grip]")).toHaveCount(kind === "rack" ? 3 : 4);
    if (kind === "external") {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: "test-results/cad-gear-grips-external.png" });
    }
    const oldSize = Number(
      await settings.getByRole("spinbutton", { name: "齿轮大小" }).inputValue(),
    );
    await dragParameterGrip(1, 20, 0);
    await expect
      .poll(async () =>
        Number(await settings.getByRole("spinbutton", { name: "齿轮大小" }).inputValue()),
      )
      .toBeGreaterThan(oldSize);
    await dragParameterGrip(2, kind === "rack" ? 0 : -20, kind === "rack" ? 20 : 0);
    await expect
      .poll(async () =>
        Number(await settings.getByRole("spinbutton", { name: "齿轮齿数" }).inputValue()),
      )
      .toBeGreaterThan(teeth);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(settings.getByRole("spinbutton", { name: "齿轮齿数" })).toHaveValue(String(teeth));
    if (kind !== "rack") {
      const center = await canvas.locator('[data-cad-gear-grip="0"]').boundingBox();
      const rotate = await canvas.locator('[data-cad-gear-grip="3"]').boundingBox();
      if (!center || !rotate) throw new Error("Gear rotation controls missing");
      const cx = center.x + center.width / 2,
        cy = center.y + center.height / 2;
      const rx = rotate.x + rotate.width / 2,
        ry = rotate.y + rotate.height / 2;
      const radius = Math.hypot(rx - cx, ry - cy);
      await dragParameterGrip(3, cx + radius - rx, cy - ry);
      const after = await canvas.locator('[data-cad-gear-grip="0"]').boundingBox();
      expect(after?.x).toBeCloseTo(center.x, 0);
      expect(after?.y).toBeCloseTo(center.y, 0);
    }
  }
  await canvas.press("Escape");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "test-results/cad-gears.png" });
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
  const dwgTarget = join(workbench.root, "gears.dwg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, dwgTarget);
  await page.getByRole("button", { name: "导出 DWG", exact: true }).click();
  await expect(workspace.getByText("已导出 DWG 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect((await readFile(dwgTarget)).subarray(0, 6).toString()).toBe("AC1032");
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await app.close();
  const again = await workbench.launch();
  const reopened = await again.firstWindow();
  await dismissWorkbenchWelcome(reopened);
  const safety = reopened.getByRole("button", { name: "稍后设置", exact: true });
  if (await safety.isVisible()) await safety.click();
  await reopened.getByText("齿轮示意图验收", { exact: true }).first().dblclick();
  await reopened.getByRole("button", { name: "插入", exact: true }).click();
  await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const openRail = reopened.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if ((await openRail.isVisible()) && (await openRail.getAttribute("aria-expanded")) !== "true")
    await openRail.click();
  const restored = reopened.getByRole("region", { name: "CAD标号", exact: true });
  const dxfTarget = join(workbench.root, "restored-gears.dxf");
  await again.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, dxfTarget);
  const closeSafety = reopened.getByRole("button", { name: "暂时关闭数据安全提示", exact: true });
  if (await closeSafety.isVisible()) await closeSafety.click();
  await reopened.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(restored.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const dxf = await readFile(dxfTarget, "utf8");
  // Count actual model references, not retained/normalized block definitions.
  const runtime = join(process.cwd(), "resources/cadcraft/wasm");
  const { initSync, CadcraftSession } = await import(
    pathToFileURL(join(runtime, "cadcraft.js")).href
  );
  initSync({ module: await readFile(join(runtime, "cadcraft_bg.wasm")) });
  const kernel = new CadcraftSession();
  try {
    kernel.load_dxf(await readFile(dxfTarget));
    const result = JSON.parse(kernel.scene()) as {
      entities: { gear?: { kind: string; teeth: number } }[];
    };
    expect(result.entities.filter((entity) => entity.gear)).toHaveLength(3);
    expect(
      result.entities
        .filter((entity) => entity.gear)
        .map((entity) => entity.gear?.kind)
        .sort(),
    ).toEqual(["external", "internal", "rack"]);
  } finally {
    kernel.free();
  }
  expect(dxf).toContain('"teeth":16');
  expect(dxf).toContain('"kind":"internal"');
  expect(dxf).toContain('"kind":"rack"');
  expect(dxf).toMatch(/\bLINE\b/);
  // Read the actual DWG back through the shipping importer, then inspect its
  // editable entities rather than treating the file header as a round trip.
  await restored.getByLabel("选择图纸文件").setInputFiles({
    name: "exported-gears.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile(dwgTarget),
  });
  await expect(restored.locator('.drawing-project-name[title="exported-gears.dwg"]')).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await expect(restored.locator(".drawing-vector-preview").first()).toHaveAttribute("data-render-state", "ready", { timeout: 60_000 });
  const roundTripTarget = join(workbench.root, "round-trip-gears.dxf");
  await again.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, roundTripTarget);
  await reopened.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect.poll(async () => (await readFile(roundTripTarget).catch(() => Buffer.alloc(0))).length, { timeout: 60_000 }).toBeGreaterThan(0);
  const roundTrip = new CadcraftSession();
  try {
    roundTrip.load_dxf(await readFile(roundTripTarget));
    const entities = JSON.parse(roundTrip.scene()).entities as { type: string; gear?: { kind: string } }[];
    expect(entities.filter(entity => entity.gear).map(entity => entity.gear!.kind).sort()).toEqual(["external", "internal", "rack"]);
    expect(entities.some(entity => entity.type === "Line")).toBe(true);
  } finally {
    roundTrip.free();
  }
});
