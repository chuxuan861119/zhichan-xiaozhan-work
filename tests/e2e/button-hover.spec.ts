import { writeFile } from "node:fs/promises";
import { expect, test } from "./helpers/workbench.js";

test("numbering buttons provide visible hover feedback", async ({ workbench }, testInfo) => {
  test.setTimeout(300_000);
  const app = await workbench.launch();
  const rows: { context: string; name: string; classes: string; changed: boolean }[] = [];
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "新建专利", exact: true })).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
    const cdp = process.env.HOVER_AUDIT === "1" ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      // Hidden windows can suspend transition frames; inspect the final CSS state instead.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { transition: none !important; animation: none !important; }",
      });
    }
    const audit = async (context: string) => {
      const dialogs = page.locator('[role="dialog"]:visible');
      const scope = (await dialogs.count()) ? dialogs.last() : page;
      const buttons = scope.locator(
        process.env.HOVER_AUDIT === "1"
          ? "button:visible"
          : ".reference-mark-panel__numbering-buttons button:visible",
      );
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        if (
          !(await button.isVisible()) ||
          (await button.isDisabled()) ||
          (await button.getAttribute("aria-disabled")) === "true"
        )
          continue;
        const info = await button.evaluate((node) => ({
          name:
            node.getAttribute("aria-label") ||
            node.textContent?.trim() ||
            node.getAttribute("title") ||
            "",
          classes: node.className,
        }));
        if (
          info.classes.includes("settings-workspace-navigation__item") &&
          rows.some((row) => row.classes === info.classes && row.name === info.name)
        )
          continue;
        if (!cdp) {
          await page.mouse.move(0, 0);
          await page.waitForTimeout(180);
        }
        const visual = () =>
          button.evaluate((node) =>
            [node, ...node.querySelectorAll("svg, span")]
              .map((el) => {
                const s = getComputedStyle(el);
                return [
                  s.backgroundColor,
                  s.color,
                  s.borderColor,
                  s.boxShadow,
                  s.opacity,
                  s.filter,
                  s.transform,
                  s.fill,
                  s.stroke,
                ].join("|");
              })
              .join("\n"),
          );
        const before = await visual();
        let nodeId = 0;
        if (cdp) {
          await button.evaluate((node) => node.setAttribute("data-hover-audit", "current"));
          const document = await cdp.send("DOM.getDocument");
          ({ nodeId } = await cdp.send("DOM.querySelector", {
            nodeId: document.root.nodeId,
            selector: '[data-hover-audit="current"]',
          }));
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
        } else await button.hover({ timeout: 2000, force: true });
        if (!cdp) await page.waitForTimeout(180);
        rows.push({ context, ...info, changed: before !== (await visual()) });
        if (cdp) {
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
          await button.evaluate((node) => node.removeAttribute("data-hover-audit"));
        }
      }
      console.log(
        `Hover audit: ${context} (${rows.filter((row) => row.context === context).length} enabled buttons)`,
      );
    };
    if (process.env.HOVER_AUDIT === "1") {
      await audit("专利库");
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const labels = await page.locator(".settings-workspace-navigation__item").allTextContents();
      for (const label of labels) {
        await page
          .locator(".settings-workspace-navigation__item")
          .filter({ hasText: label })
          .click();
        await audit(`设置/${label.trim()}`);
      }
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    }
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    if (process.env.HOVER_AUDIT === "1") await audit("新建专利弹窗");
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("悬停反馈测试");
    await dialog.getByRole("radio", { name: "发明", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await expect(page.getByRole("button", { name: "顺序编号", exact: true })).toBeVisible();
    await audit("权利要求书");
    if (process.env.HOVER_AUDIT === "1") {
      for (const book of ["说明书", "说明书附图", "说明书摘要"]) {
        await page.getByRole("tab", { name: book, exact: true }).click();
        await audit(book);
      }
    }
    await testInfo.attach("hover-audit", {
      body: JSON.stringify(rows, null, 2),
      contentType: "application/json",
    });
    for (const name of ["顺序编号", "自定义编号"]) {
      expect(
        rows.find((row) => row.context === "权利要求书" && row.name === name)?.changed,
        name,
      ).toBe(true);
    }
  } finally {
    await writeFile(testInfo.outputPath("hover-results.json"), JSON.stringify(rows, null, 2));
    await app.close();
  }
});
