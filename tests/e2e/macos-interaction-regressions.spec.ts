import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { expect, test } from "./helpers/workbench.js";

test("Mac interaction fixes work together in an isolated application", async ({ workbench }) => {
  test.skip(process.platform !== "darwin", "macOS native menu verification");
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const nativeHistory = async (label: string) =>
    app.evaluate(({ Menu, BrowserWindow }, value) => {
      const item = Menu.getApplicationMenu()!
        .items.find((i) => i.label === "编辑")!
        .submenu!.items.find((i) => i.label === value)!;
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("index.html"),
      )!;
      item.click(undefined as never, window, {} as never);
    }, label);
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "暂不创建" }).click();
    await expect(welcome).not.toBeVisible();
  }
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("index.html"),
    )!;
    const item = Menu.getApplicationMenu()!
      .items.find((i) => i.label === "文件")!
      .submenu!.items.find((i) => i.label === "新建专利")!;
    item.click(undefined as never, window, {} as never);
  });
  const create = page.getByRole("dialog", { name: "新建专利" });
  const title = create.getByRole("textbox", { name: "专利名称" });
  await title.pressSequentially("Mac交互回归");
  await nativeHistory("撤销");
  await expect(title).not.toHaveValue("Mac交互回归");
  await nativeHistory("重做");
  await expect(title).toHaveValue("Mac交互回归");
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).not.toBeVisible();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();

  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.click();
  await editor.pressSequentially("Mac原生菜单正文撤销验证");
  await nativeHistory("撤销");
  await expect(editor).not.toContainText("Mac原生菜单正文撤销验证");
  await nativeHistory("重做");
  await expect(editor).toContainText("Mac原生菜单正文撤销验证");

  // Exercise the real overflow menu at the app's supported minimum window width.
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("index.html"),
    )!;
    window.setSize(1000, 760);
    window.webContents.setZoomFactor(1.25);
  });
  await page.getByRole("button", { name: "更多工具", exact: true }).click();
  const menu = page.getByRole("menu", { name: "更多编辑工具" });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setZoomFactor(1);
      window.setSize(1280, 900);
    }
  });

  await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
  const png = await sharp({
    create: { width: 120, height: 100, channels: 3, background: "#245b7c" },
  })
    .png()
    .toBuffer();
  await page.getByLabel("说明书附图页面", { exact: true }).evaluate(
    (el, bytes) => {
      const dataTransfer = new DataTransfer();
      for (let i = 0; i < 3; i++)
        dataTransfer.items.add(
          new File([new Uint8Array(bytes)], `图${i + 1}.png`, { type: "image/png" }),
        );
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    [...png],
  );
  const figure = (n: number) => page.getByRole("button", { name: `选择图${n}`, exact: true });
  await expect(figure(3)).toBeVisible();
  await figure(1).hover();
  await expect
    .poll(() => figure(1).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  await figure(1).click();
  await figure(2).click({ modifiers: ["Meta"] });
  await expect(page.locator('.drawing-figure-card[data-selected="true"]')).toHaveCount(2);
  await figure(2).press("Meta+a");
  await expect(page.locator('.drawing-figure-card[data-selected="true"]')).toHaveCount(3);
  // Observe copy dispatch without touching the user's system clipboard.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("assets:copy-images");
    ipcMain.handle("assets:copy-images", () => {
      process.env.MAC_INTERACTION_TEST_COPIES = String(
        Number(process.env.MAC_INTERACTION_TEST_COPIES ?? 0) + 1,
      );
      return { ok: true, value: undefined };
    });
  });
  await figure(2).press("Meta+c");
  await expect.poll(() => app.evaluate(() => process.env.MAC_INTERACTION_TEST_COPIES)).toBe("1");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeAttached();
  const aboveWorkspace = await page.evaluate(() => {
    const dialog = document.querySelector(".application-settings-dialog")!;
    const presence = dialog.closest(".motion-presence")!;
    for (const animation of presence.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 200;
    }
    const box = dialog.querySelector("section")!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!hit && dialog.contains(hit);
  });
  expect(aboveWorkspace).toBe(true);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.finish();
  });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).not.toBeVisible();

  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "交互测试.png", mimeType: "image/png", buffer: png });
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const point = async (x: number, y: number) =>
    canvas.evaluate(
      (el, p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform((el as SVGSVGElement).getScreenCTM()!);
        return { x: q.x, y: q.y };
      },
      { x, y },
    );
  for (const [x, y] of [
    [20, 20],
    [70, 40],
  ]) {
    const p = await point(x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await canvas.focus();
  await nativeHistory("撤销");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await canvas.focus();
  await nativeHistory("重做");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await canvas.focus();
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("index.html"),
    )!;
    Menu.getApplicationMenu()!
      .items.find((item) => item.label === "编辑")!
      .submenu!.items.find((item) => item.label === "全选")!
      .click(undefined as never, window, {} as never);
  });
  await expect(workspace.locator('[data-annotation][data-selected="true"]')).toHaveCount(1);
  await nativeHistory("复制");
  await nativeHistory("剪切");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await nativeHistory("粘贴");
  const pastePoint = await point(50, 50);
  await page.mouse.click(pastePoint.x, pastePoint.y);
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await nativeHistory("撤销");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await canvas.press("Meta+z");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);

  await workspace.getByLabel("选择图纸文件").setInputFiles({
    name: "公开DWG样本.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile("tests/fixtures/cad/sample_AC1032.dwg"),
  });
  await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  // Unified CAD shows live vector geometry while retaining the raster checkpoint offscreen.
  await expect(workspace.locator("[data-cad-detail-live-scene]")).toBeVisible();
  await expect
    .poll(() => workspace.locator("[data-cad-detail-live-scene] path").count())
    .toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("mac-dwg-live-scene.png") });
  // Input once per frame used to restart easing and keep viewBox unchanged.
  const zoomSamples = await canvas.evaluate(async (el) => {
    const samples: number[] = [];
    const box = el.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -4,
          ctrlKey: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      samples.push(Number(el.getAttribute("viewBox")!.split(" ")[2]));
    }
    return samples;
  });
  // React may coalesce a frame in hidden Electron; require continuous progress,
  // no reverse movement, and updates during at least half of the input sequence.
  for (let i = 1; i < zoomSamples.length; i++)
    expect(zoomSamples[i]!).toBeLessThanOrEqual(zoomSamples[i - 1]!);
  expect(new Set(zoomSamples).size).toBeGreaterThanOrEqual(5);
  const panSamples = await canvas.evaluate(async (el) => {
    const read = () => el.getAttribute("viewBox")!.split(" ").map(Number);
    const before = read();
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 30, deltaY: 20, bubbles: true, cancelable: true }),
    );
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { before, after: read() };
  });
  expect(panSamples.after[0]!).toBeGreaterThan(panSamples.before[0]!);
  expect(panSamples.after[1]!).toBeGreaterThan(panSamples.before[1]!);
  expect(panSamples.after[2]).toBe(panSamples.before[2]);
  const beforeDrag = await canvas.getAttribute("viewBox");
  const canvasBox = (await canvas.boundingBox())!;
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(
    canvasBox.x + canvasBox.width / 2 + 60,
    canvasBox.y + canvasBox.height / 2 + 40,
    { steps: 8 },
  );
  await page.mouse.up({ button: "right" });
  await expect(canvas).not.toHaveAttribute("viewBox", beforeDrag!);
  expect(Number((await canvas.getAttribute("viewBox"))!.split(" ")[2])).toBe(panSamples.after[2]);
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("index.html"),
    )!;
    Menu.getApplicationMenu()!
      .items.find((item) => item.label === "文件")!
      .submenu!.items.find((item) => item.label === "保存")!
      .click(undefined as never, window, {} as never);
  });
  await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
  await expect(workspace.locator("[data-cad-detail-live-scene]")).toBeVisible();
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: "关闭Mac交互回归", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Mac交互回归", exact: true })).toHaveCount(0);
  await page.getByRole("article", { name: "Mac交互回归", exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: "Mac交互回归", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await workspace.getByRole("button", { name: "公开DWG样本.dwg", exact: true }).click();
  // Reopening restores the persisted checkpoint; the live scene is recreated when editing.
  const checkpoint = workspace.getByRole("img", { name: "图纸底图", exact: true });
  await expect(checkpoint).toBeVisible();
  await expect
    .poll(() => checkpoint.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("mac-dwg-reopened-checkpoint.png") });
  await app.close();
});
