import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, _electron as electron, expect } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { renderPrintHtml } from "../../src/main/exports/print-template.js";
import { lineSpacingToCssLineHeight } from "../../src/shared/document/line-spacing.js";
import type {} from "./fixtures/editor-typography-contract.js";

// Use the application's exact Electron/Chromium version, always hidden and isolated.
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a fixture destructuring pattern; this fixture has no browser dependencies.
  page: async ({}, use) => {
    const userData = await mkdtemp(join(tmpdir(), "patent-typography-"));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );
    const application = await electron.launch({
      args: [
        resolve("tests/e2e/fixtures/editor-typography-electron.cjs"),
        `--user-data-dir=${userData}`,
      ],
      env: environment,
    });
    try {
      const page = await application.firstWindow();
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
      await use(page);
    } finally {
      await application.close();
    }
  },
});
let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { entries: ["tests/e2e/fixtures/editor-typography.html"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [process.cwd(), await realpath(resolve("node_modules"))] },
    },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0];
  if (!address) throw new Error("missing typography fixture address");
  url = `${address}tests/e2e/fixtures/editor-typography.html`;
});
test.afterAll(async () => {
  await server?.close();
});

const paragraphs = Array.from(
  { length: 18 },
  (_, index) =>
    `<p style="text-align:justify;text-indent:2em">电池包主体${"测".repeat(18 + index)}于：后续正文，用于测试换行。</p>`,
).join("");

test("selection toolbar anchors correctly on its first opening and on a new selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const zoom of [80, 100, 150]) {
    await page.goto(url);
    await page.addStyleTag({
      content: await readFile(resolve("src/renderer/src/app/app.css"), "utf8"),
    });
    await expect.poll(() => page.evaluate(() => window.typography.ready())).toBe(true);
    await page.evaluate(() => window.typography.load(`<p>${"选中文字位置测试".repeat(6)}</p>`));
    await page.locator("#paper").evaluate((element, value) => {
      element.style.zoom = String(value / 100);
    }, zoom);
    const editor = page.locator(".patent-prosemirror");
    const bubble = page.locator(".editor-selection-menu:not([data-spatial-paint])");
    for (const from of [1, 18]) {
      const selection = await editor.evaluate((element, start) => {
        const e = (element as HTMLElement & { editor: Editor }).editor;
        e.view.focus();
        e.commands.setTextSelection({ from: start, to: start + 4 });
        const a = e.view.coordsAtPos(start);
        const b = e.view.coordsAtPos(start + 4, -1);
        return {
          center: (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
          top: Math.min(a.top, b.top),
          bottom: Math.max(a.bottom, b.bottom),
        };
      }, from);
      await expect(bubble).toBeVisible();
      await expect
        .poll(async () => {
          const rect = await bubble.boundingBox();
          return Math.abs((rect?.x ?? 0) + (rect?.width ?? 0) / 2 - selection.center);
        })
        .toBeLessThan(2);
      const before = await bubble.boundingBox();
      expect(before).not.toBeNull();
      expect(before!.y + before!.height <= selection.top || before!.y >= selection.bottom).toBe(
        true,
      );
      await bubble.getByRole("button", { name: "居中", exact: true }).click();
      await page.waitForTimeout(200);
      const after = await bubble.boundingBox();
      expect(after?.x).toBeCloseTo(before!.x, 0);
      expect(after?.y).toBeCloseTo(before!.y, 0);
    }
    await page.evaluate(() => {
      document.body.style.minHeight = "1800px";
      window.scrollBy(0, 32);
    });
    await expect
      .poll(async () => {
        const rect = await bubble.boundingBox();
        if (!rect) return Infinity;
        const selection = await editor.evaluate((element) => {
          const e = (element as HTMLElement & { editor: Editor }).editor;
          const a = e.view.coordsAtPos(e.state.selection.from);
          const b = e.view.coordsAtPos(e.state.selection.to, -1);
          return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
        });
        return Math.min(
          Math.abs(rect.y + rect.height + 8 - selection.top),
          Math.abs(rect.y - selection.bottom - 8),
        );
      })
      .toBeLessThan(1);
    await editor.press("Escape");
    await expect(bubble).toBeHidden();
  }
});

test("drawing list hover panels stay inside the viewport for enabled and disabled actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const selectors = [
    ".reference-mark-panel__fill",
    ".reference-mark-panel__copy",
    ".drawing-explanation-rail__fill",
    ".drawing-explanation-rail__copy",
  ];
  for (const disabled of [false, true]) {
    await page.goto(
      `${url.replace("editor-typography.html", "drawing-list-help.html")}${disabled ? "?disabled" : ""}`,
    );
    for (const selector of selectors) {
      const button = page.locator(selector);
      // Hidden Electron windows may throttle pointer stability checks; exercise the captured event directly.
      await button.dispatchEvent("pointermove", { bubbles: true });
      const panel = page.locator(".drawing-list-help");
      await expect(panel).toHaveCount(1);
      await expect(panel).toHaveCSS("position", "fixed");
      await expect(panel).toBeInViewport({ ratio: 0.99 });
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect(button).not.toHaveAttribute("title");
      await panel.getByRole("switch").dispatchEvent("click");
      // Shrinking can move the panel away from the pointer; leaving dismisses it by design.
      await page
        .locator("body")
        .dispatchEvent("pointermove", { bubbles: true, clientX: 0, clientY: 0 });
      await expect(panel).toHaveCount(0);
      await button.dispatchEvent("pointermove", { bubbles: true });
      await expect(panel).toHaveClass(/compact-panel/);
      await expect(panel).toBeInViewport({ ratio: 0.99 });
      await panel.getByRole("switch").dispatchEvent("click");
      await expect(panel).not.toHaveClass(/compact-panel/);
      await page
        .locator("body")
        .dispatchEvent("pointermove", { bubbles: true, clientX: 0, clientY: 0 });
      await expect(panel).toHaveCount(0);
    }
  }
});

test("drawing list hover help wraps examples without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto(url.replace("editor-typography.html", "drawing-list-help.html"));
  for (const selector of [
    ".reference-mark-panel__fill",
    ".reference-mark-panel__copy",
    ".drawing-explanation-rail__fill",
    ".drawing-explanation-rail__copy",
  ]) {
    await page.locator(selector).dispatchEvent("pointermove", { bubbles: true });
    const panel = page.locator(".drawing-list-help");
    await expect(panel).toHaveCount(1);
    await expect
      .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(1);
    await page
      .locator("body")
      .dispatchEvent("pointermove", { bubbles: true, clientX: 0, clientY: 0 });
  }
});

test("snapshot figure changes locate current and deleted images inside the preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url.replace("editor-typography.html", "snapshot-preview.html")}?figures`);
  await expect(page.getByText("新增 2 张")).toBeVisible();
  await expect(page.getByText("删除 1 张")).toBeVisible();
  const workspace = page.locator(".snapshot-content-preview__workspace");
  const rail = page.getByRole("complementary", { name: "变化位置" });
  await workspace.evaluate((element) => {
    element.scrollTop = 0;
  });
  await rail.getByRole("button", { name: "图25：新增附图" }).click();
  const added = page.getByRole("article", { name: "图25", exact: true });
  await expect(added).toHaveClass(/is-snapshot-change-target/);
  await expect(added).toBeInViewport({ ratio: 0.9 });
  await workspace.evaluate((element) => {
    element.scrollTop = 0;
  });
  await rail.getByRole("button", { name: "图25：新增附图" }).click();
  await expect(added).toBeInViewport({ ratio: 0.9 });
  await rail.getByRole("button", { name: "图1：删除附图" }).click();
  const deleted = page.getByRole("article", { name: "原图1（已删除）", exact: true });
  await expect(deleted).toHaveClass(/is-snapshot-change-target/);
  await expect(deleted).toBeInViewport({ ratio: 0.9 });
  await expect(deleted.getByRole("img")).toBeVisible();
  expect(await deleted.getByRole("img").evaluate((element) => element.style.transform)).toContain(
    "rotate(270deg)",
  );
  await rail.getByRole("button", { name: "图1：附图调整" }).click();
  await expect(page.getByText("附图旋转：0° → 90°")).toBeVisible();
  const rotated = page.getByRole("article", { name: "图1", exact: true }).getByRole("img");
  expect(await rotated.evaluate((element) => element.style.transform)).toContain("rotate(90deg)");
  for (const width of [1280, 1080]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        rotated.evaluate((element) => {
          const image = element.getBoundingClientRect();
          const frame = element.parentElement?.getBoundingClientRect();
          return (
            frame != null &&
            image.left >= frame.left - 1 &&
            image.right <= frame.right + 1 &&
            image.top >= frame.top - 1 &&
            image.bottom <= frame.bottom + 1
          );
        }),
      )
      .toBe(true);
  }
  expect(
    (await page.getByRole("dialog", { name: "v4 内容预览" }).boundingBox())?.y,
  ).toBeGreaterThanOrEqual(38);
  await page.screenshot({ path: test.info().outputPath("snapshot-figure-navigation.png") });
});

