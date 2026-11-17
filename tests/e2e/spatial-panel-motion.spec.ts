import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("drawing accordions animate the native hidden state and honor reduced motion", async ({
  page,
}) => {
  await page.setContent(`
    <aside class="patent-global-function-rail">
      <section class="reference-mark-panel" data-collapsible="true">
        <div class="reference-mark-panel__body"><input value="保留草稿"><div style="height:160px"></div></div>
      </section>
      <section class="drawing-explanation-rail" data-collapsed="false">
        <div class="drawing-explanation-cards"><div style="height:160px"></div></div>
      </section>
    </aside>
  `);
  for (const file of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/patents/function-rail/function-rail-appearance.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });

  for (const selector of [".reference-mark-panel__body", ".drawing-explanation-cards"]) {
    const result = await page.locator(selector).evaluate(async (element) => {
      const el = element as HTMLElement;
      for (const animation of el.getAnimations()) animation.finish();
      const height = () => el.getBoundingClientRect().height;
      const fullHeight = height();
      el.hidden = true;
      getComputedStyle(el).height;
      const animations = el.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 200;
      }
      const closingHeight = height();
      for (const animation of animations) animation.finish();
      const closedHeight = height();
      el.hidden = false;
      getComputedStyle(el).height;
      const opening = el.getAnimations();
      for (const animation of opening) {
        animation.pause();
        animation.currentTime = 200;
      }
      const openingHeight = height();
      for (const animation of opening) animation.finish();
      return { fullHeight, closingHeight, closedHeight, openingHeight, finalHeight: height() };
    });
    expect(result.closingHeight).toBeGreaterThan(0);
    expect(result.closingHeight).toBeLessThan(result.fullHeight);
    expect(result.closedHeight).toBe(0);
    expect(result.openingHeight).toBeGreaterThan(0);
    expect(result.openingHeight).toBeLessThan(result.fullHeight);
    expect(result.finalHeight).toBe(result.fullHeight);
  }
  await expect(page.locator("input")).toHaveValue("保留草稿");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page.locator(".reference-mark-panel__body").evaluate((element) => {
    (element as HTMLElement).hidden = true;
    getComputedStyle(element).height;
    return element.getAnimations().length;
  });
  expect(animations).toBe(0);
});

test("rails and assistant panels use 400ms easing and reverse without jumping", async ({
  page,
}) => {
  await page.setContent(`
    <aside class="patent-global-function-rail" data-motion="enter">功能栏</aside>
    <aside class="assistant-side-panel" data-motion="enter">侧面板</aside>
    <aside class="assistant-side-panel text-polish-panel" data-motion="enter">AI 助手</aside>
  `);
  for (const file of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/patents/function-rail/function-rail-responsive.css",
    "src/renderer/src/patents/ai-correction/text-polish-panel.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  for (const selector of [
    ".patent-global-function-rail",
    ".assistant-side-panel:not(.text-polish-panel)",
    ".text-polish-panel",
  ]) {
    const result = await page.locator(selector).evaluate((element) => {
      const el = element as HTMLElement;
      for (const animation of el.getAnimations()) animation.finish();
      el.dataset.motion = "exit";
      getComputedStyle(el).opacity;
      const animations = el.getAnimations();
      const timings = animations.map((animation) => animation.effect?.getTiming());
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 200;
      }
      const middle = Number(getComputedStyle(el).opacity);
      el.dataset.motion = "enter";
      const reversed = Number(getComputedStyle(el).opacity);
      for (const animation of el.getAnimations()) animation.finish();
      return { timings, middle, reversed, end: Number(getComputedStyle(el).opacity) };
    });
    expect(result.timings.length).toBeGreaterThan(0);
    for (const timing of result.timings) {
      expect(timing?.duration).toBe(400);
      expect(timing?.easing).toBe("ease-in-out");
    }
    expect(result.middle).toBeGreaterThan(0);
    expect(result.middle).toBeLessThan(1);
    expect(result.reversed).toBeCloseTo(result.middle, 2);
    expect(result.end).toBe(1);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [".patent-global-function-rail", ".text-polish-panel"]) {
    const count = await page.locator(selector).evaluate((element) => {
      (element as HTMLElement).dataset.motion = "exit";
      getComputedStyle(element).opacity;
      return element.getAnimations().length;
    });
    expect(count).toBe(0);
  }
});
