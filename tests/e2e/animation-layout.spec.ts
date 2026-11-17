import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("drawing accordions animate their padding to zero instead of snapping at display none", async ({
  page,
}) => {
  await page.setContent(`<div class="patent-global-function-rail">
    <section class="reference-mark-panel" data-collapsible="true"><div class="reference-mark-panel__body"><p>标记内容</p></div></section>
    <section class="drawing-explanation-rail" data-collapsed="false"><div class="drawing-explanation-cards"><p>说明内容</p></div></section>
  </div>`);
  for (const file of ["app/app.css", "patents/function-rail/function-rail-appearance.css"]) {
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${file}`, "utf8") });
  }
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => {
      animation.finish();
    }),
  );
  for (const selector of [".reference-mark-panel__body", ".drawing-explanation-cards"]) {
    const result = await page.locator(selector).evaluate((element) => {
      const panel = element as HTMLElement;
      const initialPadding = getComputedStyle(panel).paddingBottom;
      panel.hidden = true;
      getComputedStyle(panel).height;
      for (const animation of panel.getAnimations()) {
        animation.pause();
        animation.currentTime = 399;
      }
      return {
        initialPadding,
        endPadding: Number.parseFloat(getComputedStyle(panel).paddingBottom),
        endHeight: panel.getBoundingClientRect().height,
      };
    });
    expect(result.initialPadding).toBe("20px");
    expect(result.endPadding).toBeLessThan(0.1);
    expect(result.endHeight).toBeLessThan(0.1);
  }
});

test("retained month and AI preset nodes leave no residual grid gap when removed", async ({
  page,
}) => {
  await page.setContent(`<section class="library-list">
    <section class="library-month-group"><button>月份一</button><div class="spatial-collapse library-month-collapse" data-motion="exit"><div class="spatial-collapse__content"><div class="patent-library-month-cards"><article>专利</article></div></div></div></section><section class="library-month-group"><button id="month">月份二</button></section>
    </section><div class="text-polish-panel"><div class="text-polish-launch"><div class="text-polish-requirement">
    <details class="polish-preset-disclosure polish-launch-presets"><summary>常用需求</summary><div class="spatial-collapse" data-motion="exit"><div class="spatial-collapse__content"><fieldset>需求</fieldset></div></div></details><textarea></textarea><div class="polish-launch-actions"><button>开始</button></div>
    </div></div></div>`);
  for (const file of [
    "app/app.css",
    "library/library-view.css",
    "patents/ai-correction/text-polish-panel.css",
  ]) {
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${file}`, "utf8") });
  }
  const result = await page.evaluate(() => {
    document.getAnimations().forEach((animation) => {
      animation.finish();
    });
    const position = () =>
      ["#month", "textarea"].map(
        (selector) => document.querySelector(selector)?.getBoundingClientRect().y,
      );
    const before = position();
    document.querySelectorAll(".spatial-collapse").forEach((element) => {
      element.remove();
    });
    return { before, after: position() };
  });
  expect(result.before).toEqual(result.after);
});
