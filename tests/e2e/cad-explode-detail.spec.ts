import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("whole detail explode is durable, undoable and does not detach existing patent labels", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWorkbenchWelcome(page);
  const name = "整体分解保存验收";
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
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
  const pin=page.getByRole("button", { name: "固定", exact: true }); if(await pin.isVisible())await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = ws.getByRole("application", { name: "CAD标号画布" });
  const settled = async () => {
    await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(ws).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
  };
  const project = () =>
    page.evaluate(async (name) => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw Error(list.error.message);
      const opened = await window.patentApi.patents.open(
        list.value.find((p) => p.name === name)!.patentId,
      );
      if (!opened.ok) throw Error(opened.error.message);
      return opened.value.patent.drawingProjects[0]!;
    }, name);
  await settled();
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 220, y: 220 } });
  await canvas.click({ position: { x: 280, y: 280 } });
  await settled();
  await canvas.press("Escape");
  await ws.locator('.drawing-toolbar [data-drawing-tool="label"]').click();
  await canvas.click({ position: { x: 220, y: 220 } });
  await canvas.click({ position: { x: 130, y: 170 } });
  await settled();
  await panel.getByRole("button", { name: "局部放大", exact: true }).click();
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
  await canvas.click({ position: { x: 250, y: 250 } });
  await canvas.click({ position: { x: 310, y: 250 } });
  await canvas.click({ position: { x: 400, y: 150 } });
  await canvas.click({ position: { x: 600, y: 300 } });
  await settled();
  await expect.poll(async () => (await project()).detailViews?.length).toBe(1);
  const original = await project();
  expect(original.annotations).toHaveLength(1);
  // Ordinary geometry is also a drag handle for a mixed selection of CAD, labels and details.
  await canvas.press("Escape");
  await canvas.press("Control+a");
  const box=(await canvas.boundingBox())!;
  await page.mouse.move(box.x+235,box.y+220);await page.mouse.down();
  await page.mouse.move(box.x+275,box.y+255);
  await expect(ws.locator("[data-cad-affine-preview]").first()).toBeVisible();
  await page.mouse.up();await settled();
  await expect.poll(async()=>(await project()).annotations[0]!.x).not.toBe(original.annotations[0]!.x);
  const moved=await project(), mark=moved.annotations[0]!, oldMark=original.annotations[0]!;
  const dx=mark.x-oldMark.x,dy=mark.y-oldMark.y;
  expect(Math.abs(dx)).toBeGreaterThan(0);
  oldMark.points.forEach((p,i)=>{
    expect(mark.points[i]!.x-p.x).toBeCloseTo(dx,5);
    expect(mark.points[i]!.y-p.y).toBeCloseTo(dy,5);
  });
  for(const key of ["center","source","marker","title"] as const){
    expect(moved.detailViews![0]![key].x-original.detailViews![0]![key].x).toBeCloseTo(dx,5);
    expect(moved.detailViews![0]![key].y-original.detailViews![0]![key].y).toBeCloseTo(dy,5);
  }
  expect(moved.detailViews![0]!.radius).toBe(original.detailViews![0]!.radius);
  await canvas.press("Control+z");await settled();
  await expect.poll(async()=>(await project()).annotations).toEqual(original.annotations);
  expect((await project()).detailViews).toEqual(original.detailViews);
  const detail = original.cad!.objects!.find((o) => o.kind === "detail")!;
  const members = [...(detail.body ?? []), ...(detail.frame ?? []), ...(detail.source ?? [])];
  await canvas.press("Escape");
  await canvas.locator('[data-detail-part="content"]').first().click();
  await panel.getByRole("button", { name: "分解", exact: true }).click();
  await expect(ws.locator(".cad-instruction-card")).toContainText("已分解 1");
  await settled();
  const detached = await project();
  expect(detached.detailViews).toEqual([]);
  expect(detached.annotations).toEqual(original.annotations);
  expect(detached.cad?.objects?.some((o) => o.kind === "detail")).toBe(false);
  await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settled();
  expect((await project()).detailViews).toEqual(original.detailViews);
  await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await settled();
  expect((await project()).detailViews).toEqual([]);
  const target = join(workbench.root, "exploded-detail.dxf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await ws.getByRole("button", { name: "导出 DXF", exact: true }).click();
  await expect(ws.getByText(/^已导出 DXF 图纸。/)).toBeVisible({ timeout: 60_000 });
  const dxf = await readFile(target, "utf8");
  expect(dxf).not.toContain("PW_DETAIL_");
  for (const handle of members) expect(dxf).toMatch(new RegExp(`\\n\\s*5\\r?\\n${handle}\\r?\\n`));
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
  await page.getByText(name, { exact: true }).first().dblclick();
  await expect(page.getByRole("tab", { name: "说明书", exact: true })).toBeVisible();
  expect((await project()).detailViews).toEqual([]);
  expect((await project()).annotations).toEqual(original.annotations);
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
