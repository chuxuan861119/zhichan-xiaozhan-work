import type { Locator, Page } from "@playwright/test";
import {
  choosePaneBook,
  enterDualView,
  expect,
  selectDualPane,
  test,
} from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
}

async function createPatent(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function renderedWidth(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  return box?.width ?? 0;
}

/** 等宽度稳定下来再取基准值，避开打开文档时的适应窗口动画。 */
async function stableWidth(page: Page, locator: Locator): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const width = await renderedWidth(locator);
    if (width > 0 && Math.abs(width - previous) < 1) return width;
    previous = width;
    await page.waitForTimeout(50);
  }
  throw new Error("文档页宽度没有稳定下来");
}

/** 每次都重新取中线当前位置：拖动之后它已经不在原来的 x 上了。 */
async function dragDivider(page: Page, divider: Locator, deltaX: number): Promise<void> {
  const box = await divider.boundingBox();
  if (!box) throw new Error("无法定位双屏中线");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 12 });
  await page.mouse.up();
}

test("continuous splitter movement tracks the pointer without reversing page scale", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 2560, height: 1000 });
  await dismissWelcome(page);
  await createPatent(page, "连续拖动验收");
  await enterDualView(page);
  await choosePaneBook(page, "right", "连续拖动验收", "说明书");
  await stableWidth(page, page.locator('[data-pane="left"] .patent-page-zoom-frame'));
  const divider = page.locator(".dual-document-divider");
  const box = await divider.boundingBox();
  if (!box) throw new Error("Missing splitter");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    let previous: { left: number; right: number } | undefined;
    const outward = Array.from({ length: 61 }, (_, index) => index * 7);
    const returning = outward.slice(4, -1).reverse();
    let previousDelta = 0;
    for (const delta of [...outward, ...returning]) {
      await page.mouse.move(x + delta, y);
      const sample = await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const width = (side: string) => {
          const paper = document.querySelector(`[data-pane="${side}"] .patent-page-zoom-frame`);
          if (!paper) throw new Error("Missing page");
          return paper.getBoundingClientRect().width;
        };
        const splitter = document.querySelector(".dual-document-divider");
        if (!splitter) throw new Error("Missing splitter");
        const rect = splitter.getBoundingClientRect();
        return { left: width("left"), right: width("right"), divider: rect.x + rect.width / 2 };
      });
      expect(Math.abs(sample.divider - (x + delta))).toBeLessThan(1);
      if (previous) {
        const direction = Math.sign(delta - previousDelta);
        expect((sample.left - previous.left) * direction).toBeGreaterThanOrEqual(-1);
        expect(Math.abs(sample.left - previous.left)).toBeLessThan(10);
        expect((sample.right - previous.right) * direction).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.right - previous.right)).toBeLessThan(10);
      }
      previous = sample;
      previousDelta = delta;
    }
  } finally {
    await page.mouse.up();
  }
});

