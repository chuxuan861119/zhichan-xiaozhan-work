import { readFileSync } from "node:fs";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";

const { beforeAll, afterAll, beforeEach, afterEach } = test;

let browser: Browser;
let page: Page;
const cssFiles = [
  "src/renderer/src/editor/editor.css",
  "src/renderer/src/app/app.css",
  "src/renderer/src/shared/standard-dialog.css",
  "src/renderer/src/shared/app-dialog.css",
];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1000, height: 720 }, reducedMotion: "reduce" });
});
afterEach(async () => {
  await page.close();
});

async function show(markup: string) {
  await page.setContent(
    `<html lang="zh-CN"><head><style>${cssFiles.map((path) => readFileSync(path, "utf8")).join("\n")}</style></head><body>${markup}</body></html>`,
  );
}

function standard(size: "s" | "xl" = "s") {
  // Layout fixtures use production CSS; component behavior is tested separately.
  return `<div class="standard-dialog-overlay"><div class="standard-dialog standard-dialog--${size}" role="dialog">
    <header class="standard-dialog__header"><h2 class="standard-dialog__title">确认移出标记</h2><button class="standard-dialog__close dialog-close-control"><svg class="dialog-close-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button></header>
    <div class="standard-dialog__body"><p>仅移出标记列表，不修改正文和编号。</p><p>${"需要保留的关键词".repeat(8)}</p></div>
    <footer class="standard-dialog__footer"><button>取消</button><button class="primary-button">确认移出</button></footer>
  </div></div>`;
}

for (const host of [
  "formula-dialog",
  "ai-model-editor",
  "application-settings-dialog__header",
  "snapshot-content-preview__header",
]) {
  test(`${host} shares the modal close control without changing on hover`, async () => {
    await show(
      `<section class="${host}" role="dialog"><button class="dialog-close-button snapshot-content-preview__close dialog-close-control" aria-label="关闭"><svg class="dialog-close-icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button></section>`,
    );
    const button = page.getByRole("button", { name: "关闭", exact: true });
    await page.locator(`.${host}`).evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    for (const hovered of [false, true]) {
      if (hovered) await button.hover();
      const shape = await button.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const icon = el.querySelector("svg")!.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          width: box.width,
          height: box.height,
          radius: style.borderRadius,
          dx: icon.x + icon.width / 2 - (box.x + box.width / 2),
          dy: icon.y + icon.height / 2 - (box.y + box.height / 2),
        };
      });
      expect(shape.width).toBeCloseTo(30, 1);
      expect(shape.height).toBeCloseTo(30, 1);
      expect(shape.radius).toBe("6px");
      expect(shape.dx).toBeCloseTo(0, 1);
      expect(shape.dy).toBeCloseTo(0, 1);
    }
  });
}

test("standard dialogs use explicit compact typography and a consistent action row", async () => {
  await show(standard());
  if (process.env.DIALOG_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.DIALOG_SCREENSHOT_DIR}/standard.png` });
  expect(
    await page.locator(".standard-dialog__title").evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("16px");
  expect(
    await page.locator(".standard-dialog__body").evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("14px");
  expect(
    await page
      .locator(".standard-dialog__footer button")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("13px");
  expect(
    await page
      .locator(".standard-dialog__footer button")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(34);
});

for (const size of ["s", "xl"] as const) {
  test(`${size} dialog keeps actions visible and text inside on small windows`, async () => {
    await page.setViewportSize({ width: 380, height: 320 });
    await show(standard(size));
    const bounds = await page.locator(".standard-dialog").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const footerElement = el.querySelector("footer");
      if (!footerElement) throw new Error("Missing dialog footer");
      const footer = footerElement.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        footerBottom: footer.bottom,
        overflow: el.scrollWidth > el.clientWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(380);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(320);
    expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.bottom);
    expect(bounds.overflow).toBe(false);
  });
}

test("legacy confirmation shell has the same title and button scale", async () => {
  await show(
    '<div class="dialog-backdrop"><section class="close-dialog dialog-with-standard-close" role="dialog"><button class="dialog-close-button dialog-close-button--corner">×</button><h2>保存更改</h2><p>是否保存当前文档的更改？</p><div class="dialog-actions"><button>取消</button><button class="primary-button">保存</button></div></section></div>',
  );
  if (process.env.DIALOG_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.DIALOG_SCREENSHOT_DIR}/legacy.png` });
  expect(await page.locator("h2").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  expect(
    await page
      .locator(".dialog-actions button")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("13px");
  expect(
    await page.locator(".dialog-close-button").evaluate((el) => el.getBoundingClientRect().width),
  ).toBe(30);
});

