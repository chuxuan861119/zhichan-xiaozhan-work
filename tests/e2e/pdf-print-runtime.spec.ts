import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";
import { stableUuid, writePatdoc } from "./helpers/documents.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

test("renders generated PDF bytes into the print preview canvas", async ({ workbench }) => {
  const sourcePath = join(workbench.root, "打印预览源文档.patdoc");
  let nextId = 70_000;
  const patent = createBlankPatent(
    { patentType: "invention", name: "打印预览源文档" },
    {
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      createId: () => stableUuid(nextId++),
    },
  );
  await writePatdoc(sourcePath, { patent, assets: [] });

  const application = await workbench.launch(sourcePath);
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        ),
      ).toBe(false);
    }

    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "打印…", exact: true }).click();

    const printCenter = page.getByRole("dialog", { name: "打印中心" });
    await expect(printCenter).toBeVisible();
    const canvas = printCenter.getByLabel("打印预览画布");
    await expect(canvas).toBeVisible();
    await expect
      .poll(async () =>
        canvas.evaluate((element) => {
          const preview = element as HTMLCanvasElement;
          if (preview.width === 0 || preview.height === 0) return false;
          const context = preview.getContext("2d");
          if (!context) return false;
          const pixels = context.getImageData(0, 0, preview.width, preview.height).data;
          for (let index = 3; index < pixels.length; index += 4) {
            if ((pixels[index] ?? 0) > 0) return true;
          }
          return false;
        }),
      )
      .toBe(true);
    await printCenter.getByLabel("打印内容", { exact: true }).selectOption("all");
    await expect(printCenter.locator(".print-preview-canvas-wrap canvas")).toHaveCount(5);
    const pages = printCenter.locator(".print-preview-canvas-wrap canvas");
    await expect
      .poll(() => pages.nth(1).evaluate((element) => (element as HTMLCanvasElement).width))
      .toBeGreaterThan(1);
    const firstBox = await pages.nth(0).boundingBox();
    const secondBox = await pages.nth(1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(secondBox?.y).toBeGreaterThan((firstBox?.y ?? 0) + (firstBox?.height ?? 0));
    await printCenter.locator(".print-preview-canvas-wrap").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => pages.nth(4).evaluate((element) => (element as HTMLCanvasElement).width))
      .toBeGreaterThan(1);
    await expect(printCenter.getByText("让应用记住打印机、单双面、颜色、方向和纸张。")).toHaveCount(
      0,
    );
  } finally {
    await application.close().catch(() => undefined);
  }
});
