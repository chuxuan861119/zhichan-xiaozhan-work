import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

for (const selected of ["文字", "段落", "页面"]) {
  test(`format submenu supports horizontal pointer travel from ${selected}`, async ({ page }) => {
    await page.setContent(`<nav class="menu-bar"><div class="menu-bar__menu-group">
      <button>格式</button><div class="file-menu format-menu" role="menu">
      ${["文字", "段落", "页面"]
        .map(
          (label) => `<div class="format-menu__branch" data-expanded="${label === selected}">
      <button class="menu-submenu-trigger">${label}</button>
      ${label === selected ? '<div class="file-menu format-submenu"><button id="target">子菜单选项</button></div>' : ""}</div>`,
        )
        .join("")}
      </div></div></nav>`);
    await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
    await page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>(".format-menu");
      const target = document.getElementById("target");
      if (!menu || !target) throw new Error("missing menu fixture");
      menu.onpointerleave = () => {
        document.querySelector(".format-submenu")?.remove();
      };
      target.onclick = () => {
        document.body.dataset.clicked = "true";
      };
    });
    const trigger = await page.getByRole("button", { name: selected, exact: true }).boundingBox();
    const submenu = await page.locator(".format-submenu").boundingBox();
    if (!trigger || !submenu) throw new Error("missing menu bounds");
    expect(Math.abs(submenu.y - trigger.y)).toBeLessThanOrEqual(6);
    const y = trigger.y + trigger.height / 2;
    await page.mouse.move(trigger.x + trigger.width / 2, y);
    // Stop in the actual gap; a timed dismissal alone must not count as a fix.
    await page.mouse.move((trigger.x + trigger.width + submenu.x) / 2, y, { steps: 10 });
    await expect(page.locator("#target")).toBeVisible();
    await page.mouse.move(submenu.x + 30, y, { steps: 10 });
    await page.locator("#target").click();
    await expect(page.locator("body")).toHaveAttribute("data-clicked", "true");
    await page.mouse.move(700, 500);
    await expect(page.locator("#target")).toHaveCount(0);
  });
}

test("format menu color labels match ordinary menu items", async ({ page }) => {
  await page.setContent(`
    <nav class="menu-bar">
      <div class="file-menu format-submenu">
        <button>上标</button>
        <label class="menu-color-picker">文字颜色<input type="color" /></label>
        <label class="menu-color-picker">突出显示颜色<input type="color" /></label>
      </div>
    </nav>
  `);
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });

  const metrics = await page.locator(".format-submenu > *").evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item);
      return {
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        height: style.height,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      };
    }),
  );
  expect(metrics).toHaveLength(3);
  expect(metrics[1]).toEqual(metrics[0]);
  expect(metrics[2]).toEqual(metrics[0]);
});