test("professional tool shell keeps formula sizing while matching application actions", async () => {
  await show(
    '<div class="dialog-backdrop dialog-backdrop--modeless"><section class="formula-dialog" role="dialog"><header><h2>插入数学公式</h2><button class="dialog-close-button">×</button></header><math-field style="font-size:24px">x+y</math-field><footer><button>取消</button><button class="primary-button">插入</button></footer></section></div>',
  );
  expect(await page.locator("h2").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  expect(await page.locator("math-field").evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "24px",
  );
  expect(
    await page.locator(".primary-button").evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(37, 99, 235)");
  expect(
    await page.locator(".dialog-backdrop").evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe("none");
});

for (const [title, className] of [
  ["数学公式", "formula-dialog"],
  ["化学方程式", "formula-dialog chemistry-dialog"],
  ["化学结构式", "formula-dialog chemistry-dialog chemistry-dialog--structure"],
  ["物理公式", "other-formula-dialog"],
]) {
  test(`${title} floating window has extra depth without blocking the document`, async () => {
    await show(
      `<main style="position:fixed;inset:0;background:white"><button id="document-action" style="position:fixed;left:8px;bottom:8px">编辑文档</button></main>
      <div class="dialog-backdrop dialog-backdrop--modeless dialog-layer--modeless"><section class="${className} dialog-surface--floating" role="dialog" style="width:560px;height:360px"><header><h2>${title}</h2></header><div>预览</div><footer><button>取消</button></footer></section></div>`,
    );
    // main.tsx loads the global skin after component styles; keep its reset in the regression.
    await page.addStyleTag({ content: readFileSync("resources/ui/workbench-ui.css", "utf8") });
    const dialog = page.getByRole("dialog");
    const shadows = await dialog.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(shadows).toContain("20px 56px");
    expect(shadows).toContain("28px");
    expect(shadows).not.toMatch(/0px 0px 0px \S+px/u);
    await expect(dialog).toHaveCSS("border-top-width", "0px");
    await expect(dialog).toHaveCSS("border-radius", "12px");
    const backdrop = page.locator(".dialog-backdrop");
    await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(backdrop).toHaveCSS("pointer-events", "none");
    await expect(dialog).toHaveCSS("pointer-events", "auto");
    await page.locator("#document-action").click();
    await expect(page.locator("#document-action")).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("floating-window-depth.png") });
  });
}

test("drawing-only formula modals keep their surface shadow with the complete skin", async () => {
  for (const className of [
    "formula-dialog",
    "formula-dialog chemistry-dialog",
    "formula-dialog chemistry-dialog chemistry-dialog--structure",
  ]) {
    await show(
      `<div class="dialog-backdrop dialog-layer--modal"><section class="${className}" role="dialog" style="width:560px;height:360px"><header><h2>附图公式编辑</h2></header></section></div>`,
    );
    await page.addStyleTag({ content: readFileSync("resources/ui/workbench-ui.css", "utf8") });
    const dialog = page.getByRole("dialog");
    const shadow = await dialog.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(shadow).toContain("28px");
    expect(shadow).not.toMatch(/0px 0px 0px \S+px/u);
    await expect(dialog).toHaveCSS("border-top-width", "0px");
    await expect(dialog).toHaveCSS("border-radius", "12px");
    await expect(page.locator(".dialog-backdrop")).toHaveCSS("pointer-events", "auto");
  }
});

test("warning close button stays inside its white dialog, with no colored overlay", async () => {
  await show(
    '<div class="operation-feedback-backdrop"><section class="operation-feedback is-error dialog-with-standard-close" role="alertdialog"><button class="dialog-close-button dialog-close-button--corner">×</button><span class="operation-feedback__icon">!</span><div class="operation-feedback__content"><h2>无法编号</h2><p>请选择需要编号的关键词。</p><button class="operation-feedback__acknowledge">知道了</button></div></section></div>',
  );
  const rects = await page.locator(".operation-feedback").evaluate((el) => {
    const box = el.getBoundingClientRect();
    const closeElement = el.querySelector(".dialog-close-button");
    if (!closeElement) throw new Error("Missing warning close control");
    const close = closeElement.getBoundingClientRect();
    return { top: box.top, right: box.right, closeTop: close.top, closeRight: close.right };
  });
  expect(rects.closeTop).toBeGreaterThanOrEqual(rects.top);
  expect(rects.closeRight).toBeLessThanOrEqual(rects.right);
  expect(
    await page
      .locator(".operation-feedback")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(255, 255, 255)");
  expect(
    await page
      .locator(".operation-feedback-backdrop")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  if (process.env.DIALOG_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.DIALOG_SCREENSHOT_DIR}/warning.png` });
});

test("long identifiers and several actions wrap without widening the dialog", async () => {
  await page.setViewportSize({ width: 380, height: 360 });
  await show(
    standard()
      .replace("需要保留的关键词".repeat(8), "long-unbroken-patent-name".repeat(12))
      .replace("确认移出</button>", "保留正文并移出登记</button><button>仅编号当前关键词</button>"),
  );
  const layout = await page.locator(".standard-dialog").evaluate((el) => {
    const body = el.querySelector(".standard-dialog__body");
    const footer = el.querySelector("footer");
    if (!body || !footer) throw new Error("Missing dialog content or actions");
    return {
      bodyOverflow: body.scrollWidth > body.clientWidth,
      footerOverflow: footer.scrollWidth > footer.clientWidth,
    };
  });
  expect(layout).toEqual({ bodyOverflow: false, footerOverflow: false });
});

test("dialog chrome does not override a document preview font or compact pane close button", async () => {
  await show(
    standard("xl").replace(
      "<p>仅移出标记列表，不修改正文和编号。</p>",
      '<div class="patent-prosemirror"><p style="font-size:22px;font-family:serif;color:red">预览正文</p></div>',
    ) +
      '<header class="dual-document-pane__header"><button class="dialog-close-button">×</button></header>',
  );
  expect(
    await page.locator(".patent-prosemirror p").evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("22px");
  expect(
    await page.locator(".patent-prosemirror p").evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(255, 0, 0)");
  expect(
    await page
      .locator(".dual-document-pane__header button")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBe(20);
});
