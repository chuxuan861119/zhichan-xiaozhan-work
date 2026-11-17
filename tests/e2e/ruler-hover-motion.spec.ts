import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("ruler hover and leave animate at 400ms while wheel navigation stays responsive", async ({
  page,
}) => {
  await page.setContent(`
    <aside class="document-structure-ruler" data-mode="compact"
      style="position:absolute;left:100px;top:100px;height:120px;width:20px;--document-structure-ruler-slot-width:20px;--document-structure-ruler-wide-width:76px">
      <div class="document-structure-ruler__panel">
        <button class="document-structure-ruler__marker" style="top:20px;height:18px;--ruler-navigation-shift-y:40px">
          <span class="document-structure-ruler__label--wide">权利要求 1</span>
        </button>
      </div>
    </aside>
  `);
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() => {
    const ruler = document.querySelector<HTMLElement>(".document-structure-ruler");
    if (!ruler) throw new Error("Missing ruler fixture");
    ruler.getBoundingClientRect();
    for (const animation of document.getAnimations()) animation.finish();
    ruler.onpointerenter = () => {
      ruler.dataset.navigation = "true";
    };
    ruler.onpointerleave = () => {
      delete ruler.dataset.navigation;
    };
  });
  await page.locator(".document-structure-ruler").hover();
  const result = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".document-structure-ruler__panel");
    const marker = document.querySelector<HTMLElement>(".document-structure-ruler__marker");
    const label = document.querySelector<HTMLElement>(".document-structure-ruler__label--wide");
    if (!panel || !marker || !label) throw new Error("Missing ruler fixture elements");
    const animations = [panel, marker, label].flatMap((element) => element.getAnimations());
    const spatial = animations.filter((animation) => {
      const property = (animation as CSSTransition).transitionProperty;
      return ["width", "transform", "opacity"].includes(property);
    });
    for (const animation of spatial) {
      animation.pause();
      animation.currentTime = 200;
    }
    return {
      timings: spatial.map((animation) => animation.effect?.getTiming()),
      width: panel.getBoundingClientRect().width,
      opacity: Number(getComputedStyle(label).opacity),
    };
  });
  expect(result.timings.length).toBeGreaterThanOrEqual(3);
  for (const timing of result.timings) {
    expect(timing?.duration).toBe(400);
    expect(timing?.easing).toBe("ease-in-out");
  }
  expect(result.width).toBeGreaterThan(20);
  expect(result.width).toBeLessThan(76);
  expect(result.opacity).toBeGreaterThan(0);
  expect(result.opacity).toBeLessThan(1);
  await page.mouse.move(0, 0);
  const leave = await page.locator(".document-structure-ruler__label--wide").evaluate((label) => {
    const opacity = Number(getComputedStyle(label).opacity);
    for (const animation of label.getAnimations()) animation.finish();
    return { opacity, display: getComputedStyle(label).display };
  });
  expect(leave.opacity).toBeCloseTo(result.opacity, 2);
  expect(leave.display).toBe("none");
  await page.locator(".document-structure-ruler").evaluate((ruler) => {
    (ruler as HTMLElement).dataset.navigation = "true";
    (ruler.querySelector(".document-structure-ruler__panel") as HTMLElement).dataset.wheelActive =
      "true";
  });
  await expect(page.locator(".document-structure-ruler__marker")).toHaveCSS(
    "transition-duration",
    "0.09s",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".document-structure-ruler__panel")).toHaveCSS(
    "transition-duration",
    "0s",
  );
});
