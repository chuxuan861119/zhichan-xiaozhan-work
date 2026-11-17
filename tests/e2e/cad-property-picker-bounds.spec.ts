import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("rail property pickers fit the viewport and keep every option accessible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(`<div class="patent-global-function-rail" style="position:fixed;right:8px;bottom:65px;width:260px">
    <label>线型<select aria-label="线型" style="width:100%">${Array.from({ length: 30 }, (_, i) => `<option value="${i}">线型 ${i}</option>`).join("")}</select></label>
  </div>`);
  for (const file of [
    "shared/dropdown-motion.css",
    "patents/function-rail/function-rail-select.css",
  ])
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${file}`, "utf8") });
  const select = page.getByRole("combobox", { name: "线型", exact: true });
  for (const [width, height, bottom] of [
    [800, 1200, 65],
    [800, 600, 65],
    [500, 300, 100],
    [800, 600, 500],
  ] as const) {
    await page.setViewportSize({ width, height });
    await select
      .locator("..")
      .locator("..")
      .evaluate((el, offset) => {
        (el as HTMLElement).style.bottom = `${offset}px`;
      }, bottom);
    await select.click();
    const pickerHeight = await select.evaluate((el) =>
      parseFloat(getComputedStyle(el, "::picker(select)").height),
    );
    expect(pickerHeight).toBeLessThanOrEqual(280);
    const first = select.getByRole("option", { name: "线型 0", exact: true });
    await expect(first).toBeInViewport();
    const last = select.getByRole("option", { name: "线型 29", exact: true });
    await last.scrollIntoViewIfNeeded();
    const bounds = await last.boundingBox();
    if (!bounds) throw new Error("Missing last picker option");
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await last.click();
    await expect(select).toHaveValue("29");
    await select.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(select).toHaveValue("0");
  }
});
