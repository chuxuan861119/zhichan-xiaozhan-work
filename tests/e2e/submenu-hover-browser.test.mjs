import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixture = new URL("./fixtures/submenu-hover.html", import.meta.url).pathname;
const url = `${process.env.SUBMENU_TEST_ORIGIN ?? "http://127.0.0.1:5173"}/@fs${fixture}`;

test("diagonal movement preserves the submenu without opening crossed branches", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url);
    await page.getByRole("button", { name: "格式", exact: true }).click();
    const text = page.getByRole("menuitem", { name: "文字", exact: true });
    const paragraph = page.getByRole("menuitem", { name: "段落", exact: true });
    await text.hover();
    const submenu = page.getByRole("menu", { name: "文字格式", exact: true });
    await submenu.waitFor({ state: "visible" });
    const target = await submenu.boundingBox();
    const row = await paragraph.boundingBox();
    await page.mouse.move(row.x + row.width - 15, row.y + row.height / 2);
    await page.waitForTimeout(90);
    assert.equal(await paragraph.getAttribute("aria-expanded"), "false");
    await page.mouse.move(target.x + 30, row.y + row.height / 2);
    await page.waitForTimeout(400);
    assert.equal(await text.getAttribute("aria-expanded"), "true");
    assert.equal(await paragraph.getAttribute("aria-expanded"), "false");
    await paragraph.hover();
    await page.getByRole("menu", { name: "段落格式", exact: true }).waitFor({ state: "visible" });
    assert.equal(await paragraph.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "帮助", exact: true }).click();
    const websites = page.getByRole("menuitem", { name: "常用官方网站", exact: true });
    await websites.hover();
    const sites = page.getByRole("menu", { name: "常用官方网站", exact: true });
    const sitesBox = await sites.boundingBox();
    const feedback = await page
      .getByRole("menuitem", { name: "建议与反馈", exact: true })
      .boundingBox();
    await page.mouse.move(feedback.x + feedback.width - 15, feedback.y + feedback.height / 2);
    await page.waitForTimeout(90);
    assert.equal(await websites.getAttribute("aria-expanded"), "true");
    await page.mouse.move(sitesBox.x + 30, sitesBox.y + 80);
    await page.waitForTimeout(400);
    assert.equal(await websites.getAttribute("aria-expanded"), "true");
    await page.mouse.move(1200, 10);
    await page.waitForFunction(
      () =>
        document
          .querySelector(".official-websites-group > button")
          ?.getAttribute("aria-expanded") === "false",
    );
  } finally {
    await browser.close();
  }
});

test("library official websites stay inside the viewport and accept pointer input", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?library=single`);
      await page.getByRole("button", { name: "帮助", exact: true }).click();
      assert.equal(await page.getByRole("menuitem", { name: "重新查看界面介绍" }).count(), 0);
      const trigger = page.getByRole("menuitem", { name: "常用官方网站", exact: true });
      await trigger.click();
      const menu = page.getByRole("menu", { name: "常用官方网站", exact: true });
      await menu.waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900);
      const gaps = await menu.locator("fieldset").evaluateAll((groups) =>
        groups.flatMap((group) => {
          const rows = [...group.querySelectorAll('[role="menuitem"]')];
          return rows
            .slice(1)
            .map(
              (row, index) =>
                row.getBoundingClientRect().top - rows[index].getBoundingClientRect().bottom,
            );
        }),
      );
      assert.ok(gaps.every((gap) => Math.abs(gap) < 1));
      const site = menu.getByRole("menuitem", { name: "国家知识产权局", exact: true });
      await site.hover();
      await page.waitForTimeout(400);
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await trigger.focus();
      await page.keyboard.press("ArrowRight");
      await menu.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
  } finally {
    await browser.close();
  }
});