test("snapshot auxiliary changes scroll to content on repeated clicks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url.replace("editor-typography.html", "snapshot-preview.html")}?auxiliary`);
  await page.getByLabel("其他文档快照").selectOption("materials");
  const rail = page.getByRole("complementary", { name: "其他文档变化" });
  const workspace = page.locator(".snapshot-content-preview__workspace");
  const target = workspace.locator("[data-snapshot-change-id]").first();
  await expect(target).toBeAttached();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await workspace.evaluate((element) => {
      element.scrollTop = 0;
    });
    await rail.getByRole("button").click();
    await expect(target).toBeInViewport({ ratio: 0.9 });
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(500);
  }
});

test("snapshot preview opens large and supports dragging and all eight resize directions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  test.setTimeout(120_000);
  await page.goto(url.replace("editor-typography.html", "snapshot-preview.html"));
  const dialog = page.getByRole("dialog", { name: "v4 内容预览" });
  await expect(dialog).toBeVisible();
  const initial = await dialog.boundingBox();
  expect(initial!.y).toBeGreaterThanOrEqual(38);
  expect(initial!.width).toBeGreaterThan(1080);
  expect(initial!.height).toBeGreaterThan(720);
  expect(
    (await page.locator(".snapshot-content-preview__workspace").boundingBox())!.height,
  ).toBeGreaterThan(600);
  for (const edge of ["e", "w", "s", "n", "se", "sw", "ne", "nw"]) {
    const handle = dialog.locator(`.dialog-resize--${edge}`);
    const box = (await handle.boundingBox())!;
    const before = (await dialog.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + (edge.includes("w") ? 20 : edge.includes("e") ? -20 : 0),
      box.y + box.height / 2 + (edge.includes("n") ? 20 : edge.includes("s") ? -20 : 0),
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => {
        const after = (await dialog.boundingBox())!;
        return Math.round(
          edge === "s" || edge === "n" ? before.height - after.height : before.width - after.width,
        );
      })
      .toBe(20);
  }
  const beforeDrag = (await dialog.boundingBox())!;
  const header = (await dialog.locator(".standard-dialog__header").boundingBox())!;
  await page.mouse.move(header.x + 150, header.y + 20);
  await page.mouse.down();
  await page.mouse.move(header.x + 170, header.y + 40, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await dialog.boundingBox())!.x - beforeDrag.x))
    .toBe(20);
  await page.screenshot({ path: test.info().outputPath("snapshot-preview.png") });
  const movedHeader = (await dialog.locator(".standard-dialog__header").boundingBox())!;
  await page.mouse.move(movedHeader.x + 150, movedHeader.y + 20);
  await page.mouse.down();
  await page.mouse.move(movedHeader.x + 150, 0);
  await page.mouse.up();
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(38);
  const north = (await dialog.locator(".dialog-resize--n").boundingBox())!;
  await page.mouse.move(north.x + north.width / 2, north.y + 3);
  await page.mouse.down();
  await page.mouse.move(north.x + north.width / 2, 0);
  await page.mouse.up();
  expect((await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(38);
});

test("protection settings fit without vertical scrolling at desktop sizes", async ({ page }) => {
  await page.goto(url.replace("editor-typography.html", "protection-settings.html"));
  await expect(page.getByRole("button", { name: "保存定时备份设置" })).toBeVisible();
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1024, height: 700 },
  ]) {
    await page.setViewportSize(size);
    const viewport = page.locator(".settings-workspace-content__route > div");
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBe(0);
    await expect(page.getByRole("button", { name: "保存定时备份设置" })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole("checkbox", { name: "启用自动快照" })).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath("protection-settings.png") });
  await page.goto(`${url.replace("editor-typography.html", "protection-settings.html")}?snapshot`);
  await expect(page.getByRole("checkbox", { name: "启用自动快照" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "启用定时备份" })).toHaveCount(0);
  await expect(page.getByText(/下次检查：/)).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath("snapshot-settings.png") });
});

test("retained selection follows zoom without spilling onto adjacent lines", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.goto(`${url}?book=claims&layout=page&retained`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() =>
    window.typography.load("<p>选中文字第一行<br>选中文字第二行<br>选中文字第三行</p>"),
  );
  await page.locator(".patent-prosemirror").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.getByRole("textbox", { name: "面板输入框" }).focus();
  for (const zoom of [50, 80, 100, 150, 200, 50]) {
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const layer = document.querySelector(".editor-selection-overlay:not([hidden])");
          const box = layer
            ?.querySelector(".editor-selection-overlay__rect")
            ?.getBoundingClientRect();
          const p = document.querySelector(".patent-prosemirror p");
          if (!box || !p?.firstChild) return 1000;
          const range = document.createRange();
          range.selectNodeContents(p.firstChild);
          const text = range.getBoundingClientRect();
          const scale = Number(
            document
              .querySelector<HTMLElement>(".patent-page-with-rail")
              ?.style.getPropertyValue("--patent-page-zoom"),
          );
          const lineHeight = Number.parseFloat(getComputedStyle(p).lineHeight) * scale;
          return Math.max(
            Math.abs(box.height - lineHeight),
            Math.abs((box.top + box.bottom) / 2 - (text.top + text.bottom) / 2),
          );
        }),
      )
      .toBeLessThan(1.5);
  }
});

