import { drawingProjectFixture } from "../../src/shared/drawing-markup/test-fixture.js";
import { cadSemanticKey } from "../../src/shared/drawing-markup/cad-semantic-key.js";
import type { DrawingProject } from "../../src/shared/drawing-markup/model.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("old expanded previews recover without moving native geometry or capture metadata", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  const setup = await page.evaluate(async () => {
    const opened = await window.patentApi.patents.create({
      patentType: "invention",
      name: "坐标恢复验收",
    });
    if (!opened.ok) throw Error(opened.error.message);
    const dxf = new TextEncoder().encode(
      "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n10\n8\n0\n10\n-100\n20\n900\n11\n1100\n21\n-100\n0\nLINE\n5\n11\n8\n0\n10\n100\n20\n100\n11\n900\n21\n100\n0\nENDSEC\n0\nEOF\n",
    );
    const frame = { width: 1000, height: 800, mapping: { originX: 0, originY: 800, scale: 1 } };
    const prepared = await window.patentApi.assets.prepareCad({
      sessionId: opened.value.sessionId,
      operationId: crypto.randomUUID(),
      originalName: "expanded.dxf",
      format: "dxf",
      bytes: dxf,
      frame,
    });
    if (!prepared.ok) throw Error(prepared.error.message);
    return {
      opened: {
        patentId: opened.value.patentId,
        sessionId: opened.value.sessionId,
        revision: opened.value.patent.revision,
      },
      prepared: prepared.value,
      frame,
      original: [...dxf],
    };
  });
  expect(setup.prepared.height).toBeGreaterThan(setup.frame.height);
  const project: DrawingProject = {
    ...drawingProjectFixture(setup.prepared.cad.assetId),
    name: "错位底图",
    sourceKind: "dxf" as const,
    baseAssetId: setup.prepared.assets.at(-1)!.descriptor.assetId,
    baseFragments: undefined,
    annotations: [],
    detailViews: [],
    regions: drawingProjectFixture(setup.prepared.cad.assetId).regions.map((region) => ({
      ...region,
      bodyNodeId: "00000000-0000-4000-8000-000000000099",
    })),
    cad: { ...setup.prepared.cad, mapping: setup.frame.mapping, unified: 1 as const, objects: [] },
  };
  project.cad = { ...project.cad!, semanticKey: cadSemanticKey(project) };
  await page.evaluate(
    async ({ setup, project }) => {
      const result = await window.patentApi.patents.applyFigureEdit({
        patentId: setup.opened.patentId,
        sessionId: setup.opened.sessionId,
        expectedRevision: setup.opened.revision,
        figures: [],
        abstractDrawingFigureId: null,
        assets: setup.prepared.assets.map((a) => a.descriptor),
        drawingProjects: [project],
      });
      if (!result.ok) throw Error(result.error.message);
    },
    { setup, project },
  );
  await page.reload();
  await page.getByText("坐标恢复验收", { exact: true }).dblclick();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  const open = async () => {
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  };
  await open();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  await expect(workspace.locator('.drawing-vector-preview[data-render-state="ready"]')).toBeVisible(
    { timeout: 60_000 },
  );
  const saved = async () =>
    page.evaluate(async (id) => {
      const opened = await window.patentApi.patents.open(id);
      if (!opened.ok) throw Error(opened.error.message);
      const project = opened.value.patent.drawingProjects[0]!;
      const native = await window.patentApi.assets.readDrawingSource(
        opened.value.sessionId,
        project.cad!.assetId,
      );
      const preview = await window.patentApi.assets.readDrawingSource(
        opened.value.sessionId,
        project.baseAssetId,
      );
      if (!native.ok || !preview.ok) throw Error("Missing saved assets");
      return { project, native: [...native.value], svg: new TextDecoder().decode(preview.value) };
    }, setup.opened.patentId);
  await expect.poll(async () => (await saved()).project.baseAssetId).not.toBe(project.baseAssetId);
  const repaired = await saved();
  expect(repaired.native).toEqual(setup.original);
  expect(repaired.project.cad!.assetId).toBe(project.cad!.assetId);
  expect(repaired.project.cad!.mapping).toEqual(project.cad!.mapping);
  expect([repaired.project.width, repaired.project.height]).toEqual([1000, 800]);
  expect(repaired.project.regions).toEqual(project.regions);
  expect(repaired.svg).toMatch(/viewBox="0 0 1000(?:\.0+)? 800(?:\.0+)?"/);
  // The out-of-frame line is retained in the SVG; a fixed frame is not a geometry crop.
  expect(repaired.svg).toContain("-100");
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  await expect(
    page
      .getByRole("region", { name: "CAD实体编辑" })
      .getByRole("button", { name: "直线", exact: true }),
  ).toBeEnabled();
  await canvas.press("Control+a");
  await expect(workspace.locator(".cad-selection-overlay")).toBeAttached();
  await expect(page.getByText("2 个对象已选中", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("aligned.png") });
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览" });
  const image = preview.getByAltText("取图导出预览");
  await expect(image).toBeVisible();
  const previewBytes = await image.evaluate(async (el) => [
    ...new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer()),
  ]);
  const ratio = await image.evaluate(async (el) => {
    const image = el as HTMLImageElement;
    await image.decode();
    return image.naturalWidth / image.naturalHeight;
  });
  // The diagonal spans 1200 x 1000, crossing all four original frame edges.
  expect(Math.abs(ratio - 1.2)).toBeLessThan(0.015);
  await preview.getByRole("button", { name: "插入说明书附图", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(workspace.getByText(/已插入附图/).first()).toBeVisible();
  await workspace.getByRole("button", { name: "插入附图", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const opened = await window.patentApi.patents.open(id);
        return opened.ok ? opened.value.patent.figures.length : 0;
      }, setup.opened.patentId),
    )
    .toBe(2);
  const inserted = await page.evaluate(async (id) => {
    const opened = await window.patentApi.patents.open(id);
    if (!opened.ok) throw Error(opened.error.message);
    return Promise.all(
      opened.value.patent.figures.map(async (figure) => {
        const bytes = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          figure.assetId,
        );
        if (!bytes.ok) throw Error(bytes.error.message);
        return [...bytes.value];
      }),
    );
  }, setup.opened.patentId);
  expect(inserted).toEqual([previewBytes, previewBytes]);
  expect((await saved()).native).toEqual(setup.original);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await open();
  await expect(
    workspace.locator('.drawing-vector-preview[data-render-state="ready"]'),
  ).toBeVisible();
  expect((await saved()).project.baseAssetId).toBe(repaired.project.baseAssetId);
});
