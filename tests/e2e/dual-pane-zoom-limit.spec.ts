import type { Locator, Page } from "@playwright/test";
import {
  choosePaneBook,
  enterDualView,
  expect,
  selectDualPane,
  test,
} from "./helpers/workbench.js";

async function openDual(page: Page) {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双显缩放联动验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await enterDualView(page);
  await choosePaneBook(page, "right", "双显缩放联动验收", "说明书");
  await page.setViewportSize({ width: 1746, height: 998 });
}

const pane = (page: Page, side: "left" | "right") =>
  page.locator(`.dual-document-pane[data-pane="${side}"]`);
async function metrics(region: Locator) {
  return region.evaluate((element) => {
    const viewport = element.querySelector<HTMLElement>(".patent-editor-workspace")!;
    const layout = viewport.querySelector<HTMLElement>(".patent-page-with-rail")!;
    const paper = layout.querySelector<HTMLElement>(".patent-page-zoom-frame")!;
    const style = getComputedStyle(viewport);
    const available =
      viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      zoom: Number((element as HTMLElement).dataset.dualZoom),
      width: paper.getBoundingClientRect().width,
      actualZoom: (paper.getBoundingClientRect().width / paper.offsetWidth) * 100,
      max: ((available - 28 - 48 - 1) / paper.offsetWidth) * 100,
      overflow: viewport.scrollWidth - viewport.clientWidth,
      compact: layout.dataset.paneRulerCompact,
      space: layout.dataset.paneRailSpace,
      scroll: viewport.scrollTop,
    };
  });
}

async function wheel(region: Locator, deltaY: number) {
  await region
    .locator(".editor-workspace")
    .dispatchEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true });
}

test("animated swaps reapply the width budget to unequal physical panes", async ({ workbench }) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openDual(page);
  const divider = page.getByRole("separator", { name: "双文档分隔线" });
  const box = await divider.boundingBox();
  if (!box) throw new Error("Missing split divider");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  for (const side of ["left", "right"] as const) {
    await selectDualPane(page, side);
    for (let step = 0; step < 25; step++) await page.keyboard.press("Control+=");
  }
  for (let swap = 0; swap < 3; swap++) {
    await page.getByRole("button", { name: "交换左右文档" }).click();
    await expect(page.locator(".dual-pane-swap-ghost-layer")).toHaveCount(0);
    for (const side of ["left", "right"] as const) {
      await expect
        .poll(async () => (await metrics(pane(page, side))).compact)
        .toMatch(/^(true|false)$/);
      await expect
        .poll(async () => (await metrics(pane(page, side))).overflow)
        .toBeLessThanOrEqual(1);
      const m = await metrics(pane(page, side));
      expect(m.zoom).toBeLessThanOrEqual(m.max + 0.001);
      expect(Math.abs(m.actualZoom - m.zoom)).toBeLessThan(0.08);
    }
  }
});

test("rapid inverse layout clicks honor the newest intent without losing either document", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openDual(page);
  const toggle = page.getByRole("button", { name: "同屏双显", exact: true });
  const targets = await page
    .locator(".dual-document-pane")
    .evaluateAll((panes) => panes.map((element) => element.querySelector("header")?.textContent));
  await toggle.click();
  await page.waitForTimeout(70);
  await toggle.click();
  await page.waitForTimeout(700);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(
    await page
      .locator(".dual-document-pane")
      .evaluateAll((panes) => panes.map((element) => element.querySelector("header")?.textContent)),
  ).toEqual(targets);
  // Reverse after the outgoing phase committed single mode, but before its
  // incoming phase finished. Both documents must still return intact.
  await toggle.click();
  await page.waitForTimeout(270);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.waitForTimeout(650);
  expect(
    await page
      .locator(".dual-document-pane")
      .evaluateAll((panes) => panes.map((element) => element.querySelector("header")?.textContent)),
  ).toEqual(targets);
  await toggle.click();
  await page.waitForTimeout(60);
  await toggle.click();
  await page.waitForTimeout(60);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(600);
  await expect(page.locator(".dual-document-workspace")).toHaveCount(0);
  // Cancel an entry while its native-window preparation is still asynchronous.
  await toggle.click();
  await toggle.click();
  await page.waitForTimeout(700);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".dual-document-workspace")).toHaveCount(0);
});

