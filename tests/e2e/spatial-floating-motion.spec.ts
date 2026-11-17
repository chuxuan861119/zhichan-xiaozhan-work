import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: process.platform === "darwin" ? "chrome" : "msedge", headless: true });

test("image controls fade out with shared timing and respect reduced motion", async ({ page }) => {
  await page.setContent(
    '<div class="image-selection-frame"><button class="image-selection-frame__resize" data-motion="enter">缩放</button></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/editor/editor.css", "utf8") });
  const result = await page.locator("button").evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
    (element as HTMLElement).dataset.motion = "exit";
    getComputedStyle(element).opacity;
    const animations = element.getAnimations();
    const timings = animations.map((animation) => animation.effect?.getTiming());
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = Number(getComputedStyle(element).opacity);
    for (const animation of animations) animation.finish();
    return {
      timings,
      middle,
      end: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
    };
  });
  expect(result.timings.length).toBeGreaterThan(0);
  expect(
    result.timings.every((timing) => timing?.duration === 400 && timing.easing === "ease-in-out"),
  ).toBe(true);
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(1);
  expect(result.end).toBe(0);
  expect(result.pointerEvents).toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator("button")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
});

test("ruler navigation and menus fade in and out with shared timing", async ({ page }) => {
  await page.setContent(
    '<div class="spatial-presence" data-motion="enter"><nav class="ruler-navigation-popover" style="left:40px;top:40px;width:200px;height:120px">导航</nav></div>',
  );
  for (const file of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/patents/ruler-navigation-popover.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const result = await page.locator("nav").evaluate((el) => {
    for (const a of el.getAnimations()) a.finish();
    if (!el.parentElement) throw new Error("presence wrapper missing");
    el.parentElement.dataset.motion = "exit";
    getComputedStyle(el).opacity;
    const animations = el.getAnimations();
    const timings = animations.map((a) => a.effect?.getTiming());
    for (const a of animations) {
      a.pause();
      a.currentTime = 200;
    }
    const middle = Number(getComputedStyle(el).opacity);
    for (const a of animations) a.finish();
    const closed = Number(getComputedStyle(el).opacity);
    el.parentElement.dataset.motion = "enter";
    getComputedStyle(el).opacity;
    for (const a of el.getAnimations()) a.finish();
    return { timings, middle, closed, opened: Number(getComputedStyle(el).opacity) };
  });
  expect(result.timings.every((t) => t?.duration === 400 && t.easing === "ease-in-out")).toBe(true);
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(1);
  expect(result.closed).toBe(0);
  expect(result.opened).toBe(1);
});

test("standard dialogs animate both entering and exiting", async ({ page }) => {
  await page.setContent(
    '<div class="standard-dialog-overlay" data-motion="enter"><div class="standard-dialog standard-dialog--m">设置</div></div>',
  );
  for (const file of [
    "src/renderer/src/app/app.css",
    "src/renderer/src/shared/standard-dialog.css",
  ])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const result = await page.locator(".standard-dialog-overlay").evaluate((element) => {
    for (const a of element.getAnimations({ subtree: true })) a.finish();
    (element as HTMLElement).dataset.motion = "exit";
    getComputedStyle(element).opacity;
    const animations = element.getAnimations({ subtree: true });
    const dialog = element.querySelector(".standard-dialog");
    if (!dialog) throw new Error("dialog missing");
    const timings = [element, dialog].map((el) => ({
      duration: getComputedStyle(el).animationDuration,
      easing: getComputedStyle(el).animationTimingFunction,
    }));
    for (const a of animations) {
      a.pause();
      a.currentTime = 200;
    }
    const middle = Number(getComputedStyle(element).opacity);
    for (const a of animations) a.finish();
    return {
      count: animations.length,
      timings,
      middle,
      end: Number(getComputedStyle(element).opacity),
    };
  });
  expect(result.count).toBe(2);
  expect(result.timings.every((t) => t.duration === "0.4s" && t.easing === "ease-in-out")).toBe(
    true,
  );
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(1);
  expect(result.end).toBe(0);
});

test("internal view changes and fold arrows use the shared spatial rhythm", async ({ page }) => {
  await page.setContent(
    '<div class="spatial-view">历史对话</div><button type="button" class="drawing-explanation-rail__toggle" aria-expanded="true"><span class="drawing-explanation-rail__toggle-caret"></span></button><button type="button" class="reference-mark-panel__toggle" aria-expanded="true"><span class="reference-mark-panel__toggle-caret"></span></button>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  const view = await page.locator(".spatial-view").evaluate((element) => {
    const style = getComputedStyle(element);
    const timings = { duration: style.animationDuration, easing: style.animationTimingFunction };
    for (const a of element.getAnimations()) {
      a.pause();
      a.currentTime = 200;
    }
    return { ...timings, opacity: Number(getComputedStyle(element).opacity) };
  });
  expect(view.duration).toBe("0.4s");
  expect(view.easing).toBe("ease-in-out");
  expect(view.opacity).toBeGreaterThan(0);
  expect(view.opacity).toBeLessThan(1);
  for (const selector of [
    ".drawing-explanation-rail__toggle-caret",
    ".reference-mark-panel__toggle-caret",
  ]) {
    const timing = await page.locator(selector).evaluate((element) => ({
      duration: getComputedStyle(element).transitionDuration,
      easing: getComputedStyle(element).transitionTimingFunction,
    }));
    expect(timing).toEqual({ duration: "0.4s", easing: "ease-in-out" });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.locator(".spatial-view").evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  expect(
    await page
      .locator(".reference-mark-panel__toggle-caret")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});

test("formula collection exit uses shared dialog timing and respects reduced motion", async ({
  page,
}) => {
  await page.setContent(
    '<div class="motion-presence" data-motion-state="open"><div class="matrix-insert-backdrop"><section class="other-formula-dialog" role="dialog">公式库</section></div></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  const result = await page.locator(".motion-presence").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
    (element as HTMLElement).dataset.motionState = "closing";
    const backdrop = element.firstElementChild as HTMLElement;
    const dialog = backdrop.firstElementChild as HTMLElement;
    getComputedStyle(backdrop).opacity;
    const animations = element.getAnimations({ subtree: true });
    const timing = getComputedStyle(dialog).animationDuration;
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = Number(getComputedStyle(backdrop).opacity);
    for (const animation of animations) animation.finish();
    return {
      count: animations.length,
      timing,
      middle,
      end: Number(getComputedStyle(backdrop).opacity),
    };
  });
  expect(result.count).toBe(2);
  expect(result.timing).toBe("0.4s");
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(1);
  expect(result.end).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".other-formula-dialog")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("special character dialogs animate exit without intercepting pointers", async ({ page }) => {
  await page.setContent(
    '<div class="motion-presence" data-motion-state="open"><div class="special-character-dialog-backdrop"><section class="special-character-dialog" role="dialog">特殊字符</section></div></div>',
  );
  for (const file of ["src/renderer/src/app/app.css", "src/renderer/src/editor/editor.css"])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const result = await page.locator(".motion-presence").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
    (element as HTMLElement).dataset.motionState = "closing";
    const backdrop = element.firstElementChild as HTMLElement;
    getComputedStyle(backdrop).opacity;
    const animations = element.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = Number(getComputedStyle(backdrop).opacity);
    return {
      middle,
      count: animations.length,
      pointer: getComputedStyle(backdrop).pointerEvents,
      duration: getComputedStyle(backdrop).animationDuration,
    };
  });
  expect(result.count).toBe(2);
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(1);
  expect(result.pointer).toBe("none");
  expect(result.duration).toBe("0.4s");
});

