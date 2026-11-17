import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("rectangle mouse methods and corners remain editable, undoable and usable as patent figures", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "新建专利" });
  await creation.getByRole("radio", { name: "实用新型", exact: true }).check();
  await creation.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(creation).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
  const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
  await expect(panel.getByRole("button", { name: "矩形", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(panel.getByRole("button", { name: "正多边形", exact: true })).toBeVisible();
  const saved = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
    await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
  };
  const count = async () => {
    await canvas.press("ControlOrMeta+a");
    const label = await panel.getByRole("group", { name: "修改" }).locator("legend").innerText();
    return Number(label.match(/\d+/)?.[0] ?? 0);
  };
  const cancel = async () => {
    await canvas.press("Escape");
    await canvas.press("Escape");
  };
  const methods = [
    {
      name: "两点矩形",
      points: [
        [160, 200],
        [300, 300],
      ],
    },
    {
      name: "中心矩形",
      points: [
        [250, 250],
        [310, 300],
      ],
    },
    {
      name: "三点矩形",
      points: [
        [160, 200],
        [300, 230],
        [260, 320],
      ],
    },
    {
      name: "中心倾斜矩形",
      points: [
        [250, 250],
        [320, 270],
        [240, 310],
      ],
    },
  ];
  for (const method of methods)
    for (const corner of ["sharp", "round", "chamfer"]) {
      await cancel();
      await panel.getByRole("button", { name: "矩形选项", exact: true }).click();
      await page.getByRole("menuitemradio", { name: method.name, exact: true }).click();
      const settings = page.getByRole("region", {
        name: `${method.name === "两点矩形" ? "矩形" : method.name}设置`,
        exact: true,
      });
      await settings.getByRole("combobox", { name: "角部样式" }).selectOption(corner);
      if (corner !== "sharp") await settings.getByRole("spinbutton").fill("2");
      const points = method.points,
        first = points[0]!,
        last = points.at(-1)!;
      if (method.name === "中心矩形") {
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + first[0]!, box.y + first[1]!);
        await page.mouse.down();
        // The canvas distinguishes a deliberate drag from sub-120ms click-release jitter.
        await page.waitForTimeout(150);
        await page.mouse.move(box.x + last[0]!, box.y + last[1]!, { steps: 8 });
        await expect(canvas.locator(".cad-gesture-preview")).toBeVisible();
        await page.mouse.up();
      } else {
        for (const [x, y] of points.slice(0, -1))
          await canvas.click({ position: { x: x!, y: y! } });
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + last[0]!, box.y + last[1]!);
        await expect(canvas.locator(".cad-gesture-preview")).toBeVisible();
        await canvas.click({ position: { x: last[0]!, y: last[1]! } });
      }
      await saved();
      await expect(ws.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
      await expect.poll(count).toBe(1);
      await cancel();
      await canvas.press("Control+z");
      await saved();
      await expect.poll(count).toBe(0);
      await cancel();
      await canvas.press("Control+y");
      await saved();
      await expect.poll(count).toBe(1);
      await ws.getByRole("button", { name: "预览成图", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
      const image = preview.getByRole("img", { name: "取图导出预览", exact: true });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      if (method.name === "中心倾斜矩形" && corner === "chamfer") {
        await page.screenshot({ path: testInfo.outputPath("tilted-chamfer-figure.png") });
        await preview.getByRole("button", { name: "插入说明书附图" }).click();
        await expect(
          ws.getByRole("region", { name: "已插入附图" }).getByRole("button", { name: "定位图1" }),
        ).toBeVisible();
      } else {
        await preview.getByRole("button", { name: "取消", exact: true }).click();
      }
      await cancel();
      if (method.name !== "中心倾斜矩形" || corner !== "chamfer") {
        await canvas.press("Control+z");
        await saved();
      }
    }
  await panel.getByRole("button", { name: "正多边形", exact: true }).click();
  await page.getByRole("spinbutton", { name: "边数", exact: true }).fill("7");
  await canvas.click({ position: { x: 220, y: 220 } });
  await canvas.click({ position: { x: 320, y: 280 } });
  await saved();
  await expect.poll(count).toBe(2);
});