test("inline images rest on the surrounding text baseline like Word", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${url}?book=description&layout=page&inline-image`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(",")[1] ?? ""), (c) =>
      c.charCodeAt(0),
    );
    Object.assign(window, {
      patentApi: { assets: { getPreview: async () => ({ ok: true, value: bytes }) } },
    });
    window.typography.load(
      '<p>11222<span data-patent-inline-asset-id="00000000-0000-4000-8000-000000000812" assetId="00000000-0000-4000-8000-000000000812" widthMm="50"></span>22222</p>',
    );
  });
  await expect(page.locator(".patent-inline-figure img")).toBeVisible();
  for (const zoom of [50, 100, 200]) {
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    const difference = await page.evaluate(() => {
      const image = document.querySelector(".patent-inline-figure img");
      const paragraph = image?.closest("p");
      if (!image || !paragraph) throw new Error("missing inline image");
      const marker = document.createElement("span");
      marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      paragraph.append(marker);
      const delta = Math.abs(
        image.getBoundingClientRect().bottom - marker.getBoundingClientRect().bottom,
      );
      marker.remove();
      return delta;
    });
    expect(difference).toBeLessThan(1);
  }
  await page.screenshot({ path: test.info().outputPath("inline-image-baseline.png") });
  const layoutDuringRotation = await page
    .locator(".image-selection-frame")
    .evaluate(async (source) => {
      // Measure the shared layout styles outside ProseMirror's DOM observer.
      const frame = source.cloneNode(true) as HTMLElement;
      frame.dataset.rotationTest = "true";
      frame.style.position = "fixed";
      frame.style.top = "20px";
      frame.style.left = "20px";
      document.body.append(frame);
      frame.getBoundingClientRect();
      frame.style.width = "25mm";
      frame.style.setProperty("--image-aspect-ratio", "0.5");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const start = frame.getBoundingClientRect().height;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const later = frame.getBoundingClientRect().height;
      return { start, later };
    });
  expect(Math.abs(layoutDuringRotation.start - layoutDuringRotation.later)).toBeLessThan(1);
  const image = page.locator('[data-rotation-test="true"] > img');
  await image.evaluate((element) => {
    getComputedStyle(element).transform;
    element.style.transform = "translate(-50%, -50%) rotate(90deg)";
  });
  const duringRotation = await image.evaluate(async (element) => {
    const animation = element.getAnimations()[0];
    if (!animation)
      throw new Error(`missing rotation transition: ${getComputedStyle(element).transition}`);
    animation.pause();
    animation.currentTime = 80;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const during = { a: matrix.a, b: matrix.b };
    animation.finish();
    return during;
  });
  expect(duringRotation.a).toBeGreaterThan(0);
  expect(duringRotation.b).toBeGreaterThan(0);
  await expect
    .poll(() =>
      image.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).b),
    )
    .toBeCloseTo(1, 3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await image.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    "0s",
  );
  await page.locator('[data-rotation-test="true"]').evaluate((frame) => frame.remove());
});

test("image drag handles follow the pointer at every page zoom", async ({ page }) => {
  await page.goto(`${url}?layout=image`);
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  for (const zoom of [50, 80, 100, 150, 200]) {
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    const frame = page.locator(".image-selection-frame");
    const before = await frame.boundingBox();
    const handle = await page.getByRole("button", { name: "从右下角缩放图片" }).boundingBox();
    if (!before || !handle) throw new Error("missing image handle");
    const x = handle.x + handle.width / 2,
      y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y, { steps: 5 });
    await page.mouse.up();
    const after = await frame.boundingBox();
    expect(Math.abs((after?.width ?? 0) - before.width - 20)).toBeLessThan(1);
  }
});

test("ruler and function rail stay linked when pages overflow and recover", async ({ page }) => {
  await page.goto(`${url}?book=claims&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() =>
    window.typography.load(
      Array.from(
        { length: 40 },
        (_, i) => `<p>${i + 1}. 一种测试装置，包括底座和连接组件。</p>`,
      ).join(""),
    ),
  );
  const scope = page.locator('.patent-function-rail-scope[data-function-rail-scope="single"]');
  const workspace = page.locator(".editor-workspace");
  const slot = page.locator(".patent-global-function-rail-slot");
  const ruler = page.getByRole("complementary", { name: "文档结构标尺" });
  for (const [width, zoom, layout] of [
    [1200, 50, "docked"],
    [600, 150, "overlay"],
    [1200, 50, "docked"], // Recovered page space resumes automatic docking.
  ] as const) {
    await scope.evaluate((node, value) => {
      node.style.width = `${value}px`;
    }, width);
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    await workspace.evaluate((node) => {
      node.scrollLeft = 0;
      node.scrollTop = 0;
    });
    await expect(slot).toHaveAttribute("data-layout", layout);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const paper = document.querySelector(".patent-page-zoom-frame")?.getBoundingClientRect();
          const ruler = document
            .querySelector(".document-structure-ruler")
            ?.getBoundingClientRect();
          if (!paper || !ruler) return 1000;
          return Math.max(Math.abs(paper.top - ruler.top), Math.abs(paper.height - ruler.height));
        }),
      )
      .toBeLessThan(2);
    // Hidden Electron windows need a compositor frame for viewport observations.
    await page.screenshot();
    await expect(ruler).toBeInViewport();
    if (layout === "overlay") {
      await workspace.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
    }
    const paperLeft = await page
      .locator(".patent-page-zoom-frame")
      .evaluate((node) => node.getBoundingClientRect().left);
    if (layout === "overlay") {
      // Hover opens the rail and replaces its handle before a click can settle.
      await page.getByRole("button", { name: "展开功能栏", exact: true }).hover();
      await expect(slot).toHaveAttribute("data-expanded", "true");
      expect(
        await page
          .locator(".patent-page-zoom-frame")
          .evaluate((node) => node.getBoundingClientRect().left),
      ).toBeCloseTo(paperLeft, 0);
      await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
      await page.getByRole("textbox", { name: "面板输入框" }).focus();
      await page.mouse.move(10, 850);
      await expect(slot).toHaveAttribute("data-expanded", "false");
    }
    await workspace.evaluate((node) => {
      node.scrollLeft = 0;
    });
    await workspace.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.mouse.move(10, 850);
    await expect
      .poll(() =>
        ruler.evaluate((element) =>
          element
            .closest(".patent-page-with-rail")!
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState !== "running"),
        ),
      )
      .toBe(true);
    await expect(ruler).not.toHaveAttribute("data-scroll-active", "true");
    const point = await ruler.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const viewport = element.closest(".editor-workspace")!.getBoundingClientRect();
      return {
        x: bounds.left + bounds.width / 2,
        y: (Math.max(bounds.top, viewport.top) + Math.min(bounds.bottom, viewport.bottom)) / 2,
      };
    });
    await page.mouse.move(point.x, point.y);
    if ((await ruler.getAttribute("data-mode")) === "compact") {
      const menu = page.locator(".ruler-navigation-popover:not([inert])");
      await expect(menu).toBeVisible();
      await menu.getByRole("button", { name: "权利要求 40", exact: true }).click();
    } else {
      await expect(ruler).toHaveAttribute("data-navigation", "true");
      // Expanded navigation spreads dense labels; wheel to the last row before clicking it.
      await page.mouse.wheel(0, 2000);
      const marker = ruler.locator(".document-structure-ruler__marker").last();
      await expect(marker).toHaveAttribute("data-center", "true");
      await expect
        .poll(() =>
          ruler.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState !== "running"),
          ),
        )
        .toBe(true);
      await marker.click();
    }
    await page.screenshot();
    await expect(page.locator(".patent-prosemirror p").last()).toBeInViewport();
  }
});

test("right compact ruler ignores a crossing and opens after 300ms hover", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${url}?book=claims&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() =>
    window.typography.load(
      Array.from({ length: 30 }, (_, i) => `<p>${i + 1}. 一种测试装置，包括底座。</p>`).join(""),
    ),
  );
  await page
    .locator(".patent-page-with-rail")
    .evaluate((element) => element.style.setProperty("--column-ruler-width", "20px"));
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  const ruler = page.getByRole("complementary", { name: "文档结构标尺" });
  await expect(ruler).toHaveAttribute("data-mode", "compact");
  await ruler.evaluate((element) => {
    const pane = document.createElement("div");
    pane.className = "dual-document-pane";
    pane.dataset.pane = "right";
    element.replaceWith(pane);
    pane.append(element);
  });
  const menu = page.locator(".ruler-navigation-popover:not([inert])");
  const point = await ruler.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 100, right: r.right };
  });
  await page.mouse.move(point.x - 40, point.y);
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(point.right + 40, point.y);
  await page.waitForTimeout(600);
  await expect(menu).toHaveCount(0);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(150);
  await expect(menu).toHaveCount(0);
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw Error("missing ruler hover menu");
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.waitForTimeout(250);
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "权利要求 1", exact: true }).click();
  await expect(menu).toHaveCount(0);
});

for (const book of ["claims", "description", "abstract"]) {
  test(`${book}: zoomed long pages end at the visible scroll bottom`, async ({ page }) => {
    await page.goto(`${url}?book=${book}&layout=page`);
    await page.waitForFunction(() => window.typography?.ready());
    await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
    const workspace = page.locator(".editor-workspace");
    // A narrow pane represents the same page layout used by side-by-side editing.
    for (const width of [1200, 600]) {
      await workspace.evaluate((node, value) => {
        node.style.width = `${value}px`;
      }, width);
      for (const count of [100, 160, 1]) {
        await page.evaluate(
          (size) =>
            window.typography.load(
              Array.from(
                { length: size },
                (_, i) => `<p>第${i + 1}段：底座、支撑杆和连接组件。</p>`,
              ).join(""),
            ),
          count,
        );
        for (const zoom of [0.5, 0.8, 0.9, 1, 1.5, 2]) {
          const geometry = await workspace.evaluate((node, value) => {
            const layout = node.querySelector<HTMLElement>(".patent-page-with-rail");
            const paper = node.querySelector<HTMLElement>(".patent-book-rich-text");
            if (!layout || !paper) throw new Error("missing page");
            layout.style.setProperty("--patent-page-zoom", String(value));
            node.scrollTop = node.scrollHeight;
            node.scrollLeft = -node.scrollWidth;
            const viewport = node.getBoundingClientRect();
            const bounds = paper.getBoundingClientRect();
            node.scrollLeft = node.scrollWidth;
            return {
              bottom: bounds.bottom,
              top: viewport.top,
              bottomGap: viewport.top + node.clientTop + node.clientHeight - bounds.bottom,
              width: bounds.width,
              left: bounds.left,
              viewportLeft: viewport.left,
              rightOverflow:
                paper.getBoundingClientRect().right - (viewport.left + node.clientWidth),
            };
          }, zoom);
          expect(geometry.bottom, `${book}/${width}/${count}/${zoom}`).toBeGreaterThan(
            geometry.top,
          );
          // Short pages may not fill the viewport; long pages must not leave a blank tail.
          if (count > 1) expect(Math.abs(geometry.bottomGap - 20)).toBeLessThan(1.5);
          expect(geometry.width).toBeCloseTo(820 * zoom, 0);
          expect(geometry.left).toBeGreaterThanOrEqual(geometry.viewportLeft);
          expect(geometry.rightOverflow).toBeLessThan(1.5);
        }
      }
    }
  });
}

