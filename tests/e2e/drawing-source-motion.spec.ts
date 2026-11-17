import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("drawing source sidebar interpolates width and honors reduced motion", async ({ page }) => {
  await page.setContent(
    '<main class="drawing-workspace-content" style="width:800px;height:400px"><aside class="drawing-sources"><div class="drawing-source-content"><div style="height:160px">素材</div></div></aside><section>画布</section></main>',
  );
  await page.addStyleTag({
    content: readFileSync("src/renderer/src/drawing-markup/drawing-workspace.css", "utf8"),
  });
  await page.waitForTimeout(450);
  const result = await page.locator("main").evaluate((element) => {
    const firstColumn = () => Number.parseFloat(getComputedStyle(element).gridTemplateColumns);
    const expanded = firstColumn();
    element.classList.add("is-sources-collapsed");
    getComputedStyle(element).gridTemplateColumns;
    const animations = element.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = firstColumn();
    for (const animation of animations) animation.finish();
    return {
      expanded,
      middle,
      collapsed: firstColumn(),
      duration: getComputedStyle(element).transitionDuration,
    };
  });
  expect(result.expanded).toBe(218);
  expect(result.middle).toBeGreaterThan(42);
  expect(result.middle).toBeLessThan(218);
  expect(result.collapsed).toBe(42);
  expect(result.duration).toBe("0.4s");
  const collapse = await page.locator(".drawing-source-content").evaluate((element) => {
    const el = element as HTMLElement;
    el.hidden = true;
    getComputedStyle(el).opacity;
    const animations = el.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = Number(getComputedStyle(el).opacity);
    for (const animation of animations) animation.finish();
    return { middle, collapsed: el.getBoundingClientRect().height };
  });
  expect(collapse.middle).toBeGreaterThan(0);
  expect(collapse.middle).toBeLessThan(1);
  expect(collapse.collapsed).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.locator("main").evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
});
