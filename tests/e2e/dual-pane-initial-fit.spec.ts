import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { choosePaneBook, enterDualView, expect, test } from "./helpers/workbench.js";

test("initial dual view uses the real rail footprint and fills each page viewport", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双显首次适宽验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await enterDualView(page);
  await choosePaneBook(page, "right", "双显首次适宽验收", "说明书");
  await page.setViewportSize({ width: 1746, height: 998 });
  const metrics = () =>
    page.locator(".dual-document-pane").evaluateAll((panes) =>
      panes.map((pane) => {
        const viewport = pane.querySelector<HTMLElement>(".patent-editor-workspace");
        const layout = viewport?.querySelector<HTMLElement>(".patent-page-with-rail");
        const frame = layout?.querySelector<HTMLElement>(".patent-page-zoom-frame");
        if (!viewport || !layout || !frame) throw new Error("Missing page");
        const style = getComputedStyle(viewport);
        const columns = getComputedStyle(layout).gridTemplateColumns.split(" ").map(parseFloat);
        const available =
          viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return {
          pane: pane.getBoundingClientRect().width,
          available,
          columns,
          page: frame.getBoundingClientRect().width,
          scale: frame.getBoundingClientRect().width / frame.offsetWidth,
          rail: pane
            .querySelector(".patent-global-function-rail-slot")
            ?.getAttribute("data-layout"),
          expanded: pane
            .querySelector(".patent-global-function-rail-slot")
            ?.getAttribute("data-expanded"),
          reserved: getComputedStyle(layout).getPropertyValue(
            "--patent-function-rail-reserved-width",
          ),
          layouts: [...viewport.querySelectorAll(".patent-page-with-rail")].map((l) => ({
            hidden: Boolean(l.closest("[hidden]")),
            zoom: (l as HTMLElement).style.getPropertyValue("--patent-page-zoom"),
            reserved: getComputedStyle(l).getPropertyValue("--patent-function-rail-reserved-width"),
          })),
          spare:
            available - (columns[0] ?? 0) - (columns[2] ?? 0) - frame.getBoundingClientRect().width,
        };
      }),
    );

  const divider = page.locator(".dual-document-divider");
  await expect
    .poll(async () =>
      (await metrics()).every(
        (m) => m.expanded === "false" && m.rail === "overlay" && (m.columns[0] ?? Infinity) <= 28,
      ),
    )
    .toBe(true);
  await expect.poll(async () => (await metrics()).every((m) => m.scale > 0.93)).toBe(true);
  await expect(page.locator('.document-structure-ruler[data-mode="wide"]:visible')).toHaveCount(0);
  await divider.press("ArrowLeft");
  await divider.press("Shift+ArrowLeft");
  await divider.press("Shift+ArrowLeft");
  const left = page.locator('.dual-document-pane[data-pane="left"]');
  await expect(left.getByRole("button", { name: "展开功能栏", exact: true })).toBeVisible();
  await left.getByRole("button", { name: "展开功能栏", exact: true }).click();
  await left.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await page.mouse.move(10, 10);
  await divider.press("Home");
  await page.waitForTimeout(1200);
  console.log("DUAL_COLLAPSED_METRICS", JSON.stringify(await metrics()));
  await expect.poll(async () => (await metrics()).at(0)?.scale).toBeGreaterThan(0.85);
  await expect
    .poll(async () => Math.max(...(await metrics()).map((m) => Math.abs(m.spare))))
    .toBeLessThan(9);

  // Hovered and pinned overlays keep the same page geometry.
  const width = (await metrics()).at(0)?.page ?? 0;
  await left.getByRole("button", { name: "展开功能栏", exact: true }).click();
  await expect(left.getByRole("button", { name: "收起功能栏", exact: true })).toBeVisible();
  await left.getByRole("button", { name: "固定", exact: true }).click();
  expect(Math.abs(((await metrics()).at(0)?.page ?? 0) - width)).toBeLessThan(2);
  await left.getByRole("button", { name: "收起功能栏", exact: true }).click();
  await page.mouse.move(10, 10);
  await expect
    .poll(async () => Math.abs(((await metrics()).at(0)?.page ?? 0) - width))
    .toBeLessThan(2);
  await page.screenshot({ path: "test-results/dual-pane-initial-fit.png" });
  // More logical pixels must not expand controls on a physically small or unknown screen.
  await page.setViewportSize({ width: 2560, height: 1440 });
  const hardware = await page.evaluate(async () => {
    const result = await (
      window as unknown as { patentApi: PatentApi }
    ).patentApi.application.getWindowLayoutState();
    return result.ok ? result.value.displayWidthMm : null;
  });
  console.log("PHYSICAL_DISPLAY_WIDTH_MM", hardware);
  await expect
    .poll(async () => (await metrics()).at(1)?.rail)
    .toBe(hardware != null && hardware >= 500 ? "docked" : "overlay");
  await page.setViewportSize({ width: 1746, height: 998 });
  await expect
    .poll(async () =>
      (await metrics()).every(
        (m) => m.rail === "overlay" && m.expanded === "false" && (m.columns[0] ?? Infinity) <= 28,
      ),
    )
    .toBe(true);
});