test("page ruler and rail share available width when expanded collapsed and resized", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${url}?book=description&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() => {
    const layout = document.querySelector(".patent-book-editor-layout");
    if (!layout) throw new Error("missing layout");
    const shell = document.createElement("div");
    shell.className = "patent-drafting-shell";
    layout.before(shell);
    shell.append(layout);
  });
  const scope = page.locator('.patent-function-rail-scope[data-function-rail-scope="single"]');
  const slot = page.locator(".patent-global-function-rail-slot");
  for (const [width, zoom, mode] of [
    [1500, 125, "docked"],
    [1403, 125, "overlay"],
    [1300, 100, "docked"], // Recovered space resumes automatic docking.
    [1000, 100, "overlay"],
    [1500, 125, "docked"],
  ] as const) {
    await scope.evaluate((node, value) => {
      node.style.width = `${value}px`;
    }, width);
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    await expect(slot).toHaveAttribute("data-layout", mode);
    const checkGeometry = async () => {
      // Paint the resized hidden window before reading rAF/ResizeObserver-driven geometry.
      await page.screenshot();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const layout = document
              .querySelector(".patent-page-with-rail")!
              .getBoundingClientRect();
            const paper = document
              .querySelector(".patent-page-zoom-frame")!
              .getBoundingClientRect();
            const ruler = document
              .querySelector(".document-structure-ruler")!
              .getBoundingClientRect();
            const rail = document.querySelector(".patent-global-function-rail-slot")!;
            const right =
              rail.getAttribute("data-layout") === "docked"
                ? rail.getBoundingClientRect().right
                : paper.right;
            return Math.max(0, right - layout.right, layout.left - ruler.left);
          }),
        )
        .toBeLessThan(1.5);
    };
    await checkGeometry();
    if (mode === "overlay") {
      await page.getByRole("button", { name: "展开功能栏", exact: true }).hover();
      await expect(slot).toHaveAttribute("data-expanded", "true");
      await checkGeometry();
      await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
      await page.getByRole("textbox", { name: "面板输入框" }).focus();
      await page.mouse.move(10, 850);
      await expect(slot).toHaveAttribute("data-layout", "overlay");
      await expect(slot).toHaveAttribute("data-expanded", "false");
      await checkGeometry();
    }
  }
});

test("smooth document zoom keeps its reading anchor and rail layout", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto(`${url}?book=description&layout=page&linked&smooth`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.evaluate(() => {
    window.typography.load(
      Array.from({ length: 100 }, (_, i) => `<p>第${i + 1}段：底座、支撑杆和连接组件。</p>`).join(
        "",
      ),
    );
  });
  const workspace = page.locator(".editor-workspace");
  await workspace.evaluate((node) => {
    node.scrollTop = 1800;
  });
  for (const [zoom, mode] of [
    [150, "overlay"],
    [100, "docked"],
  ] as const) {
    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".editor-workspace")!;
      const layout = viewport.querySelector<HTMLElement>(".patent-page-with-rail")!;
      const paper = layout.querySelector<HTMLElement>(".patent-page-zoom-frame")!;
      const readingPoint = () => viewport.getBoundingClientRect().top + viewport.clientHeight / 3;
      const startScale = Number(layout.style.getPropertyValue("--patent-page-zoom"));
      const anchor = (readingPoint() - paper.getBoundingClientRect().top) / startScale;
      viewport.dataset.samples = "0";
      viewport.dataset.maxDrift = "0";
      const listener = () => {
        const scale = Number(layout.style.getPropertyValue("--patent-page-zoom"));
        viewport.dataset.samples = String(Number(viewport.dataset.samples) + 1);
        const drift = Math.abs(paper.getBoundingClientRect().top + anchor * scale - readingPoint());
        viewport.dataset.maxDrift = String(Math.max(Number(viewport.dataset.maxDrift), drift));
        if (scale === Number(viewport.dataset.targetScale))
          layout.removeEventListener("patent-document-zoom-frame", listener);
      };
      layout.addEventListener("patent-document-zoom-frame", listener);
    });
    await workspace.evaluate((node, value) => {
      node.dataset.targetScale = String(value / 100);
    }, zoom);
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    await expect
      .poll(() =>
        page
          .locator(".patent-page-with-rail")
          .evaluate((node) =>
            Number((node as HTMLElement).style.getPropertyValue("--patent-page-zoom")),
          ),
      )
      .toBe(zoom / 100);
    expect(Number(await workspace.getAttribute("data-samples"))).toBeGreaterThanOrEqual(2);
    expect(Number(await workspace.getAttribute("data-max-drift"))).toBeLessThan(3);
    await expect(page.locator(".patent-global-function-rail-slot")).toHaveAttribute(
      "data-layout",
      mode,
    );
  }
});

test("rail reservation animates page and ruler together without animating page width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.setContent(
    '<div class="patent-page-with-rail" data-structure-ruler="true" style="width:1500px"><aside class="document-structure-ruler" data-mode="wide"></aside><main class="patent-page-zoom-frame" style="height:100px"></main><aside class="patent-global-function-rail-slot" data-layout="docked"></aside></div>',
  );
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  for (const mode of ["overlay", "docked"]) {
    const result = await page.evaluate((mode) => {
      const layout = document.querySelector<HTMLElement>(".patent-page-with-rail")!;
      const paper = document.querySelector<HTMLElement>(".patent-page-zoom-frame")!;
      const ruler = document.querySelector<HTMLElement>(".document-structure-ruler")!;
      const before = paper.getBoundingClientRect().left;
      document
        .querySelector(".patent-global-function-rail-slot")!
        .setAttribute("data-layout", mode);
      void layout.offsetWidth;
      const animation = layout.getAnimations()[0];
      if (!animation) return null;
      animation.pause();
      const duration = Number(animation.effect!.getTiming().duration);
      const samples = [0, duration / 2, duration].map((time) => {
        animation.currentTime = time;
        return {
          left: paper.getBoundingClientRect().left,
          rulerRight: ruler.getBoundingClientRect().right,
          width: paper.getBoundingClientRect().width,
        };
      });
      animation.finish();
      return { before, samples, duration };
    }, mode);
    expect(result).not.toBeNull();
    expect(result!.duration).toBe(400);
    const [start, middle, end] = result!.samples;
    expect(Math.abs(start!.left - result!.before)).toBeLessThan(1);
    expect(Math.abs(end!.left - start!.left)).toBeCloseTo(146, 0);
    expect(middle!.left).toBeGreaterThan(Math.min(start!.left, end!.left));
    expect(middle!.left).toBeLessThan(Math.max(start!.left, end!.left));
    for (const sample of result!.samples) {
      expect(sample.width).toBeCloseTo(820, 0);
      expect(sample.left - sample.rulerRight).toBeCloseTo(0, 0);
    }
  }
});

