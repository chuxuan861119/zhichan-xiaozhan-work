import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { expect, test } from "./helpers/workbench.js";

test("dense wide ruler labels expand inline without a hover popover", async ({
  workbench,
}, info) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1450, height: 900 });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("密集标尺回归样本");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page.getByRole("textbox", { name: "编辑 说明书", exact: true }).evaluate((element) => {
    const editor = (
      element as HTMLElement & { editor: { commands: { setContent(value: unknown): void } } }
    ).editor;
    editor.commands.setContent({
      type: "doc",
      content: [
        "技术领域",
        ...Array.from(
          { length: 50 },
          (_, i) => `第${i + 1}段：本装置包括底座和支撑架，用于保持工件稳定。`,
        ),
      ].map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    });
  });
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  for (const mode of ["single", "columns"] as const) {
    if (mode === "columns") {
      await page.setViewportSize({ width: 1800, height: 800 });
      await page.getByRole("button", { name: "双列显示", exact: true }).click();
      await expect(page.locator(".dual-column-layout")).toBeVisible();
      await columnScrollbar(page).fill("0");
    }
    const ruler = page.locator(".patent-page-with-rail > .document-structure-ruler:visible");
    await expect(ruler.locator("[data-cluster-count]").first()).toBeVisible();
    await expect
      .poll(() =>
        ruler.evaluate((element) => {
          const labels = [
            ...element.querySelectorAll<HTMLElement>(".document-structure-ruler__label--wide"),
          ]
            .filter(
              (label) =>
                getComputedStyle(label).visibility !== "hidden" &&
                label.getBoundingClientRect().height > 0,
            )
            .map((label) => label.getBoundingClientRect())
            .sort((a, b) => a.top - b.top);
          return labels.every((label, i) => i === 0 || label.top >= labels[i - 1]!.bottom - 0.5);
        }),
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`${mode}-labels.png`) });
    await expect(ruler).toHaveAttribute("data-mode", "wide");
    await ruler.locator("[data-cluster-count]").first().hover();
    const navigation = page.getByRole("navigation", { name: "文档导航" });
    await expect(ruler).toHaveAttribute("data-navigation", "true");
    await expect(navigation).toHaveCount(0);
    await expect(
      ruler.getByRole("button", { name: "定位到缺少背景技术", exact: true }),
    ).toBeVisible();
    await expect(
      ruler.getByRole("button", { name: "定位到缺少发明内容", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${mode}-navigation.png`) });
    await page.keyboard.press("Escape");
    await page.mouse.move(700, 70);
    await expect(navigation).toBeHidden();
  }
});
