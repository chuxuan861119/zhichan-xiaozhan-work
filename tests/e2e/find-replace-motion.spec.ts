import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test.beforeEach(async ({ page }) => {
  const bundle = await build({
    entryPoints: ["tests/e2e/fixtures/find-replace-motion.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  await page.setContent(
    '<html data-reduced-motion="false"><body><div id="root"></div></body></html>',
  );
  for (const file of [
    "app/app.css",
    "editor/editor.css",
    "patents/function-rail/function-rail-appearance.css",
    "exports/print-center.css",
    "flowcharts/flowchart.css",
  ]) {
    await page.addStyleTag({ content: readFileSync(`src/renderer/src/${file}`, "utf8") });
  }
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(page.locator(".find-replace-panel")).toBeVisible();
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
});

for (const { id, width, height } of [
  { id: "password", width: 1280, height: 900 },
  { id: "print", width: 1280, height: 900 },
  { id: "export", width: 1280, height: 900 },
  { id: "export", width: 600, height: 900 },
  { id: "export", width: 600, height: 500 },
  { id: "scope", width: 1280, height: 900 },
]) {
  test(`${id} ${width}x${height}: removing a finished collapse does not snap the following content`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.locator(`#${id} > button`).click();
    const closing = page.locator(`#${id} > .spatial-collapse[data-motion="exit"]`);
    await expect(closing).toHaveCount(1);
    const before = await page.evaluate((id) => {
      document
        .querySelectorAll(`#${id} .spatial-collapse`)
        .forEach((element) => element.getAnimations().forEach((animation) => animation.finish()));
      return document.querySelector(`#${id} .following`)!.getBoundingClientRect().top;
    }, id);
    await expect(closing).toHaveCount(0);
    const after = await page
      .locator(`#${id} .following`)
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThan(0.1);
  });
}

for (const inRail of [true, false]) {
  test(`find and replace collapse input and action rows without an end-of-motion jump (rail: ${inRail})`, async ({
    page,
  }) => {
    if (!inRail)
      await page
        .locator(".patent-global-function-rail")
        .evaluate((element) => element.classList.remove("patent-global-function-rail"));
    await page.getByRole("button", { name: "查找", exact: true }).click();
    await expect(page.locator('.find-replace-panel [data-motion="exit"]').first()).toBeAttached();
    const before = await page.locator(".find-replace-panel").evaluate((element) => {
      element.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
      return element.getBoundingClientRect().height;
    });
    await expect(page.locator('.find-replace-panel [data-motion="exit"]')).toHaveCount(0);
    const after = await page
      .locator(".find-replace-panel")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(after - before)).toBeLessThan(0.1);
  });
}

test("reversing find/replace midway keeps its input and current layout", async ({ page }) => {
  const replacement = page.getByRole("textbox", { name: "替换为" });
  await replacement.fill("保留替换内容");
  await replacement.evaluate((element) => element.setAttribute("data-original-input", "true"));
  await page.getByRole("button", { name: "查找", exact: true }).click();
  const middle = await page.locator(".find-replace-panel").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 200;
    }
    return element.getBoundingClientRect().height;
  });
  await page.getByRole("button", { name: "替换", exact: true }).click();
  const restarted = await page.locator(".find-replace-panel").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
    return element.getBoundingClientRect().height;
  });
  expect(Math.abs(restarted - middle)).toBeLessThan(1);
  await expect(replacement).toHaveValue("保留替换内容");
  await expect(replacement).toHaveAttribute("data-original-input", "true");
});

test("reduced motion switches immediately without retaining replacement controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await expect(page.locator(".find-replace-panel .spatial-collapse")).toHaveCount(0);
  await page.getByRole("button", { name: "替换", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "替换为" })).toBeVisible();
});