test("rail uses the outer twelve pixel margins before collapsing and keeps recovery hysteresis", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${url}?book=description&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  const scope = page.locator('.patent-function-rail-scope[data-function-rail-scope="single"]');
  const rail = page.locator(".patent-global-function-rail-slot");
  for (const zoom of [100, 125]) {
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    const threshold = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>(".editor-workspace")!;
      const layout = document.querySelector<HTMLElement>(".patent-page-with-rail")!;
      const paper = document.querySelector(".patent-page-zoom-frame")!.getBoundingClientRect();
      const ruler = Number.parseFloat(getComputedStyle(layout).gridTemplateColumns);
      return paper.width + ruler + 292 + 24 + workspace.offsetWidth - workspace.clientWidth;
    });
    const resize = (extra: number) =>
      scope.evaluate((node, width) => {
        node.style.width = `${width}px`;
      }, threshold + extra);
    await resize(20);
    await expect(rail).toHaveAttribute("data-layout", "docked");
    await resize(1);
    await expect(rail).toHaveAttribute("data-layout", "docked");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = document.querySelector<HTMLElement>(".editor-workspace")!;
          const layout = document.querySelector<HTMLElement>(".patent-page-with-rail")!;
          const paper = document.querySelector(".patent-page-zoom-frame")!.getBoundingClientRect();
          const rail = document
            .querySelector(".patent-global-function-rail-slot")!
            .getBoundingClientRect();
          const left =
            paper.left -
            Number.parseFloat(getComputedStyle(layout).gridTemplateColumns) -
            workspace.getBoundingClientRect().left;
          const right = workspace.getBoundingClientRect().left + workspace.clientWidth - rail.right;
          return Math.max(Math.abs(left - 12.5), Math.abs(right - 12.5));
        }),
      )
      .toBeLessThan(1);
    await resize(-2);
    await expect(rail).toHaveAttribute("data-layout", "overlay");
    await resize(1);
    await expect(rail).toHaveAttribute("data-layout", "overlay");
    await resize(14);
    await expect(rail).toHaveAttribute("data-layout", "docked");
  }
});

test("dual view opening fits the paper ruler and rail to the actual pane width", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Load the real layout before mounting, as the application does. Injecting it
  // afterwards would first measure an unstyled page and enter recovery hysteresis.
  await page.route("**/editor-typography.html?**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "</head>",
        '<link rel="stylesheet" href="/src/renderer/src/app/app.css"></head>',
      ),
    });
  });
  for (const width of [1280, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${url}?book=description&layout=page&linked&dualWidth=${width}`);
    await page.waitForFunction(() => window.typography?.ready());
    await expect(page.locator(".patent-global-function-rail-slot")).toHaveAttribute(
      "data-layout",
      width < 2560 ? "overlay" : "docked",
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = document.querySelector<HTMLElement>(".editor-workspace")!;
          const layout = document.querySelector<HTMLElement>(".patent-page-with-rail")!;
          const paper = document.querySelector(".patent-page-zoom-frame")!.getBoundingClientRect();
          const ruler = Number.parseFloat(getComputedStyle(layout).gridTemplateColumns);
          const rail = document.querySelector(".patent-global-function-rail-slot")!;
          const railWidth = rail.getAttribute("data-layout") === "docked" ? 292 : 48;
          const remaining = workspace.clientWidth - 24 - ruler - railWidth - paper.width;
          return (
            remaining >= -0.1 &&
            remaining < (210 * 96) / 25.4 / 100 + 1 &&
            workspace.scrollWidth <= workspace.clientWidth
          );
        }),
      )
      .toBe(true);
  }
});

test("function rail keeps its inert panel through exit motion before hiding it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${url}?book=description&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.getByRole("button", { name: "展开功能栏" }).click();
  for (const name of ["固定", "收起功能栏"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toHaveCSS("width", "30px");
    await expect(button).toHaveCSS("height", "30px");
    await expect(button).toHaveCSS("border-radius", "6px");
    await expect(button.locator("svg")).toHaveCSS("width", "16px");
  }
  const result = await page.evaluate(async () => {
    const rail = document.querySelector<HTMLElement>(".patent-global-function-rail")!;
    await Promise.all(rail.getAnimations().map((animation) => animation.finished));
    const started = new Promise((resolve) =>
      rail.addEventListener(
        "transitionrun",
        () => {
          resolve({
            inert: rail.inert,
            hidden: rail.hidden,
            duration: getComputedStyle(rail).transitionDuration.split(", "),
            easing: getComputedStyle(rail).transitionTimingFunction.split(", "),
          });
        },
        { once: true },
      ),
    );
    rail.querySelector<HTMLButtonElement>('[aria-label="收起功能栏"]')!.click();
    return started;
  });
  expect(result).toEqual({
    inert: true,
    hidden: false,
    duration: ["0.6s", "0.6s", "0.6s"],
    easing: ["ease-in-out", "ease-in-out", "ease-in-out"],
  });
  await expect(page.locator(".patent-global-function-rail")).toBeHidden();
});

test("automatic rail collapse exits rightward from its docked screen position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${url}?book=description&layout=page&linked`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await expect(page.locator(".patent-global-function-rail-slot")).toHaveAttribute(
    "data-layout",
    "docked",
  );
  const drift = await page.evaluate(async () => {
    const rail = document.querySelector<HTMLElement>(".patent-global-function-rail")!;
    await Promise.all(rail.getAnimations().map((a) => a.finished));
    await new Promise(requestAnimationFrame);
    const sample = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        const exiting = document.querySelector<HTMLElement>(
          '.patent-global-function-rail[data-motion="exit"]',
        );
        if (!exiting) return;
        observer.disconnect();
        if (
          exiting.closest(".patent-global-function-rail-slot")?.getAttribute("data-layout") !==
            "docked" ||
          exiting.querySelector(".patent-global-function-rail__header")
        ) {
          resolve(-998);
          return;
        }
        if (getComputedStyle(exiting).position !== "fixed") {
          observer.disconnect();
          resolve(-999);
          return;
        }
        // Compare against the captured pre-layout-switch anchor, not the page's
        // position before the zoom (the page itself is allowed to move).
        const before = Number.parseFloat(exiting.style.left);
        let minimum = exiting.getBoundingClientRect().left - before;
        const sampleFrame = () => {
          const current = document.querySelector<HTMLElement>(
            '.patent-global-function-rail[data-motion="exit"]',
          );
          if (!current) {
            resolve(minimum);
            return;
          }
          minimum = Math.min(minimum, current.getBoundingClientRect().left - before);
          requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    const select = document.querySelector<HTMLSelectElement>('[aria-label="测试缩放"]')!;
    select.value = "125";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return sample;
  });
  expect(drift).toBeGreaterThanOrEqual(-1);
  expect(drift).toBeLessThan(20);
});

test("zoomed page caret hit testing and typing stay aligned", async ({ page }) => {
  await page.goto(`${url}?book=description&layout=page`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  for (const zoom of [0.5, 0.8, 1.5, 2]) {
    await page.evaluate((value) => {
      document
        .querySelector<HTMLElement>(".patent-page-with-rail")
        ?.style.setProperty("--patent-page-zoom", String(value));
      window.typography.load(
        Array.from({ length: 100 }, (_, i) => `<p>第${i + 1}段：底座、支撑杆和连接组件。</p>`).join(
          "",
        ),
      );
    }, zoom);
    await page.locator(".patent-prosemirror").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+End");
    const last = page.locator(".patent-prosemirror p").last();
    await expect(last).toBeInViewport();
    const point = await last.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.insertText("定位验证");
    await expect(last).toContainText("定位验证");
  }
});

test("drawing workbench ruler leaves no blank scroll tail and keeps rail navigation linked", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 300;
    const bytes = Array.from(atob(canvas.toDataURL("image/png").split(",")[1] ?? ""), (c) =>
      c.charCodeAt(0),
    );
    Object.defineProperty(window, "patentApi", {
      value: { assets: { getPreview: async () => ({ ok: true, value: bytes }) } },
    });
  });
  await page.goto(`${url}?layout=drawings`);
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  await page.addStyleTag({
    content: await readFile(
      "src/renderer/src/patents/function-rail/function-rail-appearance.css",
      "utf8",
    ),
  });
  await expect(page.locator(".drawing-figure-frame img")).toHaveCount(9);
  await expect
    .poll(() =>
      page
        .locator(".drawing-figure-frame img")
        .last()
        .evaluate((img: HTMLImageElement) => img.naturalHeight),
    )
    .toBe(300);
  const scope = page.locator('.patent-function-rail-scope[data-function-rail-scope="single"]');
  const workspace = page.locator(".editor-workspace");
  const slot = page.locator(".patent-global-function-rail-slot");
  for (const [width, zoom, layout] of [
    [1300, 100, "docked"],
    [1300, 50, "docked"],
    [600, 150, "overlay"],
    [1300, 100, "docked"],
  ] as const) {
    await scope.evaluate((node, value) => {
      node.style.width = `${value}px`;
    }, width);
    await page.getByRole("combobox", { name: "测试缩放" }).selectOption(String(zoom));
    await expect(slot).toHaveAttribute("data-layout", layout);
    await page.mouse.move(10, 850);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const row = document
            .querySelector('.drawing-pair-row[data-figure-id="figure-9"]')
            ?.getBoundingClientRect();
          const paper = document.querySelector(".drawing-page")?.getBoundingClientRect();
          const marker = document.querySelector<HTMLElement>('[aria-label="定位到图9"]');
          if (!row || !paper || !marker) return 1000;
          return Math.abs(
            Number.parseFloat(marker.style.top) - (row.top - paper.top + (row.height - 22) / 2),
          );
        }),
      )
      .toBeLessThan(1.5);
    // Wait for the ruler's height transition, not just its target inline style.
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "定位到图9", exact: true })
          .evaluate((node) =>
            Math.abs(node.getBoundingClientRect().height - Number.parseFloat(node.style.height)),
          ),
      )
      .toBeLessThan(0.1);
    await expect
      .poll(async () =>
        workspace.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          const paper = node.querySelector(".drawing-page")?.getBoundingClientRect();
          if (!paper) throw new Error("missing drawing page");
          return Math.abs(node.getBoundingClientRect().top + node.clientHeight - paper.bottom - 20);
        }),
      )
      .toBeLessThan(1.5);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const paper = document.querySelector(".drawing-page")?.getBoundingClientRect();
          const ruler = document
            .querySelector(".document-structure-ruler")
            ?.getBoundingClientRect();
          if (!paper || !ruler) throw new Error("missing drawing ruler");
          return Math.max(Math.abs(paper.top - ruler.top), Math.abs(paper.height - ruler.height));
        }),
      )
      .toBeLessThan(2);
    if (layout === "overlay") {
      await page.getByRole("button", { name: "展开功能栏", exact: true }).click();
      await page.getByRole("button", { name: "固定", exact: true }).click();
    }
    // Start with no selection: mounting image settings must not invalidate the scroll target.
    await page.getByRole("button", { name: "定位到图9", exact: true }).click();
    await expect(page.locator('.drawing-pair-row[data-figure-id="figure-9"]')).toBeInViewport();
    await expect(page.getByRole("button", { name: "选择图9", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.getByRole("button", { name: "选择图9", exact: true }).click();
    await expect(page.getByRole("button", { name: "选择图9", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const explanation = page.locator('.drawing-explanation-card[data-figure-id="figure-9"]');
    await expect(explanation).toBeInViewport();
    await explanation.click();
    await expect(page.locator('.drawing-pair-row[data-figure-id="figure-9"]')).toBeInViewport();
    if (layout === "overlay") {
      await page.getByRole("button", { name: "收起功能栏", exact: true }).click();
      await page.mouse.move(10, 850);
      await expect(slot).toHaveAttribute("data-expanded", "false");
    }
    await page.keyboard.press("Escape");
  }
});

test("zoomed drawing pages end at the visible scroll bottom", async ({ page }) => {
  await page.setContent(
    '<main class="editor-workspace patent-editor-workspace" style="height:700px"><div class="drawing-editor-layout"><div class="patent-page-with-rail" data-structure-ruler-offset="true"><main class="drawing-page patent-page-zoom-frame"></main></div></div></main>',
  );
  await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
  for (const className of [
    "drawing-page patent-page-zoom-frame",
    "drawings-editor patent-page-zoom-frame",
  ]) {
    for (const zoom of [0.5, 0.8, 0.9, 1, 1.5, 2]) {
      const geometry = await page.evaluate(
        ({ className, zoom }) => {
          const workspace = document.querySelector<HTMLElement>(".editor-workspace");
          const layout = document.querySelector<HTMLElement>(".patent-page-with-rail");
          const paper = document.querySelector<HTMLElement>(".patent-page-zoom-frame");
          if (!workspace || !layout || !paper) throw new Error("missing drawing page");
          paper.className = className;
          paper.innerHTML = '<div style="height:3000px">附图布局测试</div>';
          layout.style.setProperty("--patent-page-zoom", String(zoom));
          workspace.scrollTop = workspace.scrollHeight;
          return {
            gap:
              workspace.getBoundingClientRect().top +
              workspace.clientHeight -
              paper.getBoundingClientRect().bottom,
            width: paper.getBoundingClientRect().width,
          };
        },
        { className, zoom },
      );
      expect(Math.abs(geometry.gap - 20)).toBeLessThan(1.5);
      expect(geometry.width).toBeCloseTo(820 * zoom, 0);
    }
  }
});

for (const book of ["claims", "description", "abstract"]) {
  test(`${book}: paragraph alignment also applies to the last line`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?book=${book}`);
    await page.waitForFunction(() => window.typography?.ready());
    await page.evaluate(() => window.typography.load("<p>短标题</p>"));
    for (const alignment of ["center", "right", "left"] as const) {
      await page.evaluate((value) => window.typography.align(value), alignment);
      const geometry = await page.evaluate(() => ({
        bounds: window.typography.bounds(),
        line: window.typography.lines()[0],
      }));
      const { bounds, line } = geometry;
      if (!line) throw new Error("missing title line");
      if (alignment === "center")
        expect(
          Math.abs((line.left + line.right) / 2 - (bounds.left + bounds.right) / 2),
        ).toBeLessThan(2);
      if (alignment === "right") expect(Math.abs(line.right - bounds.right)).toBeLessThan(2);
      if (alignment === "left") expect(Math.abs(line.left - bounds.left)).toBeLessThan(2);
    }
    expect(errors).toEqual([]);
  });
  test(`${book}: paste has no delayed layout change`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?book=${book}`);
    await page.waitForFunction(() => window.typography?.ready());
    const original = await page.evaluate(() => window.typography.json());
    await page.evaluate(() => window.typography.all());
    const before = await page.evaluate(
      (html) => window.typography.paste(html, "合成排版测试"),
      paragraphs,
    );
    // Wait beyond the old 120 ms measurement timer and React's document echo.
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.typography.lines())).toEqual(before);
    const pasted = await page.evaluate(() => window.typography.json());
    expect(await page.evaluate(() => window.typography.undo())).toBe(true);
    await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(original);
    expect(await page.evaluate(() => window.typography.redo())).toBe(true);
    await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(pasted);
    expect(errors).toEqual([]);
  });
}

