import type { Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { expect, test } from "./helpers/workbench.js";

async function expectSingleSelectionLayer(layout: Locator) {
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const active = (element as HTMLElement).dataset.activeColumn;
        const mirror = element.querySelector(
          `.dual-column-paper[data-side="${active === "0" ? "1" : "0"}"]`,
        );
        const rects = [...(mirror?.querySelectorAll(".dual-column-selection > span") ?? [])].map(
          (node) => node.getBoundingClientRect(),
        );
        if (rects.length < 2) return Number.POSITIVE_INFINITY;
        let overlap = 0;
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            if (!a || !b) continue;
            const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            // Fitted scales can round touching edges by ~0.01 CSS px, not a second selection.
            if (width <= 0.02 || height <= 0.02) continue;
            overlap = Math.max(overlap, width * height);
          }
        return overlap;
      }),
    )
    .toBeLessThanOrEqual(1);
  const heightError = await layout.evaluate((element) => {
    const active = (element as HTMLElement).dataset.activeColumn;
    const mirror = element.querySelector(
      `.dual-column-paper[data-side="${active === "0" ? "1" : "0"}"]`,
    );
    const paragraph = mirror?.querySelector("p");
    if (!paragraph) return Infinity;
    const zoom = Number.parseFloat(
      (element as HTMLElement).style.getPropertyValue("--column-zoom"),
    );
    const expected = Number.parseFloat(getComputedStyle(paragraph).lineHeight) * zoom;
    const heights = [...(mirror?.querySelectorAll(".dual-column-selection > span") ?? [])].map(
      (node) => node.getBoundingClientRect().height,
    );
    // Ignore the two edge-clipped lines; interior highlights must fill the line box.
    return Math.abs(Math.max(...heights) - expected);
  });
  expect(heightError).toBeLessThanOrEqual(1);
}

