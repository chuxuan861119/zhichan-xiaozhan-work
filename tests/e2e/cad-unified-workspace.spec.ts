import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("one CAD canvas combines drawing, numbering, mixed transforms, frozen clipboard and editable details", async ({
  workbench,
}) => {
  test.setTimeout(240_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill("统一CAD工作区验收");
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(
    workspace.getByText("图纸已导入。选中线条、图形和标号后即可预览或插入附图。", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
  const panel = page.getByRole("region", { name: "CAD实体编辑" }),
    canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const settle = async () => {
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 60_000 },
    );
    await expect(workspace).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
  };
  const project = () =>
    page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw new Error(list.error.message);
      const patent = await window.patentApi.patents.open(
        list.value.find((p) => p.name === "统一CAD工作区验收")!.patentId,
      );
      if (!patent.ok) throw new Error(patent.error.message);
      return patent.value.patent.drawingProjects[0]!;
    });
  await settle();
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(workspace.locator(".drawing-project-name")).toHaveCount(2);
  await settle();
  await workspace.locator(".drawing-project-name").first().click();
  await settle();
  await app.evaluate(
    ({ ipcMain }, assetId) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      const original = handlers.get("drawings:read-source")!;
      let reads = 0;
      handlers.set("drawings:read-source", (...args) => {
        if ((args[1] as { assetId?: string })?.assetId === assetId) reads++;
        return original(...args);
      });
      (globalThis as unknown as { finishBaseReadProbe: () => number }).finishBaseReadProbe = () => {
        handlers.set("drawings:read-source", original);
        return reads;
      };
    },
    (await project()).baseAssetId,
  );
  await expect(panel.getByRole("button", { name: "绘图修改", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: /坐标|图层/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 150, y: 150 } });
  await panel.evaluate((el) => {
    (window as unknown as { preservedCadPanel: Element }).preservedCadPanel = el;
  });
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("tabpanel", { name: "附图标记", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
  expect(
    await panel.evaluate(
      (el) => (window as unknown as { preservedCadPanel: Element }).preservedCadPanel === el,
    ),
  ).toBe(true);
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await canvas.click({ position: { x: 350, y: 250 } });
  await settle();
  await canvas.press("Enter");
  await settle();
  expect(
    await app.evaluate(() =>
      (globalThis as unknown as { finishBaseReadProbe: () => number }).finishBaseReadProbe(),
    ),
  ).toBe(0);
  await workspace.locator('[data-drawing-tool="label"]').click();
  await canvas.click({ position: { x: 250, y: 200 } });
  await canvas.click({ position: { x: 450, y: 170 } });
  await expect(canvas.locator("[data-annotation]")).toHaveCount(1);
  await workspace.locator('[data-drawing-tool="select"]').click();
  await settle();
  const original = await project();
  expect(original.cad?.unified).toBe(1);
  expect(original.cad?.objects?.find((o) => o.kind === "label")?.label?.length).toBe(2);
  await canvas.press("Control+a");
  await panel.getByRole("button", { name: "移动", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 100 } });
  await canvas.click({ position: { x: 120, y: 120 } });
  await settle();
  const moved = await project();
  expect(moved.annotations[0]!.x).not.toBe(original.annotations[0]!.x);
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settle();
  expect((await project()).annotations).toEqual(original.annotations);
  await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await settle();
  expect((await project()).annotations).toEqual(moved.annotations);
  await canvas.press("Control+a");
  await canvas.press("Control+c");
  await expect(
    workspace.getByText("已复制选中对象，粘贴后点击放置位置。", { exact: true }),
  ).toBeVisible();
  await canvas.press("Delete");
  await settle();
  expect((await project()).annotations).toHaveLength(0);
  await canvas.press("Control+v");
  await canvas.click({ position: { x: 300, y: 250 } });
  await settle();
  expect((await project()).annotations).toHaveLength(1);
  const detailTool = panel.getByRole("button", { name: "局部放大", exact: true });
  const beforeDetail = await project();
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "展开功能栏", exact: true }).click();
  await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
  const topDetail = detailTool;
  await topDetail.click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("tab", { name: "CAD工具", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(detailTool).toHaveAttribute("aria-pressed", "true");
  await expect(workspace.locator(".cad-instruction-card")).toContainText("点击取图圆心");
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
  await canvas.click({ position: { x: 300, y: 250 } });
  await expect(workspace.locator(".cad-instruction-card")).toContainText("确定圆的大小");
  await canvas.press("Escape");
  const cancelledDetail = await project();
  expect(cancelledDetail.detailViews).toHaveLength(0);
  expect(cancelledDetail.cad?.assetId).toBe(beforeDetail.cad?.assetId);
  await expect(topDetail).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toBeVisible();
  await topDetail.click();
  await expect(panel).toBeVisible();
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
  await expect(workspace.locator(".cad-instruction-card")).toContainText("点击取图圆心");
  await expect(page.getByRole("textbox", { name: "局部放大比例", exact: true })).toHaveValue(
    "2:1",
  );
  await expect(detailTool).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("button", { name: "选择", exact: true })).toHaveCount(0);
  await detailTool.click();
  await expect(topDetail).toHaveAttribute("aria-pressed", "false");
  await detailTool.click();
  await expect(topDetail).toHaveAttribute("aria-pressed", "true");
  await workspace.getByRole("button", { name: "放大图纸", exact: true }).click();
  await expect
    .poll(async () =>
      Number.parseInt(await workspace.locator(".drawing-zoom-value").innerText(), 10),
    )
    .toBeGreaterThan(140);
  await settle();
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(process.cwd(), "out-cadcraft-user-instance/detail-tool.png"),
  });
  const sourcePoint = await canvas.evaluate((el, p) => {
    const matrix = (el as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error("CAD camera unavailable");
    const screen = new DOMPoint(p.x, p.y).matrixTransform(matrix),
      bounds = el.getBoundingClientRect();
    return { x: screen.x - bounds.x, y: screen.y - bounds.y };
  }, beforeDetail.annotations[0]!.points[0]!);
  for (const position of [
    sourcePoint,
    { x: sourcePoint.x + 30, y: sourcePoint.y },
    { x: sourcePoint.x - 70, y: sourcePoint.y - 70 },
  ])
    await canvas.click({ position });
  await canvas.evaluate((el) => {
    const probe = {
      frames: [] as {
        view: string | null;
        detail: boolean;
        source: string | null;
        landmark: [number, number] | null;
      }[],
      running: true,
    };
    (window as unknown as { detailPaintProbe: typeof probe }).detailPaintProbe = probe;
    const sample = () => {
      const circle = el.querySelector<SVGCircleElement>('[data-detail-part="marker"] circle');
      const matrix = circle?.getScreenCTM();
      const point =
        circle && matrix
          ? new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(matrix)
          : null;
      probe.frames.push({
        view: el.getAttribute("viewBox"),
        detail: !!document.querySelector("[data-detail-image], [data-cad-detail-live-body]"),
        source: document.querySelector(".drawing-vector-preview img")?.getAttribute("src") ?? null,
        landmark: point ? [point.x, point.y] : null,
      });
      if (probe.running) requestAnimationFrame(sample);
    };
    sample();
  });
  await canvas.click({ position: { x: 650, y: 300 } });
  await expect(canvas.locator("[data-detail-radius-ghost]")).toHaveCount(0);
  await expect.poll(async () => (await project()).detailViews?.length).toBe(1);
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  const paintFrames = await page.evaluate(() => {
    const probe = (
      window as unknown as {
        detailPaintProbe: {
          frames: {
            view: string | null;
            detail: boolean;
            source: string | null;
            landmark: [number, number] | null;
          }[];
          running: boolean;
        };
      }
    ).detailPaintProbe;
    probe.running = false;
    return probe.frames;
  });
  expect([...new Set(paintFrames.map((f) => f.view?.split(" ").slice(2).join(" ")))]).toHaveLength(
    1,
  );
  const landmark = paintFrames.find((f) => f.landmark)?.landmark;
  if (!landmark) throw new Error("Detail landmark was not painted");
  for (const f of paintFrames)
    if (f.landmark) {
      expect(Math.abs(f.landmark[0] - landmark[0])).toBeLessThan(0.5);
      expect(Math.abs(f.landmark[1] - landmark[1])).toBeLessThan(0.5);
    }
  expect(paintFrames.filter((f) => f.source === paintFrames[0]!.source && !f.detail)).toHaveLength(
    0,
  );
  await workspace.locator('[data-drawing-tool="select"]').click();
  await settle();
  const detailed = await project();
  expect(detailed.detailViews).toHaveLength(1);
  expect(detailed.detailViews?.[0]?.ratio).toBe(2);
  expect(detailed.cad?.objects?.find((o) => o.kind === "detail")?.body?.length).toBeGreaterThan(0);
  const detail = canvas.locator('[data-detail-part="content"]').first();
  await detail.click();
  const highlights = canvas.locator('g[color="#007aff"] polyline');
  await expect(highlights).not.toHaveCount(0);
  expect(
    await highlights.evaluateAll((lines) =>
      lines.every((line) => (line.getAttribute("points") ?? "").split(" ").length <= 3),
    ),
  ).toBe(true);
  await page.screenshot({
    path: join(process.cwd(), "out-cadcraft-user-instance/detail-highlight-verified.png"),
  });
  const resize = canvas.locator('[data-detail-part="resize"]');
  const start = await resize.boundingBox();
  if (!start) throw new Error("Missing detail resize grip");
  const ratioBeforeDrag = (await project()).detailViews![0]!.ratio;
  const resizeFrom = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  await page.mouse.move(resizeFrom.x, resizeFrom.y);
  await page.mouse.down();
  const liveBody = workspace.locator("[data-cad-detail-live-body]");
  await expect(liveBody).toBeVisible();
  const originalBodyBox = await liveBody.boundingBox();
  const originalCircleBox = await detail.boundingBox();
  await liveBody.evaluate((el) => {
    (window as unknown as { liveDetailPath: Element | null }).liveDetailPath =
      el.querySelector("path");
  });
  await page.mouse.move(resizeFrom.x + 25, resizeFrom.y, { steps: 12 });
  const biggerBodyBox = await liveBody.boundingBox();
  const biggerCircleBox = await detail.boundingBox();
  if (!originalBodyBox || !originalCircleBox || !biggerBodyBox || !biggerCircleBox)
    throw new Error("Live detail geometry was not painted");
  expect(biggerBodyBox.width).toBeGreaterThan(originalBodyBox.width + 20);
  // Screen strokes keep their pixel width while geometry scales. Compare in
  // pixels, not ratios of stroke-inclusive bounds (small circles magnify that error).
  expect(
    Math.abs(
      biggerBodyBox.width -
        (originalBodyBox.width * biggerCircleBox.width) / originalCircleBox.width,
    ),
  ).toBeLessThan(2);
  expect(
    await liveBody.evaluate(
      (el) =>
        el.querySelector("path") ===
        (window as unknown as { liveDetailPath: Element }).liveDetailPath,
    ),
  ).toBe(true);
  expect((await project()).cad!.assetId).toBe(detailed.cad!.assetId);
  await page.mouse.up();
  // Keep the final transformed body throughout the asynchronous save/image handoff.
  await expect(liveBody).toBeVisible();
  const finalTransform = await liveBody.getAttribute("transform");
  expect(finalTransform).not.toContain("scale(1)");
  await settle();
  expect((await project()).detailViews![0]!.ratio).toBeGreaterThan(ratioBeforeDrag);
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settle();
  expect((await project()).detailViews![0]!.ratio).toBe(ratioBeforeDrag);
  // Shrinking follows the same path; cancellation never creates a saved revision.
  await detail.click();
  const shrinkStart = await resize.boundingBox();
  if (!shrinkStart) throw new Error("Missing restored detail resize grip");
  const beforeCancel = await project();
  await page.mouse.move(
    shrinkStart.x + shrinkStart.width / 2,
    shrinkStart.y + shrinkStart.height / 2,
  );
  await page.mouse.down();
  await expect(liveBody).toBeVisible();
  const initialWidth = (await liveBody.boundingBox())!.width;
  await page.mouse.move(shrinkStart.x - 20, shrinkStart.y + shrinkStart.height / 2, { steps: 8 });
  expect((await liveBody.boundingBox())!.width).toBeLessThan(initialWidth - 20);
  await canvas.press("Escape");
  await page.mouse.up();
  await expect(liveBody).toBeVisible();
  expect((await project()).cad).toEqual(beforeCancel.cad);
  expect((await project()).detailViews).toEqual(beforeCancel.detailViews);
  await detail.click();
  // Hold the actual persistence boundary. All following interactions must
  // complete before this gate is released, including another resize and undo.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get("cad:prepare")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlers.set("cad:prepare", async () => {
      await gate;
      return { ok: false, error: { code: "IO_ERROR", message: "模拟后台保存失败" } };
    });
    (globalThis as unknown as { releaseCadSave: () => void }).releaseCadSave = () => {
      handlers.set("cad:prepare", original);
      release();
    };
  });
  try {
    const delayedGrip = await resize.boundingBox();
    if (!delayedGrip) throw new Error("Missing delayed resize grip");
    await page.mouse.move(
      delayedGrip.x + delayedGrip.width / 2,
      delayedGrip.y + delayedGrip.height / 2,
    );
    await page.mouse.down();
    await expect(liveBody).toBeVisible();
    await page.mouse.move(delayedGrip.x + 18, delayedGrip.y + delayedGrip.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(workspace).toHaveAttribute("data-cad-pending", "true");
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(liveBody).toHaveCount(1);
    // The document switch is not a close/export boundary. It must stay usable
    // while this CAD checkpoint cannot yet reach storage.
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect(page.getByRole("tab", { name: "说明书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const description = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await description.press("Control+End");
    await description.press("Enter");
    await description.pressSequentially("后台保存期间继续编辑");
    await expect(description).toContainText("后台保存期间继续编辑");
    await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
    await expect(workspace).toHaveAttribute("data-cad-pending", "true");
    await workspace.locator(".drawing-project-name").nth(1).click();
    await expect(workspace.locator(".drawing-project-name").nth(1)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled();
    await workspace.locator(".drawing-project-name").first().click();
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled();
    await detail.click();
    await expect(workspace).toHaveAttribute("data-cad-pending", "true");
    // Saving remains blocked, yet selection, a second resize and history work.
    const secondGrip = await resize.boundingBox();
    if (!secondGrip) throw new Error("Missing second resize grip");
    const firstWidth = (await detail.boundingBox())!.width;
    await page.mouse.move(
      secondGrip.x + secondGrip.width / 2,
      secondGrip.y + secondGrip.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(secondGrip.x + 25, secondGrip.y + secondGrip.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled();
    expect((await detail.boundingBox())!.width).toBeGreaterThan(firstWidth + 20);
    expect((await project()).cad!.assetId).toBe(beforeCancel.cad!.assetId);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect.poll(async () => (await detail.boundingBox())!.width).toBeCloseTo(firstWidth, 0);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "局部放大比例", exact: true })).toHaveValue(
      "2:1",
    );
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await canvas.click({ position: { x: 100, y: 100 } });
    await canvas.click({ position: { x: 200, y: 100 } });
    await canvas.press("Enter");
    await expect(panel.getByRole("button", { name: "移动", exact: true })).toBeEnabled();
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(workspace).toHaveAttribute("data-cad-pending", "true");
  } finally {
    await app.evaluate(() =>
      (globalThis as unknown as { releaseCadSave: () => void }).releaseCadSave(),
    );
  }
  await expect(workspace.getByRole("button", { name: "重试后台保存", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled();
  await expect(workspace).toHaveAttribute("data-cad-pending", "true");
  await workspace.getByRole("button", { name: "重试后台保存", exact: true }).click();
  await settle();
  await expect(workspace.getByRole("button", { name: "重试后台保存", exact: true })).toHaveCount(0);
  expect((await project()).detailViews).toEqual(beforeCancel.detailViews);
  await detail.click();
  await page.getByRole("button", { name: "放大局部图", exact: true }).click();
  await settle();
  expect((await project()).detailViews?.[0]?.ratio).toBe(2.5);
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await settle();
  expect((await project()).detailViews?.[0]?.ratio).toBe(2);
  await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await settle();
  expect((await project()).detailViews?.[0]?.ratio).toBe(2.5);
  await detail.click();
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
  await page.getByRole("textbox", { name: "局部放大比例", exact: true }).press("Enter");
  await settle();
  expect((await project()).detailViews?.[0]?.ratio).toBe(2);
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await page.getByRole("tab", { name: "CAD工具", exact: true }).click();
  await topDetail.click();
  await expect(page.getByRole("tab", { name: "CAD工具", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(workspace.locator(".cad-instruction-card")).toContainText("点击取图圆心");
  await canvas.press("Escape");
  expect((await project()).detailViews).toHaveLength(1);
  await detail.click();
  await expect(page.getByRole("textbox", { name: "局部放大比例", exact: true })).toHaveValue(
    "2:1",
  );
  await page.getByRole("button", { name: "编辑图形", exact: true }).click();
  await expect(page.locator(".cad-detail-breadcrumb")).toBeVisible();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 640, y: 300 } });
  await canvas.click({ position: { x: 660, y: 300 } });
  await settle();
  await canvas.press("Enter");
  const edited = await project();
  expect(edited.cad?.objects?.find((o) => o.kind === "detail")?.body?.length).toBe(
    (detailed.cad?.objects?.find((o) => o.kind === "detail")?.body?.length ?? 0) + 1,
  );
  await page.locator(".cad-detail-breadcrumb").getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".cad-detail-breadcrumb")).toHaveCount(0);
  const target = join(workbench.root, "unified.dwg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  const exportButton = workspace.getByRole("button", { name: "导出 DWG", exact: true });
  await exportButton.focus();
  await exportButton.press("Enter");
  await expect(workspace.getByText(/^已导出 DWG 图纸。/u)).toBeVisible({
    timeout: 60_000,
  });
  expect((await readFile(target)).subarray(0, 6).toString()).toBe("AC1032");
  await page.screenshot({
    path: join(process.cwd(), "out-cadcraft-user-instance/unified-workspace.png"),
  });
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await expect(page.getByRole("tab", { name: "附图标记", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await app.close();
  const again = await workbench.launch(),
    reopened = await again.firstWindow();
  await dismissWorkbenchWelcome(reopened);
  const safety = reopened.getByRole("button", { name: "稍后设置", exact: true });
  if (await safety.isVisible()) await safety.click();
  await reopened.getByText("统一CAD工作区验收", { exact: true }).first().dblclick();
  await reopened.getByRole("button", { name: "插入", exact: true }).click();
  await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await expect(reopened.getByRole("tab", { name: "附图标记", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(reopened.getByRole("region", { name: "CAD实体编辑", exact: true })).toBeHidden();
  await expect(reopened.locator("[data-annotation]")).toHaveCount(1);
  const saved = await reopened.evaluate(async () => {
    const list = await window.patentApi.patents.list("active");
    if (!list.ok) throw new Error(list.error.message);
    const value = await window.patentApi.patents.open(list.value[0]!.patentId);
    if (!value.ok) throw new Error(value.error.message);
    return value.value.patent.drawingProjects[0]!;
  });
  expect(saved.cad).toEqual(edited.cad);
  expect(saved.detailViews).toEqual(edited.detailViews);
  expect(saved.annotations).toEqual(edited.annotations);
  await reopened.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect(reopened.getByRole("textbox", { name: "编辑 说明书", exact: true })).toContainText(
    "后台保存期间继续编辑",
  );
});