test("line-end clicks keep the caret on the clicked line, including the paper margin", async ({
  page,
}) => {
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate((html) => window.typography.load(html), paragraphs);
  await page.waitForTimeout(300);
  for (const keyword of [false, true]) {
    await page.evaluate((enabled) => {
      window.typography.keyword(enabled);
      const paper = document.getElementById("paper");
      if (!paper) throw new Error("missing paper");
      paper.style.transformOrigin = "top center";
      paper.style.transform = enabled ? "scale(1.15)" : "scale(1)";
    }, keyword);
    const geometry = await page.evaluate(() => ({
      bounds: window.typography.bounds(),
      lines: window.typography.lines().slice(0, 10),
    }));
    for (const line of geometry.lines.filter((_, index) => index % 2 === 0)) {
      for (const x of [line.right - 1, geometry.bounds.right + 25]) {
        await page.mouse.click(x, (line.top + line.bottom) / 2);
        await expect
          .poll(async () => {
            const top = await page.evaluate(() => window.typography.selection().top);
            // Display-only smaller keywords have slightly different glyph rectangles.
            return top === null ? Infinity : Math.abs(top - line.top);
          })
          .toBeLessThan(3);
        // A collapsed DOM Range can report BOTH sides of a soft wrap. Home tests
        // the browser's actual visual caret affinity, not only that Range's first rect.
        await page.keyboard.press("Shift+Home");
        await expect
          .poll(
            () =>
              page.evaluate(() => ({
                from: window.typography.selection().from,
                to: window.typography.selection().to,
              })),
            {
              message: `line ${line.from}-${line.to}, x offset from edge ${x - geometry.bounds.right}`,
            },
          )
          .toEqual({ from: line.from, to: line.to });
      }
    }
  }
});

