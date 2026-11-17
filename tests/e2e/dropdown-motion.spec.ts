import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

type MotionModule = {
  createDropdownMotion(): {
    update(element: HTMLElement | undefined, open: boolean): void;
    dispose(): void;
  };
  findDropdownSurface(presence: HTMLElement | null): HTMLElement | undefined;
};
type MotionWindow = Window & { DropdownMotion: MotionModule };

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test.beforeEach(async ({ page }) => {
  await page.setContent("<body></body>");
  for (const file of [
    "app/app.css",
    "editor/ui/toolbar-dropdowns.css",
    "exports/print-center.css",
    "patents/function-rail/function-rail-select.css",
    "drawing-markup/drawing-workspace.css",
    "shared/dropdown-motion.css",
  ])
    await page.addStyleTag({
      content: readFileSync(resolve("src/renderer/src", file), "utf8"),
    });
  const bundle = await build({
    entryPoints: [resolve("src/renderer/src/shared/dropdown-motion.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "DropdownMotion",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" });
});

test("all retained menu surfaces reveal downwards, fold upwards and leave nested menus unclipped", async ({
  page,
}) => {
  for (const name of [
    "file-menu",
    "toolbar-import-menu",
    "toolbar-export-menu",
    "toolbar-overflow-menu",
    "patent-card-menu-panel",
    "library-import-menu__panel",
    "template-catalog-card__overflow-menu",
    "patent-tabs__overflow-menu",
    "patent-split-controls__menu",
    "legislation-more__menu",
    "color-palette",
    "insert-table-popover",
    "dual-document-pane__switcher-popover",
    "claims-description-menu",
    "editor-color-picker__palette",
    "flowchart-project-menu",
  ]) {
    const result = await page.evaluate((name) => {
      const { createDropdownMotion, findDropdownSurface } = (window as unknown as MotionWindow)
        .DropdownMotion;
      const wrapper = document.createElement("div");
      wrapper.className = "spatial-presence";
      wrapper.dataset.motion = "enter";
      const menu = document.createElement("div");
      menu.className = name;
      if (
        ![
          "color-palette",
          "insert-table-popover",
          "dual-document-pane__switcher-popover",
          "claims-description-menu",
          "editor-color-picker__palette",
        ].includes(name)
      )
        menu.role = "menu";
      menu.style.cssText =
        "position:fixed;left:180px;top:60px;width:240px;height:200px;margin:0;padding:0;z-index:20000;background:white";
      menu.innerHTML =
        '<button style="position:absolute;left:260px;top:0;width:100px;height:40px">二级菜单</button>';
      if (name === "flowchart-project-menu") {
        const layer = document.createElement("div");
        layer.className = "flowchart-project-menu-layer";
        layer.append(menu);
        wrapper.append(layer);
      } else wrapper.append(menu);
      document.body.append(wrapper);
      const motion = createDropdownMotion();
      motion.update(findDropdownSurface(wrapper), true);
      const enter = menu.getAnimations()[0];
      if (!enter) throw new Error(`no entering animation: ${name}`);
      const timing = enter.effect?.getTiming();
      enter.pause();
      enter.currentTime = 130;
      const bounds = menu.getBoundingClientRect();
      const hit = (offset: number) =>
        menu.contains(document.elementFromPoint(bounds.left + 20, bounds.top + offset));
      const middle = {
        top: hit(20),
        bottom: hit(180),
        transform: getComputedStyle(menu).transform,
      };
      enter.finish();
      const rest = getComputedStyle(menu).clipPath;
      const nested = menu.querySelector("button");
      const nestedBounds = nested?.getBoundingClientRect();
      const nestedVisible = nestedBounds
        ? document.elementFromPoint(nestedBounds.left + 10, nestedBounds.top + 10) === nested
        : false;
      wrapper.dataset.motion = "exit";
      motion.update(menu, false);
      const exit = menu.getAnimations()[0];
      if (!exit) throw new Error("no exit animation");
      exit.pause();
      exit.currentTime = 130;
      const exitPointerEvents = getComputedStyle(menu).pointerEvents;
      // Probe paint hit-testing without the deliberate interaction lock masking it.
      menu.style.pointerEvents = "auto";
      const reverse = { top: hit(20), bottom: hit(180) };
      menu.style.removeProperty("pointer-events");
      const interrupted = {
        clip: getComputedStyle(menu).clipPath,
        opacity: getComputedStyle(menu).opacity,
      };
      wrapper.dataset.motion = "enter";
      motion.update(menu, true);
      const reopened = menu.getAnimations()[0];
      if (!reopened) throw new Error("no reopening animation");
      reopened.pause();
      reopened.currentTime = 0;
      const resumed = {
        clip: getComputedStyle(menu).clipPath,
        opacity: getComputedStyle(menu).opacity,
      };
      reopened.finish();
      wrapper.dataset.motion = "exit";
      motion.update(menu, false);
      menu.getAnimations()[0]?.finish();
      const closed = Number(getComputedStyle(menu).opacity);
      motion.dispose();
      wrapper.remove();
      return {
        timing,
        middle,
        rest,
        nestedVisible,
        reverse,
        exitPointerEvents,
        interrupted,
        resumed,
        closed,
      };
    }, name);
    expect(result.timing?.duration, name).toBe(260);
    expect(result.timing?.easing, name).toBe("ease-in-out");
    expect(result.middle.top, name).toBe(true);
    expect(result.middle.bottom, name).toBe(false);
    expect(result.middle.transform, name).toBe(
      name === "dual-document-pane__switcher-popover" ? "matrix(1, 0, 0, 1, -120, 0)" : "none",
    );
    expect(result.rest, name).toBe("none");
    if (name === "file-menu") expect(result.nestedVisible, name).toBe(true);
    expect(result.reverse, name).toEqual({ top: true, bottom: false });
    expect(result.exitPointerEvents, name).toBe("none");
    expect(result.resumed, name).toEqual(result.interrupted);
    expect(result.closed, name).toBe(0);
  }
});

test("native option lists retain reverse animation on close and keep keyboard selection", async ({
  page,
}) => {
  await page.locator("body").evaluate((body) => {
    body.innerHTML = `<div class="print-center-dialog" style="margin:40px"><select aria-label="纸张"><option>A3</option><option>A4</option><option>A5</option></select></div>
      <div class="library-view" style="margin:40px"><select aria-label="排序"><option>最近编辑</option><option>名称</option><option>创建时间</option></select></div>`;
  });
  for (const label of ["纸张", "排序"]) {
    const select = page.getByRole("combobox", { name: label });
    await select.click();
    // Chromium's internal picker transitions are not exposed by getAnimations().
    await page.waitForTimeout(160);
    const middle = await select.evaluate(
      (element) => getComputedStyle(element, "::picker(select)").clipPath,
    );
    expect(middle).toContain("calc(");
    await expect
      .poll(() =>
        select.evaluate((element) => getComputedStyle(element, "::picker(select)").clipPath),
      )
      .toBe("inset(-32px)");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(160);
    const exited = await select.evaluate((element) => {
      const style = getComputedStyle(element, "::picker(select)");
      return {
        clip: style.clipPath,
        display: style.display,
        pointerEvents: style.pointerEvents,
        duration: style.transitionDuration,
      };
    });
    expect(exited.duration).toContain("0.26s");
    expect(exited.clip).toContain("calc(");
    expect(exited.display).not.toBe("none");
    expect(exited.pointerEvents).toBe("none");
    await expect
      .poll(() =>
        select.evaluate((element) => getComputedStyle(element, "::picker(select)").display),
      )
      .toBe("none");
    await select.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await select.inputValue()).toBe(label === "纸张" ? "A4" : "名称");
  }
});

test("reduced motion bypasses reveal and non-menu popovers retain their own motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await page.evaluate(() => {
    const { createDropdownMotion, findDropdownSurface } = (window as unknown as MotionWindow)
      .DropdownMotion;
    const presence = document.createElement("div");
    presence.className = "spatial-presence";
    presence.innerHTML = '<div role="menu">菜单</div><select><option>选项</option></select>';
    document.body.append(presence);
    const motion = createDropdownMotion();
    const menu = findDropdownSurface(presence);
    if (!menu) throw new Error("menu missing");
    motion.update(menu, true);
    const count = menu.getAnimations().length;
    const duration = getComputedStyle(
      presence.querySelector("select") as HTMLElement,
      "::picker(select)",
    ).transitionDuration;
    presence.innerHTML = '<nav class="ruler-navigation-popover">导航</nav>';
    const nonMenu = findDropdownSurface(presence);
    motion.dispose();
    presence.remove();
    return { count, duration, nonMenu: !!nonMenu };
  });
  expect(result).toEqual({ count: 0, duration: "0s", nonMenu: false });
});

