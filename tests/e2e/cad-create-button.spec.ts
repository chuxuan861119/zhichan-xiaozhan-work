import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: "msedge", headless: true });

test("new drawing button keeps its icon and label centered with the application theme", async ({
  page,
}) => {
  await page.setContent(`<section class="drawing-workspace"><aside class="drawing-sources">
    <div class="drawing-source-content"><button type="button" class="drawing-create-button">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5v14"/></svg><span>新建图纸</span>
    </button></div></aside></section>`);
  for (const file of [
    "src/renderer/src/drawing-markup/drawing-workspace.css",
    "resources/ui/workbench-ui.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const button = page.getByRole("button", { name: "新建图纸" });
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const layout = await button.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      const label = element.querySelector("span")!.getBoundingClientRect();
      return {
        display: getComputedStyle(element).display,
        iconOffset: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
        labelOffset: Math.abs(label.y + label.height / 2 - button.y - button.height / 2),
        gap: label.x - icon.right,
        height: button.height,
      };
    });
    expect(["flex", "inline-flex"]).toContain(layout.display);
    expect(layout.iconOffset).toBeLessThanOrEqual(0.75);
    expect(layout.labelOffset).toBeLessThanOrEqual(0.75);
    expect(layout.gap).toBeGreaterThanOrEqual(6);
    expect(layout.height).toBeGreaterThanOrEqual(30);
  }
  await button.focus();
  await expect(button).toBeFocused();
  await button.evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  await expect(button).toBeDisabled();
});
