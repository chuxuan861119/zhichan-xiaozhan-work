import { readFile } from "node:fs/promises";
import { CadcraftSession, initSync } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("ordinary lines highlight and show array copies after changing a detail scale", async ({
  workbench,
}) => {
  test.setTimeout(90000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const app = await workbench.launch();
  const kernel = new CadcraftSession();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1100 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("局部放大后阵列回归");
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
    const click = (x: number, y: number) => canvas.click({ position: { x, y } });
    const settled = async () => {
      await expect(workspace).toHaveAttribute("data-cad-pending", "false");
      await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible();
    };
    const saved = async () => {
      const { project, bytes } = await page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) throw Error("Test patent missing");
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) throw Error(opened.error.message);
        const project = opened.value.patent.drawingProjects[0];
        if (!project?.cad) throw Error("Test CAD drawing missing");
        const result = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          project.cad.assetId,
        );
        if (!result.ok) throw Error(result.error.message);
        return { project, bytes: Array.from(result.value) };
      });
      kernel.load_dxf(Uint8Array.from(bytes));
      const scene = JSON.parse(kernel.scene()) as {
        entities: { handle: string; type: string }[];
        primitives: { handle: string; points: [number, number][] }[];
      };
      const lines = new Set(scene.entities.filter((e) => e.type === "Line").map((e) => e.handle));
      return { project, lines: scene.primitives.filter((p) => lines.has(p.handle)) };
    };
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await click(180, 620);
    await click(320, 620);
    await canvas.press("Enter");
    await settled();
    await panel.getByRole("button", { name: "矩形", exact: true }).click();
    await click(220, 220);
    await click(280, 280);
    await settled();
    await canvas.press("Escape");
    await panel.getByRole("button", { name: "局部放大", exact: true }).click();
    await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
    for (const [x, y] of [
      [250, 250],
      [310, 250],
      [400, 150],
      [600, 400],
    ] as const)
      await click(x, y);
    await settled();
    await canvas.press("Escape");
    const frame = canvas.locator('circle[data-detail-part="content"]');
    const at = await frame.evaluate((node) => {
      const circle = node as SVGCircleElement;
      const d = circle.r.baseVal.value / Math.sqrt(2);
      const p = new DOMPoint(
        circle.cx.baseVal.value + d,
        circle.cy.baseVal.value + d,
      ).matrixTransform(circle.getScreenCTM()!);
      return { x: p.x, y: p.y };
    });
    await page.mouse.click(at.x, at.y);
    const baseline = await saved();
    await page.getByRole("button", { name: "放大局部图", exact: true }).click();
    await settled();
    await expect
      .poll(async () => (await saved()).project.detailViews?.[0]?.ratio)
      .toBeGreaterThan(baseline.project.detailViews?.[0]?.ratio ?? 0);
    await canvas.press("Escape");
    await click(250, 620);
    await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeEnabled();
    await expect
      .soft(canvas.locator(".cad-selection-overlay polyline"))
      .toHaveCount(1, { timeout: 2000 });

    await panel.getByRole("button", { name: "阵列", exact: true }).click();
    await page.getByRole("spinbutton", { name: "列数", exact: true }).fill("2");
    await page.getByRole("spinbutton", { name: "列间距", exact: true }).fill("350");
    const apply = page.getByRole("button", { name: "应用", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();
    await settled();
    await expect.poll(async () => (await saved()).lines.length).toBe(baseline.lines.length + 1);
    const result = await saved();
    const source = baseline.lines[0]?.points[0];
    if (!source) throw Error("Test line missing");
    const copy = result.lines.find((line) => {
      const p = line.points[0];
      return p && Math.abs(p[0] - source[0] - 350) < 0.01 && Math.abs(p[1] - source[1]) < 0.01;
    });
    if (!copy || !result.project.cad)
      throw Error("Array copy was not saved at the requested spacing");
    await expect(canvas.locator(".cad-selection-overlay")).toHaveCount(0);
    await expect(workspace.getByRole("button", { name: "预览成图", exact: true })).toBeDisabled();
    const point = await canvas.evaluate(
      (svg, { points, mapping }) => {
        const [a, b] = points;
        if (!a || !b) throw Error("Array copy missing");
        const p = new DOMPoint(
          ((a[0] + b[0]) / 2 - mapping.originX) * mapping.scale,
          (mapping.originY - (a[1] + b[1]) / 2) * mapping.scale,
        ).matrixTransform((svg as unknown as SVGSVGElement).getScreenCTM()!);
        return { x: p.x, y: p.y };
      },
      { points: copy.points, mapping: result.project.cad.mapping },
    );
    await expect.soft
      .poll(
        () =>
          canvas.evaluate(
            (svg, point) =>
              Array.from(
                svg.parentElement!.querySelectorAll<SVGPathElement>(
                  "[data-cad-detail-live-scene] path",
                ),
              ).some((path) => {
                const matrix = path.getScreenCTM();
                return (
                  matrix &&
                  path.isPointInStroke(
                    new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse()),
                  )
                );
              }),
            point,
          ),
        { timeout: 2000 },
      )
      .toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(canvas.locator(".cad-selection-overlay polyline")).toHaveCount(1);
  } finally {
    kernel.free();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await app.close();
  }
});
