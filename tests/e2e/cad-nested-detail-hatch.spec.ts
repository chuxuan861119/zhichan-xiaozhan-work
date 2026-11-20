import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

for (const cropped of [false, true]) test(`nested CAD details hatch and delete only their source marker (cropped=${cropped})`, async ({
  workbench,
}) => {
  test.setTimeout(120000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1100 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill("二次放大剖面填充回归");
    await create.getByRole("radio", { name: "实用新型", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
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
    const panel = page.getByRole("region", { name: "CAD实体编辑" });
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const settled = () => expect(workspace).toHaveAttribute("data-cad-pending", "false");
    const snapshot = () =>
      page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) throw Error("Test patent missing");
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) throw Error(opened.error.message);
        const project = opened.value.patent.drawingProjects[0]!;
        const bytes = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          project.cad!.assetId,
        );
        if (!bytes.ok) throw Error(bytes.error.message);
        return { project, bytes: Array.from(bytes.value) };
      });
    await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "矩形", exact: true }).click();
    await canvas.click({ position: { x: 220, y: 220 } });
    await canvas.click({ position: { x: 280, y: 280 } });
    await settled();
    for (const [ratio, points] of [
      [
        "2:1",
        [
          [250, 250],
          [310, 250],
          [400, 150],
          [600, 400],
        ],
      ],
      [
        cropped ? "2:1" : "1.5:1",
        cropped ? [[630,400],[680,400],[780,300],[1000,600]] : [
          [600, 400],
          [690, 400],
          [780, 300],
          [1000, 600],
        ],
      ],
    ] as const) {
      await canvas.press("Escape");
      await panel.getByRole("button", { name: "局部放大", exact: true }).click();
      await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill(ratio);
      for (const [x, y] of points) await canvas.click({ position: { x, y } });
      await settled();
    }
    await canvas.press("Escape");
    await expect(workspace.locator('[data-detail-part="content"]')).toHaveCount(2);
    await panel.getByRole("button", { name: "剖面填充", exact: true }).click();
    await page.getByRole("button", { name: "选择图案 单线", exact: true }).click();
    await canvas.click({ position: { x: cropped ? 1080 : 997, y: cropped ? 600 : 597 } });
    await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await settled();
    const kernel = new CadcraftSession();
    try {
      await expect
        .poll(async () => {
          const { project, bytes } = await snapshot();
          kernel.load_dxf(new Uint8Array(bytes));
          const scene = JSON.parse(kernel.scene());
          const hatch = scene.entities.find((e: any) => e.type === "Hatch");
          if (!hatch) return { missingHatch: true };
          const outer = hatch.geometry.loops.find((loop: any) => loop.outer);
          const m = project.cad!.mapping;
          const points = outer.vertices.map((v: any) => v.p ?? v);
          const xs = points.map((p: any) => ((p.x ?? p[0]) - m.originX) * m.scale);
          const ys = points.map((p: any) => (m.originY - (p.y ?? p[1])) * m.scale);
          const nested = project.detailViews![1]!;
          const parent = project.detailViews![0]!;
          const half = parent.radius * 0.5 * parent.ratio * nested.ratio;
          const body = new Set(project.cad!.objects!.find(o => o.id === nested.id)!.body);
          const fillPoints = scene.primitives.filter((p: any) => p.handle === hatch.handle).flatMap((p: any) => p.points);
          const rightEdge = nested.center.x +
            (parent.radius * 0.5 * parent.ratio - (nested.source.x - parent.center.x)) * nested.ratio;
          return {
            geometry: cropped ? fillPoints.length > 0 && fillPoints.every(([x,y]: number[]) => {
              const px = (x! - m.originX) * m.scale, py = (m.originY - y!) * m.scale;
              return px >= rightEdge - 0.1 && Math.hypot(px-nested.center.x,py-nested.center.y) <= nested.radius*nested.ratio + 0.1;
            }) : Math.abs(Math.min(...xs) - (nested.center.x - half)) < 0.1 &&
              Math.abs(Math.max(...xs) - (nested.center.x + half)) < 0.1 &&
              Math.abs(Math.min(...ys) - (nested.center.y - half)) < 0.1 &&
              Math.abs(Math.max(...ys) - (nested.center.y + half)) < 0.1,
            paintOrder: scene.primitives.findIndex((p: any) => p.handle === hatch.handle) >
              scene.primitives.findLastIndex((p: any) => body.has(p.handle) && p.kind === "mask"),
            attached: body.has(hatch.handle),
          };
        })
        .toEqual({ geometry: true, paintOrder: true, attached: true });
    } finally {
      kernel.free();
    }
    await canvas.press("Escape");
    const baseline = (await snapshot()).project;
    const parentId = baseline.detailViews![0]!.id;
    const childId = baseline.detailViews![1]!.id;
    const circlePoint = async (selector: string) => workspace.locator(selector).evaluate(node => {
      const circle = node as SVGCircleElement;
      const d = circle.r.baseVal.value / Math.sqrt(2);
      const p = new DOMPoint(circle.cx.baseVal.value + d, circle.cy.baseVal.value + d).matrixTransform(circle.getScreenCTM()!);
      return { x: p.x, y: p.y };
    });
    const parentFrame = `[data-detail="${parentId}"] circle[data-detail-part="content"]`;
    const source = `[data-detail="${childId}"] [data-detail-source-hit]`;
    await page.mouse.click(...Object.values(await circlePoint(parentFrame)) as [number, number]);
    await page.getByRole("button", { name: "编辑图形", exact: true }).click();
    await expect(page.locator(".cad-detail-breadcrumb")).toContainText("内部编辑");
    await page.mouse.click(...Object.values(await circlePoint(source)) as [number, number]);
    await expect(workspace.locator(`[data-detail="${childId}"] [data-detail-part="marker"] circle[stroke="#007AFF"]`)).toHaveCount(1);
    await canvas.press("Delete");
    await settled();
    await expect(workspace.locator(source)).toHaveCount(0);
    await expect(workspace.locator('[data-detail-part="content"]')).toHaveCount(2);
    await expect.poll(async () => (await snapshot()).project.detailViews![1]!.markerHidden).toBe(true);
    const retained = (await snapshot()).project;
    expect(retained.cad!.objects!.find(o => o.id === childId)!.body)
      .toEqual(baseline.cad!.objects!.find(o => o.id === childId)!.body);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await expect(workspace.locator(source)).toHaveCount(1);
    await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    await settled();
    await expect(workspace.locator(source)).toHaveCount(0);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await page.mouse.click(...Object.values(await circlePoint(source)) as [number, number]);
    await page.getByRole("button", { name: "删除局部放大标记", exact: true }).click();
    await settled();
    await expect(workspace.locator(source)).toHaveCount(0);
    await expect(workspace.locator('[data-detail-part="content"]')).toHaveCount(2);
    const target = join(workbench.root, "nested-marker-deleted.dxf");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await workspace.getByRole("button", { name: "导出 DXF", exact: true }).click();
    await expect(workspace.getByText(/^已导出 DXF 图纸。/)).toBeVisible({ timeout: 60000 });
    const exported = new CadcraftSession();
    try {
      exported.load_dxf(new Uint8Array(await readFile(target)));
      const scene = JSON.parse(exported.scene());
      const handles = new Set(scene.entities.map((e: any) => e.handle));
      expect(baseline.cad!.objects!.find(o => o.id === childId)!.body!.every(h => handles.has(h))).toBe(true);
      expect(baseline.cad!.objects!.find(o => o.id === childId)!.source!.some(h => handles.has(h))).toBe(false);
      expect(scene.entities.some((e: any) => e.type === "Hatch")).toBe(true);
    } finally { exported.free(); }
    await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
    await page.getByRole("button", { name: "关闭二次放大剖面填充回归", exact: true }).click();
    await page.getByText("二次放大剖面填充回归", { exact: true }).first().dblclick();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    await settled();
    await expect(workspace.locator(source)).toHaveCount(0);
    await expect(workspace.locator('[data-detail-part="content"]')).toHaveCount(2);
    expect((await snapshot()).project.detailViews![1]).toEqual({ ...baseline.detailViews![1], markerHidden: true });
    await workspace.screenshot({ path: test.info().outputPath("nested-detail-hatch.png") });
    expect(
      await app.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
