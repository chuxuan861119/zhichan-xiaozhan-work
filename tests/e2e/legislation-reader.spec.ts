import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./helpers/workbench.js";

test("offline legislation reader renders searchable official text and PDF", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  try {
    const page = await app.firstWindow();
    await page.context().setOffline(true);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "专利法律法规" }).click();
    const dialog = page.getByRole("dialog", { name: "专利法律法规", exact: true });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".patent-tabs__library-tab")
          .evaluate((tab) => getComputedStyle(tab, "::after").clipPath),
      )
      .toBe("inset(-6px -6px 0px)");
    await expect(dialog.getByRole("button", { name: "最大化阅读" })).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(dialog.getByRole("button", { name: "最大化阅读" })).toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );
    await expect(dialog.getByRole("button", { name: "关闭专利法律法规" })).toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );
    await expect(dialog.getByLabel("法规正文")).toContainText("第八十二条");
    const verifyCopy = async (selector: string) => {
      await dialog.locator(selector).first().click({ clickCount: 3 });
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
      expect(selected.trim().length).toBeGreaterThan(3);
      await page.keyboard.press("Control+c");
      await expect
        .poll(async () =>
          (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n"),
        )
        .toBe(selected.replace(/\r\n/g, "\n"));
    };
    await verifyCopy(".legislation-reader__text p");
    await dialog.getByRole("button", { name: "最大化阅读" }).focus();
    await page.keyboard.press("Control+f");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await dialog.getByRole("button", { name: "常用法条", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "新颖性、创造性与实用性" })).toBeVisible();
    await expect(dialog.locator("details[open]")).toHaveCount(21);
    await expect(dialog.locator("details[open]").first()).toContainText("本法所称现有技术");
    await expect(dialog.getByText(/适用提示/)).toHaveCount(0);
    await verifyCopy(".legislation-common__card details p");
    await page.screenshot({ path: test.info().outputPath("common-articles.png") });
    await dialog.getByRole("button", { name: "查看原文：专利法第二十二条", exact: true }).click();
    await expect(dialog.locator('[data-article-target="true"]')).toBeInViewport();
    await dialog.getByRole("button", { name: "常用法条", exact: true }).click();
    await dialog.getByRole("button", { name: "撰写规范", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "新颖性、创造性与实用性" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "查看原文：实施细则第二十五条", exact: true }).click();
    await expect(dialog.locator('[data-article-target="true"]')).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "查找（Ctrl+F）", exact: true })).toHaveCount(
      0,
    );
    await verifyCopy(".legislation-reader__text [data-article-target=true]");
    await dialog.getByRole("button", { name: "最大化阅读" }).focus();
    await page.keyboard.press("Control+f");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await dialog.getByRole("button", { name: "专利法", exact: true }).click();
    await dialog.getByRole("searchbox").fill("专利权");
    await expect(dialog.locator("mark").first()).toBeAttached();
    await dialog.getByRole("button", { name: "下一处" }).click();
    await expect(dialog.getByRole("status")).toContainText("2 /");
    await dialog.getByRole("button", { name: "实施细则", exact: true }).click();
    await expect(dialog.getByLabel("法规正文")).toContainText("第一百四十九条");
    await dialog.getByRole("navigation", { name: "条文目录" }).getByRole("button").last().click();
    const savedScroll = await dialog
      .getByLabel("法规正文")
      .evaluate((element) => element.scrollTop);
    expect(savedScroll).toBeGreaterThan(100);
    await page.screenshot({ path: test.info().outputPath("legislation-text.png") });
    await dialog.getByRole("button", { name: "审查指南", exact: true }).click();
    await expect(dialog.locator(".pdfViewer canvas").first()).toBeVisible({ timeout: 25000 });
    await expect(dialog.locator(".legislation-reader__pdf-badge")).toHaveText("PDF");
    await expect(
      dialog.locator(".legislation-reader__pagination").getByLabel("指南页码"),
    ).toBeVisible();
    await expect(
      dialog.locator(".legislation-reader__pdf-area .legislation-reader__page-controls"),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(dialog.getByLabel("指南页码")).toHaveValue("2");
    await dialog.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(dialog.getByLabel("指南页码")).toHaveValue("1");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(
      dialog.getByRole("navigation", { name: "审查指南目录" }).getByRole("button"),
    ).toHaveCount(44);
    await dialog.getByRole("button", { name: "第二章 说明书和权利要求书", exact: true }).click();
    await expect(dialog.getByLabel("指南页码")).toHaveValue("109");
    await dialog.getByRole("button", { name: "实施细则", exact: true }).click();
    await expect
      .poll(() => dialog.getByLabel("法规正文").evaluate((element) => element.scrollTop))
      .toBe(savedScroll);
    await dialog.getByRole("button", { name: "审查指南", exact: true }).click();
    await expect(dialog.getByLabel("指南页码")).toHaveValue("109");
    await dialog.getByRole("searchbox").fill("创造性");
    await expect(dialog.locator(".textLayer .highlight").first()).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: test.info().outputPath("legislation-pdf.png") });
    const target = join(workbench.root, "official-guide.pdf");
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, "showSaveDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      });
    }, target);
    await dialog.getByRole("button", { name: "保存副本" }).click();
    await expect
      .poll(async () => {
        try {
          return (await readFile(target)).subarray(0, 5).toString();
        } catch {
          return "";
        }
      })
      .toBe("%PDF-");
    await dialog.getByRole("button", { name: "关闭专利法律法规" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await page.getByRole("menuitem", { name: "专利法律法规" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
  }
});
