import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("offset, break and direct selection dragging work with undo, figure preview and insertion", async ({
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
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  const saved = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
    await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
  };
  const cancel = async () => {
    await canvas.press("Escape");
    await canvas.press("Escape");
  };
  const count = async () => {
    await canvas.press("ControlOrMeta+a");
    const text = await panel.getByRole("group", { name: "修改" }).locator("legend").innerText();
    return Number(text.match(/\d+/)?.[0] ?? 0);
  };
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: 160, y: 250 } });
  await canvas.click({ position: { x: 360, y: 250 } });
  await canvas.press("Enter");
  await saved();
  await expect.poll(count).toBe(1);
  await panel.getByRole("button", { name: "偏移", exact: true }).click();
  await page.getByRole("spinbutton", { name: "偏移距离", exact: true }).fill("10");
  await canvas.click({ position: { x: 260, y: 190 } });
  await saved();
  await cancel();
  await expect.poll(count).toBe(2);
  await cancel();
  await panel.getByRole("button", { name: "打断", exact: true }).click();
  await canvas.click({ position: { x: 200, y: 250 } });
  await canvas.click({ position: { x: 240, y: 250 } });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 280, box.y + 250);
  await expect(canvas.locator('[data-trim-context="true"]')).toBeVisible();
  await canvas.click({ position: { x: 280, y: 250 } });
  await saved();
  await expect.poll(count).toBe(3);
  await expect(panel.getByRole("button", { name: "局部拉伸", exact: true })).toHaveCount(0);
  // All three lines remain selected. Grab away from their endpoints/midpoints.
  await page.mouse.move(box.x + 305, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 410, box.y + 290);
  await expect(canvas.locator("[data-cad-affine-preview]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("direct-drag-live-preview.png") });
  await page.mouse.up();
  await saved();
  await cancel();
  await canvas.press("ControlOrMeta+z");
  await saved();
  await canvas.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  await saved();
  await expect.poll(count).toBe(3);
  await ws.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
  const image = preview.getByRole("img", { name: "取图导出预览", exact: true });
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await preview.getByRole("button", { name: "插入说明书附图" }).click();
  await expect(
    ws.getByRole("region", { name: "已插入附图" }).getByRole("button", { name: "定位图1" }),
  ).toBeVisible();
  const locate = ws.getByRole("region", { name: "已插入附图" }).getByRole("button", { name: "定位图1" });
  const expectFitted = async () => {
    await locate.click();
    await expect.poll(async () => canvas.evaluate((svg) => {
      const target = svg.querySelector("[data-published-location]");
      if (!target) return false;
      const area = target.getBoundingClientRect(), screen = svg.getBoundingClientRect();
      return Math.abs(area.x + area.width / 2 - screen.x - screen.width / 2) < 2
        && Math.abs(area.y + area.height / 2 - screen.y - screen.height / 2) < 2
        && Math.abs(Math.max(area.width / screen.width, area.height / screen.height) - 0.8) < 0.02;
    })).toBe(true);
  };
  await expectFitted();
  for (let i = 0; i < 3; i++) await ws.getByRole("button", { name: "缩小图纸", exact: true }).click();
  await expectFitted();
  for (let i = 0; i < 3; i++) await ws.getByRole("button", { name: "放大图纸", exact: true }).click();
  await expectFitted();
  // The same fit must run after loading a different sheet, not before its default view resets.
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled();
  await expect(canvas.locator("[data-published-location]")).toHaveCount(0);
  await expectFitted();

  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await page.getByRole("button", { name: "新增附图标记", exact: true }).click();
  const registration = page.getByRole("dialog", { name: "新增附图标记" });
  await registration.getByLabel("关键词", { exact: true }).fill("底座");
  await registration.getByRole("button", { name: "添加", exact: true }).click();
  await expect(registration).toBeHidden();
  await expect(page.getByRole("button", { name: "选中标号1", exact: true })).toContainText("底座");
  await ws.getByRole("button", { name: "标号", exact: true }).click();
  await page.getByLabel("标号内容", { exact: true }).fill("2");
  const placeLabel = async (x: number) => {
    await canvas.click({ position: { x, y: 300 } });
    await canvas.click({ position: { x: x + 60, y: 230 } });
  };
  await placeLabel(200);
  const keyword = page.getByPlaceholder("填入关键词（选填）");
  await expect(keyword).toBeVisible();
  await expect(keyword).not.toBeFocused();
  const keywordBox = (await keyword.boundingBox())!;
  expect(keywordBox.height).toBeGreaterThan(28);
  expect(keywordBox.height).toBeLessThan(48);
  await keyword.fill("支撑杆");
  await keyword.press("Enter");
  await expect(keyword).toHaveCount(0);
  await placeLabel(340);
  await expect(page.getByLabel("标号3关键词", { exact: true })).toBeVisible();
  await page.getByLabel("标号3关键词", { exact: true }).fill("端盖");
  await placeLabel(460); // Commit 3 by clicking outside and continue with the same click.
  await expect(page.getByLabel("标号4关键词", { exact: true })).toBeVisible();
  await placeLabel(580); // Ignore the optional keyword for 4 and keep drawing.
  await expect(page.getByLabel("标号5关键词", { exact: true })).toBeVisible();
  await canvas.press("Escape");
  await saved();
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await expect(page.getByRole("button", { name: "选中标号2", exact: true })).toContainText("支撑杆");
  await expect(page.getByRole("button", { name: "选中标号3", exact: true })).toContainText("端盖");
  await expect(page.getByRole("button", { name: "选中标号4", exact: true })).toHaveCount(0);

  // Both manual registrations and CAD-created keywords stay editable even
  // before they have been mentioned or numbered in the document.
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  const openRail = page.getByRole("button", {name:"展开功能栏",exact:true});
  if (await openRail.isVisible()) await openRail.click();
  const pinRail = page.getByRole("button", {name:"固定",exact:true});
  if (await pinRail.isVisible()) await pinRail.click();
  for (const [oldKeyword, newKeyword, number] of [["底座","安装底座","10"],["支撑杆","支撑轴","2"]]) {
    const correction = page.getByRole("button",{name:`修改标记：${oldKeyword}`,exact:true});
    await expect(correction.locator("..").getByRole("button",{name:"定位问题",exact:true})).toHaveCount(0);
    await correction.click();
    await page.getByLabel(`${oldKeyword}序号`,{exact:true}).fill(number!);
    await page.getByLabel(`${oldKeyword}关键词`,{exact:true}).fill(newKeyword!);
    await page.getByRole("button",{name:`保存${oldKeyword}`,exact:true}).click();
    await expect(page.getByRole("button",{name:`编辑${newKeyword}`,exact:true})).toBeEnabled();
  }
  await page.getByRole("tab",{name:"说明书",exact:true}).click();
  await expect(page.getByRole("button",{name:"编辑安装底座",exact:true})).toBeEnabled();
  await expect(page.getByRole("button",{name:"编辑支撑轴",exact:true})).toBeEnabled();
});
