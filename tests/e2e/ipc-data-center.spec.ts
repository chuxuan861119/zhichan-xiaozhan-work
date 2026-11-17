import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./helpers/workbench.js";

test("IPC数据中心支持离线查询、边查边写、复制与报告保存", async ({ workbench }) => {
  test.setTimeout(150_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("IPC浮窗验收");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利" }).click();
    await expect(create).toBeHidden();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
    await editor.click();
    await page.keyboard.type("查询期间编辑正文。");
    const before = await editor.innerText();
    const selection = await page.evaluate(() => ({
      anchor: getSelection()?.anchorOffset,
      focus: getSelection()?.focusOffset,
    }));
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(() => ({
        anchor: getSelection()?.anchorOffset,
        focus: getSelection()?.focusOffset,
      })),
    ).toEqual(selection);
    const dialog = page.getByRole("dialog", { name: "IPC数据中心", exact: true });
    await expect(dialog).toBeVisible();
    const iframe = page.frameLocator('iframe[title="IPC数据中心查询页面"]');
    await expect(iframe.locator("#classificationInput")).toBeEnabled({ timeout: 35_000 });
    await expect(dialog.getByRole("status")).toHaveCount(0);
    const nativeWindow = await app.browserWindow(page);
    const embedded = page.frames().find((item) => item.url().startsWith("patent-ipc://center/"));
    if (!embedded) throw new Error("IPC frame missing");
    for (const [width, height] of [
      [1024, 700],
      [1440, 900],
    ]) {
      await nativeWindow.evaluate(
        (win, bounds) => win.setContentSize(bounds[0], bounds[1]),
        [width, height],
      );
      await expect
        .poll(() =>
          page.evaluate(([w, h]) => innerWidth === w && Math.abs(innerHeight - h) <= 2, [
            width,
            height,
          ] as [number, number]),
        )
        .toBe(true);
      await expect
        .poll(() => embedded.evaluate(() => document.documentElement.scrollHeight - innerHeight))
        .toBeLessThanOrEqual(1);
      const home = await embedded.locator(".ipc-home").boundingBox();
      const nav = await embedded.locator("#clearBtn").boundingBox();
      expect(home).not.toBeNull();
      expect(nav).not.toBeNull();
      if (home && nav) expect(home.y + home.height).toBeLessThanOrEqual(nav.y);
    }
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = dialog.locator(`.dialog-resize--${corner}`);
      await expect(handle).toHaveCSS(
        "cursor",
        corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
      );
      await expect(handle).toHaveCSS("background-image", "none");
      const before = await dialog.boundingBox();
      const grip = await handle.boundingBox();
      if (!before || !grip) throw new Error("Corner missing");
      const dx = corner.includes("w") ? 24 : -24;
      const dy = corner.includes("n") ? 24 : -24;
      await page.mouse.move(grip.x + 7, grip.y + 7);
      await page.mouse.down();
      await page.mouse.move(grip.x + 7 + dx, grip.y + 7 + dy, { steps: 4 });
      await page.mouse.up();
      const after = await dialog.boundingBox();
      if (!after) throw new Error("Resized window missing");
      expect(after.width).toBeCloseTo(before.width - 24, 0);
      expect(after.height).toBeCloseTo(before.height - 24, 0);
      expect(corner.includes("w") ? after.x + after.width : after.x).toBeCloseTo(
        corner.includes("w") ? before.x + before.width : before.x,
        0,
      );
      expect(corner.includes("n") ? after.y + after.height : after.y).toBeCloseTo(
        corner.includes("n") ? before.y + before.height : before.y,
        0,
      );
    }
    const initialBounds = await dialog.boundingBox();
    const resize = dialog.locator(".dialog-resize--se");
    const grip = await resize.boundingBox();
    if (!grip || !initialBounds) throw new Error("Resize grip missing");
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"),
        { x: grip.x + 7, y: grip.y + 7 },
      ),
    ).toBe("调整IPC窗口大小");
    await page.mouse.move(grip.x + 7, grip.y + 7);
    await page.mouse.down();
    await page.mouse.move(grip.x - 73, grip.y - 73, { steps: 6 });
    await page.mouse.up();
    const resized = await dialog.boundingBox();
    expect(resized?.width).toBeLessThan(initialBounds.width - 50);
    expect(resized?.height).toBeLessThan(initialBounds.height - 50);
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await expect
      .poll(() => dialog.boundingBox())
      .toEqual({ x: 0, y: 38, width: viewport.width, height: viewport.height - 38 });
    await dialog.getByRole("button", { name: "返回编辑器" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    await iframe.locator("#classificationInput").press("Escape");
    await expect.poll(() => dialog.boundingBox()).toEqual(resized);
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    await dialog.getByRole("button", { name: "还原IPC数据中心" }).click();
    await expect.poll(() => dialog.boundingBox()).toEqual(resized);
    // Prime the compositor without showing the hidden test window.
    await nativeWindow.evaluate((win) =>
      win.webContents
        .capturePage(undefined, { stayHidden: true, stayAwake: true })
        .then(() => undefined),
    );
    // Drag the window to expose the left side of the editor without activating any OS window.
    const header = dialog.locator("header");
    // The floating surface must subtract itself from Electron's native titlebar drag region.
    await expect(dialog).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(header).toHaveCSS("-webkit-app-region", "no-drag");
    const hostBounds = await nativeWindow.evaluate((win) => win.getBounds());
    const overlapStart = await header.boundingBox();
    if (!overlapStart) throw new Error("IPC header missing");
    await page.mouse.move(overlapStart.x + 100, overlapStart.y + 20);
    await page.mouse.down();
    await page.mouse.move(overlapStart.x + 100, 0, { steps: 6 });
    await page.mouse.up();
    const overlap = await header.boundingBox();
    if (!overlap) throw new Error("Overlapping header missing");
    expect(overlap.y).toBeLessThan(38);
    await page.mouse.move(overlap.x + 100, overlap.y + 20);
    await page.mouse.down();
    await page.mouse.move(overlap.x + 140, overlap.y + 80, { steps: 6 });
    await page.mouse.up();
    expect((await header.boundingBox())?.y).toBeGreaterThan(overlap.y);
    expect(await nativeWindow.evaluate((win) => win.getBounds())).toEqual(hostBounds);
    const box = await header.boundingBox();
    if (!box) throw new Error("IPC header missing");
    await page.mouse.move(box.x + 100, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 155, box.y + 55, { steps: 6 });
    await page.mouse.up();
    const moved = await header.boundingBox();
    expect(moved?.y).not.toBe(box.y);
    // Release over the embedded area after the window reaches its viewport boundary.
    if (!moved) throw new Error("Moved titlebar missing");
    await page.mouse.move(moved.x + 100, moved.y + 20);
    await page.mouse.down();
    await page.mouse.move(viewport.width - 40, viewport.height - 30, { steps: 8 });
    await page.mouse.up();
    await expect(dialog).toHaveAttribute("data-dragging", "false");
    const releasedBounds = await dialog.boundingBox();
    await page.mouse.move(30, viewport.height - 80, { steps: 5 });
    await expect.poll(() => dialog.boundingBox()).toEqual(releasedBounds);
    await iframe.locator("#classificationInput").fill("A01B1");
    await iframe.locator("#queryIPCBtn").click();
    await expect(iframe.locator("#contentArea")).toContainText("A01B1/00");
    await iframe.locator("#classificationInput").fill("手动工具");
    await iframe.locator("#queryIPCBtn").click();
    await expect(iframe.locator("#contentArea")).toContainText("查询结果");
    await iframe.locator("#dictionaryBtn").click();
    await expect(iframe.locator("#dictionaryContent")).toContainText("A部");
    await iframe.locator("#dictionaryContent").getByText("A部", { exact: true }).click();
    await expect(iframe.locator("#section-A-content")).toContainText("A01");
    await iframe.locator("#classificationInput").fill("人工智能");
    await iframe.locator("#priorityBtn").click();
    await expect(iframe.locator("#contentArea")).toContainText("匹配统计");
    await expect(iframe.getByText("匹配统计", { exact: true })).toBeVisible();
    const frame = page.frames().find((item) => item.url().startsWith("patent-ipc://center/"));
    if (!frame) throw new Error("IPC frame unavailable");
    // Exercise the same native bridge used by the result copy controls.
    await frame.evaluate(() => {
      void (window as unknown as { copyText(text: string): Promise<void> }).copyText("A01B1/02");
    });
    await expect(iframe.locator("body")).toContainText("已复制到剪贴板");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("A01B1/02");
    await iframe.locator("#classificationInput").fill("G01N");
    await iframe.locator("#preExamBtn").click();
    await expect(iframe.locator("#preExamResultContainer")).toContainText("G01N");
    await expect(dialog).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(iframe.locator("#shareReportBtn")).toBeVisible();
    const reportPath = join(workbench.root, "ipc-report.png");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, reportPath);
    const image = await frame.evaluate(async () => {
      const api = window as unknown as {
        currentPreExamData: { centersByProvince: Record<string, unknown> };
        generateReportImage(province: string, data: unknown): Promise<string>;
        confirmSaveImage(png: string): Promise<void>;
      };
      const province = Object.keys(api.currentPreExamData.centersByProvince)[0];
      if (!province) throw new Error("No report province found");
      const png = await api.generateReportImage(province, api.currentPreExamData);
      await api.confirmSaveImage(png);
      return png;
    });
    expect((await readFile(reportPath)).toString("base64")).toBe(image.split(",")[1]);
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await frame.evaluate(
      async (png) =>
        (window as unknown as { confirmSaveImage(png: string): Promise<void> }).confirmSaveImage(
          png,
        ),
      image,
    );
    await expect(iframe.locator("body")).toContainText("已取消保存");
    expect(await iframe.locator("body").innerText()).not.toMatch(/购物车|中转站|试用期/);
    // Editor remains usable while the tool stays open. The editor's left edge is outside the panel.
    await editor.click({ position: { x: 20, y: 70 } });
    await page.keyboard.press("Control+End");
    await page.keyboard.type("浮窗开启时继续输入。");
    await expect(editor).toContainText("浮窗开启时继续输入。");
    expect(await editor.innerText()).toContain(before.trim());
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "返回编辑器" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    await expect(iframe.locator("#classificationInput")).toHaveValue("G01N");
    await expect(iframe.locator("#preExamResultContainer")).toContainText("G01N");
    await expect(dialog).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // capturePage preserves the hidden OS window while including cross-origin frame surfaces.
    const nativeCapture = await nativeWindow.evaluate(async (win) =>
      (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }))
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      test.info().outputPath("ipc-results.png"),
      Buffer.from(nativeCapture, "base64"),
    );
    expect(errors).toEqual([]);
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
      expect(await nativeWindow.evaluate((win) => win.isVisible())).toBe(false);
  } finally {
    await app.close();
  }
});
