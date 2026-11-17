import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("native disclosures animate opening and closing and honor reduced motion", async ({
  page,
}) => {
  await page.setContent(
    '<details class="spatial-disclosure"><summary>思考过程</summary><div style="height:160px">内容</div></details>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  // Wait for the initial style insertion to settle before measuring a user toggle.
  await page.waitForTimeout(450);
  const disclosure = page.locator("details");
  const height = () => disclosure.evaluate((element) => element.getBoundingClientRect().height);
  const closed = await height();
  const timing = await disclosure.evaluate((element) => {
    const style = getComputedStyle(element, "::details-content");
    return { duration: style.transitionDuration, easing: style.transitionTimingFunction };
  });
  expect(timing.duration).toContain("0.4s");
  expect(timing.easing).toContain("ease-in-out");
  await page.locator("summary").click();
  await page.waitForTimeout(180);
  const middleOpen = await height();
  await page.waitForTimeout(300);
  const expanded = await height();
  expect(middleOpen).toBeGreaterThan(closed);
  expect(middleOpen).toBeLessThan(expanded);
  await page.locator("summary").click();
  await page.waitForTimeout(180);
  const middleClose = await height();
  expect(middleClose).toBeGreaterThan(closed);
  expect(middleClose).toBeLessThan(expanded);
  await page.waitForTimeout(300);
  expect(await height()).toBe(closed);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("summary").click();
  expect(await height()).toBe(expanded);
  expect(
    await disclosure.evaluate(
      (element) => getComputedStyle(element, "::details-content").transitionDuration,
    ),
  ).toBe("0s");
});

test("retained summaries interpolate height while closing and reopening", async ({ page }) => {
  await page.setContent(
    '<div class="spatial-collapse" data-motion="enter"><div class="spatial-collapse__content"><section style="height:160px">摘要</section></div></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  const result = await page.locator(".spatial-collapse").evaluate((element) => {
    const el = element as HTMLElement;
    for (const animation of el.getAnimations()) animation.finish();
    const expanded = el.getBoundingClientRect().height;
    el.dataset.motion = "exit";
    getComputedStyle(el).gridTemplateRows;
    const closing = el.getAnimations();
    for (const animation of closing) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = el.getBoundingClientRect().height;
    for (const animation of closing) animation.finish();
    const closed = el.getBoundingClientRect().height;
    el.dataset.motion = "enter";
    getComputedStyle(el).gridTemplateRows;
    for (const animation of el.getAnimations()) animation.finish();
    return { expanded, middle, closed, reopened: el.getBoundingClientRect().height };
  });
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(result.expanded);
  expect(result.closed).toBe(0);
  expect(result.reopened).toBe(result.expanded);
});
