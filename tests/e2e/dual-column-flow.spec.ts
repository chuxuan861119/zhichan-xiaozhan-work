import type { Editor } from "@tiptap/core";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { columnScrollbar } from "./helpers/column-scrollbar.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("dual-column flow styles and settings preserve the live editor and layout", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利", exact: true });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双列衔接效果验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
  await editor.evaluate((element) => {
    localStorage.setItem("patent-dual-column-intro-seen", "1");
    (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 80 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `${index + 1}. 一种装置，其特征在于：底座连接支撑杆。` }],
      })),
    });
  });
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  const layout = page.locator(".dual-column-layout");
  const flow = page.locator(".dual-column-flow");
  await expect(flow).toBeVisible();
  await expect(flow).toHaveAttribute("data-style", "graphite");
  await expect(flow).toHaveAttribute("data-mode", "boxes");
  const nativeBar = page.getByRole("scrollbar", { name: "双列文档滚动位置" });
  const barGeometry = await nativeBar.evaluate((element) => {
    const viewport = element.closest(".editor-workspace");
    if (!viewport) throw new Error("Missing viewport");
    const bar = element.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return {
      tag: element.tagName,
      overflow: getComputedStyle(element).overflowY,
      rightError: Math.abs(bar.right - bounds.right),
      topError: Math.abs(bar.top - bounds.top),
    };
  });
  expect(barGeometry).toEqual({ tag: "DIV", overflow: "scroll", rightError: 0, topError: 0 });
  expect(
    await page.locator(".dual-column-paper-background").evaluateAll((papers) =>
      papers.map((paper) => {
        const style = getComputedStyle(paper);
        return [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ];
      }),
    ),
  ).toEqual([
    ["12px", "12px", "0px", "0px"],
    ["0px", "0px", "12px", "12px"],
  ]);
  await columnScrollbar(page).fill("200");
  const baseline = await layout.evaluate((element) => {
    element.setAttribute("data-flow-test-identity", "original");
    return {
      position: (element as HTMLElement).dataset.columnPosition,
      width: element.getBoundingClientRect().width,
    };
  });
  const openSettings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "显示偏好", exact: true }).click();
    return settings;
  };
  if (!baseline.position) throw new Error("Missing initial scroll position");
  for (const style of ["classic", "slim", "ceramic", "graphite"]) {
    const settings = await openSettings();
    await settings.getByLabel("传送盒风格").selectOption(style);
    await expect(flow).toHaveAttribute("data-style", style);
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(layout).toHaveAttribute("data-flow-test-identity", "original");
    await expect(layout).toHaveAttribute("data-column-position", baseline.position);
    expect(await layout.evaluate((element) => element.getBoundingClientRect().width)).toBe(
      baseline.width,
    );
    const geometry = await flow.evaluate((element) => {
      const root = element.getBoundingClientRect();
      const boxes = [...element.querySelectorAll(".flow-box")].map((box) => {
        const rect = box.getBoundingClientRect();
        return { top: rect.top - root.top, bottom: rect.bottom - root.top };
      });
      return { height: root.height, boxes, pointerEvents: getComputedStyle(element).pointerEvents };
    });
    expect(geometry.pointerEvents).toBe("none");
    expect(geometry.boxes[0]?.top).toBeCloseTo(geometry.height - 20, 0);
    expect(geometry.boxes[0]?.bottom).toBeLessThanOrEqual(geometry.height + 0.1);
    expect(geometry.boxes[1]?.bottom).toBeLessThanOrEqual(20.1);
    await page.screenshot({ path: testInfo.outputPath(`flow-${style}.png`) });
  }
  const settings = await openSettings();
  await settings.getByLabel("双列衔接效果").selectOption("boxes");
  await expect(flow).toHaveAttribute("data-mode", "boxes");
  await expect(flow.locator("svg")).toBeHidden();
  await settings.getByLabel("双列衔接效果").selectOption("off");
  await expect(flow).toBeHidden();
  await expect(settings.getByLabel("传送盒风格")).toBeDisabled();
  await settings.getByLabel("双列衔接效果").selectOption("cable");
  await expect(flow).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  for (const [value, reverse] of [
    [400, false],
    [300, true],
  ] as const) {
    const state = await layout.evaluate((element, value) => {
      const slider = element.querySelector<HTMLElement>(".dual-column-scrollbar");
      if (!slider) throw new Error("Missing column scrollbar");
      slider.scrollTop = value;
      slider.dispatchEvent(new Event("scroll"));
      const flow = element.querySelector(".dual-column-flow");
      const currentPath = flow?.querySelector(".flow-current:not(.flow-glow)");
      if (!flow || !currentPath) throw new Error("Missing flow current");
      const current = getComputedStyle(currentPath);
      return {
        moving: flow.classList.contains("moving"),
        reverse: flow.classList.contains("backward"),
        color: current.stroke,
        animation: current.animationPlayState,
      };
    }, value);
    expect(state).toEqual({
      moving: true,
      reverse,
      color: "rgb(108, 175, 255)",
      animation: "running",
    });
  }
  await expect(flow).not.toHaveClass(/moving/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await flow
      .locator(".flow-current")
      .first()
      .evaluate((element) => getComputedStyle(element).display),
  ).toBe("none");
  await page.setViewportSize({ width: 1900, height: 850 });
  await expect(flow).toBeVisible();
  const stored = await page.evaluate(async () => {
    const result = await (window as unknown as { patentApi: PatentApi }).patentApi.settings.read();
    return result.ok ? result.value.dualColumnFlow : null;
  });
  expect(stored).toEqual({ style: "graphite", mode: "cable", margin: "dust" });
  expect(
    await editor.evaluate(
      (element) => (element as HTMLElement & { editor: Editor }).editor.getJSON().content?.length,
    ),
  ).toBe(80);
  await page.getByRole("button", { name: "双列显示", exact: true }).click();
  await expect(flow).toHaveCount(0);
});
