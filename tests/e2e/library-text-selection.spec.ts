import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

test("library text supports drag-copy without double-click word selection in every view", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const profile = await workbench.launchProfile("library-text-selection");
  try {
    const page = await profile.application.firstWindow();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { patentApi: PatentApi }).patentApi),
    );
    await page.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const result = await api.patents.create({
        name: "Selection sample patent",
        patentType: "invention",
      });
      if (!result.ok) throw new Error(result.error.message);
      await api.patents.release(result.value.sessionId);
    });
    await page.reload();
    const library = page.getByRole("main", { name: "专利库" });
    await expect(library).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.evaluate(() => {
      document.addEventListener(
        "dblclick",
        () => {
          document.documentElement.dataset.doubleClickSelection =
            window.getSelection()?.toString() ?? "";
        },
        true,
      );
      // Verify the browser copy event without changing the user's system clipboard.
      document.addEventListener(
        "copy",
        (event) => {
          event.preventDefault();
          document.documentElement.dataset.copiedSelection =
            window.getSelection()?.toString() ?? "";
        },
        true,
      );
    });
    for (const mode of ["单栏视图", "双栏视图", "图文视图"]) {
      await library.getByRole("button", { name: mode }).click();
      const title = library.getByRole("heading", { name: "Selection sample patent", exact: true });
      await expect(title).toBeVisible();
      await title.click({ trial: true });
      const box = await title.boundingBox();
      if (!box) throw new Error("Missing patent title bounds");
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 70, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      const selected = await page.evaluate(() => window.getSelection()?.toString());
      expect(selected?.length).toBeGreaterThan(0);
      await page.keyboard.press("Control+c");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.copiedSelection))
        .toBe(selected);
      await page.evaluate(() => {
        window.getSelection()?.removeAllRanges();
        delete document.documentElement.dataset.doubleClickSelection;
      });
      await title.dblclick({ position: { x: 15, y: box.height / 2 } });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.doubleClickSelection))
        .toBe("");
      await expect(page.getByRole("main", { name: "专利编辑区" })).toBeVisible();
      await page.getByRole("tab", { name: "专利库", exact: true }).click();
    }
  } finally {
    await profile.application.close();
  }
});
