import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { stableUuid, writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

async function inkBounds(png: Buffer, minY = 0) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = minY; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (
        (data[i + 3] ?? 0) > 128 &&
        // Small superscripts have antialiased gray edges at CSS-pixel resolution.
        // Include those edges, but exclude the blue selection background.
        (data[i] ?? 255) < 160 &&
        (data[i + 1] ?? 255) < 160 &&
        (data[i + 2] ?? 255) < 160
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  expect(right).toBeGreaterThan(left);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

test("selected formula toolbar editing and alignment match the actual preview PDF", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  let id = 79000;
  const patent = createBlankPatent(
    { patentType: "invention", name: "公式排版验收" },
    {
      now: () => new Date("2026-09-07T00:00:00Z"),
      createId: () => stableUuid(id++),
    },
  );
  const book = patent.books.find((item) => item.kind === "claims");
  if (!book) throw new Error("Missing claims book");
  book.document.content = [
    { id: stableUuid(id++), type: "block-formula", source: "x^2", formulaKind: "math" },
  ];
  const path = join(workbench.root, "公式排版验收.patdoc");
  await writePatdoc(path, { patent, assets: [] });
  const application = await workbench.launch();
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1920, height: 1200 });
  page.setDefaultTimeout(5000);
  try {
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      ),
    ).toBe(false);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const welcome = page.getByRole("button", { name: "暂不创建" });
    if (await welcome.isVisible()) await welcome.click();
    const backupReminder = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await backupReminder.isVisible()) await backupReminder.click();
    await application.evaluate(({ dialog }, sourcePath) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [sourcePath] }),
      });
    }, path);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    if (await backupReminder.isVisible()) await backupReminder.click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const formula = page.locator('.patent-prosemirror [data-type="block-math"]:visible');
    await expect(formula).toHaveCount(1);
    await formula.click();
    await page.getByRole("combobox", { name: "字号", exact: true }).selectOption("10.5");
    await expect(formula).toHaveCSS("font-size", "14px");
    await expect(page.getByRole("combobox", { name: "字号", exact: true })).toHaveValue("10.5");
    await page.getByRole("button", { name: "插入数学公式", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑数学公式", exact: true });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole("textbox", { name: "可视公式编辑器" });
    await expect
      .poll(() => field.evaluate((el) => (el as HTMLElement & { value: string }).value))
      .toBe("x^2");
    await field.evaluate((el) => {
      (el as HTMLElement & { value: string }).value = String.raw`\frac{x^2+1}{2}+\int_0^1 x\,dx`;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(formula).toHaveCount(1);

    for (const [alignment, label] of [
      ["left", "左对齐"],
      ["center", "居中"],
      ["right", "右对齐"],
    ] as const) {
      await formula.click();
      await page.getByRole("button", { name: "段落对齐", exact: true }).click();
      await page.getByRole("menuitemradio", { name: label, exact: true }).click();
      await expect(formula).toHaveAttribute("data-formula-alignment", alignment);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await formula.evaluate((el) => {
        const paper = el.closest(".patent-book-rich-text");
        if (!paper) throw new Error("Missing editor paper");
        const rect = el.getBoundingClientRect(),
          pageRect = paper.getBoundingClientRect();
        return {
          left: rect.left - pageRect.left,
          top: rect.top - pageRect.top,
          pageWidth: pageRect.width,
        };
      });
      const editorInk = await inkBounds(await formula.screenshot({ scale: "css" }));
      await formula.screenshot({
        path: testInfo.outputPath(`${alignment}-editor.png`),
        scale: "css",
      });
      await page.getByRole("button", { name: "文件", exact: true }).click();
      await page.getByRole("menuitem", { name: "打印…", exact: true }).click();
      const print = page.getByRole("dialog", { name: "打印中心" });
      await expect(print.getByText(/第 1 \/ \d+ 页/)).toBeVisible();
      // Compare at high raster resolution, not a small fit-page thumbnail.
      await print.getByRole("combobox", { name: "预览缩放", exact: true }).selectOption("200");
      await expect(print.getByText(/正在打开 PDF|PDF 页面渲染失败|PDF 预览加载失败/)).toHaveCount(
        0,
      );
      const canvas = print.getByLabel("打印预览画布");
      await expect
        .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.width))
        .toBeGreaterThan(1500);
      await expect(print.locator(".print-preview-message, .print-preview-overlay")).toHaveCount(0);
      // The PDF page counter is ready before its asynchronous canvas paint completes.
      await expect
        .poll(() =>
          canvas.evaluate((el: HTMLCanvasElement) => {
            const pixels = el.getContext("2d")?.getImageData(0, 0, el.width, el.height).data;
            if (!pixels) return false;
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                (pixels[i + 3] ?? 0) > 128 &&
                (pixels[i] ?? 255) < 180 &&
                (pixels[i + 1] ?? 255) < 180 &&
                (pixels[i + 2] ?? 255) < 180
              )
                return true;
            }
            return false;
          }),
        )
        .toBe(true);
      const canvasData = await canvas.evaluate((el: HTMLCanvasElement) => ({
        data: el.toDataURL("image/png"),
        width: el.width,
      }));
      const pdfPng = Buffer.from(canvasData.data.slice(canvasData.data.indexOf(",") + 1), "base64");
      await writeFile(testInfo.outputPath(`${alignment}-preview.png`), pdfPng);
      const ratio = geometry.pageWidth / canvasData.width;
      // Exclude the page title, while retaining a guard band above the expected formula.
      const pdfInk = await inkBounds(pdfPng, Math.floor((geometry.top - 10) / ratio));
      const actual = {
        left: pdfInk.left * ratio,
        top: pdfInk.top * ratio,
        width: pdfInk.width * ratio,
        height: pdfInk.height * ratio,
      };
      const expected = {
        left: geometry.left + editorInk.left,
        top: geometry.top + editorInk.top,
        width: editorInk.width,
        height: editorInk.height,
      };
      console.log(JSON.stringify({ alignment, geometry, actual, expected }));
      for (const dimension of ["left", "top", "width", "height"] as const) {
        expect(
          Math.abs(actual[dimension] - expected[dimension]),
          `${alignment} ${dimension}`,
        ).toBeLessThan(3);
      }
      await print.getByRole("button", { name: "关闭打印中心" }).click();
    }
    // Exercise the real color toolbar, PDF renderer and persisted library path.
    await formula.click();
    await page
      .locator(".tool-bar:visible")
      .getByRole("button", { name: "打开文字颜色菜单", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "文字颜色", exact: true })
      .getByRole("button", { name: "标准色 #FF0000", exact: true })
      .click();
    await expect(formula).toHaveCSS("color", "rgb(255, 0, 0)");
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…", exact: true }).click();
    const colorPrint = page.getByRole("dialog", { name: "打印中心" });
    await expect(colorPrint.getByText(/第 1 \/ \d+ 页/)).toBeVisible();
    await colorPrint.getByRole("combobox", { name: "预览缩放", exact: true }).selectOption("200");
    await expect
      .poll(() =>
        colorPrint.getByLabel("打印预览画布").evaluate((canvas: HTMLCanvasElement) => {
          const pixels = canvas
            .getContext("2d")
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          let red = 0;
          if (pixels)
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                (pixels[i] ?? 0) > 200 &&
                (pixels[i + 1] ?? 255) < 80 &&
                (pixels[i + 2] ?? 255) < 80 &&
                (pixels[i + 3] ?? 0) > 128
              )
                red++;
            }
          return red;
        }),
      )
      .toBeGreaterThan(100);
    await colorPrint.getByRole("button", { name: "关闭打印中心" }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = (window as typeof window & { patentApi: PatentApi }).patentApi;
          const listed = await api.patents.list("active");
          if (!listed.ok) throw new Error("Failed to list the test library");
          const saved = listed.value.find((item) => item.name === "公式排版验收");
          if (!saved) throw new Error("Test patent is missing");
          const opened = await api.patents.open(saved.patentId);
          if (!opened.ok) throw new Error("Failed to reopen the saved patent");
          try {
            return opened.value.patent.books
              .find((item) => item.kind === "claims")
              ?.document.content.filter((item) => item.type === "block-formula");
          } finally {
            await api.patents.release(opened.value.sessionId);
          }
        }),
      )
      .toMatchObject([
        {
          type: "block-formula",
          alignment: "right",
          fontSizePt: 10.5,
          color: "#FF0000",
          source: String.raw`\frac{x^2+1}{2}+\int_0^1 x\,dx`,
        },
      ]);
  } catch (error) {
    console.log("DIAGNOSTIC", (await page.locator("body").innerText()).slice(0, 6000));
    throw error;
  } finally {
    await application.close();
  }
});