test("zoom follows the hovered pane and controls recover on a laptop when pages shrink", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDual(page);
  for (const side of ["left", "right"] as const) {
    await selectDualPane(page, side);
    for (let i = 0; i < 6; i++) await page.keyboard.press("Control+-");
    await expect.poll(async () => (await metrics(pane(page, side))).space).toBe("fits");
    await expect(
      pane(page, side).locator(
        '.patent-global-function-rail-slot[data-layout="docked"][data-expanded="true"] .patent-global-function-rail',
      ),
    ).toBeVisible();
    await expect.poll(async () => (await metrics(pane(page, side))).compact).toBe("false");
  }
  await selectDualPane(page, "right");
  await page.keyboard.press("Control+=");
  const rightBefore = await metrics(pane(page, "right"));
  await pane(page, "left").locator(".document-structure-ruler").dispatchEvent("wheel", {
    deltaY: -32,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(async () => (await metrics(pane(page, "left"))).zoom).toBeGreaterThan(51);
  expect((await metrics(pane(page, "right"))).zoom).toBe(rightBefore.zoom);
  await expect(pane(page, "right")).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Control+=");
  await expect
    .poll(async () => (await metrics(pane(page, "right"))).zoom)
    .toBeGreaterThan(rightBefore.zoom);

  // The compact right ruler must also zoom its own page without becoming active.
  for (let step = 0; step < 25; step++) await page.keyboard.press("Control+=");
  await expect(pane(page, "right").locator(".document-structure-ruler")).toHaveAttribute(
    "data-mode",
    "compact",
  );
  await selectDualPane(page, "left");
  const leftBeforeRightWheel = (await metrics(pane(page, "left"))).zoom;
  const rightBeforeRulerWheel = (await metrics(pane(page, "right"))).zoom;
  await pane(page, "right").locator(".document-structure-ruler").dispatchEvent("wheel", {
    deltaY: 32,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await expect
    .poll(async () => (await metrics(pane(page, "right"))).zoom)
    .toBeLessThan(rightBeforeRulerWheel);
  expect((await metrics(pane(page, "left"))).zoom).toBe(leftBeforeRightWheel);
  await expect(pane(page, "left")).toHaveAttribute("data-active", "true");

  for (const width of [1746, 1400, 2560]) {
    await page.setViewportSize({ width, height: 998 });
    for (const side of ["left", "right"] as const) {
      await selectDualPane(page, side);
      for (let step = 0; step < 25; step++) await page.keyboard.press("Control+=");
      await expect(
        page.getByRole("contentinfo").getByRole("button", { name: "放大", exact: true }),
      ).toBeDisabled();
      await expect
        .poll(async () => {
          const m = await metrics(pane(page, side));
          return Math.abs(m.zoom - m.max);
        })
        .toBeLessThan(0.001);
      await expect
        .poll(async () => (await metrics(pane(page, side))).overflow)
        .toBeLessThanOrEqual(1);
      await expect.poll(async () => (await metrics(pane(page, side))).compact).toBe("true");
      await expect
        .poll(async () => {
          const m = await metrics(pane(page, side));
          return Math.abs(m.actualZoom - m.zoom);
        })
        .toBeLessThan(0.08);
      const before = (await metrics(pane(page, side))).zoom;
      await wheel(pane(page, side), -120);
      await page.waitForTimeout(40);
      expect((await metrics(pane(page, side))).zoom).toBe(before);
      await page.keyboard.press("Control+0");
      expect((await metrics(pane(page, side))).zoom).toBeLessThanOrEqual(
        (await metrics(pane(page, side))).max,
      );
    }
  }
});

test("continuous wheel input paints intermediate widths and keeps a top page at the top", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openDual(page);
  await selectDualPane(page, "left");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Control+-");
  await expect.poll(async () => (await metrics(pane(page, "left"))).actualZoom).toBeLessThan(50.1);
  const widths: number[] = [];
  for (let i = 0; i < 8; i++) {
    await wheel(pane(page, "left"), -16);
    await page.waitForTimeout(32);
    widths.push((await metrics(pane(page, "left"))).width);
  }
  expect(widths.at(-1)! - widths[0]!).toBeGreaterThan(15);
  expect(
    widths.filter((width, index) => index > 0 && width > widths[index - 1]!).length,
  ).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => (await metrics(pane(page, "left"))).scroll).toBe(0);
});