test("chemistry tray remains separate from the scroll body while collapsing", async ({ page }) => {
  await page.setContent(
    '<div class="chemistry-dialog" style="height:500px"><header style="height:40px">化学</header><div class="chemistry-dialog-scroll-body" style="height:100px">编辑器</div><div class="spatial-collapse chemistry-periodic-collapse" data-motion="enter"><div class="spatial-collapse__content"><div class="chemistry-periodic-tray"><div style="height:180px">周期表</div></div></div></div><footer style="height:40px">确定</footer></div>',
  );
  for (const file of ["src/renderer/src/app/app.css", "src/renderer/src/editor/editor.css"])
    await page.addStyleTag({ content: readFileSync(file, "utf8") });
  const result = await page.locator(".chemistry-periodic-collapse").evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
    const expanded = element.getBoundingClientRect().height;
    (element as HTMLElement).dataset.motion = "exit";
    getComputedStyle(element).gridTemplateRows;
    const animations = element.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = element.getBoundingClientRect().height;
    for (const animation of animations) animation.finish();
    return { expanded, middle, closed: element.getBoundingClientRect().height };
  });
  expect(result.middle).toBeGreaterThan(0);
  expect(result.middle).toBeLessThan(result.expanded);
  expect(result.closed).toBe(0);
});