test("dragging the midline preserves manual zoom until its pane cap and stops at readable widths", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dismissWelcome(page);
  await createPatent(page, "中线拖动验收");
  await enterDualView(page);
  await choosePaneBook(page, "right", "中线拖动验收", "说明书");
  await page.setViewportSize({ width: 1400, height: 1000 });

  const workspace = page.getByRole("region", { name: "同屏双文档工作区" });
  const divider = workspace.locator(".dual-document-divider");
  const leftPage = page
    .getByRole("region", { name: "左侧文档", exact: true })
    .locator(".patent-page-zoom-frame");
  const rightPage = page
    .getByRole("region", { name: "右侧文档", exact: true })
    .locator(".patent-page-zoom-frame");

  // 命中区是真实的一格，视觉上的细线靠 ::after 画在里面。
  await expect.poll(() => renderedWidth(divider)).toBeGreaterThanOrEqual(15);

  // 手动放大到每侧适宽上限。
  for (const side of ["left", "right"] as const) {
    await selectDualPane(page, side);
    for (let step = 0; step < 20; step += 1) await page.keyboard.press("Control+=");
  }
  const leftBefore = await stableWidth(page, leftPage);
  const rightBefore = await stableWidth(page, rightPage);
  expect(leftBefore).toBeGreaterThan(0);
  expect(rightBefore).toBeGreaterThan(0);

  const verifyFit = async () => {
    for (const side of ["left", "right"] as const) {
      const state = await workspace.locator(`[data-pane="${side}"]`).evaluate((pane) => {
        const viewport = pane.querySelector<HTMLElement>(".editor-workspace")!;
        const paper = viewport.querySelector<HTMLElement>(".patent-page-zoom-frame")!;
        return {
          overflow: viewport.scrollWidth - viewport.clientWidth,
          paint: (paper.getBoundingClientRect().width / paper.offsetWidth) * 100,
          stored: Number((pane as HTMLElement).dataset.dualZoom),
          scroll: viewport.scrollTop,
        };
      });
      expect(state.overflow).toBeLessThanOrEqual(1);
      expect(Math.abs(state.paint - state.stored)).toBeLessThan(0.08);
      expect(state.scroll).toBe(0);
    }
  };
  // 极限左移：只有窄侧被限宽；宽侧保留手动比例。
  await dragDivider(page, divider, -380);
  for (const side of ["left", "right"] as const) {
    const pane = workspace.locator(`[data-pane="${side}"]`);
    expect(await renderedWidth(pane)).toBeGreaterThanOrEqual(527);
  }
  await expect.poll(() => renderedWidth(rightPage)).toBeCloseTo(rightBefore, 0);
  await expect.poll(() => renderedWidth(leftPage)).toBeLessThan(leftBefore);
  await verifyFit();
  const leftAfterClamp = await stableWidth(page, leftPage);

  // 极限右移：已选比例不因变宽而自动增大，另一侧只在不再容纳时缩小。
  await dragDivider(page, divider, 760);
  await expect.poll(() => renderedWidth(rightPage)).toBeLessThan(rightBefore);
  await expect.poll(() => renderedWidth(leftPage)).toBeCloseTo(leftAfterClamp, 0);
  await verifyFit();
  const rightAfterClamp = await stableWidth(page, rightPage);

  // 双击恢复等宽，不更改两侧缩放。
  await divider.dblclick();
  await expect
    .poll(async () => Math.abs((await renderedWidth(rightPage)) - rightAfterClamp))
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => Math.abs((await renderedWidth(leftPage)) - leftAfterClamp))
    .toBeLessThanOrEqual(2);
  await verifyFit();
});

test("controls collapse in the narrow pane while the splitter is still being dragged", async ({
  workbench,
}) => {
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 2560, height: 1000 });
  await dismissWelcome(page);
  await createPatent(page, "拖动过程联动验收");
  await enterDualView(page);
  await choosePaneBook(page, "right", "拖动过程联动验收", "说明书");
  for (const side of ["left", "right"] as const) {
    await selectDualPane(page, side);
    for (let step = 0; step < 20; step += 1) await page.keyboard.press("Control+-");
  }
  const left = page.getByRole("region", { name: "左侧文档", exact: true });
  const right = page.getByRole("region", { name: "右侧文档", exact: true });
  await expect(left.locator(".patent-global-function-rail-slot")).toHaveAttribute(
    "data-layout",
    "docked",
  );
  await expect(left.locator(".document-structure-ruler")).toHaveAttribute("data-mode", "wide");
  const divider = page.locator(".dual-document-divider");
  const box = await divider.boundingBox();
  if (!box) throw Error("Missing splitter");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x - 850, y, { steps: 12 });
    await expect(page.locator(".dual-document-workspace")).toHaveAttribute(
      "data-split-resizing",
      "true",
    );
    await expect(left.locator(".patent-global-function-rail-slot")).toHaveAttribute(
      "data-expanded",
      "false",
    );
    await expect(left.locator(".document-structure-ruler")).toHaveAttribute("data-mode", "compact");
    await expect(right.locator(".patent-global-function-rail-slot")).toHaveAttribute(
      "data-layout",
      "docked",
    );
    expect(
      await left
        .locator(".editor-workspace")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  } finally {
    await page.mouse.up();
  }
});