test("a backward margin drag retains its anchor and direction", async ({ page }) => {
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate((html) => window.typography.load(html), paragraphs);
  const { bounds, lines } = await page.evaluate(() => ({
    bounds: window.typography.bounds(),
    lines: window.typography.lines(),
  }));
  const start = lines[2];
  const end = lines[0];
  if (!start || !end) throw new Error("missing drag target lines");
  await page.mouse.move(bounds.right + 25, (start.top + start.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.left + 1, (end.top + end.bottom) / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        anchor: window.typography.selection().anchor,
        head: window.typography.selection().head,
      })),
    )
    .toEqual({ anchor: start.to, head: end.from });
});

test("keyword display and resizing are immediate and do not change copied text or history", async ({
  page,
}) => {
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate((html) => window.typography.load(html), paragraphs);
  const before = await page.evaluate(() => {
    window.typography.all();
    return {
      json: window.typography.json(),
      clipboard: window.typography.clipboard(),
      history: window.typography.history(),
    };
  });
  for (const width of [480, 630]) {
    for (const enabled of [true, false]) {
      const immediate = await page.evaluate(
        ({ width, enabled }) => {
          const paper = document.getElementById("paper");
          if (!paper) throw new Error("missing paper");
          paper.style.width = `${width}px`;
          window.typography.keyword(enabled);
          return window.typography.lines();
        },
        { width, enabled },
      );
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => window.typography.lines())).toEqual(immediate);
      expect(
        await page.evaluate(() => ({
          json: window.typography.json(),
          clipboard: window.typography.clipboard(),
          history: window.typography.history(),
        })),
      ).toEqual(before);
    }
  }
});

test("composition is not reflowed by a delayed punctuation task", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() => window.typography.load("<p>输入测试：</p>"));
  const bounds = await page.evaluate(() => window.typography.bounds());
  await page.mouse.click(bounds.left + 70, bounds.top + 10);
  await page.keyboard.press("End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "中文，", selectionStart: 3, selectionEnd: 3 });
  const composing = await page.evaluate(() => ({
    text: window.typography.text(),
    lines: window.typography.lines(),
  }));
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(() => ({
      text: window.typography.text(),
      lines: window.typography.lines(),
    })),
  ).toEqual(composing);
  await cdp.send("Input.insertText", { text: "中文，" });
  await expect.poll(() => page.evaluate(() => window.typography.text())).toBe("输入测试：中文，");
  expect(errors).toEqual([]);
});

test("larger selected text uses proportional line spacing without changing the spacing multiple", async ({
  page,
}) => {
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() =>
    window.typography.load("<p>字号调整测试<br>第二行文字<br>第三行文字</p>"),
  );
  const original = await page.evaluate(() => window.typography.json());
  await page.evaluate(() => {
    window.typography.all();
    window.typography.fontSize(28);
  });
  const metrics = await page.evaluate(() => {
    const paragraph = document.querySelector(".patent-prosemirror p");
    const span = paragraph?.querySelector("span[data-font-size-pt]");
    if (!paragraph || !span) throw new Error("missing enlarged text");
    const lines = window.typography.lines();
    if (!lines[0] || !lines[1]) throw new Error("missing enlarged text lines");
    return {
      fontSize: Number.parseFloat(getComputedStyle(span).fontSize),
      lineDistance: lines[1].top - lines[0].top,
      paragraphFont: paragraph.getAttribute("data-default-font-size-pt"),
      lineSpacing: paragraph.getAttribute("data-line-height"),
    };
  });
  expect(metrics.paragraphFont).toBe("28");
  expect(metrics.lineSpacing).toBe("1.5");
  expect(metrics.lineDistance).toBeCloseTo(metrics.fontSize * lineSpacingToCssLineHeight(1.5), 0);
  const enlarged = await page.evaluate(() => window.typography.json());
  expect(await page.evaluate(() => window.typography.undo())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(original);
  expect(await page.evaluate(() => window.typography.redo())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(enlarged);
});

test("mixed text spacing matches the print renderer at different display scales", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  for (const scale of [1, 1.25, 1.5]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await page.goto(`${url}?book=description`);
    await page.waitForFunction(() => window.typography?.ready());
    await page.evaluate(() =>
      window.typography.load(
        "<p>普通正文PLC控制器，温度25℃。<br>第二行正文。</p>" +
          '<p style="text-align:justify">混合字号<span style="font-size:28pt">较大的技术名称</span>及其结构。<br>下一行正常文字。</p>' +
          '<p><span style="font-size:28pt">连续较大文字<br>第二行较大文字</span></p>',
      ),
    );
    const saved = await page.evaluate(() => window.typography.saved());
    const printHtml = await renderPrintHtml(saved, [], { includeDocumentHeader: false });
    const geometry = await page.evaluate(async (html) => {
      await document.fonts.ready;
      const editor = document.querySelector<HTMLElement>(".patent-prosemirror");
      if (!editor) throw new Error("missing editor");
      const frame = document.createElement("iframe");
      frame.style.cssText = `width:${editor.getBoundingClientRect().width}px;height:800px;border:0`;
      const ready = new Promise<void>((resolve) => {
        frame.onload = () => resolve();
      });
      frame.srcdoc = html;
      document.body.append(frame);
      await ready;
      const printed = frame.contentDocument;
      if (!printed) throw new Error("missing print document");
      await printed.fonts.ready;
      const heights = (root: ParentNode) =>
        Array.from(
          root.querySelectorAll("p"),
          (paragraph) => paragraph.getBoundingClientRect().height,
        );
      const result = { editor: heights(editor), print: heights(printed) };
      frame.remove();
      return result;
    }, printHtml);
    expect(geometry.editor).toHaveLength(3);
    geometry.editor.forEach((height, index) => {
      expect(height).toBeCloseTo(geometry.print[index] ?? 0, 0);
    });
    expect(await page.evaluate(() => window.typography.saved().content)).toEqual(saved.content);
  }
});

test("mixed Chinese punctuation and Latin identifiers retain natural wrapping and a short last line", async ({
  page,
}) => {
  await page.goto(url);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() =>
    window.typography.load(
      `<p style="text-align:justify">${"控制器（PLC）驱动电机，温度为25℃；传感器反馈“正常”信号。".repeat(6)}结束。</p>`,
    ),
  );
  const result = await page.evaluate(() => ({
    lines: window.typography.lines(),
    bounds: window.typography.bounds(),
  }));
  expect(result.lines.length).toBeGreaterThan(3);
  for (const line of result.lines) {
    expect(line.text).not.toMatch(/^[，。；：！？、）”]/u);
    expect(line.text).not.toMatch(/[（“]$/u);
    expect(line.right).toBeLessThanOrEqual(result.bounds.right + 1);
    if (line.text.includes("P") || line.text.includes("L") || line.text.includes("C"))
      expect(line.text).toContain("PLC");
  }
  const last = result.lines.at(-1);
  expect(last).toBeDefined();
  expect((last?.right ?? 0) - (last?.left ?? 0)).toBeLessThan(
    result.bounds.right - result.bounds.left - 10,
  );
});

test("large mixed documents retain input, formula content and undo during spacing changes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}?book=description`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() =>
    window.typography.load(
      '<p>首段x<sup>2</sup>，H<sub>2</sub>O；公式<span data-type="inline-math" data-latex="x^2"></span>。</p>' +
        Array.from(
          { length: 700 },
          (_, i) =>
            `<p>${i}：控制器PLC通过传感器采集信号，温度为25℃，按照预设条件执行操作并记录结果。${"专利正文".repeat(5)}</p>`,
        ).join(""),
    ),
  );
  expect((await page.evaluate(() => window.typography.text())).length).toBeGreaterThan(40_000);
  await page.locator(".patent-prosemirror").focus();
  await page.keyboard.press("Control+End");
  const before = await page.evaluate(() => window.typography.text());
  const inserted = "连续输入，编号123；".repeat(20);
  await page.keyboard.insertText(inserted);
  await expect.poll(() => page.evaluate(() => window.typography.text())).toBe(before + inserted);
  const original = await page.evaluate(() => window.typography.json());
  await page.evaluate(() => {
    window.typography.all();
    window.typography.fontSize(18);
  });
  const formatted = await page.evaluate(() => window.typography.json());
  expect(await page.evaluate(() => window.typography.undo())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(original);
  expect(await page.evaluate(() => window.typography.redo())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.typography.json())).toEqual(formatted);
  expect(await page.evaluate(() => window.typography.text())).toBe(before + inserted);
  await expect(page.locator(".patent-prosemirror .katex")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("12px KaTeX_Main"))).toBe(true);
  expect(errors).toEqual([]);
});

