import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./helpers/workbench.js";

test("dragging a document image moves it instead of importing a copy", async ({ workbench }) => {
  test.setTimeout(120_000);
  const application = await workbench.launchAllowMultipleInstances("--headless");
  try {
    await application.evaluate(
      ({ dialog }, path) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        });
      },
      join(process.cwd(), "tests", "fixtures", "images", "sample.png"),
    );
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利" }).click();
    const create = page.getByRole("dialog", { name: "新建专利" });
    await create.getByRole("textbox", { name: "专利名称" }).fill("图片拖动测试");
    await create.getByRole("radio", { name: "发明", exact: true }).check();
    await create.getByRole("button", { name: "创建专利" }).click();
    await expect(create).toBeHidden({ timeout: 30_000 });
    const suggestion = page.getByRole("button", { name: "稍后设置" });
    if (await suggestion.isVisible()) await suggestion.click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "插入图片" }).click();
    const editor = page.locator(".patent-prosemirror[contenteditable=true]:visible").first();
    const images = editor.locator('img[alt="专利图片"]');
    await expect(images).toHaveCount(1);
    await images.first().evaluate((image: HTMLImageElement) => image.decode());
    const destination = editor.locator("p").filter({ hasText: "本发明涉及" });
    const originalOrder = await editor
      .locator(".node-figure")
      .evaluateAll((nodes) => nodes.map((node) => node.previousElementSibling?.textContent));
    await page.evaluate(
      (bytes) => {
        document.addEventListener(
          "drop",
          (event) => {
            // Exercise the browser file-payload variant without relying on the host
            // Chromium version to add it to an otherwise normal internal drag.
            const payload = new DataTransfer();
            payload.items.add(
              new File([Uint8Array.from(bytes)], "drag.png", { type: "image/png" }),
            );
            if (event.dataTransfer)
              Object.defineProperty(event.dataTransfer, "files", { value: payload.files });
          },
          { capture: true, once: true },
        );
      },
      Array.from(readFileSync(join(process.cwd(), "tests", "fixtures", "images", "sample.png"))),
    );
    await images.first().dragTo(destination);
    await expect
      .poll(() =>
        editor
          .locator(".node-figure")
          .evaluateAll((nodes) => nodes.map((node) => node.previousElementSibling?.textContent)),
      )
      .toEqual([expect.stringContaining("本发明涉及")]);
    await expect(images).toHaveCount(1);
    await editor.press("Control+z");
    await expect
      .poll(() =>
        editor
          .locator(".node-figure")
          .evaluateAll((nodes) => nodes.map((node) => node.previousElementSibling?.textContent)),
      )
      .toEqual(originalOrder);
    await expect(images).toHaveCount(1);
    await editor.press("Control+y");
    await expect
      .poll(() =>
        editor
          .locator(".node-figure")
          .evaluateAll((nodes) => nodes.map((node) => node.previousElementSibling?.textContent)),
      )
      .toEqual([expect.stringContaining("本发明涉及")]);
    await images.first().click();
    await page
      .getByRole("region", { name: "图片设置" })
      .getByRole("button", { name: "嵌入型" })
      .click();
    await images.first().dragTo(editor.locator("p").filter({ hasText: "本发明要解决" }));
    await expect(images).toHaveCount(1);
    await expect(
      editor.locator("p").filter({ hasText: "本发明要解决" }).locator('img[alt="专利图片"]'),
    ).toHaveCount(1);
    await page.keyboard.down("Control");
    try {
      await images.first().dragTo(destination);
    } finally {
      await page.keyboard.up("Control");
    }
    await expect(images).toHaveCount(2);
    await editor.press("Control+z");
    await expect(images).toHaveCount(1);
  } finally {
    await application.close();
  }
});