test("corner notices and centered feedback retain a 400ms exit without shifting alignment", async ({
  page,
}) => {
  await page.setContent(
    '<div class="motion-presence" data-motion-state="closing"><section class="data-safety-guide">数据安全提示</section></div><div class="motion-presence" data-motion-state="closing"><section class="operation-feedback is-success" data-motion="exit">已完成</section></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  for (const selector of [".data-safety-guide", ".operation-feedback"]) {
    const result = await page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      const timings = { duration: style.animationDuration, easing: style.animationTimingFunction };
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = 200;
      }
      const middle = Number(getComputedStyle(element).opacity);
      for (const animation of element.getAnimations()) animation.finish();
      return {
        ...timings,
        middle,
        end: Number(getComputedStyle(element).opacity),
        left: getComputedStyle(element).left,
      };
    });
    expect(result.duration).toBe("0.4s");
    expect(result.easing).toBe("ease-in-out");
    expect(result.middle).toBeGreaterThan(0);
    expect(result.middle).toBeLessThan(1);
    expect(result.end).toBe(0);
    if (selector === ".operation-feedback") expect(result.left).toBe("640px");
  }
});

test("centered figure hover previews keep their center during exit", async ({ page }) => {
  await page.setContent(
    '<div class="spatial-presence" data-motion="enter"><span class="patent-illustrated-hover__popover patent-illustrated-hover__popover--image" style="width:200px;height:100px">附图</span></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  const result = await page.locator("span").evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
    const initial = element.getBoundingClientRect();
    const parent = element.parentElement;
    if (!parent) throw new Error("presence missing");
    parent.dataset.motion = "exit";
    getComputedStyle(element).opacity;
    for (const animation of element.getAnimations()) {
      animation.pause();
      animation.currentTime = 200;
    }
    const middle = element.getBoundingClientRect();
    return {
      x: initial.x,
      y: initial.y,
      midX: middle.x,
      midY: middle.y,
      opacity: Number(getComputedStyle(element).opacity),
    };
  });
  expect(result.midX).toBe(result.x);
  expect(result.midY).toBe(result.y);
  expect(result.opacity).toBeGreaterThan(0);
  expect(result.opacity).toBeLessThan(1);
});

test("error feedback exits at the modal center", async ({ page }) => {
  await page.setContent(
    '<div class="operation-feedback-backdrop" data-motion="enter"><section class="operation-feedback is-error">失败提示</section></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  const result = await page.locator("section").evaluate((element) => {
    const parent = element.parentElement;
    if (!parent) throw new Error("backdrop missing");
    for (const animation of parent.getAnimations({ subtree: true })) animation.finish();
    parent.dataset.motion = "exit";
    getComputedStyle(element).opacity;
    for (const animation of parent.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 200;
    }
    const box = element.getBoundingClientRect();
    return {
      center: box.x + box.width / 2,
      expected: window.innerWidth / 2,
      duration: getComputedStyle(element).animationDuration,
    };
  });
  expect(result.center).toBeCloseTo(result.expected, 1);
  expect(result.duration).toBe("0.4s");
});

test("closing guidance fades its nested halo along with its card", async ({ page }) => {
  await page.setContent(
    '<div class="spatial-presence" data-motion="enter"><div class="spatial-presence" data-motion="enter"><div class="writing-guidance-ring" style="width:100px;height:100px"></div></div><aside class="writing-guidance-card">引导</aside></div>',
  );
  await page.addStyleTag({ content: readFileSync("src/renderer/src/app/app.css", "utf8") });
  await page.addStyleTag({
    content: readFileSync("src/renderer/src/writing-guidance/writing-guidance.css", "utf8"),
  });
  const result = await page
    .locator(".spatial-presence")
    .first()
    .evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) animation.finish();
      (element as HTMLElement).dataset.motion = "exit";
      getComputedStyle(element).opacity;
      const nodes = [
        element.querySelector(".writing-guidance-ring"),
        element.querySelector("aside"),
      ];
      return nodes.map((node) => {
        if (!node) throw new Error("guidance paint missing");
        getComputedStyle(node).opacity;
        for (const animation of node.getAnimations()) {
          animation.pause();
          animation.currentTime = 200;
        }
        return {
          opacity: Number(getComputedStyle(node).opacity),
          duration: getComputedStyle(node).transitionDuration,
        };
      });
    });
  for (const item of result) {
    expect(item.opacity).toBeGreaterThan(0);
    expect(item.opacity).toBeLessThan(1);
    expect(item.duration).toContain("0.4s");
  }
});

