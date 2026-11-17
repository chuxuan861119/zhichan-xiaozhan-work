import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("quick trim and extend hide settings and support stable hover, drag and completion", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
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
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 60000 },
  );
  for (const [a, b] of [
    [
      [120, 240],
      [420, 240],
    ],
    [
      [260, 130],
      [260, 350],
    ],
  ] as const) {
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await canvas.click({ position: { x: a[0], y: a[1] } });
    await canvas.click({ position: { x: b[0], y: b[1] } });
    await canvas.press("Escape");
    await expect(
      workspace.getByRole("button", { name: "撤销标号编辑", exact: true }),
    ).toBeEnabled();
  }
  await panel.getByRole("button", { name: "修剪", exact: true }).click();
  await expect(panel.getByLabel("修剪模式")).toHaveCount(0);
  await expect(panel.getByLabel("修剪选择方式")).toHaveCount(0);
  await expect(panel.getByRole("region", {name:"修剪设置"})).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-cad-object-cursor", "true");
  await expect
    .poll(() => canvas.evaluate((el) => decodeURIComponent(getComputedStyle(el).cursor)))
    .toMatch(/pickbox\.svg|<rect/);
  await canvas.hover({ position: { x: 180, y: 240 } });
  await expect(canvas.locator('[data-trim-original="true"]')).not.toHaveCount(0);
  await expect(canvas.locator('[data-trim-original="true"]').first()).toHaveAttribute(
    "stroke",
    "#c4c4c4",
  );
  await expect(canvas.locator('[data-trim-original="true"]').first()).toHaveAttribute(
    "stroke-dasharray",
    "none",
  );
  await canvas.evaluate((element) => {
    const probe = {active:true,samples:0,missing:0};
    (window as unknown as {trimHoverProbe:typeof probe}).trimHoverProbe = probe;
    const sample = () => {
      if (!probe.active) return;
      probe.samples++;
      if (!element.querySelector('[data-trim-original="true"]')) probe.missing++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let i=0;i<12;i++) await canvas.hover({position:{x:180+i*3,y:240}});
  const stability = await page.evaluate(() => {
    const probe=(window as unknown as {trimHoverProbe:{active:boolean;samples:number;missing:number}}).trimHoverProbe;
    probe.active=false;
    return {samples:probe.samples,missing:probe.missing};
  });
  expect(stability.samples).toBeGreaterThan(3);
  expect(stability.missing).toBe(0);
  // A deliberate departure clears the retained result, and returning recomputes it.
  await canvas.hover({position:{x:180,y:210}});
  await expect(canvas.locator('[data-trim-original="true"]')).toHaveCount(0);
  await canvas.hover({position:{x:180,y:240}});
  await expect(canvas.locator('[data-trim-original="true"]')).not.toHaveCount(0);
  await page.screenshot({ path: "test-results/cad-trim-preview.png" });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 180, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 190, box.y + 280, { steps: 12 });
  await expect(canvas.locator('[data-trim-fence="true"]')).toBeVisible();
  await page.mouse.up();
  await expect(panel.getByRole("button", { name: "修剪", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(canvas).toHaveAttribute("data-cad-object-cursor", "false");
  await canvas.hover({ position: { x: 320, y: 280 } });
  await expect(canvas.locator('[data-trim-fence="true"]')).toBeVisible();
  await canvas.press("Escape");
  await expect(panel.getByLabel("修剪模式")).toHaveCount(0);
  await expect(canvas.locator('[data-trim-fence="true"]')).toHaveCount(0);
  await panel.getByRole("button", {name:"修剪选项",exact:true}).click();
  await page.getByRole("menuitemradio", {name:"延伸",exact:true}).click();
  await expect(panel.getByRole("region", {name:"延伸设置"})).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: /延伸|边界/ })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-cad-object-cursor", "true");
  await canvas.press("Escape");
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await canvas.click({ position: { x: 150, y: 380 } });
  await canvas.click({ position: { x: 450, y: 550 } });
  await panel.getByRole("button", { name: "剖面填充", exact: true }).click();
  await page.getByRole("button", { name: "选择图案 实心", exact: true }).click();
  await canvas.click({ position: { x: 220, y: 450 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 300, y: 360 } });
  await canvas.click({ position: { x: 300, y: 570 } });
  await canvas.press("Escape");
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  await expect(panel.getByRole("button", {name:"修剪选项",exact:true})).toBeEnabled();
  await panel.getByRole("button", {name:"修剪选项",exact:true}).click();
  await page.getByRole("menuitemradio", {name:"修剪",exact:true}).click();
  await canvas.hover({ position: { x: 220, y: 450 } });
  await expect(canvas.locator('path[data-trim-original="true"][fill="#c4c4c4"]')).not.toHaveCount(
    0,
  );
  await expect(canvas.locator("[data-trim-context]")).toBeVisible();
  const previewPaint = await canvas
    .locator("[data-trim-context]")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("path")).map((p) => ({
        fill: getComputedStyle(p).fill,
        width: (p as SVGGraphicsElement).getBBox().width,
      })),
    );
  expect(previewPaint.find((p) => p.fill === "rgb(196, 196, 196)")!.width).toBeCloseTo(
    previewPaint.find((p) => p.fill === "rgb(0, 0, 0)")!.width * 2,
    2,
  );
  await page.screenshot({ path: "test-results/cad-trim-hatch-preview.png" });
  await canvas.click({ position: { x: 220, y: 450 } });
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
  await canvas.press("Escape");
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "重做标号编辑", exact: true })).toBeEnabled();
});
