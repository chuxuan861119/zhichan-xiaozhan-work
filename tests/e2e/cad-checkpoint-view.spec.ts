import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("drawing checkpoints preserve the panned and zoomed CAD viewport in every frame", async ({
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
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const settle = async () => {
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(workspace.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 60_000 },
    );
  };
  await settle();
  const initial = await canvas.getAttribute("viewBox");
  const box = await canvas.boundingBox();
  if (!box || !initial) throw new Error("CAD viewport has not loaded");
  await page.mouse.move(box.x + 350, box.y + 280);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 390, box.y + 310);
  await canvas.press("Escape");
  await page.mouse.up({ button: "middle" });
  await expect(canvas).toHaveCSS("transform", "none");
  await expect(canvas).toHaveAttribute("viewBox", initial);
  await page.mouse.move(box.x + 350, box.y + 280);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 413, box.y + 317, { steps: 5 });
  const translated = await canvas.evaluate((svg) => {
    const matrix = new DOMMatrix(getComputedStyle(svg).transform);
    return {
      x: matrix.e,
      y: matrix.f,
      inner: svg.querySelector("[data-drawing-scene]")?.getAttribute("transform"),
    };
  });
  expect(translated).toEqual({ x: 63, y: 37, inner: null });
  await page.mouse.up({ button: "middle" });
  await expect(canvas).toHaveCSS("transform", "none");
  await workspace.getByRole("button", { name: "放大图纸", exact: true }).click();
  await settle();
  await expect(canvas).not.toHaveAttribute("viewBox", initial);

  for (const name of ["直线", "圆", "矩形"]) {
    await panel.getByRole("button", { name, exact: true }).click();
    const baseline = await canvas.getAttribute("viewBox");
    const source = workspace.locator(".drawing-vector-preview img").first();
    const previousSource = await source.getAttribute("src");
    const visibleGeometry = () =>
      workspace
        .locator("[data-cad-detail-live-scene] path")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")).join("|"));
    const previousGeometry = await visibleGeometry();
    if (!baseline || !previousSource) throw new Error("CAD preview has not loaded");
    await page.evaluate(() => {
      const state = { running: true, missing: 0, views: [] as string[] };
      (window as unknown as { cadViewportProbe: typeof state }).cadViewportProbe = state;
      const sample = () => {
        if (!state.running) return;
        const canvas = document.querySelector('[aria-label="CAD标号画布"]');
        state.views.push(canvas?.getAttribute("viewBox") ?? "missing");
        if (!document.querySelector(".drawing-vector-preview img")) state.missing++;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    // This test checks viewport stability, not the timed click/drag discriminator.
    await canvas.click({ position: { x: box.width / 2 - 60, y: box.height / 2 - 40 } });
    await canvas.click({ position: { x: box.width / 2 + 10, y: box.height / 2 + 5 } });
    if (name === "直线") await canvas.press("Enter");
    // The working vector scene updates without replacing the retained background image.
    await expect.poll(visibleGeometry).not.toBe(previousGeometry);
    await expect(workspace).toHaveAttribute("data-cad-pending", "false");
    await settle();
    const frames = await page.evaluate(() => {
      const state = (
        window as unknown as {
          cadViewportProbe: { running: boolean; missing: number; views: string[] };
        }
      ).cadViewportProbe;
      state.running = false;
      return { missing: state.missing, views: [...new Set(state.views)] };
    });
    expect(frames.missing, name).toBe(0);
    expect(frames.views, name).toEqual([baseline]);
    await expect(canvas).toHaveAttribute("viewBox", baseline);
    await canvas.press("Escape");
  }

  const savedView = await canvas.getAttribute("viewBox");
  if (!savedView) throw new Error("CAD viewport has not loaded");
  for (const name of ["撤销标号编辑", "重做标号编辑"]) {
    await workspace.getByRole("button", { name, exact: true }).click();
    await settle();
    await expect(canvas).toHaveAttribute("viewBox", savedView);
  }
  // Leaving an active drawing tool must release its retained backdrop for the
  // next project, even when no unfinished stroke needs to be cancelled.
  const priorProjectSource = await workspace
    .locator(".drawing-vector-preview img")
    .first()
    .getAttribute("src");
  if (!priorProjectSource) throw new Error("CAD preview missing");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(workspace.locator(".drawing-project-row")).toHaveCount(2);
  await settle();
  await expect(workspace.locator(".drawing-vector-preview img").first()).not.toHaveAttribute(
    "src",
    priorProjectSource,
  );
  await workspace.locator(".drawing-project-row button[aria-pressed]").first().click();
  await settle();
  await expect(canvas).toHaveAttribute("viewBox", savedView);
  await workspace.getByRole("button", { name: "适合窗口", exact: true }).click();
  await settle();
  await expect(canvas).toHaveAttribute("viewBox", initial);
});