test("settings and print windows share entrance and exit paint", async ({ page }) => {
  await page.setContent(
    "<style>" +
      readFileSync("src/renderer/src/app/app.css", "utf8") +
      readFileSync("src/renderer/src/shared/standard-dialog.css", "utf8") +
      "</style>",
  );
  const result = await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="motion-presence" data-motion-state="open"><div class="application-settings-dialog"><div class="application-settings-dialog__backdrop"></div><section class="application-settings-dialog__surface">设置</section></div></div><div class="standard-dialog-overlay" data-motion="enter"><section class="standard-dialog">打印</section></div>',
    );
    const presence = document.querySelector(".motion-presence") as HTMLElement;
    const settings = presence.firstElementChild as HTMLElement;
    const print = document.querySelector(".standard-dialog-overlay") as HTMLElement;
    const sample = (node: HTMLElement) => {
      getComputedStyle(node).opacity;
      for (const animation of node.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 200;
      }
      const surface = node.querySelector("section")!;
      const style = getComputedStyle(surface);
      return {
        opacity: Number(getComputedStyle(node).opacity) * Number(style.opacity),
        transform: style.transform,
        duration: style.animationDuration,
        easing: style.animationTimingFunction,
      };
    };
    const enter = [sample(settings), sample(print)];
    presence.dataset.motionState = "closing";
    presence.inert = true;
    print.dataset.motion = "exit";
    const exit = [sample(settings), sample(print)];
    for (const animation of settings.getAnimations({ subtree: true })) animation.finish();
    return { enter, exit, end: Number(getComputedStyle(settings).opacity), inert: presence.inert };
  });
  expect(result.enter[0]).toEqual(result.enter[1]);
  expect(result.exit[0]).toEqual(result.exit[1]);
  expect(result.enter[0]!.opacity).toBeCloseTo(0.25, 2);
  expect(result.enter[0]!.duration).toBe("0.4s");
  expect(result.enter[0]!.easing).toBe("ease-in-out");
  expect(result.end).toBe(0);
  expect(result.inert).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".application-settings-dialog__surface")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});

test("real settings mount starts the print entrance and retains safe exit", async ({ page }) => {
  await page.goto(`http://127.0.0.1:5173/@fs${resolve("tests/e2e/fixtures/settings-motion.html")}`);
  await page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  const samples = await page.evaluate(async () => {
    const result: { time: number; opacity: number; name: string; transform: string }[] = [];
    const start = performance.now();
    (document.querySelector("button") as HTMLElement).click();
    await new Promise<void>((done) => {
      const frame = () => {
        const surface = document.querySelector(".application-settings-dialog__surface");
        const root = document.querySelector(".application-settings-dialog");
        const time = performance.now() - start;
        if (surface && root) {
          const style = getComputedStyle(surface);
          result.push({
            time,
            opacity: Number(style.opacity) * Number(getComputedStyle(root).opacity),
            name: style.animationName,
            transform: style.transform,
          });
        }
        if (time < 460) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    return result;
  });
  expect(samples[0]!.opacity).toBeLessThan(0.1);
  expect(samples[0]!.name).toBe("standard-dialog-window-in");
  expect(samples.some((frame) => frame.opacity > 0.1 && frame.opacity < 0.9)).toBe(true);
  expect(samples.at(-1)?.opacity).toBe(1);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await expect(page.locator(".application-settings-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".application-settings-dialog")).toHaveCount(0);
});

test("real settings remain above the positioned workspace throughout entrance", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:5173/@fs${resolve("tests/e2e/fixtures/settings-motion.html")}`);
  await page.getByRole("button", { name: "打开设置", exact: true }).waitFor();
  const paint = await page.evaluate(async () => {
    (document.querySelector("button") as HTMLElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const dialog = document.querySelector(".application-settings-dialog")!;
    const presence = dialog.closest(".motion-presence")!;
    const surface = dialog.querySelector("section")!;
    getComputedStyle(surface).opacity;
    for (const animation of presence.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 200;
    }
    const box = surface.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { aboveWorkspace: hit !== null && dialog.contains(hit) };
  });
  expect(paint.aboveWorkspace).toBe(true);
  const exit = await page.evaluate(async () => {
    const dialog = document.querySelector(".application-settings-dialog")!;
    const presence = dialog.closest(".motion-presence")!;
    for (const animation of presence.getAnimations({ subtree: true })) animation.finish();
    (dialog.querySelector('button[aria-label="关闭设置"]') as HTMLElement).click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const surface = dialog.querySelector("section")!;
    return {
      root: getComputedStyle(dialog).animationName,
      surface: getComputedStyle(surface).animationName,
      interactionReleased: dialog.closest("[inert]") !== null,
    };
  });
  expect(exit).toEqual({
    root: "standard-dialog-overlay-out",
    surface: "standard-dialog-window-out",
    interactionReleased: true,
  });
});