test("superscripts and subscripts keep normal line spacing and inline fractions do not overlap the next line", async ({
  page,
}) => {
  await page.goto(`${url}?book=description`);
  await page.waitForFunction(() => window.typography?.ready());
  await page.evaluate(() =>
    window.typography.load(
      "<p>正常行文字<br>第二行文字</p><p>x<sup>2</sup>和H<sub>2</sub>O<br>第二行文字</p>" +
        '<p>公式<span data-type="inline-math" data-latex="\\frac{x}{y}"></span><br>第二行文字</p>',
    ),
  );
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => {
    const paragraphs = document.querySelectorAll(".patent-prosemirror p");
    const plain = paragraphs[0];
    const scripts = paragraphs[1];
    const formula = paragraphs[2];
    const math = formula?.querySelector(".katex");
    if (!plain || !scripts || !formula?.lastChild || !math)
      throw new Error("missing formula sample");
    const range = document.createRange();
    range.selectNodeContents(formula.lastChild);
    return {
      plain: plain.getBoundingClientRect().height,
      scripts: scripts.getBoundingClientRect().height,
      formulaBottom: math.getBoundingClientRect().bottom,
      nextLineTop: range.getBoundingClientRect().top,
    };
  });
  expect(metrics.scripts).toBeCloseTo(metrics.plain, 0);
  expect(metrics.formulaBottom).toBeLessThanOrEqual(metrics.nextLineTop);
});

for (const size of [9, 10.5, 12, 14]) {
  test(`whole paragraph ${size}pt shrinks line height and matches print`, async ({ page }) => {
    await page.goto(url);
    await page.waitForFunction(() => window.typography?.ready());
    await page.evaluate(() =>
      window.typography.load("<p>字号调整测试<br>第二行文字<br>第三行文字</p>"),
    );
    await page.evaluate((size) => {
      window.typography.all();
      window.typography.fontSize(size);
    }, size);
    const metrics = await page.evaluate(() => {
      const p = document.querySelector(".patent-prosemirror p")!;
      const lines = window.typography.lines();
      return {
        font: parseFloat(getComputedStyle(p).fontSize),
        distance: lines[1]!.top - lines[0]!.top,
      };
    });
    expect(metrics.font).toBeCloseTo((size * 96) / 72, 1);
    expect(metrics.distance).toBeCloseTo(metrics.font * lineSpacingToCssLineHeight(1.5), 0);
    const saved = await page.evaluate(() => window.typography.saved());
    const html = await renderPrintHtml(saved, [], { includeDocumentHeader: false });
    const printed = await page.evaluate(async (html) => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      frame.contentDocument!.open();
      frame.contentDocument!.write(html);
      frame.contentDocument!.close();
      await frame.contentDocument!.fonts.ready;
      const p = frame.contentDocument!.querySelector("p")!;
      const walker = frame.contentDocument!.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const tops: number[] = [];
      while (walker.nextNode()) {
        const range = frame.contentDocument!.createRange();
        range.selectNodeContents(walker.currentNode);
        tops.push(range.getBoundingClientRect().top);
      }
      const result = {
        font: parseFloat(frame.contentWindow!.getComputedStyle(p).fontSize),
        distance: tops[1]! - tops[0]!,
      };
      frame.remove();
      return result;
    }, html);
    expect(printed.font).toBeCloseTo(metrics.font, 1);
    expect(printed.distance).toBeCloseTo(metrics.distance, 0);
  });
}

for (const kind of ["text", "highlight"] as const) {
  for (const method of ["HEX", "RGB", "drag"] as const) {
    test(`${kind} ${method}: inline color popup preserves direct selection and rounded bounds`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`${url}?colors`);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.waitForFunction(() => window.typography.ready());
      await page.addStyleTag({ content: await readFile("src/renderer/src/app/app.css", "utf8") });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => {
        window.typography.load("<p>测试选中文字</p>");
        window.typography.all();
      });
      if (method === "HEX") {
        await page.locator(".patent-prosemirror").evaluate((element) => {
          const editor = (element as HTMLElement & { editor: Editor }).editor;
          editor.view.focus();
          editor.commands.setTextSelection({ from: 1, to: 5 });
        });
      }
      const toolbar =
        method === "HEX"
          ? page.getByRole("toolbar", { name: "选区格式" })
          : page.locator(".tool-bar");
      await toolbar
        .getByRole("button", {
          name: kind === "text" ? "打开文字颜色菜单" : "打开文本突出显示颜色菜单",
        })
        .click();
      await toolbar
        .getByRole("button", {
          name: kind === "text" ? "其他颜色" : "其他突出显示颜色",
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", {
        name: kind === "text" ? "其他颜色" : "其他突出显示颜色",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          radius: style.borderTopLeftRadius,
          border: style.borderTopWidth,
          shadow: style.boxShadow,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      expect(geometry.radius).toBe("12px");
      expect(geometry.border).toBe("0px");
      expect(geometry.shadow).not.toContain("0px 0px 0px");
      await dialog.screenshot({ path: testInfo.outputPath("custom-color.png") });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(1280);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(720);
      if (method === "HEX") {
        await dialog.getByLabel("HEX").fill("#123ABC");
        await dialog.getByLabel("HEX").press("Enter");
      } else if (method === "RGB") {
        await dialog.getByLabel("R", { exact: true }).fill("235");
        await dialog.getByLabel("G", { exact: true }).fill("80");
        await dialog.getByLabel("B", { exact: true }).fill("60");
        await dialog.getByLabel("B", { exact: true }).press("Enter");
      } else {
        const area = await dialog.getByRole("slider", { name: "饱和度与亮度" }).boundingBox();
        if (!area) throw Error("missing saturation area");
        await page.mouse.move(area.x + 20, area.y + 20);
        await page.mouse.down();
        await page.mouse.move(area.x + 100, area.y + 80, { steps: 5 });
        await expect(dialog).toBeVisible();
        await page.mouse.up();
      }
      await expect(dialog).toBeVisible();
      const markup = await page.locator(".patent-prosemirror").innerHTML();
      const property = kind === "text" ? "color" : "background-color";
      if (method === "drag") expect(markup).toContain(`${property}: rgb(`);
      else
        expect(markup).toContain(
          `${property}: ${method === "HEX" ? "rgb(18, 58, 188)" : "rgb(235, 80, 60)"}`,
        );
      if (method === "HEX") {
        await page.evaluate(() => {
          (window as Window & { EyeDropper?: unknown }).EyeDropper = class {
            open() {
              return new Promise((resolve) =>
                setTimeout(() => {
                  window.dispatchEvent(new Event("blur"));
                  resolve({ sRGBHex: "#112233" });
                }, 20),
              );
            }
          };
        });
        // Reload the popup's capability check without touching native OS input.
        await dialog.getByLabel("HEX").press("Escape");
        await toolbar
          .getByRole("button", {
            name: kind === "text" ? "其他颜色" : "其他突出显示颜色",
            exact: true,
          })
          .click();
        await dialog.getByRole("button", { name: "屏幕取色" }).click();
        await expect(dialog.getByLabel("HEX")).toHaveValue("#112233");
        await expect(dialog).toBeVisible();
      }
      await dialog.getByLabel("R", { exact: true }).fill("128");
      await dialog.getByLabel("G", { exact: true }).fill("64");
      await dialog.getByLabel("B", { exact: true }).fill("32");
      await expect(dialog.getByLabel("B", { exact: true })).toBeFocused();
      await expect(dialog).toBeVisible();
      expect(await page.locator(".patent-prosemirror").innerHTML()).toContain(
        `${property}: rgb(128, 64, 32)`,
      );
      const selected = await page.evaluate(() => window.typography.selection());
      expect(selected.from).toBeLessThan(selected.to);
      await dialog.getByLabel("B", { exact: true }).press("Escape");
      await expect(dialog).toHaveCount(0);
      await toolbar
        .getByRole("button", {
          name: kind === "text" ? "其他颜色" : "其他突出显示颜色",
          exact: true,
        })
        .click();
      await expect(dialog.getByLabel("HEX")).toHaveValue("#804020");
      await page.mouse.click(1200, 700);
      await expect(dialog).toHaveCount(0);
    });
  }
}
