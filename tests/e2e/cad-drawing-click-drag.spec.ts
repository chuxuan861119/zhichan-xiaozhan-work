import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("CAD drawing clicks tolerate release jitter and deliberate drags still finish", async ({
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
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 60_000 },
  );
  await panel.getByRole("button", { name: "矩形", exact: true }).click();
  await expect(canvas).toBeFocused();
  // Keyboard navigation onto a rail button must not disable canvas cancellation.
  await panel.getByRole("button", { name: "矩形", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(canvas).toBeFocused();
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toHaveAttribute(
    "aria-pressed", "false",
  );
  await panel.getByRole("button", { name: "正多边形选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "正多边形 · 内接于圆", exact: true }).click();
  const sides = page.getByRole("dialog", { name: "正多边形设置" }).getByRole("spinbutton", { name: "边数" });
  await expect(sides).toBeFocused();
  await sides.fill("6");
  await page.keyboard.press("Enter");
  await expect(canvas).toBeFocused();
  await expect(panel.getByRole("button", { name: "正多边形", exact: true })).toHaveAttribute(
    "aria-pressed", "true",
  );
  await sides.click();
  await page.keyboard.press("Escape");
  await expect(canvas).toBeFocused();
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toHaveAttribute(
    "aria-pressed", "false",
  );
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing CAD canvas");
  // Losing a removed/blank control's focus restores canvas keyboard ownership.
  await canvas.evaluate((element) => (element as SVGSVGElement).blur());
  await expect(canvas).toBeFocused();
  const viewport = workspace.locator(".drawing-viewport");
  const viewportBefore = await viewport.boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 280, box.y + 240, { steps: 4 });
  await expect.poll(() => canvas.evaluate((element) => element.style.transform)).not.toBe("");
  expect(await viewport.boundingBox()).toEqual(viewportBefore);
  expect(await canvas.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  expect(await viewport.evaluate((element) => {
    const ring = getComputedStyle(element, "::after");
    return { position: ring.position, inset: ring.inset, pointerEvents: ring.pointerEvents, border: ring.borderTopWidth };
  })).toEqual({ position: "absolute", inset: "0px", pointerEvents: "none", border: "2px" });
  await page.mouse.up({ button: "middle" });
  await expect(canvas).toBeFocused();
  const input = await page.context().newCDPSession(page);
  const reset = async () => {
    await canvas.press("Escape");
    await expect(workspace.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  };
  const choose = async (tool: string) => {
    if (["矩形", "正多边形"].includes(tool)) {
      await panel.getByRole("button", { name: `${tool}选项`, exact: true }).click();
      await page.getByRole("menuitemradio", { name: tool === "矩形" ? "两点矩形" : "正多边形 · 内接于圆", exact: true }).click();
    }
    const button = panel.getByRole("button", { name: tool === "三点圆弧" ? "圆弧" : tool, exact: true });
    if (!["矩形", "正多边形"].includes(tool)) await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  };
  const gesture = async (seconds: number, dx: number, move: boolean, dy = 8) => {
    await page.mouse.move(box.x + 160, box.y + 160);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const timestamp = (Date.now() - 1000) / 1000;
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x + 160,
      y: box.y + 160,
      button: "left",
      buttons: 1,
      clickCount: 1,
      timestamp,
    });
    if (move)
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        // Match Playwright's held-button CDP event. Omitting button here makes
        // Chromium release capture before pointerup and cancels the gesture.
        button: "left",
        x: box.x + 160 + dx,
        y: box.y + 160 + dy,
        buttons: 1,
        timestamp: timestamp + seconds,
      });
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + 160 + dx,
      y: box.y + 160 + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
      timestamp: timestamp + seconds + 0.01,
    });
  };
  for (const tool of ["矩形", "圆", "直线"]) {
    for (const [seconds, dx, move, dy] of [
      [0.08, 12, true, 8],
      [0.2, 12, false, 8],
      [0.2, 5, true, 0],
    ] as const) {
      await choose(tool);
      await gesture(seconds, dx, move, dy);
      await page.mouse.move(box.x + 300, box.y + 250);
      const endHint=tool==="矩形"?"指定对角点；也可以按住拖动绘制。":"点击终点；Esc 取消。";
      await expect(workspace.getByText(endHint, { exact: true })).toBeVisible();
      await canvas.click({ position: { x: 300, y: 250 } });
      await expect(workspace.getByText(endHint, { exact: true })).toHaveCount(0);
      await reset();
    }
  }
  // Multi-point tools must not skip a step on release either.
  for (const [tool, hint] of [
    ["三点圆弧", "指定圆弧经过点。"],
    ["椭圆", "指定第一条轴端点，可以是长轴或短轴。"],
    ["正多边形", "指定半径；预览显示实际多边形。"],
  ]) {
    await choose(tool!);
    await gesture(0.08, 12, true);
    await page.mouse.move(box.x + 300, box.y + 250);
    await expect(workspace.getByText(hint!, { exact: true })).toBeVisible();
    await reset();
  }
  // Moving/copying through a tool shares the same first-point gesture.
  for (const tool of ["移动", "复制"]) {
    await canvas.press("Control+a");
    await expect(panel.getByText(/\d+ 个对象已选中/, { exact: true })).toBeVisible();
    await choose(tool);
    await gesture(0.08, 12, true);
    await expect(workspace.getByText("点击终点；Esc 取消。", { exact: true })).toBeVisible();
    await reset();
  }
  // Deliberate held-button movement must still finish on release.
  for (const tool of ["矩形", "圆", "直线"]) {
    await choose(tool);
    await gesture(0.2, 100, true);
    await expect(workspace.getByText(tool==="矩形"?"指定对角点；也可以按住拖动绘制。":"点击终点；Esc 取消。", { exact: true })).toHaveCount(0);
    await reset();
  }
  await input.detach();
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
