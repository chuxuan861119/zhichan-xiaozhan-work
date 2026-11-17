import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD detail caption deletes independently and survives history, export and reopening", async ({ workbench }) => {
  test.setTimeout(180000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    const name = "局部放大独立标题删除";
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
    await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    const open = async () => {
      await page.getByRole("button", { name: "插入", exact: true }).click();
      await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    };
    await open();
    const ws = page.getByRole("region", { name: "CAD标号", exact: true });
    await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const panel = page.getByRole("region", { name: "CAD实体编辑" });
    const canvas = ws.getByRole("application", { name: "CAD标号画布" });
    const settled = async () => {
      await expect(ws).toHaveAttribute("data-cad-pending", "false");
      await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled();
    };
    const project = () => page.evaluate(async (name) => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw Error(list.error.message);
      const opened = await window.patentApi.patents.open(list.value.find(p => p.name === name)!.patentId);
      if (!opened.ok) throw Error(opened.error.message);
      return opened.value.patent.drawingProjects[0]!;
    }, name);
    await settled();
    await panel.getByRole("button", { name: "矩形", exact: true }).click();
    await canvas.click({ position: { x: 220, y: 220 } });
    await canvas.click({ position: { x: 280, y: 280 } });
    await settled();
    await canvas.press("Escape");
    await panel.getByRole("button", { name: "局部放大", exact: true }).click();
    await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
    for (const [x,y] of [[250,250],[310,250],[400,150],[600,400]])
      await canvas.click({ position: { x: x!, y: y! } });
    await settled();
    await expect(ws.locator('[data-detail-part="title"]')).toHaveCount(1);
    await canvas.press("Escape");
    const original = await project();
    const detailPaths = ws.locator("[data-cad-detail-live-body] path");
    await expect(detailPaths.first()).toBeVisible();
    await expect.poll(() => detailPaths.evaluateAll(paths => paths.some(path =>
      path.getAttribute("stroke") === "#007aff" || path.getAttribute("fill") === "#007aff"))).toBe(false);
    await ws.locator('[data-detail-part="title"] text').first().click();
    await canvas.press("Delete");
    await expect(ws.locator('[data-detail-part="title"]')).toHaveCount(0);
    await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
    await expect(ws.locator('[data-detail-part="marker"]')).toHaveCount(1);
    await settled();
    await expect.poll(async () => (await project()).detailViews?.[0]?.titleHidden).toBe(true);
    expect((await project()).detailViews?.[0]).toEqual({ ...original.detailViews![0], titleHidden: true });
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await expect(ws.locator('[data-detail-part="title"]')).toHaveCount(1);
    await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    await settled();
    await expect(ws.locator('[data-detail-part="title"]')).toHaveCount(0);
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await ws.locator('[data-detail-part="title"] text').first().click();
    await page.getByRole("button", { name: "删除局部放大标记", exact: true }).click();
    await settled();
    await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
    const target = join(workbench.root, "hidden-detail-caption.dxf");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await ws.getByRole("button", { name: "导出 DXF", exact: true }).click();
    await expect(ws.getByText(/^已导出 DXF 图纸。/)).toBeVisible({ timeout: 60000 });
    const kernel = new CadcraftSession();
    try {
      kernel.load_dxf(new Uint8Array(await readFile(target)));
      const scene = JSON.parse(kernel.scene());
      expect(scene.entities.some((e: {text?: string}) => e.text === "2:1")).toBe(false);
      expect(scene.entities.some((e: {text?: string}) => e.text === "A")).toBe(true);
      expect(scene.primitives.length).toBeGreaterThan(0);
    } finally {
      kernel.free();
    }
    await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    await page.getByText(name, { exact: true }).first().dblclick();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toBeVisible();
    await open();
    await settled();
    await expect(ws.locator('[data-detail-part="title"]')).toHaveCount(0);
    await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
    expect((await project()).detailViews?.[0]?.titleHidden).toBe(true);
  } finally {
    await app.close();
  }
});