test("dual entry paints the fitted page without zooming from a narrow page and keeps the top", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双显无跳变验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const samples: { width: number; scroll: number }[] = [];
    (window as unknown as { dualSamples: typeof samples }).dualSamples = samples;
    const until = performance.now() + 1800;
    const sample = () => {
      const viewport = document.querySelector<HTMLElement>(
        '.dual-document-pane[data-pane="left"] .patent-editor-workspace',
      );
      const frame = viewport?.querySelector<HTMLElement>(".patent-page-zoom-frame");
      if (viewport && frame)
        samples.push({
          width: frame.getBoundingClientRect().width,
          scroll: viewport.scrollTop,
        });
      if (performance.now() < until) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await enterDualView(page);
  await page.waitForTimeout(1900);
  const samples = await page.evaluate(
    () => (window as unknown as { dualSamples: { width: number; scroll: number }[] }).dualSamples,
  );
  console.log("DUAL_ENTRY_FRAMES", JSON.stringify([samples[0], samples.at(-1)]));
  expect(samples.length).toBeGreaterThan(3);
  expect(
    Math.max(...samples.map((s) => s.width)) - Math.min(...samples.map((s) => s.width)),
  ).toBeLessThan(2);
  expect(Math.max(...samples.map((s) => s.scroll))).toBeLessThan(2);
});

test("each dual document restores its own reading coordinate after fitting", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const app = await workbench.launchAllowMultipleInstances();
  const page = await app.firstWindow();
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill("双显阅读位置验收");
  await dialog.getByRole("radio", { name: "发明", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  const coordinate = (selector: string, scroll?: number) =>
    page.locator(selector).evaluate((viewport, value) => {
      const frame = viewport.querySelector<HTMLElement>(".patent-page-zoom-frame");
      const layout = frame?.parentElement;
      if (!frame || !layout) throw new Error("Missing book page");
      if (value !== undefined) {
        viewport.scrollTop = value;
        viewport.dispatchEvent(new Event("scroll"));
      }
      const origin =
        frame.getBoundingClientRect().top +
        viewport.scrollTop -
        viewport.getBoundingClientRect().top;
      const scale = Number.parseFloat(
        getComputedStyle(layout).getPropertyValue("--patent-page-zoom"),
      );
      return { coordinate: (viewport.scrollTop - origin) / scale, scroll: viewport.scrollTop };
    }, scroll);
  const single = ".patent-editor-workspace:visible";
  await page
    .locator(".patent-prosemirror[contenteditable=true]:visible")
    .first()
    .fill(
      Array.from(
        { length: 90 },
        (_, i) => `${i + 1}. 阅读位置测试文本，保留每份文档的独立位置。`,
      ).join("\n"),
    );
  await page.waitForTimeout(500);
  const claims = await coordinate(single, 1200);
  expect(claims.scroll).toBeGreaterThan(1000);
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await page
    .locator(".patent-prosemirror[contenteditable=true]:visible")
    .first()
    .fill(Array.from({ length: 90 }, (_, i) => `说明书第${i + 1}段，阅读位置测试。`).join("\n"));
  await page.waitForTimeout(500);
  const description = await coordinate(single, 900);
  await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
  await page.waitForTimeout(500);
  await enterDualView(page);
  await choosePaneBook(page, "right", "双显阅读位置验收", "说明书");
  await page.waitForTimeout(700);
  const left = await coordinate('.dual-document-pane[data-pane="left"] .patent-editor-workspace');
  const right = await coordinate('.dual-document-pane[data-pane="right"] .patent-editor-workspace');
  console.log("DUAL_READING_COORDINATES", JSON.stringify({ claims, description, left, right }));
  expect(Math.abs(left.coordinate - claims.coordinate)).toBeLessThan(4);
  expect(Math.abs(right.coordinate - description.coordinate)).toBeLessThan(4);
  await page.getByRole("button", { name: "同屏双显", exact: true }).click();
  await page.waitForTimeout(600);
  const returned = await coordinate(single);
  expect(Math.abs(returned.coordinate - description.coordinate)).toBeLessThan(4);
});
