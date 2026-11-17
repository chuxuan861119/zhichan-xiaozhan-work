import type { Frame } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openDrawingEntry } from "./helpers/drawing-entry.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("drawing tools, persistence, duplicate wiring and vector multipage PDF in the real engine", async ({
  workbench,
}) => {
  test.setTimeout(150_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => console.log("DRAWING_PAGE_ERROR", error.message));
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("绘图可靠性隔离测试");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利" }).click();
    await openDrawingEntry(page, "插入流程图");
    await expect
      .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
      .toBe(1);
    const frame = page.frames().find((f) => f.url().endsWith("/embed.html"));
    if (!frame) throw new Error("绘图编辑器未加载");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();
    await frame.locator(".geSidebar a.geItem:visible").first().click();
    await expect(frame.getByRole("button", { name: "黑白线稿", exact: true })).toBeEnabled();
    await frame.getByRole("button", { name: "基础流程", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("template.png") });
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "步骤编号", exact: true }).click();
    await expect(frame.getByText("S20：处理步骤", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(frame.getByText("处理步骤", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "重做", exact: true }).click();
    await frame.getByRole("button", { name: "黑白线稿", exact: true }).click();
    await frame.locator("body").press("Control+s");
    await expect(frame.getByText("已保存", { exact: true })).toBeVisible();

    // Observe actual downloadable bytes, without invoking native save dialogs.
    await page.evaluate(() => {
      const state = window as typeof window & {
        drawingDownloads: Array<{ type: string; bytes: number[] }>;
      };
      state.drawingDownloads = [];
      const original = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob && ["application/pdf", "application/xml"].includes(blob.type)) {
          void blob.arrayBuffer().then((bytes) =>
            state.drawingDownloads.push({
              type: blob.type,
              bytes: Array.from(new Uint8Array(bytes)),
            }),
          );
        }
        return original.call(URL, blob);
      };
      HTMLAnchorElement.prototype.click = () => {};
    });
    let sourceExports = 0;
    const exportSource = async (editorFrame: Frame = frame) => {
      const exportButton = editorFrame.getByRole("button", { name: "导出至电脑", exact: true });
      if (editorFrame !== frame && process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
        await exportButton.dispatchEvent("click");
      } else {
        await exportButton.click();
      }
      const dialog = page.getByRole("dialog", { name: "导出至电脑" });
      await dialog.getByLabel("导出格式").selectOption("drawio");
      await expect(dialog.getByRole("radio", { name: "完整工程" })).toBeChecked();
      await dialog.getByRole("button", { name: "确认导出" }).click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as typeof window & { drawingDownloads: Array<{ type: string }> }
              ).drawingDownloads.filter((d) => d.type === "application/xml").length,
          ),
        )
        .toBe(++sourceExports);
      return page.evaluate(() => {
        const all = (
          window as typeof window & { drawingDownloads: Array<{ type: string; bytes: number[] }> }
        ).drawingDownloads;
        const item = all.filter((d) => d.type === "application/xml").at(-1);
        return new TextDecoder().decode(new Uint8Array(item?.bytes ?? []));
      });
    };
    expect(await exportSource()).toContain("S20");
    await frame.getByRole("button", { name: "电路图", exact: true }).click();
    await expect(frame.getByRole("button", { name: "基础流程" })).toBeHidden();
    await frame.getByRole("button", { name: "快捷连线", exact: true }).click();
    const ports = frame.getByRole("button", { name: /^连接端子 / });
    await expect(ports.first()).toBeVisible();
    const names = await ports.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("aria-label") ?? ""),
    );
    const source = names[0];
    const target = names.find((n) => n.split(" ")[1] !== source?.split(" ")[1]);
    if (!source || !target) throw new Error("测试节点端子缺失");
    for (let i = 0; i < 2; i++) {
      await frame.getByRole("button", { name: source, exact: true }).click();
      await frame.getByRole("button", { name: target, exact: true }).click();
    }
    await expect(frame.locator(".patent-toolbar__circuit-status")).toContainText("已经连接");
    const wired = await exportSource();
    expect((wired.match(/edge="1"/g) ?? []).length).toBe(3);
    await frame.getByRole("button", { name: "流程图", exact: true }).click();
    await frame.locator(".geTabContainer .geControlTab").first().click();
    await expect(frame.locator(".geTabContainer .gePageTab")).toHaveCount(2);
    await frame.getByRole("button", { name: "基础流程", exact: true }).click();
    await frame.getByRole("button", { name: "导出至电脑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导出至电脑" });
    await dialog.getByLabel("导出格式").selectOption("png");
    await expect(dialog.getByLabel("图片清晰度")).toHaveValue("2");
    await dialog.getByLabel("图片清晰度").selectOption("4");
    await dialog.getByLabel("导出格式").selectOption("pdf");
    await dialog.getByRole("radio", { name: /所有页面|全部页面/ }).check();
    await dialog.getByRole("button", { name: "确认导出" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & { drawingDownloads: Array<{ type: string }> }
            ).drawingDownloads.filter((d) => d.type === "application/pdf").length,
        ),
      )
      .toBe(1);
    const bytes = await page.evaluate(
      () =>
        (
          window as typeof window & { drawingDownloads: Array<{ type: string; bytes: number[] }> }
        ).drawingDownloads.find((d) => d.type === "application/pdf")?.bytes ?? [],
    );
    const pdfTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await pdfTask.promise;
    expect(pdf.numPages).toBe(2);
    const first = await (await pdf.getPage(1)).getTextContent();
    expect(first.items.some((item) => "str" in item && item.str.includes("S20"))).toBe(true);
    const second = await (await pdf.getPage(2)).getTextContent();
    expect(second.items.some((item) => "str" in item && item.str.includes("处理步骤"))).toBe(true);
    await pdfTask.destroy();
    await expect(frame.locator(".geTabContainer .gePageTab").last()).toHaveClass(/geActivePage/);
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible()),
        ),
      ).toBe(false);
    }
    await page.screenshot({ path: test.info().outputPath("drawing-tools.png") });
    const common = frame.locator("a.geTitle").filter({ hasText: "常用图形" }).first();
    const content = common.locator("xpath=following-sibling::div[1]/div");
    await common.click();
    await expect(content).toBeHidden();
    await frame.getByRole("button", { name: "电路图", exact: true }).click();
    await expect(content).toBeHidden();
    await frame.getByRole("button", { name: "流程图", exact: true }).click();
    await expect(content).toBeHidden();
    await page.getByRole("button", { name: "关闭流程图", exact: true }).click();
    await openDrawingEntry(page, "插入流程图");
    await expect.poll(() => page.frames().some((f) => f.url().endsWith("/embed.html"))).toBe(true);
    const reopened = page.frames().find((f) => f.url().endsWith("/embed.html"));
    if (!reopened) throw new Error("重开失败");
    await expect(reopened.locator(".geTabContainer .gePageTab")).toHaveCount(2);
    await expect(reopened.getByText("S20：处理步骤", { exact: true })).toBeVisible();
    const secondPageTab = reopened.locator(".geTabContainer .gePageTab").last();
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      // Hidden Electron can report a successful CDP click without delivering any
      // pointer event to a recreated nested frame. Exercise the real tab listener;
      // the visible run below retains native pointer-routing coverage.
      await secondPageTab.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0 });
    } else {
      await secondPageTab.click();
    }
    await expect(secondPageTab).toHaveClass(/geActivePage/);
    await expect(reopened.getByText("处理步骤", { exact: true })).toBeVisible();
    const reopenedSource = await exportSource(reopened);
    const sourcePages = await page.evaluate(
      (source) =>
        Array.from(
          new DOMParser().parseFromString(source, "text/xml").querySelectorAll("mxfile > diagram"),
        ).map((diagram) =>
          Array.from(diagram.querySelectorAll("mxCell")).map((cell) => cell.getAttribute("value")),
        ),
      reopenedSource,
    );
    expect(sourcePages).toHaveLength(2);
    expect(sourcePages[0]).toContain("S20：处理步骤");
    expect(sourcePages[1]).toContain("处理步骤");
    await expect(
      reopened
        .locator("a.geTitle")
        .filter({ hasText: "常用图形" })
        .first()
        .locator("xpath=following-sibling::div[1]/div"),
    ).toBeHidden();
  } finally {
    await app.close();
  }
});