test("one editable document flows across two columns and keeps history when toggled", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列显示隔离验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 说明书", exact: true });
  const content = Array.from(
    { length: 70 },
    (_, i) => `第${i + 1}段：底座安装支撑杆，支撑杆连接驱动机构，用于保持工件稳定。`,
  ).join("\n");
  await editor.evaluate((element, text) => {
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: [
        "双列显示隔离验收",
        "技术领域",
        ...text.split("\n").flatMap((line, i) => {
          const chapter = (
            { 10: "背景技术", 20: "发明内容", 30: "附图说明", 40: "具体实施方式" } as Record<
              number,
              string
            >
          )[i];
          return chapter ? [chapter, line] : [line];
        }),
      ].map((line) => ({
        type: "paragraph",
        content: [{ type: "text", text: line }],
      })),
    });
  }, content);
  const before = await editor.textContent();
  await page.setViewportSize({ width: 2200, height: 1100 });
  const originalBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getBounds(),
  );
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  await expect(layout).toBeVisible();
  await expect(layout.locator("[contenteditable=true]")).toHaveCount(1);
  await expect(layout.locator(".dual-column-paper")).toHaveCount(2);
  const fixedEdgeGaps = await layout.evaluate((element) => {
    const papers = element.querySelectorAll<HTMLElement>(".dual-column-paper");
    const left = papers[0];
    const right = papers[1];
    if (!left || !right) throw new Error("Missing column papers");
    return {
      left:
        left.getBoundingClientRect().height -
        Number.parseFloat(getComputedStyle(left, "::before").bottom) -
        Number((element as HTMLElement).dataset.columnHeight),
      right:
        Number.parseFloat(getComputedStyle(right).paddingTop) -
        Number.parseFloat(getComputedStyle(right, "::before").top),
    };
  });
  expect(fixedEdgeGaps.left).toBeCloseTo(0, 0);
  expect(fixedEdgeGaps.right).toBeCloseTo(0, 0);
  await expect(
    layout.locator(":scope > .document-structure-ruler .document-structure-ruler__marker"),
  ).not.toHaveCount(0);
  await expect(editor).toHaveText(before ?? "");
  await editor.focus();
  await page.keyboard.press("Control+A");
  const initialLeft = await layout.locator('.dual-column-paper[data-side="0"]').boundingBox();
  if (!initialLeft) throw new Error("Missing left column");
  await page.mouse.move(initialLeft.x + 300, initialLeft.y + 300);
  await expect(layout).toHaveAttribute("data-active-column", "0");
  const packed = await layout.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const host = element.parentElement?.getBoundingClientRect();
    const paper = element.querySelector(":scope > .patent-page-zoom-frame") as HTMLElement;
    return {
      centerError: host ? Math.abs((bounds.left + bounds.right - host.left - host.right) / 2) : 999,
      unusedColumnWidth:
        Number.parseFloat((element as HTMLElement).style.getPropertyValue("--column-width")) -
        paper.getBoundingClientRect().width -
        84,
    };
  });
  expect(packed.centerError).toBeLessThanOrEqual(1);
  expect(Math.abs(packed.unusedColumnWidth)).toBeLessThanOrEqual(1);
  const scrollbar = columnScrollbar(page);
  await scrollbar.fill("400");
  const liveRuler = layout.locator(":scope > .document-structure-ruler");
  const hoverY = await layout.evaluate((element) => element.getBoundingClientRect().top + 220);
  const leftCenterY = await layout.evaluate(
    (element) =>
      element.getBoundingClientRect().top +
      Number((element as HTMLElement).dataset.columnHeight) / 2,
  );
  const rulerX = await layout.evaluate((element) => element.getBoundingClientRect().left + 60);
  await page.mouse.move(rulerX, hoverY);
  await expect(liveRuler).toHaveAttribute("data-navigation", "true");
  await expect
    .poll(() =>
      liveRuler
        .locator(".document-structure-ruler__panel")
        .evaluate((element) => getComputedStyle(element).position),
    )
    .toBe("absolute");
  await expect
    .poll(() =>
      liveRuler
        .locator('[data-center="true"]')
        .first()
        .evaluate(
          (element, y) =>
            Math.abs(
              element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 - y,
            ),
          leftCenterY,
        ),
    )
    .toBeLessThan(2);
  const rulerBefore = await scrollbar.inputValue();
  await liveRuler.dispatchEvent("wheel", { clientY: hoverY, clientX: 100, deltaY: 26 });
  await expect.poll(() => scrollbar.inputValue()).toBe(rulerBefore);
  await liveRuler.dispatchEvent("pointerout");
  await page.mouse.move(900, 65);
  await expect.poll(() => layout.getAttribute("data-column-position")).toBe("400");
  const edges = await layout.evaluate((element) => {
    const viewport = element.closest(".editor-workspace") as HTMLElement;
    const bounds = viewport.getBoundingClientRect();
    const paper = element.querySelector('.dual-column-paper[data-side="1"]') as HTMLElement;
    return {
      topGap: element.getBoundingClientRect().top - bounds.top,
      bottomGap: bounds.top + viewport.clientHeight - paper.getBoundingClientRect().bottom,
    };
  });
  expect(Math.abs(edges.topGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(edges.bottomGap)).toBeLessThanOrEqual(1);
  await scrollbar.fill("0");
  const start = await layout.evaluate((element) => {
    const paper = element.querySelector('.dual-column-paper[data-side="0"]') as HTMLElement;
    const source = element.querySelector(":scope > .patent-page-zoom-frame") as HTMLElement;
    return {
      paperTop: Number.parseFloat(getComputedStyle(paper, "::before").top),
      contentTop: source.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  });
  expect(start.paperTop).toBe(20);
  expect(start.contentTop).toBeCloseTo(20, 0);
  await page.screenshot({ path: "test-results/dual-column-start.png" });
  await scrollbar.fill((await scrollbar.getAttribute("max")) ?? "0");
  const endGap = await layout
    .locator('.dual-column-paper[data-side="1"]')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element, "::before").bottom));
  expect(endGap).toBe(20);
  await page.screenshot({ path: "test-results/dual-column-end.png" });
  await scrollbar.fill("400");
  const check = await layout.evaluate((element) => {
    const source = element.querySelector(":scope > .patent-page-zoom-frame") as HTMLElement;
    const mirror = element.querySelector(
      '.dual-column-paper[data-side="1"] .patent-page-zoom-frame',
    ) as HTMLElement;
    const height = Number((element as HTMLElement).dataset.columnHeight);
    return {
      offsetDifference: source.getBoundingClientRect().top - mirror.getBoundingClientRect().top,
      height,
      sameText: source.textContent === mirror.textContent,
      overflow: element.scrollWidth > element.clientWidth + 2,
    };
  });
  expect(check.sameText).toBe(true);
  expect(check.overflow).toBe(false);
  expect(check.offsetDifference).toBeCloseTo(check.height - 20, 0);
  await expectSingleSelectionLayer(layout);
  await page.screenshot({ path: "test-results/dual-column-middle.png" });
  const right = await layout.locator('.dual-column-paper[data-side="1"]').boundingBox();
  if (!right) throw new Error("Missing right column");
  await page.mouse.move(right.x + right.width * 0.6, right.y + 130);
  await expectSingleSelectionLayer(layout);
  await page.mouse.click(right.x + right.width * 0.6, right.y + 130);
  await expect(layout).toHaveAttribute("data-active-column", "1");
  const rightHoverY = await layout.evaluate((element) => element.getBoundingClientRect().top + 300);
  const rightCenterY = await layout.evaluate(
    (element) =>
      element.getBoundingClientRect().top +
      20 +
      Number((element as HTMLElement).dataset.columnHeight) / 2,
  );
  await liveRuler.dispatchEvent("pointerover", { clientY: rightHoverY });
  await expect
    .poll(() =>
      liveRuler
        .locator('[data-center="true"]')
        .first()
        .evaluate(
          (element, y) =>
            Math.abs(
              element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 - y,
            ),
          rightCenterY,
        ),
    )
    .toBeLessThan(2);
  await expect(layout.locator('.dual-column-copy [data-navigation="true"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/dual-column-ruler-hover.png" });
  await liveRuler.dispatchEvent("pointerout");
  await editor.dispatchEvent("compositionstart", { data: "中" });
  const left = await layout.locator('.dual-column-paper[data-side="0"]').boundingBox();
  if (!left) throw new Error("Missing left column");
  await page.mouse.move(left.x + left.width * 0.6, left.y + 160);
  await expect(layout).toHaveAttribute("data-active-column", "1");
  await editor.dispatchEvent("compositionend", { data: "中" });
  await page.keyboard.insertText("右列编辑验收");
  await expect(editor).toContainText("右列编辑验收");
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText(before ?? "");
  await page.keyboard.press("Control+y");
  await expect(editor).toContainText("右列编辑验收");
  await page.keyboard.press("Control+End");
  await expect(layout).toHaveAttribute("data-active-column", "1");
  await expect
    .poll(async () => {
      const value = await scrollbar.inputValue();
      return Math.abs(Number(value) - Number(await scrollbar.getAttribute("max")));
    })
    .toBeLessThan(1);
  await page.keyboard.press("Control+Home");
  await expect(layout).toHaveAttribute("data-active-column", "0");
  await expect.poll(() => scrollbar.inputValue()).toBe("0");
  const rulerTarget = layout
    .locator(":scope > .document-structure-ruler button")
    .filter({ hasText: "具体实施方式" })
    .first();
  // The real ruler command must route its ordinary scroll request into column flow.
  // Drive animation frames deterministically without exposing the hidden native window.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const scrollSamples = [Number(await layout.getAttribute("data-column-position"))];
  await rulerTarget.dispatchEvent("click");
  for (let frame = 0; frame < 25; frame++) {
    await page.clock.runFor(16);
    scrollSamples.push(Number(await layout.getAttribute("data-column-position")));
  }
  expect(new Set(scrollSamples.map((value) => Math.round(value))).size).toBeGreaterThan(3);
  await page.clock.resume();
  await expect
    .poll(() => layout.evaluate((element) => element.closest(".editor-workspace")?.scrollTop))
    .toBe(0);
  await page.screenshot({ path: "test-results/dual-column-ruler.png" });
  const paperWidth = await layout
    .locator(":scope > .patent-page-zoom-frame")
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("contentinfo").getByRole("button", { name: "放大", exact: true }).click();
  await expect
    .poll(() =>
      layout
        .locator(":scope > .patent-page-zoom-frame")
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(paperWidth * 1.08);
  await expect
    .poll(() => layout.evaluate((element) => element.closest(".editor-workspace")?.scrollTop))
    .toBe(0);
  await page
    .getByRole("contentinfo")
    .getByRole("button", { name: /缩放.*点击重置/ })
    .click();
  await expect
    .poll(() =>
      layout
        .locator(":scope > .patent-page-zoom-frame")
        .evaluate(
          (element, width) => Math.abs(element.getBoundingClientRect().width - width),
          paperWidth,
        ),
    )
    .toBeLessThan(1);
  await page.setViewportSize({ width: 1900, height: 1000 });
  await expect
    .poll(() => layout.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(1900);
  // Initial fit reserves expanded controls; manually zoom to test compact controls.
  for (let step = 0; step < 20; step++) await page.keyboard.press("Control+=");
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "放大", exact: true }),
  ).toBeDisabled();
  const railSlot = layout.locator(":scope > .patent-global-function-rail-slot");
  await expect(railSlot).toHaveAttribute("data-layout", "overlay");
  await expect(railSlot).toHaveAttribute("data-expanded", "false");
  await expect(layout.locator(":scope > .document-structure-ruler")).toHaveAttribute(
    "data-mode",
    "compact",
  );
  await expect(
    layout.locator(".dual-column-copy .document-structure-ruler").first(),
  ).toHaveAttribute("data-mode", "compact");
  await page.screenshot({ path: "test-results/dual-column-compact.png" });
  const edgeToggle = page.locator(".dual-column-edge-toggle");
  await expect(edgeToggle).toBeVisible();
  const edgeGap = await edgeToggle.evaluate((element) =>
    Math.abs(
      element.getBoundingClientRect().right -
        (element.closest(".patent-function-rail-edge-host")?.getBoundingClientRect().right ??
          Number.NaN),
    ),
  );
  expect(edgeGap).toBeLessThanOrEqual(1);
  await edgeToggle.getByRole("button", { name: "展开功能栏", exact: true }).click();
  await expect(railSlot).toHaveAttribute("data-expanded", "true");
  await expect(edgeToggle).toBeVisible();
  expect(
    await edgeToggle.evaluate((element) =>
      Math.abs(
        element.getBoundingClientRect().right -
          (element.closest(".patent-function-rail-edge-host")?.getBoundingClientRect().right ??
            Number.NaN),
      ),
    ),
  ).toBeLessThanOrEqual(1);
  const panelCheck = await railSlot.evaluate((element) => {
    const panel = element.querySelector(".patent-global-function-rail") as HTMLElement;
    const layout = element.closest(".dual-column-layout") as HTMLElement;
    const rect = panel.getBoundingClientRect();
    const before = layout.dataset.columnPosition;
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 50,
      clientY: rect.top + 100,
      deltaY: 100,
    });
    panel.dispatchEvent(wheel);
    return {
      before,
      after: layout.dataset.columnPosition,
      prevented: wheel.defaultPrevented,
      topGap: rect.top - layout.getBoundingClientRect().top,
    };
  });
  expect(panelCheck.after).toBe(panelCheck.before);
  expect(panelCheck.prevented).toBe(false);
  expect(panelCheck.topGap).toBeGreaterThanOrEqual(19);
  await railSlot.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await expect(railSlot).toHaveAttribute("data-expanded", "false");
  for (let step = 0; step < 25; step++) await page.keyboard.press("Control+=");
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "放大", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const viewport = element.closest(".editor-workspace") as HTMLElement;
        return viewport.scrollWidth - viewport.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  await expect(edgeToggle).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect
    .poll(() =>
      layout.evaluate((element) => {
        const viewport = element.closest(".editor-workspace") as HTMLElement;
        return viewport.scrollWidth - viewport.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(layout).toHaveCount(0);
  await expect
    .poll(async () => {
      const restored = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBounds(),
      );
      if (!restored || !originalBounds) return Infinity;
      // Windows rounds native frame sizes at fractional display scaling.
      return Math.max(
        ...(["x", "y", "width", "height"] as const).map((key) =>
          Math.abs(restored[key] - originalBounds[key]),
        ),
      );
    })
    .toBeLessThanOrEqual(1);
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText(before ?? "");
  await page.keyboard.insertText("保存恢复验收");
  const savedText = await editor.textContent();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("contentinfo").getByRole("status", { name: "已保存" })).toBeVisible();
  await page.getByRole("button", { name: "关闭双列显示隔离验收", exact: true }).click();
  const card = page.getByRole("article", { name: "双列显示隔离验收" });
  await card.getByRole("button", { name: "更多操作" }).click();
  await card.getByRole("menuitem", { name: "继续编辑" }).click();
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect(editor).toHaveText(savedText ?? "");
  expect(errors).toEqual([]);
});