test("drawing dropdown disclosures keep their panel visible throughout reverse closing", async ({
  page,
}) => {
  await page.locator("body").evaluate((body) => {
    body.innerHTML =
      '<details class="spatial-disclosure drawing-more" style="position:relative;margin:40px;width:200px"><summary>更多</summary><div class="drawing-style-popover">附图设置</div></details>';
    const panel = body.querySelector(".drawing-style-popover");
    if (panel) getComputedStyle(panel).clipPath;
  });
  await page.locator("summary").click();
  const panel = page.locator(".drawing-style-popover");
  await expect
    .poll(() => panel.evaluate((element) => getComputedStyle(element).clipPath))
    .toBe("inset(-32px)");
  await page.locator("summary").click();
  const result = await panel.evaluate((element) => {
    const animations = element.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 130;
    }
    const middle = getComputedStyle(element);
    const parent = getComputedStyle(element.parentElement as HTMLElement, "::details-content");
    return {
      count: animations.length,
      clip: middle.clipPath,
      opacity: Number(middle.opacity),
      pointerEvents: middle.pointerEvents,
      overflow: parent.overflow,
      contentVisibility: parent.contentVisibility,
    };
  });
  expect(result.count).toBe(2);
  expect(result.clip).toContain("calc(");
  expect(result.opacity).toBeCloseTo(0.5);
  expect(result.pointerEvents).toBe("none");
  expect(result.overflow).toBe("visible");
  expect(result.contentVisibility).toBe("visible");
});
