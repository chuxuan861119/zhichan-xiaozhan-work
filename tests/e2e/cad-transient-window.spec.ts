import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
test("CAD settings float beside the canvas, retain drafts and allow picking at different widths", async ({
  workbench,
}, info) => {
  test.setTimeout(150_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利", exact: true });
  await create.getByRole("radio", { name: "实用新型", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
  if (await opener.isVisible()) await opener.click();
  if (await page.getByRole("button", { name: "固定", exact: true }).isVisible())
    await page.getByRole("button", { name: "固定", exact: true }).click();
  const rail = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = ws.getByRole("application", { name: "CAD标号画布" });
  await expect(rail.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  const railSurface = page.getByRole("complementary", { name: "图纸工具全局功能栏" });
  const header = railSurface.locator(".patent-global-function-rail__header");
  const toolsTab = header.getByRole("tab", { name: "CAD工具", exact: true });
  const scrollBody = railSurface.locator(".patent-global-function-rail__body");
  const checkRailScroll = async () => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await expect
      .poll(() => scrollBody.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(100);
    const headerTop = (await header.boundingBox())!.y;
    await rail.getByRole("button", { name: "直线", exact: true }).hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scrollBody.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    await page.mouse.wheel(0, 2000);
    await expect(
      railSurface.getByRole("button", { name: "导出 DXF", exact: true }),
    ).toBeInViewport();
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => scrollBody.evaluate((el) => el.scrollTop)).toBe(0);
    await page.setViewportSize({ width: 1600, height: 1000 });
  };
  await checkRailScroll();
  for (const control of [
    toolsTab,
    header.getByRole("tab", { name: "附图标记", exact: true }),
    header.getByRole("button", { name: "取消固定", exact: true }),
    header.getByRole("button", { name: "收起功能栏", exact: true }),
  ]) {
    const start = await railSurface.boundingBox(),
      target = await control.boundingBox();
    if (!start || !target) throw new Error("Missing draggable CAD header");
    const x = target.x + target.width / 2,
      y = target.y + target.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 12, y + 2, { steps: 4 });
    await expect(railSurface).toHaveAttribute("data-dragging", "true");
    await page.mouse.up();
    await expect(railSurface).toHaveAttribute("data-draggable", "true");
    await expect(toolsTab).toHaveAttribute("aria-selected", "true");
    const end = await railSurface.boundingBox();
    if (!end) throw new Error("CAD rail unexpectedly closed after dragging");
    expect(end.x).toBeCloseTo(start.x - 12, 0);
  }
  await checkRailScroll();
  for (const control of [
    toolsTab,
    header.getByRole("tab", { name: "附图标记", exact: true }),
    header.getByRole("button", { name: "收起功能栏", exact: true }),
  ]) {
    await control.hover();
    await page.waitForTimeout(400);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await header.getByRole("tab", { name: "附图标记", exact: true }).click();
  await expect(toolsTab).toHaveAttribute("aria-selected", "false");
  await expect(railSurface.locator(".cad-reference-mark-panel")).toHaveCSS(
    "border-bottom-left-radius",
    "12px",
  );
  await expect(railSurface.locator(".cad-reference-mark-panel")).toHaveCSS("border-width", "0px");
  await toolsTab.click();
  await expect(rail).toHaveCSS("border-bottom-left-radius", "12px");
  await checkRailScroll();
  // Resizing clamps a dragged rail into the smaller viewport. Release the pin
  // to restore its dock before the existing canvas-coordinate drawing checks.
  await header.getByRole("button", { name: "取消固定", exact: true }).click();
  await opener.click();
  await header.getByRole("button", { name: "固定", exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 600 });
  for (const name of ["线宽", "线型"]) {
    const select = railSurface.getByRole("combobox", { name, exact: true });
    await select.click();
    await expect
      .poll(() => select.evaluate((el) => getComputedStyle(el, "::picker(select)").opacity))
      .toBe("1");
    const last = select.getByRole("option").last();
    await last.scrollIntoViewIfNeeded();
    const bounds = await last.boundingBox();
    if (!bounds) throw new Error("Missing CAD property option");
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: info.outputPath(`cad-property-${name}.png`) });
    await page.keyboard.press("Escape");
  }
  await scrollBody.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await rail.getByRole("button", { name: "正多边形选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "正多边形 · 内接于圆", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "正多边形设置", exact: true });
  await expect(palette).toBeVisible();
  await expect(rail.locator(".cad-tool-settings, .cad-pattern-panel")).toHaveCount(0);
  const sides = palette.getByRole("spinbutton", { name: "边数", exact: true });
  const polygonWidth = await palette.evaluate((el) => el.getBoundingClientRect().width);
  await sides.fill("7");
  await sides.press("Enter");
  await expect(canvas).toBeFocused();
  await canvas.click({ position: { x: 650, y: 350 } });
  await expect(palette).toBeVisible();
  await canvas.click({ position: { x: 720, y: 420 } });
  await expect(palette).toBeHidden();
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await expect(ws.locator(".drawing-vector-preview")).toHaveAttribute("data-render-state", "ready");
  await rail.getByRole("button", { name: "齿轮", exact: true }).click();
  await page
    .getByRole("dialog", { name: "外齿轮设置", exact: true })
    .getByRole("spinbutton")
    .fill("19");
  await expect(page.locator(".cad-transient-window")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("checkbox", { name: "中心孔", exact: true }).locator("..")).toHaveCSS(
    "flex-direction",
    "row",
  );
  await page.screenshot({ path: info.outputPath("gear-desktop.png") });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(canvas).toBeFocused();
  for (const name of ["直线", "文字", "弹簧", "圆角", "阵列", "镜像"]) {
    await rail.getByRole("button", { name, exact: true }).click();
    const settings = page.locator(".cad-transient-window");
    await expect(settings).toBeVisible();
    await expect(settings).toHaveCSS("opacity", "1");
    const layout = await settings.evaluate((el) => {
      const body = el.querySelector(".cad-transient-window__body");
      if (!body) throw new Error("Missing settings content");
      return {
        height: el.getBoundingClientRect().height,
        overflow: body.scrollWidth > body.clientWidth,
      };
    });
    expect(layout.height).toBeLessThanOrEqual(151);
    expect(layout.overflow).toBe(false);
    await page.screenshot({ path: info.outputPath(`settings-${name}.png`) });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings).toBeHidden();
  }
  await rail.getByRole("button", { name: "剖面填充", exact: true }).click();
  const hatch = page.getByRole("dialog", { name: "剖面填充设置", exact: true });
  await expect(hatch.getByRole("button", { name: "选择图案 单线", exact: true })).toBeVisible();
  await expect(hatch).not.toHaveCSS("box-shadow", "none");
  await expect(hatch).toHaveCSS("border-top-width", "1px");
  expect(await hatch.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(
    polygonWidth + 100,
  );
  await hatch.getByRole("button", { name: "选择图案 实心", exact: true }).click();
  await expect(hatch.getByRole("spinbutton", { name: "填充比例", exact: true })).toBeHidden();
  await hatch.getByRole("button", { name: "选择图案 单线", exact: true }).click();
  await expect(hatch.getByRole("spinbutton", { name: "填充比例", exact: true })).toBeVisible();
  for (const [width, height] of [
    [1600, 900],
    [1100, 900],
    [800, 900],
    [1100, 500],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(hatch).toBeVisible();
    await expect(hatch).toHaveCSS("opacity", "1");
    const overflow = await hatch.evaluate((el) => {
      const body = el.querySelector(".cad-transient-window__body"),
        host = el.closest(".cad-transient-host");
      if (!body || !host) throw new Error("Missing canvas settings host");
      const heading = el.querySelector(".cad-transient-window__header h3");
      if (!heading) throw new Error("Missing settings title");
      return {
        x: el.scrollWidth > el.clientWidth,
        bodyX: body.scrollWidth > body.clientWidth,
        bottom: el.getBoundingClientRect().bottom,
        hostBottom: host.getBoundingClientRect().bottom,
        height: el.getBoundingClientRect().height,
        limit: Math.min(150, host.clientHeight * 0.45),
        titleLeft: heading.getBoundingClientRect().left,
        titleHeight: heading.getBoundingClientRect().height,
        bodyLeft: body.getBoundingClientRect().left,
      };
    });
    expect(overflow.x).toBe(false);
    expect(overflow.bodyX).toBe(false);
    expect(overflow.bottom).toBeLessThanOrEqual(overflow.hostBottom);
    expect(overflow.height).toBeLessThanOrEqual(overflow.limit + 1);
    expect(overflow.titleHeight).toBeLessThanOrEqual(32);
    expect(overflow.titleLeft - overflow.bodyLeft).toBeLessThanOrEqual(12);
    if (width === 1600) {
      const gallery = await hatch.evaluate((el) => {
        const body = el.querySelector(".cad-transient-window__body");
        const swatches = el.querySelector(".cad-hatch-swatches");
        if (!body || !swatches) throw new Error("Missing hatch content");
        const cards = [...swatches.querySelectorAll("button")];
        const box = swatches.getBoundingClientRect();
        return {
          bodyOverflow: getComputedStyle(body).overflowY,
          visibleRows: new Set(
            cards
              .filter((card) => {
                const r = card.getBoundingClientRect();
                return r.top >= box.top && r.bottom <= box.bottom;
              })
              .map((card) => card.getBoundingClientRect().top),
          ).size,
        };
      });
      // Gap tolerance and island controls can require vertical scrolling; they
      // must stay reachable without widening the palette or hiding its actions.
      expect(gallery.bodyOverflow).toBe("auto");
      expect(gallery.visibleRows).toBeGreaterThanOrEqual(2);
    }
    await expect(hatch.getByRole("button", { name: "取消", exact: true })).toBeInViewport();
    await hatch.getByRole("button", { name: "取消", exact: true }).click({ trial: true });
    await hatch.getByRole("button", { name: "选择图案 砂石", exact: true }).click();
    await expect(hatch.getByRole("button", { name: "选择图案 砂石", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await hatch.getByRole("button", { name: "选择图案 单线", exact: true }).click();
    await hatch.locator(".cad-transient-window__body").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath(`hatch-${width}-${height}.png`) });
  }
  await hatch.getByRole("button", { name: "取消", exact: true }).click();
  await expect(hatch).toBeHidden();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await rail.getByRole("button", { name: "剖面填充", exact: true }).click();
  await canvas.click({ position: { x: 650, y: 350 } });
  await expect(hatch.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await hatch.getByRole("button", { name: "应用", exact: true }).click();
  await expect(hatch).toBeHidden();
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await expect(ws).toHaveAttribute("data-cad-pending", "false");
  await rail.getByRole("button", { name: "局部放大", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "局部放大设置", exact: true });
  await expect(detail.getByRole("textbox", { name: "局部放大比例", exact: true })).toBeVisible();
  await expect(detail).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("detail-desktop.png") });
  await detail.getByRole("textbox", { name: "局部放大比例", exact: true }).press("Escape");
  await expect(detail).toBeHidden();
  await expect(canvas).toBeFocused();
});
