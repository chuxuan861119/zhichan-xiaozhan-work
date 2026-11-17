import { join } from "node:path";
import { expect, test } from "./helpers/workbench.js";

test("keeps only the converted image selected after changing it to inline layout", async ({
  workbench,
}) => {
  const samplePng = join(process.cwd(), "tests", "fixtures", "images", "sample.png");
  const sampleJpg = join(process.cwd(), "tests", "fixtures", "images", "sample.jpg");
  const application = await workbench.launchAllowMultipleInstances("--headless");
  try {
    await application.evaluate(
      ({ dialog }, filePaths) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths }),
        });
      },
      [samplePng, sampleJpg],
    );
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) {
      await welcome.getByRole("button", { name: "暂不创建" }).click();
    }
    await page.getByRole("button", { name: "新建专利" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建专利" });
    await createDialog.getByRole("textbox", { name: "专利名称" }).fill("图片选区回归测试");
    await createDialog.getByRole("radio", { name: "发明" }).check();
    await createDialog.getByRole("button", { name: "创建专利" }).click();
    await expect(page.getByRole("button", { name: /创建中/u })).toBeHidden({ timeout: 30_000 });
    await expect(createDialog).toBeHidden({ timeout: 30_000 });
    const backupSuggestion = page.getByRole("button", { name: "稍后设置" });
    if (await backupSuggestion.isVisible()) await backupSuggestion.click();

    await page.getByRole("button", { name: "插入图片" }).click();
    const figures = page.locator(".patent-figure");
    await expect(figures).toHaveCount(2);
    await figures.first().click();
    const settings = page.getByRole("region", { name: "图片设置" });
    await settings.getByRole("button", { name: "向右旋转90°" }).click();
    await settings.getByRole("button", { name: "嵌入型" }).click();

    await expect(
      page.locator(".patent-prosemirror .image-selection-frame.is-selected"),
    ).toHaveCount(0);
    await expect(
      page.locator(
        ".patent-prosemirror .patent-figure.is-selected, .patent-prosemirror .patent-inline-figure.is-selected",
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(
        ".patent-prosemirror .ProseMirror-selectednode > .patent-inline-figure > .image-selection-frame",
      ),
    ).toHaveCount(1);

    const frame = page.locator(".patent-inline-figure .image-selection-frame");
    const resize = frame.getByRole("button", { name: "从右下角缩放图片" });
    await frame.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    await resize.scrollIntoViewIfNeeded();
    await expect(resize).toBeInViewport();
    const originalWidth = await frame.evaluate((element) => element.getBoundingClientRect().width);
    const handle = await resize.boundingBox();
    if (!handle) throw new Error("缺少图片缩放手柄");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2);
    await expect
      .poll(() => frame.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(originalWidth + 20);
    // A quarter-turned bitmap must fill the live draft frame, not retain its old mm dimensions.
    await expect
      .poll(() =>
        frame.evaluate((element) => {
          const image = element.querySelector("img");
          return Math.abs(
            element.getBoundingClientRect().width - (image?.getBoundingClientRect().width ?? 0),
          );
        }),
      )
      .toBeLessThan(2);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect
      .poll(() => frame.evaluate((element) => element.getBoundingClientRect().width))
      .toBeCloseTo(originalWidth, 0);
  } finally {
    await application.close();
  }
});
