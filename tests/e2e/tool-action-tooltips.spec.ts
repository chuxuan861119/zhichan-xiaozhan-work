import { writeFile } from "node:fs/promises";
import { expect, test } from "./helpers/workbench.js";

test("toolbar and dynamic rail buttons show nearby tooltips without stealing input", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(240_000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("按钮浮窗隔离验证");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await expect(page.getByRole("button", { name: "顺序编号", exact: true })).toBeVisible();
    const toolbar = page.getByRole("toolbar", { name: "常用工具" });
    await toolbar.getByRole("button", { name: "粗体", exact: true }).hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("加粗所选文字");
    await expect(tip).toContainText("Ctrl+B");
    await tip.screenshot({ path: testInfo.outputPath("toolbar-tooltip.png") });
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
    for (const label of ["顺序编号", "自定义编号"]) {
      await page.getByRole("button", { name: label, exact: true }).hover();
      await expect(tip).toContainText("关键词");
      await expect(tip).toContainText("暂未设置快捷键");
    }
    // Disabled copy/fill buttons remain discoverable by hovering, without executing them.
    for (const selector of [".reference-mark-panel__copy", ".reference-mark-panel__fill"]) {
      await page.locator(selector).hover({ force: true });
      await expect(tip).toBeVisible();
      await expect(tip).not.toContainText("快捷键");
    }
    await toolbar.getByRole("button", { name: "查找", exact: true }).click();
    const railButtons = page.locator(
      ".patent-global-function-rail-slot .find-replace-panel button:visible",
    );
    expect(await railButtons.count()).toBeGreaterThan(0);
    for (const button of await railButtons.all()) {
      await button.hover({ force: true });
      await expect(tip).toBeVisible();
      await expect(tip).not.toBeEmpty();
      const bounds = await tip.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (!bounds) throw new Error("Tooltip has no visible bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    const audited: string[] = [];
    const auditButtons = async (scope: string, context: string) => {
      const buttons = page.locator(`${scope} button:visible`);
      for (const button of await buttons.all()) {
        const label = await button.evaluate(
          (el) =>
            el.getAttribute("aria-label") ||
            el.textContent?.trim() ||
            el.getAttribute("title") ||
            "",
        );
        const key = `${context}/${label}`;
        if (audited.includes(key)) continue;
        if (
          [
            "清除多余格式",
            "本地检查",
            "插入从权",
            "说明书",
            "发明内容",
            "具体实施方式",
            "增补编号",
          ].includes(label)
        )
          continue;
        await page.mouse.move(0, 0);
        await button.hover({ force: true });
        await expect(tip, key).toBeVisible();
        await expect(tip, key).not.toBeEmpty();
        audited.push(key);
      }
    };
    await auditButtons(".tool-bar", "工具栏");
    const more = toolbar.getByRole("button", { name: "更多工具", exact: true });
    if (await more.isVisible()) {
      await more.click();
      await auditButtons(".toolbar-overflow-menu", "更多工具");
      await more.click();
    }
    for (const book of ["权利要求书", "说明书", "说明书附图", "说明书摘要"]) {
      await page.getByRole("tab", { name: book, exact: true }).click();
      await auditButtons(".patent-global-function-rail-slot", book);
    }
    await writeFile(testInfo.outputPath("tooltip-coverage.json"), JSON.stringify(audited, null, 2));
    expect(audited.length).toBeGreaterThan(30);
  } finally {
    await app.close();
  }
});
