import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

async function closeWorkbench(app: import("@playwright/test").ElectronApplication, page: import("@playwright/test").Page) {
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (!page.isClosed() && await later.isVisible()) await later.click();
  if (!page.isClosed()) {
    const closed = app.waitForEvent("close", { timeout: 30_000 });
    await page.evaluate(() => window.patentApi.settings.update({ closeToTray: false }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed())?.close());
    await closed;
  }
}

async function expectLeaderWeight(line: import("@playwright/test").Locator) {
  await expect
    .poll(() =>
      line.evaluate((el) => {
        const matrix = (el as SVGGraphicsElement).getScreenCTM()!;
        return Number(el.getAttribute("stroke-width")) * (el.getAttribute("vector-effect") === "non-scaling-stroke" ? 1 : Math.hypot(matrix.a, matrix.b));
      }),
    )
    .toBeCloseTo((0.3 * 96) / 25.4, 2);
}
async function visibleLeader(workspace: import("@playwright/test").Locator) {
  const annotation = workspace.locator("[data-annotation]").last();
  const id = await annotation.getAttribute("data-annotation");
  const native = workspace.locator(`[data-cad-label="${id}"] path[fill="none"]`).first();
  if (await native.count()) return native;
  return annotation.locator('polyline:not([stroke="transparent"])').last();
}
async function ghostCoordinate(ghost: import("@playwright/test").Locator, axis: "x" | "y") {
  return ghost.evaluate((root, axis) => {
    const glyph = root.querySelector<SVGGElement>("[data-label-native-glyph]");
    if (glyph) {
      const matrix = glyph.transform.baseVal.consolidate()!.matrix;
      return axis === "x" ? matrix.e : matrix.f;
    }
    return Number(root.querySelector("text")?.getAttribute(axis));
  }, axis);
}

async function createPatent(page: import("@playwright/test").Page) {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill("CAD标号验收");
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).not.toBeVisible();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}
async function openWorkspace(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  return page.getByRole("region", { name: "CAD标号", exact: true });
}

test("drawing workspace is an embedded tab and survives book and library switching", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await openWorkspace(page);
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await expect(workspace).toBeVisible();
  await expect(page.getByRole("dialog", { name: "CAD标号", exact: true })).toHaveCount(0);
  const tab = page.getByRole("tab", { name: "CAD标号", exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "嵌入工作稿.png", mimeType: "image/png", buffer: png });
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 200, 200);
  await clickPoint(page, 500, 150);
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const initialWidth = Number((await canvas.getAttribute("viewBox"))!.split(" ")[2]);
  await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => Number((await canvas.getAttribute("viewBox"))!.split(" ")[2]))
    .toBeCloseTo(initialWidth * Math.exp(-120 * 0.0014), 5);
  const view = await canvas.getAttribute("viewBox");
  await page.getByRole("tab", { name: "说明书", exact: true }).click();
  await expect(workspace).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
  await tab.click();
  await expect(canvas).toHaveAttribute("viewBox", view!);
  await page.keyboard.press("Control+z");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await page.getByRole("tab", { name: "专利库", exact: true }).click();
  await expect(workspace).not.toBeVisible();
  await page.getByRole("tab", { name: "CAD标号验收", exact: true }).click();
  await tab.click();
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(tab).toHaveCount(0);
  await openWorkspace(page);
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭CAD标号验收", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await closeWorkbench(app, page);
});
async function location(page: import("@playwright/test").Page, x: number, y: number) {
  return page.getByRole("application", { name: "CAD标号画布" }).evaluate(
    (svg, p) => {
      const m = (svg as SVGSVGElement).getScreenCTM()!;
      const q = new DOMPoint(p.x, p.y).matrixTransform(m);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function clickPoint(page: import("@playwright/test").Page, x: number, y: number) {
  const p = await location(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function rectangle(
  page: import("@playwright/test").Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const a = await location(page, x1, y1),
    b = await location(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

test("fast capture-loss-before-release commits canvas, detail and label drags once", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const workspace = await openWorkspace(page);
    const png = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await workspace.getByLabel("选择图纸文件").setInputFiles({
      name: "快速松手测试.png",
      mimeType: "image/png",
      buffer: png,
    });
    await workspace.getByRole("button", { name: "标号", exact: true }).click();
    await clickPoint(page, 200, 200);
    await clickPoint(page, 500, 150);
    await page.keyboard.press("Escape");
    await workspace.getByRole("button", { name: "局部放大", exact: true }).click();
    await clickPoint(page, 300, 300);
    await clickPoint(page, 350, 300);
    await clickPoint(page, 200, 300);
    await clickPoint(page, 700, 300);
    await page.keyboard.press("Escape");
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const label = workspace.locator("[data-annotation] text").first();
    const detail = workspace.locator('[data-detail-part="content"]').first();
    for (const kind of ["pan", "label", "detail"] as const) {
      const target = kind === "label" ? label : kind === "detail" ? detail : canvas;
      if (kind !== "pan") await target.click();
      const before = await target.evaluate((element, kind) => {
        if (kind === "pan") {
          const view = element.getAttribute("viewBox")?.split(" ").map(Number) ?? [];
          return { x: view[0] ?? 0, y: view[1] ?? 0 };
        }
        return {
          x: Number(element.getAttribute(kind === "detail" ? "cx" : "x")),
          y: Number(element.getAttribute(kind === "detail" ? "cy" : "y")),
        };
      }, kind);
      const box = await target.boundingBox();
      if (!box) throw Error("Drag target has no box");
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const end = { x: start.x + 60, y: start.y + 35 };
      const expected = await canvas.evaluate(
        (element, data) => {
          const inverse = (element as SVGSVGElement).getScreenCTM()!.inverse();
          const dx = inverse.a * 60 + inverse.c * 35;
          const dy = inverse.b * 60 + inverse.d * 35;
          element.addEventListener(
            "pointerdown",
            (event) => {
              (element as SVGSVGElement).dataset.testPointerId = String(
                (event as PointerEvent).pointerId,
              );
            },
            { once: true },
          );
          return {
            x: data.before.x + (data.kind === "pan" ? -dx : dx),
            y: data.before.y + (data.kind === "pan" ? -dy : dy),
          };
        },
        { before, kind },
      );
      const button = kind === "pan" ? "middle" : "left";
      await page.mouse.move(start.x, start.y);
      await page.mouse.down({ button });
      await page.mouse.move(end.x, end.y);
      const handoff = await canvas.evaluate((element, point) => {
        const svg = element as SVGSVGElement;
        const pointerId = Number(svg.dataset.testPointerId);
        const scene = svg.querySelector<SVGGElement>("[data-drawing-scene]");
        const before = scene?.getScreenCTM();
        expectCapture(svg.hasPointerCapture(pointerId));
        svg.releasePointerCapture(pointerId);
        // Reproduce the native macOS sequence captured during a fast physical release.
        svg.dispatchEvent(
          new PointerEvent("lostpointercapture", {
            bubbles: true,
            pointerId,
            pointerType: "mouse",
            clientX: point.x,
            clientY: point.y,
            button: -1,
            buttons: 0,
          }),
        );
        delete svg.dataset.testPointerId;
        const after = scene?.getScreenCTM();
        return { before: [before?.e, before?.f], after: [after?.e, after?.f] };
        function expectCapture(held: boolean) {
          if (!held) throw Error("Pointer capture was not established");
        }
      }, end);
      if (kind === "pan") {
        expect(handoff.after[0]).toBeCloseTo(handoff.before[0] ?? 0, 4);
        expect(handoff.after[1]).toBeCloseTo(handoff.before[1] ?? 0, 4);
      }
      await page.mouse.up({ button });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (kind === "pan") {
        const next = (await canvas.getAttribute("viewBox"))?.split(" ").map(Number) ?? [];
        expect(next[0]).toBeCloseTo(expected.x, 4);
        expect(next[1]).toBeCloseTo(expected.y, 4);
      } else {
        const x = Number(await target.getAttribute(kind === "detail" ? "cx" : "x"));
        expect(x).toBeCloseTo(expected.x, 4);
        await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
        expect(Number(await target.getAttribute(kind === "detail" ? "cx" : "x"))).toBeCloseTo(
          before.x,
          4,
        );
        await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
        expect(Number(await target.getAttribute(kind === "detail" ? "cx" : "x"))).toBeCloseTo(
          expected.x,
          4,
        );
      }
    }
  } finally {
    await page.mouse.up({ button: "middle" });
    await page.mouse.up();
    await closeWorkbench(app, page);
  }
});

test("second-click label drag cannot leave a next-label ghost after release", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const workspace = await openWorkspace(page);
    const png = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await workspace.getByLabel("选择图纸文件").setInputFiles({
      name: "两次点击标号测试.png",
      mimeType: "image/png",
      buffer: png,
    });
    await workspace.getByRole("button", { name: "标号", exact: true }).click();
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const ghost = workspace.locator('[data-drawing-preview="label"]');
    const annotations = workspace.locator("[data-annotation]");
    for (let i = 0; i < 3; i++) {
      await clickPoint(page, 200, 300);
      await expect(ghost).toBeVisible();
      await expect(annotations).toHaveCount(i);
      const end = await location(page, 500, 200);
      await canvas.evaluate((element) => {
        element.addEventListener(
          "pointerdown",
          (event) => {
            (element as SVGSVGElement).dataset.testPointerId = String(
              (event as PointerEvent).pointerId,
            );
          },
          { once: true },
        );
      });
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(end.x + 5, end.y + 5);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await canvas.evaluate((element, point) => {
        const svg = element as SVGSVGElement;
        const pointerId = Number(svg.dataset.testPointerId);
        const requestFrame = window.requestAnimationFrame;
        const frames: FrameRequestCallback[] = [];
        // Exercise the release-time preview frame before React publishes the
        // continuous-event update, matching the native fast-release ordering.
        window.requestAnimationFrame = (callback) => frames.push(callback);
        try {
          if (!svg.hasPointerCapture(pointerId)) throw Error("Pointer capture was not established");
          svg.releasePointerCapture(pointerId);
          const sample = {
            bubbles: true,
            pointerId,
            pointerType: "mouse",
            clientX: point.x + 5,
            clientY: point.y + 5,
            button: -1,
            buttons: 0,
          };
          svg.dispatchEvent(new PointerEvent("lostpointercapture", sample));
          svg.dispatchEvent(new PointerEvent("pointermove", sample));
          for (const frame of frames.splice(0)) frame(performance.now());
        } finally {
          window.requestAnimationFrame = requestFrame;
          delete svg.dataset.testPointerId;
        }
      }, end);
      await page.mouse.up();
      await expect(annotations).toHaveCount(i + 1);
      await expect(annotations.locator("text").last()).toHaveText(String(i + 1));
      await expect(ghost).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(annotations).toHaveCount(2);
    await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    await expect(annotations).toHaveCount(3);
    await expect(ghost).toHaveCount(0);
  } finally {
    await page.mouse.up();
    await closeWorkbench(app, page);
  }
});

test("drawing feedback: toolbar size, escape, clean selection and published ranges", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const w = await openWorkspace(page);
  await expect(w.getByRole("heading", { name: "添加标号", exact: true })).toHaveCount(0);
  await expect(
    w.locator(".drawing-status").getByRole("button", { name: "缩小图纸", exact: true }),
  ).toBeVisible();
  await expect(w.locator(".drawing-status .drawing-view-hint")).toBeVisible();
  await expect(
    w.locator(".drawing-sources").getByRole("button", { name: "收起图纸列表", exact: true }),
  ).toHaveText("");
  await w.getByRole("button", { name: "收起图纸列表", exact: true }).click();
  await expect(
    w.locator(".drawing-sources").getByRole("button", { name: "展开图纸列表", exact: true }),
  ).toBeVisible();
  await w.getByRole("button", { name: "展开图纸列表", exact: true }).click();
  const png = await sharp(
    Buffer.from(
      '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="300" y="250" width="200" height="200" fill="black"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "白边测试.png", mimeType: "image/png", buffer: png });
  await w.getByRole("button", { name: "标号", exact: true }).click();
  const size = w.locator(".drawing-toolbar").getByRole("slider", { name: "标号字号" });
  await expect(size).toBeVisible();
  await size.fill("36");
  await expect(w.getByLabel("标号内容")).toBeVisible();
  await expect(w.getByRole("button", { name: "标号", exact: true })).toHaveText("标号");
  for (const name of ["撤销标号编辑", "重做标号编辑"]) {
    await expect(w.getByRole("button", { name, exact: true })).toHaveText("");
  }
  await expect(w.getByRole("application", { name: "CAD标号画布" })).toHaveCSS(
    "cursor",
    /url\(.+\) 9 9, crosshair/,
  );
  await clickPoint(page, 350, 300);
  await clickPoint(page, 600, 200);
  const text = w.locator("[data-annotation] text");
  await expect(text).toHaveAttribute("font-size", "36");
  await expect(text).toHaveCSS("font-weight", "400");
  const leader = await visibleLeader(w);
  await expect(leader).toHaveCSS("stroke", "rgb(0, 0, 0)");
  await expectLeaderWeight(leader);
  await page.keyboard.press("Escape");
  await text.click();
  await expect(text).toHaveCSS("fill", "rgb(0, 122, 255)");
  await expect(leader).toHaveCSS("stroke", "rgb(0, 122, 255)");
  const toolbarGeometry = await w.evaluate((element) => {
    const sidebar = element.querySelector(".drawing-sources")!.getBoundingClientRect();
    const header = element.querySelector(".drawing-header")!.getBoundingClientRect();
    const toolbar = element.querySelector(".drawing-toolbar")!.getBoundingClientRect();
    const stage = element.querySelector(".drawing-stage")!.getBoundingClientRect();
    const footer = element.querySelector(".drawing-status")!.getBoundingClientRect();
    const workspace = element.getBoundingClientRect();
    return {
      headerOffset: Math.abs(header.x - sidebar.right),
      stageOffset: Math.abs(stage.y - toolbar.bottom),
      fullCanvas: Math.abs(stage.right - workspace.right),
      footerOverflow: footer.bottom - workspace.bottom,
      canvasHeight: stage.height,
    };
  });
  expect(toolbarGeometry.headerOffset).toBeLessThan(2);
  expect(toolbarGeometry.stageOffset).toBeLessThan(2);
  expect(toolbarGeometry.fullCanvas).toBeLessThan(2);
  expect(toolbarGeometry.footerOverflow).toBeLessThan(2);
  expect(toolbarGeometry.canvasHeight).toBeGreaterThan(200);
  await expect(w.locator(".drawing-properties")).toHaveCount(0);
  await w.screenshot({ path: test.info().outputPath("drawing-selected.png") });
  await expect(w.getByRole("button", { name: "删除标号", exact: true })).toBeVisible();
  const sizeBox = await size.boundingBox();
  await page.mouse.move(sizeBox!.x + sizeBox!.width * 0.3, sizeBox!.y + sizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sizeBox!.x + sizeBox!.width * 0.65, sizeBox!.y + sizeBox!.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(text).not.toHaveAttribute("font-size", "36");
  await w.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await expect(text).toHaveAttribute("font-size", "36");
  await text.click();
  await page.keyboard.press("Escape");
  await expect(w.getByRole("button", { name: "删除标号", exact: true })).toHaveCount(0);
  await expect(w.locator(".drawing-annotation-properties")).toHaveCount(0);
  await expect(text).toHaveCSS("fill", "rgb(0, 0, 0)");
  await expect(leader).toHaveCSS("stroke", "rgb(0, 0, 0)");
  for (const name of ["选择 / 移动", "圈选取图"]) {
    await w.getByRole("button", { name, exact: true }).click();
    const a = await location(page, 100, 100),
      b = await location(page, 800, 650);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(w.getByRole("button", { name: "选择 / 移动", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
  }
  await w.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 300, 100, 450, 400);
  const shade = w.locator("[data-region-shade]");
  await expect(shade).toHaveCount(0);
  await expect(text).toHaveCSS("fill", "rgb(224, 0, 0)");
  await w
    .locator(".drawing-viewport")
    .screenshot({ path: test.info().outputPath("selection-without-shade.png") });
  await page.keyboard.press("Escape");
  await expect(shade).toHaveCount(0);
  await expect(text).toHaveCSS("fill", "rgb(0, 0, 0)");
  await w.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 100, 100, 800, 650);
  await expect(w.locator("[data-region-outline]")).toHaveCount(1);
  const handle = await w
    .locator('[data-region-handle="nw"]:not([fill="transparent"])')
    .boundingBox();
  // The 6px solid point has a 1.5px outline.
  expect(handle!.width).toBeCloseTo(7.5, 1);
  await expect(w.locator("[data-region-shade]")).toHaveCount(0);
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(w.locator("[data-region-outline]")).toHaveCount(0);
  await w.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 100, 100, 800, 650);
  await w.getByRole("button", { name: "预览成图", exact: true }).click();
  const target = join(workbench.root, "trimmed.jpg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "导出 JPG", exact: true })
    .click();
  await expect(w.getByRole("status")).toContainText("图片已导出");
  const { data, info } = await sharp(await readFile(target))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      // JPEG ringing can turn white padding into 254; measure visible ink.
      if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  // Auto sizing keeps its 10% text safety padding instead of re-cropping
  // and enlarging the marks. At 7mm/300 DPI this is at most 11px with rounding/border.
  for (const margin of [left, top, info.width - right - 1, info.height - bottom - 1]) {
    expect(margin).toBeGreaterThanOrEqual(1);
    expect(margin).toBeLessThanOrEqual(Math.ceil((7 * 0.1 * 300) / 25.4) + 2);
  }
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "插入说明书附图", exact: true })
    .click();
  await expect(w.locator(".drawing-status")).toContainText("已插入说明书附图");
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await openWorkspace(page);
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(1);
  await rectangle(page, 100, 100, 800, 650);
  await w.getByRole("button", { name: "预览成图", exact: true }).click();
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "插入说明书附图", exact: true })
    .click();
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(2);
  await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
  await page.getByRole("button", { name: "选择图1", exact: true }).click();
  await page.getByRole("button", { name: "删除图1", exact: true }).click();
  await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(1);
  await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
  await page.getByRole("button", { name: "选择图1", exact: true }).click();
  await page.getByRole("button", { name: "删除图1", exact: true }).click();
  await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
  await expect(w.locator(".drawing-sources [data-published-figure]")).toHaveCount(0);
  await expect(w.locator("[data-region-outline]")).toHaveCount(0);
  await closeWorkbench(app, page);
});

test("drawing JPG output follows document figure numbers and has no body insertion", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const w = await openWorkspace(page);
    const source = await sharp(
      Buffer.from(
        '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="250" y="250" width="200" height="150" fill="black"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await w
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "图纸.png", mimeType: "image/png", buffer: source });
    await expect(w.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
    await rectangle(page, 100, 100, 800, 650);
    await expect(w.getByLabel("图片名称", { exact: true })).toHaveCount(0);
    await w.getByRole("button", { name: "预览成图", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
    await expect(preview.getByRole("button", { name: /正文|插入说明书$/ })).toHaveCount(0);
    const jpeg = Buffer.from(
      await preview
        .getByAltText("取图导出预览")
        .evaluate(async (img) =>
          Array.from(
            new Uint8Array(await (await fetch((img as HTMLImageElement).src)).arrayBuffer()),
          ),
        ),
    );
    expect(await sharp(jpeg).metadata()).toMatchObject({ format: "jpeg", density: 300 });
    const target = join(workbench.root, "drawing-output");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { defaultPath: string; filters: unknown[] };
        if (
          options.defaultPath !== "图纸.jpg" ||
          JSON.stringify(options.filters) !==
            JSON.stringify([{ name: "JPEG 图片", extensions: ["jpg", "jpeg"] }])
        )
          throw Error("Unexpected JPG save defaults");
        return { canceled: false, filePath };
      };
    }, target);
    await preview.getByRole("button", { name: "导出 JPG", exact: true }).click();
    await expect(preview).toContainText("图片已导出");
    expect(await readFile(`${target}.jpg`)).toEqual(jpeg);
    await preview.getByRole("button", { name: "插入说明书附图", exact: true }).click();
    await expect(preview).toBeHidden();
    const list = w.locator("[data-published-figure]");
    await expect(list).toHaveText(["图1"]);
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
    await expect(w.getByLabel("取图范围", { exact: true })).toHaveCount(0);
    await expect(w.getByRole("button", { name: "重画范围", exact: true })).toHaveCount(0);
    await expect(list.first().getByRole("img", { name: "图1", exact: true })).toBeVisible();
    const thumbnail = await list.first().locator("img").getAttribute("src");
    await list.first().click();
    await expect(w.locator("[data-published-location]")).toHaveCount(1);
    await expect(w.locator("[data-published-location]")).toHaveAttribute("pointer-events", "none");
    await expect(
      w.locator("[data-region-outline], [data-region-handle], [data-region-move]"),
    ).toHaveCount(0);
    await expect(w.getByRole("button", { name: "预览成图", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(w.locator("[data-published-location]")).toHaveCount(0);
    await w.getByRole("button", { name: "标号", exact: true }).click();
    await clickPoint(page, 300, 300);
    await clickPoint(page, 700, 150);
    await page.keyboard.press("Escape");
    await expect(w.locator("[data-annotation] text")).toHaveText("1");
    await expect(list.first().locator("img")).toHaveAttribute("src", thumbnail!);
    await expect(w.getByText("修改后待更新", { exact: true })).toHaveCount(0);
    await rectangle(page, 100, 100, 800, 650);
    await w.getByRole("button", { name: "预览成图", exact: true }).click();
    await expect(preview.getByRole("button", { name: /替换|更新|另存为新附图/ })).toHaveCount(0);
    await preview.getByRole("button", { name: "插入说明书附图", exact: true }).click();
    await expect(list).toHaveText(["图1", "图2"]);
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
    await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
    await openWorkspace(page);
    await expect(list).toHaveText(["图1", "图2"]);
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
    const stored = await Promise.all(
      (await readdir(join(workbench.root, "library", "assets")))
        .filter((name) => name.endsWith(".asset"))
        .map(async (name) => {
          const bytes = await readFile(join(workbench.root, "library", "assets", name));
          const start = Buffer.byteLength("PATASSET1\n") + 4;
          const header = JSON.parse(
            bytes.subarray(start, start + bytes.readUInt32BE(start - 4)).toString(),
          );
          return { descriptor: header.descriptor, bytes };
        }),
    );
    const inserted = stored.filter((asset) => asset.descriptor.mediaType === "image/jpeg");
    expect(inserted.length).toBeGreaterThan(0);
    for (const asset of inserted) {
      expect(asset.descriptor.extension).toBe("jpg");
      expect(
        (await sharp(asset.bytes.subarray(-asset.descriptor.byteLength)).metadata()).format,
      ).toBe("jpeg");
    }
    expect(
      inserted.some((asset) => asset.bytes.subarray(-asset.descriptor.byteLength).equals(jpeg)),
    ).toBe(true);
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.getByRole("article", { name: "图1", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "继续CAD标号", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "选择图1", exact: true }).click();
    await page.getByRole("button", { name: "删除图1", exact: true }).click();
    await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
    await expect(list).toHaveText(["图1"]);
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
  } finally {
    await page.keyboard.press("Escape");
    await closeWorkbench(app, page);
  }
});

test("cancel import retains the existing draft and releases busy controls", async ({
  workbench,
}) => {
  test.setTimeout(120000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const dialog = await openWorkspace(page);
  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "保留的底图.png", mimeType: "image/png", buffer: png });
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "标号", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1100, 800);
  });
  await app.evaluate(({ ipcMain }) => {
    let finish: ((value: unknown) => void) | undefined;
    ipcMain.removeHandler("drawings:import");
    ipcMain.handle(
      "drawings:import",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ipcMain.removeHandler("drawings:cancel-import");
    ipcMain.handle("drawings:cancel-import", () => {
      finish?.({ ok: false, error: { code: "CANCELLED", message: "已取消" } });
      return { ok: true, value: true };
    });
  });
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "取消的底图.png", mimeType: "image/png", buffer: png });
  await expect(dialog.locator(".drawing-annotation-properties")).toHaveAttribute("inert", "");
  await dialog
    .locator(".drawing-header")
    .getByRole("button", { name: "取消导入", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已取消导入，原工作稿保持不变");
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(dialog.locator(".drawing-project-row")).toHaveCount(1);
  await expect(dialog.locator(".drawing-project-row")).toContainText("保留的底图");
  const narrowLayout = await dialog.evaluate((element) => {
    const stage = element.querySelector(".drawing-stage")!.getBoundingClientRect();
    const status = element.querySelector(".drawing-status")!.getBoundingClientRect();
    return {
      height: stage.height,
      overflow: status.bottom - element.getBoundingClientRect().bottom,
    };
  });
  expect(narrowLayout.height).toBeGreaterThan(200);
  expect(narrowLayout.overflow).toBeLessThan(2);
  await dialog.screenshot({ path: join(process.cwd(), "out-apple-drawing-narrow.png") });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await closeWorkbench(app, page);
});

test("annotate whole drawing, crop afterwards, insert, replace, and reopen saved draft", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const dialog = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="1000" height="800"><rect x="200" y="200" width="300" height="300" fill="none" stroke="black" stroke-width="3"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "示意图.png", mimeType: "image/png", buffer: png });
  await expect(dialog.getByRole("button", { name: "标号", exact: true }))
    .toBeEnabled()
    .catch(async (error) => {
      console.log(await dialog.innerText());
      throw error;
    });
  await dialog.getByRole("button", { name: "标号", exact: true }).click();
  await dialog.getByLabel("标号内容").fill("12");
  await clickPoint(page, 300, 300);
  await clickPoint(page, 600, 150);
  await expect(dialog.locator("svg text")).toHaveText("12");
  await expect(dialog.locator("[data-region-outline]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "撤销标号编辑" }).click();
  await expect(dialog.locator("svg text")).toHaveCount(0);
  await dialog.getByRole("button", { name: "重做标号编辑" }).click();
  await expect(dialog.locator("svg text")).toHaveText("12");
  await dialog.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 100, 100, 800, 650);
  await dialog.getByRole("button", { name: "预览成图", exact: true }).click();
  await expect(page.getByAltText("取图导出预览")).toBeVisible();
  const exportedPath = join(workbench.root, "marked.jpg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () =>
      new Promise((resolve) => {
        (globalThis as unknown as { finishDrawingSave: () => void }).finishDrawingSave = () =>
          resolve({ canceled: false, filePath });
      });
  }, exportedPath);
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "导出 JPG", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "导入图纸", exact: true })).toBeDisabled();
  await page.getByRole("dialog", { name: "成图预览", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect(dialog.locator("[data-region-outline]")).toHaveCount(1);
  await expect(dialog.locator(".drawing-sources")).toHaveAttribute("inert", "");
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          typeof (globalThis as unknown as { finishDrawingSave?: () => void }).finishDrawingSave,
      ),
    )
    .toBe("function");
  await app.evaluate(() => {
    (globalThis as unknown as { finishDrawingSave: () => void }).finishDrawingSave();
  });
  await expect(dialog.getByRole("status")).toContainText("图片已导出");
  const exportedMetadata = await sharp(await readFile(exportedPath)).metadata();
  expect(exportedMetadata.density).toBe(300);
  expect(exportedMetadata.width).toBe(Math.round((120 / 25.4) * 300) + 2);
  await dialog.screenshot({ path: join(process.cwd(), "out-drawing-workspace.png") });
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "插入说明书附图", exact: true })
    .click();
  await expect(dialog.locator(".drawing-status")).toContainText("已插入说明书附图");
  await expect(dialog.getByRole("button", { name: "预览成图", exact: true })).toBeDisabled();
  await expect(dialog.locator("[data-published-figure]")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await openWorkspace(page);
  await expect(dialog.locator("svg text")).toHaveText("12");
  await expect(dialog.locator("[data-published-figure]")).toHaveCount(1);
  await expect(dialog.locator("[data-region-outline]")).toHaveCount(0);
  await closeWorkbench(app, page);
  const again = await workbench.launch();
  const reopened = await again.firstWindow();
  const row = reopened.getByText("CAD标号验收", { exact: true }).first();
  await row.dblclick();
  await openWorkspace(reopened);
  await expect(
    reopened.getByRole("region", { name: "CAD标号", exact: true }).locator("svg text"),
  ).toHaveText("12");
  await again.close();
});

test("label placement previews clicks and drags, with middle-button canvas panning", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const dialog = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "标号交互.png", mimeType: "image/png", buffer: png });
  const labelTool = dialog.getByRole("button", { name: "标号", exact: true });
  await expect(labelTool).toBeEnabled();
  await labelTool.click();
  // Placement controls animate the viewport; measure coordinates after layout settles.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise(requestAnimationFrame);
  });
  await clickPoint(page, 300, 300);
  const ghost = dialog.locator('[data-drawing-preview="label"]');
  const annotations = dialog.locator("[data-annotation]");
  await expect(ghost).toBeVisible();
  await expect(annotations).toHaveCount(0);
  const destination = await location(page, 600, 150);
  await page.mouse.move(destination.x, destination.y);
  const ghostText = await ghost.locator("text, [data-label-native-glyph]").boundingBox();
  expect(ghostText!.x + ghostText!.width / 2).toBeCloseTo(destination.x, 0);
  expect(ghostText!.y + ghostText!.height).toBeLessThan(destination.y);
  const previewX = await ghostCoordinate(ghost, "x");
  const previewY = await ghostCoordinate(ghost, "y");
  expect(await ghost.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await expect(ghost.locator("polyline")).toHaveCSS("stroke", "rgb(0, 0, 0)");
  await expectLeaderWeight(ghost.locator("polyline"));
  const previewPoints = await ghost.locator("polyline").getAttribute("points");
  await page.mouse.click(destination.x, destination.y);
  await expect(ghost).toHaveCount(0);
  await expect(annotations).toHaveCount(1);
  // Subpixel canvas measurements can settle between the preview and pointer release.
  const expectedLeader = previewPoints!.split(/[ ,]/u).map(Number);
  await expect
    .poll(async () => {
      const actual = (await annotations.locator("polyline").last().getAttribute("points"))!
        .split(/[ ,]/u)
        .map(Number);
      if (actual.length !== expectedLeader.length) return Infinity;
      return Math.max(...actual.map((value, i) => Math.abs(value - expectedLeader[i]!)));
    })
    .toBeLessThan(0.05);
  await expect
    .poll(async () =>
      Math.abs(
        Number(await annotations.locator("text").last().getAttribute("x")) - Number(previewX),
      ),
    )
    .toBeLessThan(0.05);
  await expect
    .poll(async () =>
      Math.abs(
        Number(await annotations.locator("text").last().getAttribute("y")) - Number(previewY),
      ),
    )
    .toBeLessThan(0.05);
  await expectLeaderWeight(await visibleLeader(dialog));
  await expect(dialog.getByRole("button", { name: "直线引出", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "折线引出", exact: true })).toHaveCount(0);

  await dialog.getByLabel("标号内容").fill("2");
  const start = await location(page, 400, 400),
    end = await location(page, 700, 250);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const dragStartedAt = await page.evaluate(() => performance.now());
  await page.mouse.move(end.x, end.y, { steps: 6 });
  // A completed press-and-drag requires 200ms; rendering speed must not supply that delay.
  await expect
    .poll(() => page.evaluate((start) => performance.now() - start, dragStartedAt))
    .toBeGreaterThanOrEqual(200);
  await expect(dialog.getByLabel("标号内容", { exact: true })).toHaveValue("2");
  const dragText = await ghost.locator("text, [data-label-native-glyph]").boundingBox();
  const dragX = await ghostCoordinate(ghost, "x");
  const dragY = await ghostCoordinate(ghost, "y");
  await expect(annotations).toHaveCount(1);
  await page.mouse.up();
  expect(dragText!.x + dragText!.width / 2).toBeCloseTo(end.x, 0);
  expect(dragText!.y + dragText!.height).toBeLessThan(end.y);
  await expect
    .poll(async () =>
      Math.abs(Number(await annotations.locator("text").last().getAttribute("x")) - Number(dragX)),
    )
    .toBeLessThan(0.05);
  await expect
    .poll(async () =>
      Math.abs(Number(await annotations.locator("text").last().getAttribute("y")) - Number(dragY)),
    )
    .toBeLessThan(0.05);
  await expect(ghost).toHaveCount(0);
  await expect(annotations).toHaveCount(2);
  await dialog.getByRole("button", { name: "撤销标号编辑" }).click();
  await expect(annotations).toHaveCount(1);
  await dialog.getByRole("button", { name: "重做标号编辑" }).click();
  await expect(annotations).toHaveCount(2);

  // Middle-button pan is available without leaving the label tool, including after zoom.
  await page.mouse.wheel(0, -120);
  const canvas = dialog.getByRole("application", { name: "CAD标号画布" });
  const initial = await canvas.getAttribute("viewBox");
  const r = await canvas.boundingBox();
  const x = r!.x + r!.width / 2,
    y = r!.y + r!.height / 2;
  const pointBefore = await location(page, 400, 400);
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  await expect(canvas).not.toHaveAttribute("viewBox", initial!);
  const pointAfter = await location(page, 400, 400);
  expect(pointAfter.x - pointBefore.x).toBeCloseTo(80, 0);
  expect(pointAfter.y - pointBefore.y).toBeCloseTo(40, 0);
  await expect(annotations).toHaveCount(2);
  await expect(ghost).toHaveCount(0);
  await expect(labelTool).toHaveAttribute("aria-pressed", "true");
  await clickPoint(page, 400, 400);
  await expect(ghost).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ghost).toHaveCount(0);
  await expect(annotations).toHaveCount(2);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await closeWorkbench(app, page);
});

test("label alignment guides snap on release and batch alignment is undoable", async ({
  workbench,
}) => {
  test.setTimeout(210000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const workspace = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .composite([{ input: Buffer.from('<svg width="1000" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="220" y="260" width="500" height="210" fill="none" stroke="black" stroke-width="3"/><path d="M220 360H720 M400 260V470" fill="none" stroke="black" stroke-width="2"/></svg>') }])
    .png()
    .toBuffer();
  expect((await sharp(png).stats()).channels[0]!.min).toBeLessThan(100);
  await workspace.getByLabel("选择图纸文件").setInputFiles({
    name: "标号对齐.png",
    mimeType: "image/png",
    buffer: png,
  });
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 250, 300);
  await clickPoint(page, 400, 200);
  const marks = workspace.locator("[data-annotation]");
  await expect(marks).toHaveCount(1);
  const first = marks.first().locator("text");
  const firstX = Number(await first.getAttribute("x"));
  const firstY = Number(await first.getAttribute("y"));
  const firstSize = Number(await first.getAttribute("font-size"));
  const unit = await workspace.getByRole("application", { name: "CAD标号画布" }).evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    const view = (svg as SVGSVGElement).viewBox.baseVal;
    return Math.max(view.width / box.width, view.height / box.height);
  });

  await clickPoint(page, 600, 360);
  const secondEnd = await location(page, firstX + 4 * unit, 320);
  await page.mouse.move(secondEnd.x, secondEnd.y);
  const ghost = workspace.locator('[data-drawing-preview="label"]');
  await expect(workspace.locator('[data-label-align-guide="vertical"]')).toHaveCount(1);
  await expect
    .poll(() => ghostCoordinate(ghost, "x"))
    .toBeCloseTo(firstX, 3);
  await page.mouse.click(secondEnd.x, secondEnd.y);
  await expect(marks).toHaveCount(2);
  await expect
    .poll(async () => Number(await marks.nth(1).locator("text").getAttribute("x")))
    .toBeCloseTo(firstX, 3);

  await clickPoint(page, 650, 370);
  const thirdEnd = await location(page, 750, firstY + firstSize * 0.55 + 8 * unit);
  await page.mouse.move(thirdEnd.x, thirdEnd.y);
  await expect(workspace.locator('[data-label-align-guide="horizontal"]')).toHaveCount(1);
  await expect
    .poll(() => ghostCoordinate(ghost, "y"))
    .toBeCloseTo(firstY, 3);
  await page.mouse.click(thirdEnd.x, thirdEnd.y);
  await expect(marks).toHaveCount(3);
  const before = await marks.evaluateAll((items) =>
    items.map((item) => ({
      x: Number(item.querySelector("text")?.getAttribute("x")),
      y: Number(item.querySelector("text")?.getAttribute("y")),
      anchor: item.querySelector("polyline")?.getAttribute("points")?.split(" ")[0],
    })),
  );

  await workspace.getByRole("button", { name: "框选编号" }).click();
  await rectangle(page, -10, -10, 1010, 810);
  await expect(workspace.locator("[data-selected-annotation-count]")).toHaveText("已选中 3 个标号");
  await workspace.getByRole("button", { name: "水平对齐" }).click();
  await expect
    .poll(async () =>
      marks.evaluateAll((items) => {
        const values = items.map((item) => Number(item.querySelector("text")?.getAttribute("y")));
        return Math.max(...values) - Math.min(...values);
      }),
    )
    .toBeLessThan(0.001);
  const horizontalXs = await marks
    .locator("text")
    .evaluateAll((texts) =>
      texts.map((text) => Number(text.getAttribute("x"))).sort((a, b) => a - b),
    );
  expect(horizontalXs[0]).toBeGreaterThan(150);
  expect(horizontalXs[2]).toBeLessThan(850);
  expect(horizontalXs[1]! - horizontalXs[0]!).toBeCloseTo(horizontalXs[2]! - horizontalXs[1]!, 3);
  const rowY = Number(await marks.first().locator("text").getAttribute("y"));
  expect(rowY).toBeGreaterThan(175);
  expect(Math.abs(260 - (rowY + firstSize * 0.55) - firstSize * 4)).toBeLessThan(3);
  const afterHorizontal = await marks.evaluateAll((items) =>
    items.map((item) => item.querySelector("polyline")?.getAttribute("points")?.split(" ")[0]),
  );
  expect(afterHorizontal).toEqual(before.map((item) => item.anchor));
  await expect(workspace.getByRole("button", { name: "撤销标号编辑" })).toBeEnabled();
  await workspace.getByRole("button", { name: "撤销标号编辑" }).click();
  await expect
    .poll(async () =>
      marks.evaluateAll((items) =>
        items.map((item) => Number(item.querySelector("text")?.getAttribute("y"))),
      ),
    )
    .toEqual(before.map((item) => item.y));
  await workspace.getByRole("button", { name: "重做标号编辑" }).click();
  await expect(workspace.getByText("已保存", { exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "框选编号" }).click();
  await expect(workspace.getByRole("button", { name: "框选编号" })).toHaveAttribute("aria-pressed", "true");
  await rectangle(page, 100, 100, 900, 700);
  await expect(workspace.locator("[data-selected-annotation-count]")).toHaveText("已选中 3 个标号");
  await workspace.getByRole("button", { name: "竖向对齐" }).click();
  await expect
    .poll(async () =>
      marks.evaluateAll((items) => {
        const values = items.map((item) => Number(item.querySelector("text")?.getAttribute("x")));
        return Math.max(...values) - Math.min(...values);
      }),
    )
    .toBeLessThan(0.001);
  const verticalYs = await marks
    .locator("text")
    .evaluateAll((texts) =>
      texts.map((text) => Number(text.getAttribute("y"))).sort((a, b) => a - b),
    );
  expect(verticalYs[0]).toBeGreaterThan(100);
  expect(verticalYs[2]).toBeLessThan(600);
  expect(verticalYs[1]! - verticalYs[0]!).toBeCloseTo(verticalYs[2]! - verticalYs[1]!, 3);
  const columnX = Number(await marks.first().locator("text").getAttribute("x"));
  expect((columnX > 130 && columnX < 220) || (columnX > 720 && columnX < 810)).toBe(true);
  await workspace.getByRole("button", { name: "选择 / 移动" }).click();
  await rectangle(page, -10, -10, 1010, 810);
  await workspace.getByRole("button", { name: "预览成图" }).click();
  const preview = page.getByRole("dialog", { name: "成图预览" });
  await expect(preview.getByAltText("取图导出预览")).toBeVisible();
  const target = join(workbench.root, "aligned-labels.jpg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await preview.getByRole("button", { name: "导出 JPG" }).click();
  await expect(workspace.locator(".drawing-feedback")).toContainText("图片已导出。", {
    timeout: 30000,
  });
  const exported = await sharp(await readFile(target)).stats();
  expect(exported.channels[0]?.min).toBeLessThan(150);
  await closeWorkbench(app, page);
});

test("drawing keyboard history, sequential labels, hand panning and closed crop previews", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const dialog = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "交互回归.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "标号", exact: true }).click();
  await dialog.getByLabel("标号内容").fill("1");
  await clickPoint(page, 300, 300);
  await clickPoint(page, 550, 150);
  const labels = dialog.locator("[data-annotation] text");
  await page.keyboard.press("Control+z");
  await expect.soft(labels).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect.soft(labels).toHaveText(["1"]);
  await clickPoint(page, 400, 400);
  await clickPoint(page, 650, 250);
  await expect.soft(labels).toHaveText(["1", "2"]);
  await expect.soft(dialog.getByLabel("标号内容")).toHaveValue("3");
  await expect.soft(dialog.getByRole("button", { name: "平移", exact: true })).toHaveCount(0);
  const canvas = dialog.getByRole("application", { name: "CAD标号画布" });
  const center = await location(page, 500, 400);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(center.x + 30, center.y + 20);
  await expect.soft(canvas).toHaveCSS("cursor", "grabbing");
  await page.mouse.up({ button: "middle" });
  await expect.soft(canvas).not.toHaveCSS("cursor", "grabbing");
  for (const [x1, x2] of [
    [150, 800],
    [800, 150],
  ]) {
    const crossing = x1! > x2!;
    await dialog.getByRole("button", { name: "选择 / 移动", exact: true }).click();
    const a = await location(page, x1!, 100),
      b = await location(page, x2!, 650);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    for (const x of [a.x, b.x]) {
      const bytes = await page.screenshot({
        clip: { x: Math.round(x) - 3, y: Math.round((a.y + b.y) / 2) - 3, width: 7, height: 7 },
      });
      const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let matching = 0;
      for (let i = 0; i < data.length; i += 3)
        if (
          crossing
            ? data[i]! < 100 && data[i + 1]! > 100 && data[i + 2]! < 140
            : data[i]! < 100 && data[i + 1]! < 160 && data[i + 2]! > 180
        )
          matching++;
      expect
        .soft(matching, "both vertical crop edges must be visible while dragging")
        .toBeGreaterThan(0);
    }
    await page.mouse.up();
  }
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await closeWorkbench(app, page);
});

function twoPagePdf(firstPage = "0 g 100 100 100 100 re f"): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 6 0 R >>",
    "",
  ];
  for (const [i, text] of [
    [3, firstPage],
    [5, "0 g 0 0 400 300 re f"],
  ] as const)
    objects[i] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let content = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

test("PDF pages remain editable independently and lasso output masks the exterior", async ({
  workbench,
}) => {
  test.setTimeout(120000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await createPatent(page);
  const dialog = await openWorkspace(page);
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "两页图纸.pdf", mimeType: "application/pdf", buffer: twoPagePdf() });
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await dialog.getByLabel("PDF 页码", { exact: false }).fill("2");
  await dialog.getByRole("button", { name: "打开此页" }).click();
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(dialog.locator(".drawing-project-row")).toHaveCount(2);
  await expect(dialog.locator(".drawing-vector-preview").first()).toHaveAttribute("data-render-state", "ready");
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)));
    await new Promise(requestAnimationFrame);
  });
  await page.getByRole("tab", { name: "图片工具" }).click();
  await page.getByRole("button", { name: "圈选取图" }).click();
  const start = await location(page, 200, 200);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const p of [
    { x: 1400, y: 200 },
    { x: 800, y: 1000 },
    { x: 200, y: 200 },
  ]) {
    const at = await location(page, p.x, p.y);
    await page.mouse.move(at.x, at.y, { steps: 12 });
  }
  await page.mouse.up();
  await dialog.getByRole("button", { name: "预览成图" }).click();
  await expect(page.getByAltText("取图导出预览")).toBeVisible();
  const target = join(workbench.root, "lasso.jpg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page
    .getByRole("dialog", { name: "成图预览" })
    .getByRole("button", { name: "导出 JPG" })
    .click();
  await expect(dialog.getByRole("status")).toContainText("图片已导出");
  const bytes = await readFile(target);
  const croppedMetadata = await sharp(bytes).metadata();
  expect(croppedMetadata.density).toBe(300);
  expect(croppedMetadata.width).toBe(Math.round((120 / 25.4) * 300) + 2);
  expect([
    ...(await sharp(bytes)
      .extract({
        left: croppedMetadata.width! - 5,
        top: croppedMetadata.height! - 5,
        width: 1,
        height: 1,
      })
      .removeAlpha()
      .raw()
      .toBuffer()),
  ]).toEqual([255, 255, 255]);
  expect([
    ...(await sharp(bytes)
      .extract({
        left: Math.floor(croppedMetadata.width! / 2),
        top: Math.floor(croppedMetadata.height! * 0.4),
        width: 1,
        height: 1,
      })
      .removeAlpha()
      .raw()
      .toBuffer()),
  ]).toEqual([0, 0, 0]);
  await dialog.screenshot({ path: join(process.cwd(), "out-drawing-pdf-lasso.png") });
  await closeWorkbench(app, page);
});

async function expectLiveVectorPan(page: import("@playwright/test").Page) {
  await expect(page.getByRole("region", { name: "CAD标号", exact: true }).getByRole("button", { name: "标号", exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "CAD标号", exact: true })).toHaveAttribute("data-cad-pending", "false");
  await page.getByRole("application", { name: "CAD标号画布" }).click({ trial: true });
  const box = await page.getByRole("application", { name: "CAD标号画布" }).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down({ button: "middle" });
  const movement = await page.evaluate(async () => {
    const svg = document.querySelector<SVGSVGElement>('svg[aria-label="CAD标号画布"]')!;
    const base = document.querySelector<HTMLCanvasElement>(".drawing-vector-preview")!;
    const drawingScene = svg.querySelector<SVGGElement>("[data-drawing-scene]")!;
    const rect = svg.getBoundingClientRect();
    const origin = () => new DOMPoint(0, 0).matrixTransform(drawingScene.getScreenCTM()!);
    const before = { base: base.getBoundingClientRect().x, annotation: origin().x };
    const source = base.querySelector("img")?.getAttribute("src");
    const timeout = window.setTimeout;
    // Keep the expensive replacement frame pending: panning must not wait for it.
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      timeout(callback, delay === 16 ? 1000 : delay, ...args)) as typeof window.setTimeout;
    const send = (type: string, dx: number) =>
      svg.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 1,
          buttons: type === "pointerup" ? 0 : 4,
          clientX: rect.x + rect.width / 2 + dx,
          clientY: rect.y + rect.height / 2,
        }),
      );
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const samples: {
      base: number;
      annotation: number;
      expected: number;
      sourceUnchanged: boolean;
      covered: boolean;
    }[] = [];
    try {
      for (const dx of [40, rect.width * 1.2, -rect.width * 1.2, 40]) {
        send("pointermove", dx);
        await frame();
        await frame();
        const imageBox = base.querySelector("img")?.getBoundingClientRect();
        samples.push({
          base: base.getBoundingClientRect().x - before.base,
          annotation: origin().x - before.annotation,
          expected: dx,
          sourceUnchanged: source === base.querySelector("img")?.getAttribute("src"),
          covered: (() => {
            const sourceBox = imageBox ?? base.getBoundingClientRect();
            return (
              sourceBox.left <= rect.left &&
              sourceBox.right >= rect.right &&
              sourceBox.top <= rect.top &&
              sourceBox.bottom >= rect.bottom
            );
          })(),
        });
      }
      return samples;
    } finally {
      send("pointerup", 40);
      window.setTimeout = timeout;
    }
  });
  await page.mouse.up({ button: "middle" });
  for (const sample of movement) {
    // The source surface may translate inside its overscan; visible coverage and
    // source/annotation alignment are the invariant, not a fixed canvas origin.
    expect(sample.annotation).toBeCloseTo(sample.expected, 1);
    expect(sample.sourceUnchanged).toBe(true);
    expect(sample.covered).toBe(true);
  }
  await expect(page.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
}

test("panning reveals offscreen drawing content before pointer release", async ({ workbench }) => {
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const workspace = await openWorkspace(page);
    await workspace.getByLabel("选择图纸文件").setInputFiles({
      name: "实时平移.pdf",
      mimeType: "application/pdf",
      buffer: twoPagePdf("0 g 80 140 20 20 re f"),
    });
    const base = workspace.locator(".drawing-vector-preview").first();
    await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const box = await canvas.boundingBox();
    if (!box) throw Error("Canvas has no viewport");
    for (let i = 0; i < 12; i++)
      await workspace.getByRole("button", { name: "放大图纸", exact: true }).click();
    await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      );
      await new Promise(requestAnimationFrame);
    });
    const mark = await location(page, 360, 600);
    expect(mark.x).toBeLessThan(box.x);
    const dx = box.x + 100 - mark.x;
    const sourceRenders = Number(await base.getAttribute("data-source-renders"));
    const start = { x: box.x + 20, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(start.x + dx, start.y, { steps: 12 });
    await expect(canvas).toHaveAttribute("data-panning", "true");
    // Pixel evidence while the button is still held: a previously offscreen
    // black mark must be painted at its new location, rather than white paper.
    await expect
      .poll(async () => {
        const pixels = await sharp(await workspace.locator(".drawing-viewport").screenshot())
          .extract({ left: 98, top: Math.round(mark.y - box.y) - 2, width: 4, height: 4 })
          .removeAlpha()
          .raw()
          .toBuffer();
        return Math.max(...pixels);
      })
      .toBeLessThan(50);
    expect(
      Number(await base.getAttribute("data-source-renders")) - sourceRenders,
    ).toBeLessThanOrEqual(32);
    expect(Number(await base.getAttribute("data-cached-tiles"))).toBeLessThanOrEqual(32);
    await page.mouse.up({ button: "middle" });
    await expect(canvas).toHaveAttribute("data-panning", "false");
    await workspace.getByRole("button", { name: "局部放大", exact: true }).click();
    for (const [x, y] of [
      [360, 600],
      [380, 600],
      [400, 600],
      [440, 600],
    ])
      await clickPoint(page, x!, y!);
    await page.keyboard.press("Escape");
    const detail = workspace.locator("[data-detail-image]").first();
    const circle = workspace.locator('[data-detail-part="content"]').first();
    await expect(detail).toBeVisible();
    for (const cancel of [false, true]) {
      const before = await detail.boundingBox();
      if (!before) throw Error("Detail image has no viewport");
      const start = await location(page, 450, 650);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(start.x + 60, start.y + 30, { steps: 6 });
      await expect.poll(async () => (await detail.boundingBox())?.x).toBeCloseTo(before.x + 60, 0);
      const imageBox = await detail.boundingBox();
      const circleBox = await circle.boundingBox();
      expect(imageBox?.x).toBeCloseTo(circleBox?.x ?? 0, 0);
      expect(imageBox?.y).toBeCloseTo(circleBox?.y ?? 0, 0);
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up({ button: "middle" });
      await expect
        .poll(async () => (await detail.boundingBox())?.x)
        .toBeCloseTo(before.x + (cancel ? 0 : 60), 0);
    }
  } finally {
    await page.mouse.up({ button: "middle" });
    await closeWorkbench(app, page);
  }
});

test("high zoom DWG drag refreshes bounded tiles before release", async ({ workbench }) => {
  test.setTimeout(120000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const workspace = await openWorkspace(page);
    await workspace.getByLabel("选择图纸文件").setInputFiles({
      name: "实时平移.dwg",
      mimeType: "image/vnd.dwg",
      buffer: await readFile(join(process.cwd(), "tests/fixtures/cad/sample_AC1032.dwg")),
    });
    const base = workspace.locator(".drawing-vector-preview").first();
    await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 90000 });
    for (let i = 0; i < 22; i++)
      await workspace.getByRole("button", { name: "放大图纸", exact: true }).click();
    await expect(base).toHaveAttribute("data-preview-region", "local");
    await expect(base).toHaveAttribute("data-render-state", "ready");
    const source = await base.locator("img").getAttribute("src");
    const originalTile = await base.locator("img").boundingBox();
    if (!originalTile) throw Error("CAD tile has no bounds");
    const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
    const box = await canvas.boundingBox();
    if (!box) throw Error("Canvas has no viewport");
    const start = { x: box.x + 20, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: "middle" });
    // Travel beyond the current tile's coverage, even when cached overscan
    // spans several screen widths and a nearby grid cell can reuse it.
    const dx = Math.max(box.width * 1.5, box.x - originalTile.x + box.width * 0.5);
    await page.mouse.move(start.x + dx, start.y, { steps: 24 });
    await expect(canvas).toHaveAttribute("data-panning", "true");
    await expect(base.locator("img")).not.toHaveAttribute("src", source!);
    await expect(base).toHaveAttribute("data-render-state", "ready");
    const held = await base.locator("img").evaluate((img) => {
      const box = img.getBoundingClientRect();
      return { x: box.x, y: box.y, src: img.getAttribute("src") };
    });
    await page.mouse.up({ button: "middle" });
    await expect(base.locator("img")).toHaveAttribute("src", held.src!);
    const released = await base.locator("img").boundingBox();
    expect(released?.x).toBeCloseTo(held.x, 1);
    expect(released?.y).toBeCloseTo(held.y, 1);
    const intrinsic = await base.locator("img").evaluate((img) => ({
      width: (img as HTMLImageElement).naturalWidth,
      height: (img as HTMLImageElement).naturalHeight,
    }));
    expect(intrinsic.width * intrinsic.height).toBeLessThanOrEqual(8_000_000);
    const decodes = await base.getAttribute("data-preview-source-decodes");
    const cacheHits = Number(await base.getAttribute("data-preview-cache-hits"));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(start.x - dx, start.y, { steps: 24 });
    await expect(canvas).toHaveAttribute("data-panning", "true");
    // Overlapping cached tiles can cover the same camera with different URLs.
    // Require cache reuse and stable release geometry, not a particular LRU entry.
    await expect(base).toHaveAttribute("data-render-state", "ready");
    await expect.poll(async () => Number(await base.getAttribute("data-preview-cache-hits"))).toBeGreaterThan(cacheHits);
    // Fast outward movement may skip intermediate cells which the return then
    // visits. Decode work is bounded by traveled viewports, not pointer samples.
    expect(Number(await base.getAttribute("data-preview-source-decodes")) - Number(decodes))
      .toBeLessThanOrEqual(Math.ceil(dx / box.width) + 1);
    const returned = await base.locator("img").boundingBox();
    const returnedSource = await base.locator("img").getAttribute("src");
    await page.mouse.up({ button: "middle" });
    await expect(base.locator("img")).toHaveAttribute("src", returnedSource!);
    const afterReturn = await base.locator("img").boundingBox();
    expect(afterReturn?.x).toBeCloseTo(returned!.x, 1);
    expect(afterReturn?.y).toBeCloseTo(returned!.y, 1);
    await workspace.getByRole("button", { name: "标号", exact: true }).click();
    const view = (await canvas.getAttribute("viewBox"))?.split(" ").map(Number);
    if (!view || view.length !== 4) throw Error("Canvas view unavailable");
    await clickPoint(page, view[0]! + view[2]! * 0.5, view[1]! + view[3]! * 0.5);
    await clickPoint(page, view[0]! + view[2]! * 0.6, view[1]! + view[3]! * 0.5);
    await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  } finally {
    await page.mouse.up({ button: "middle" });
    await closeWorkbench(app, page);
  }
});

test("PDF strokes and leaders keep display width while raster content scales and export stays unchanged", async ({
  workbench,
}) => {
  test.setTimeout(240000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  // Keep PDF.js rendering active while the test window remains hidden.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  await createPatent(page);
  const dialog = await openWorkspace(page);
  const pdf = twoPagePdf(
    "6 w 0 G 30 150 m 370 150 l S\n0 g 210 180 10 10 re f\nq 20 0 0 20 160 100 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 00> EI Q",
  );
  await dialog
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "矢量和图片.pdf", mimeType: "application/pdf", buffer: pdf });
  const frame = dialog.locator(".drawing-vector-preview").first();
  await expect(frame).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
  await expectLiveVectorPan(page);
  await dialog.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 900, 680);
  await clickPoint(page, 1100, 680);
  async function thickness(x: number, y: number, vertical: boolean) {
    return page.evaluate(
      ({ x, y, vertical }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(".drawing-vector-preview")!;
        const svg = document.querySelector<SVGSVGElement>('svg[aria-label="CAD标号画布"]')!;
        const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!);
        const r = canvas.getBoundingClientRect();
        const cx = Math.round(((p.x - r.x) * canvas.width) / r.width),
          cy = Math.round(((p.y - r.y) * canvas.height) / r.height);
        const pixels = canvas
          .getContext("2d")!
          .getImageData(
            vertical ? cx : cx - 100,
            vertical ? cy - 100 : cy,
            vertical ? 1 : 201,
            vertical ? 201 : 1,
          ).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i]! < 180 && pixels[i + 3]! > 128) count++;
        return count;
      },
      { x, y, vertical },
    );
  }
  async function leaderWidth() {
    return (await visibleLeader(dialog))
      .evaluate((el) => {
        const p = el as SVGPolylineElement,
          m = p.getScreenCTM()!;
        return Number(p.getAttribute("stroke-width")) * (el.getAttribute("vector-effect") === "non-scaling-stroke" ? 1 : Math.hypot(m.a, m.b));
      });
  }
  const strokeBefore = await thickness(800, 600, true),
    rasterBefore = await thickness(680, 760, false);
  expect(strokeBefore).toBeGreaterThan(2);
  expect(rasterBefore).toBeGreaterThan(5);
  await dialog.locator('[data-drawing-tool="select"]').click();
  await rectangle(page, 400, 250, 1250, 950);
  // Creating a range selects its physical output settings. Compare zoom within
  // that same range, not the unscaled whole-drawing style before range creation.
  const leaderBefore = await leaderWidth();
  const first = join(workbench.root, "before-zoom.jpg"),
    second = join(workbench.root, "after-zoom.jpg");
  async function save(path: string) {
    await dialog.getByRole("button", { name: "预览成图", exact: true }).click();
    await expect(page.getByAltText("取图导出预览")).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, path);
    await page.getByRole("button", { name: "导出 JPG", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("图片已导出");
  }
  await save(first);
  await page.getByRole("dialog", { name: "成图预览", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  const center = await location(page, 800, 600);
  await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -120);
  const canvas = dialog.getByRole("application", { name: "CAD标号画布" });
  await expect
    .poll(async () => Number((await canvas.getAttribute("viewBox"))!.split(" ")[2]))
    .toBeLessThan(600);
  await expect(frame).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
  await expect.poll(() => thickness(680, 760, false), { timeout: 45000 }).toBeGreaterThan(rasterBefore * 2);
  const strokeAfter = await thickness(800, 600, true),
    rasterAfter = await thickness(680, 760, false);
  expect(Math.abs(strokeAfter - strokeBefore)).toBeLessThanOrEqual(1);
  expect(rasterAfter).toBeGreaterThan(rasterBefore * 2);
  expect(await leaderWidth()).toBeCloseTo(leaderBefore, 3);
  await dialog.screenshot({ path: test.info().outputPath("pdf-strokes.png") });
  await save(second);
  expect(await readFile(second)).toEqual(await readFile(first));
  await page.getByRole("dialog", { name: "成图预览", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await closeWorkbench(app, page);
});

test("PDF panning keeps newly exposed page areas filled before detail tiles arrive", async ({
  workbench,
}) => {
  test.setTimeout(240000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  // Keep PDF.js rendering active while the test window remains hidden.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  await createPatent(page);
  const w = await openWorkspace(page);
  await w.getByLabel("选择图纸文件").setInputFiles({
    name: "缓存取图.pdf",
    mimeType: "application/pdf",
    buffer: twoPagePdf("0.7 g 0 0 400 300 re f"),
  });
  const base = w.locator(".drawing-vector-preview").first();
  await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
  await expect(w.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "CAD标号", exact: true }).getByRole("button", { name: "标号", exact: true })).toBeEnabled({ timeout: 60_000 });
  const position = await location(page, 800, 600);
  await page.mouse.move(position.x, position.y);
  for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -120);
  await expect
    .poll(async () =>
      Number((await w.getByRole("application").getAttribute("viewBox"))!.split(" ")[2]),
    )
    .toBeLessThan(300);
  await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
  const box = (await base.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "middle" });
  const samples = await page.evaluate(async () => {
    const svg = document.querySelector<SVGSVGElement>('svg[aria-label="CAD标号画布"]')!;
    const canvas = document.querySelector<HTMLCanvasElement>(".drawing-vector-preview")!;
    const box = svg.getBoundingClientRect();
    const samples: number[][] = [];
    for (const offset of [1.1, -1.1, 0.8, -0.8, 0]) {
      svg.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          button: 1,
          buttons: 4,
          clientX: box.x + box.width / 2 + box.width * offset,
          clientY: box.y + box.height / 2,
        }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const pixels = canvas.getContext("2d")!;
      const sourceBox = canvas.getBoundingClientRect();
      for (const x of [0.1, 0.5, 0.9])
        samples.push([
          ...pixels.getImageData(
            Math.floor(((box.x + box.width * x - sourceBox.x) * canvas.width) / sourceBox.width),
            Math.floor(((box.y + box.height / 2 - sourceBox.y) * canvas.height) / sourceBox.height),
            1,
            1,
          ).data,
        ]);
      samples.push([
        sourceBox.left <= box.left &&
        sourceBox.right >= box.right &&
        sourceBox.top <= box.top &&
        sourceBox.bottom >= box.bottom
          ? 1
          : 0,
      ]);
    }
    return samples;
  });
  await page.mouse.up({ button: "middle" });
  for (const sample of samples) {
    if (sample.length === 1) expect(sample[0]).toBe(1);
    else {
      expect(sample[3]).toBe(255);
      expect(sample[0]).toBeGreaterThan(170);
      expect(sample[0]).toBeLessThan(190);
    }
  }
  await expect(base).toHaveAttribute("data-render-state", "ready", { timeout: 45000 });
  expect(Number(await base.getAttribute("data-cached-tiles"))).toBeLessThanOrEqual(32);
  await closeWorkbench(app, page);
});

test("imports the supplied DWG using the bundled offline converter", async ({ workbench }) => {
  test.skip(
    !process.env.PATENT_DWG_TEST_FILE,
    "Private drawing supplied through a local environment variable only",
  );
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  await createPatent(page);
  const dialog = await openWorkspace(page);
  await dialog.getByLabel("选择图纸文件").setInputFiles({
    name: "CAD附图.dwg",
    mimeType: "image/vnd.dwg",
    buffer: await readFile(process.env.PATENT_DWG_TEST_FILE!),
  });
  await expect(dialog.locator(".drawing-status")).not.toContainText("正在导入图纸", {
    timeout: 120000,
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(dialog.getByText("工作稿随专利保存", { exact: false })).toHaveCount(0);
  await expect(dialog.getByText("导入检查提示", { exact: true })).toBeVisible();
  await expect(dialog.getByText("已还原特殊详图引用", { exact: false })).toHaveCount(0);
  const viewport = dialog.getByRole("application", { name: "CAD标号画布" });
  const originalImage = await dialog.locator(".drawing-vector-preview img").getAttribute("src");
  const cameraBeforeSwitch = await viewport.getAttribute("viewBox");
  for (const documentName of ["说明书", "权利要求书", "说明书附图"]) {
    await page.getByRole("tab", { name: documentName, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
    await expect(dialog.locator(".drawing-status")).not.toContainText("正在绘制矢量图纸");
    await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
    await expect(viewport).toHaveAttribute("viewBox", cameraBeforeSwitch!);
    await expect(dialog.locator(".drawing-vector-preview img")).toHaveAttribute(
      "src",
      originalImage!,
    );
    await dialog.getByRole("button", { name: "标号", exact: true }).click();
    await clickPoint(page, 300, 300);
    await expect(dialog.locator('[data-drawing-preview="label"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  const box = await viewport.boundingBox();
  const originalWidth = Number((await viewport.getAttribute("viewBox"))!.split(" ")[2]);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 13; i++) await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => Number((await viewport.getAttribute("viewBox"))!.split(" ")[2]))
    .toBeLessThan(originalWidth / 2);
  await expect(dialog.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.screenshot({ path: join(process.cwd(), "out-drawing-dwg.png") });
  await expect(dialog.locator(".drawing-vector-preview img")).toBeVisible();
  await expectLiveVectorPan(page);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: "关闭CAD标号验收", exact: true }).click();
  await expect(page.getByRole("main", { name: "专利库", exact: true })).toBeVisible();
  await page.getByText("CAD标号验收", { exact: true }).first().dblclick();
  await openWorkspace(page);
  await expect(dialog.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(dialog.locator(".drawing-vector-preview").first()).toHaveAttribute(
    "data-render-state",
    "ready",
  );
  await closeWorkbench(app, page);
});

test("drawing editing keeps history, numbering and offers a modal output preview", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const workspace = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "操作细节.png", mimeType: "image/png", buffer: png });
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 200, 200);
  await page.keyboard.press("Escape");
  await expect(workspace.getByRole("button", { name: "标号", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await clickPoint(page, 200, 200);
  await clickPoint(page, 500, 150);
  await expect(workspace.getByLabel("标号内容")).toHaveValue("2");
  await workspace.getByRole("button", { name: "操作细节.png", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "撤销标号编辑" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await workspace.locator("[data-annotation] text").click();
  await workspace.getByRole("application").press("Control+z");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
  await workspace.getByRole("application").press("Control+y");
  await expect(workspace.locator("[data-annotation]")).toHaveCount(1);
  await workspace.locator("[data-annotation] text").dblclick();
  const inline = workspace.getByLabel("直接修改标号");
  await inline.fill("");
  await inline.fill("12");
  await inline.press("Enter");
  await expect(workspace.locator("[data-annotation] text")).toHaveText("12");
  await workspace.getByRole("application").press("Control+z");
  await expect(workspace.locator("[data-annotation] text")).toHaveText("1");
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await openWorkspace(page);
  await workspace.getByRole("button", { name: "标号", exact: true }).click();
  await expect(workspace.getByLabel("标号内容")).toHaveValue("2");
  await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 100, 100, 700, 500);
  await expect(workspace.locator('[data-region-handle]:not([fill="transparent"])')).toHaveCount(8);
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  expect(box!.width).toBeGreaterThan(500);
  await expect
    .poll(() =>
      preview.getByAltText("取图导出预览").evaluate((img) => {
        const image = img.getBoundingClientRect();
        const pane = img.parentElement!.getBoundingClientRect();
        return image.height > 0 && image.bottom <= pane.bottom + 1 && image.right <= pane.right + 1;
      }),
    )
    .toBe(true);

  // 弹窗已挂到 body（双屏时才能盖住另一侧功能栏），截图要取整窗才看得到它。
  await page.screenshot({ path: join(process.cwd(), "out-drawing-ux-preview.png") });
  await preview.getByRole("button", { name: "取消", exact: true }).click();
  await expect(workspace.getByRole("application")).toBeVisible();
  await closeWorkbench(app, page);
});

test("drawing gestures preserve edits across movement, source switches and native close", async ({
  workbench,
}) => {
  test.setTimeout(210000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const w = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "手势一.png", mimeType: "image/png", buffer: png });
  await w.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 200, 200);
  await clickPoint(page, 500, 150);
  await w.getByLabel("连续使用此编号").check();
  await clickPoint(page, 250, 250);
  await clickPoint(page, 600, 200);
  await clickPoint(page, 300, 300);
  await clickPoint(page, 700, 250);
  await expect(w.locator("[data-annotation] text")).toHaveText(["1", "2", "2"]);
  await page.keyboard.press("Escape");
  await w.locator("[data-annotation] text").first().click();
  await w.getByLabel("标号内容").fill("42");
  await rectangle(page, 500, 150, 520, 170);
  await expect(w.locator("[data-annotation] text").first()).toHaveText("42");
  await page.keyboard.press("Escape");
  await w.locator("[data-annotation] text").first().click();
  const x = await w.locator("[data-annotation] text").first().getAttribute("x");
  await w.getByRole("application").press("ArrowRight");
  expect(
    Number(await w.locator("[data-annotation] text").first().getAttribute("x")),
  ).toBeGreaterThan(Number(x));
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "手势二.png", mimeType: "image/png", buffer: png });
  await w.getByRole("button", { name: "手势一.png", exact: true }).click();
  await expect(w.getByRole("button", { name: "撤销标号编辑" })).toBeEnabled();
  const canvas = w.getByRole("application");
  const before = await canvas.getAttribute("viewBox");
  await canvas.focus();
  await page.keyboard.down("Space");
  await rectangle(page, 700, 500, 730, 530);
  await page.keyboard.up("Space");
  expect(await canvas.getAttribute("viewBox")).not.toBe(before);
  await w.getByRole("button", { name: "适合窗口", exact: true }).click();
  await w.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await rectangle(page, 100, 100, 800, 600);
  const outline = w.locator("[data-region-outline]");
  const points = await outline.getAttribute("points");
  await rectangle(page, 400, 100, 420, 120);
  expect(await outline.getAttribute("points")).not.toBe(points);
  const east = w.locator('[data-region-handle="e"]:not([fill="transparent"])');
  const e = await east.boundingBox();
  await page.mouse.move(e!.x + e!.width / 2, e!.y + e!.height / 2);
  await page.mouse.down();
  await page.mouse.move(e!.x + e!.width / 2 + 30, e!.y + e!.height / 2);
  await page.mouse.up();
  await expect(w.locator('[data-region-handle]:not([fill="transparent"])')).toHaveCount(8);
  await page.keyboard.press("Escape");
  await w.locator("[data-annotation] text").first().click();
  const exitSettings = await page.evaluate(() =>
    (window as unknown as { patentApi: PatentApi }).patentApi.settings.update({
      closeToTray: false,
    }),
  );
  expect(exitSettings.ok).toBe(true);
  await w.getByLabel("标号内容").fill("99");
  const drawingProcess = app.process();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed())
      ?.close(),
  );
  await expect.poll(() => drawingProcess.exitCode, { timeout: 30000 }).not.toBeNull();
  const again = await workbench.launch();
  const reopened = await again.firstWindow();
  await reopened.getByText("CAD标号验收", { exact: true }).first().dblclick();
  await openWorkspace(reopened);
  await expect(reopened.locator("[data-annotation] text").first()).toHaveText("99");
  await again.close();
});

test("range selection resizes only enclosed labels with one-step undo", async ({ workbench }) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const w = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "字号选区.png", mimeType: "image/png", buffer: png });
  const size = w.getByRole("slider", { name: "标号字号" });
  await w.getByRole("button", { name: "标号", exact: true }).click();
  await size.fill("24");
  for (const x of [200, 400]) {
    await clickPoint(page, x, 400);
    await clickPoint(page, x, 200);
  }
  // The third leader crosses the selection, but its number is outside it.
  await clickPoint(page, 300, 190);
  await clickPoint(page, 700, 200);
  const labels = w.locator("[data-annotation] text");
  await expect(labels).toHaveCount(3);
  const positions = await labels.evaluateAll((es) =>
    es.map((e) => [e.getAttribute("x"), e.getAttribute("y")]),
  );
  const paintedWidths = async () => {
    const ids = await w.locator("[data-annotation]").evaluateAll(es => es.map(e => e.getAttribute("data-annotation")));
    return Promise.all(ids.map(async (id, i) => {
      const native = w.locator('[data-cad-label="' + id + '"] path:not([fill="none"])').first();
      return (await (await native.count() ? native : labels.nth(i)).boundingBox())!.width;
    }));
  };
  for (const tool of ["选择 / 移动", "圈选取图"]) {
    await w.getByRole("button", { name: tool, exact: true }).click();
    if (tool === "选择 / 移动") {
      await rectangle(page, 100, 100, 600, 250);
    } else {
      const start = await location(page, 100, 100);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const [x, y] of [
        [600, 100],
        [600, 250],
        [100, 250],
        [100, 100],
      ]) {
        const p = await location(page, x!, y!);
        await page.mouse.move(p.x, p.y, { steps: 8 });
      }
      await page.mouse.up();
    }
    await expect(w.locator("[data-selected-annotation-count]")).toHaveText("已选中 2 个标号");
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(2);
    await size.click({ trial: true });
    const originalWidths = await paintedWidths();
    const box = (await size.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await paintedWidths())[0]).not.toBe(originalWidths[0]);
    const changedWidths = await paintedWidths();
    expect(changedWidths[1]).not.toBe(originalWidths[1]);
    expect(changedWidths[2]).toBeCloseTo(originalWidths[2]!, 2);
    expect(await labels.evaluateAll(es => es.map(e => [e.getAttribute("x"), e.getAttribute("y")]))).toEqual(positions);
    await page.keyboard.press("Control+z");
    await expect.poll(paintedWidths).toEqual(originalWidths);
    await page.keyboard.press("Control+y");
    await expect.poll(paintedWidths).toEqual(changedWidths);
    await page.keyboard.press("Control+z");
    await expect.poll(paintedWidths).toEqual(originalWidths);
    await page.keyboard.press("Escape");
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(0);
    await w.getByRole("button", { name: "标号", exact: true }).click();
    await size.fill("48");
    for (const label of await labels.all()) await expect(label).toHaveAttribute("font-size", "24");
  }
  await closeWorkbench(app, page);
});

test("range tools finish in selection mode and blank canvas clears the old range", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const w = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "连续选区.png", mimeType: "image/png", buffer: png });
  const outline = w.locator("[data-region-outline]");
  for (const name of ["选择 / 移动", "圈选取图"]) {
    const tool = w.getByRole("button", { name, exact: true });
    await tool.click();
    const draw = async () => {
      if (name === "圈选取图" && (await tool.getAttribute("aria-pressed")) !== "true")
        await tool.click();
      const start = await location(page, 200, 200);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await expect(outline).toHaveCount(0);
      for (const [x, y] of name === "选择 / 移动"
        ? [[600, 500]]
        : [
            [600, 200],
            [600, 500],
            [200, 500],
            [200, 200],
          ]) {
        const p = await location(page, x!, y!);
        await page.mouse.move(p.x, p.y, { steps: 6 });
      }
      await page.mouse.up();
      await expect(outline).toHaveCount(1);
      await expect(w.getByRole("button", { name: "选择 / 移动", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    };
    await draw();
    // Dragging blank canvas starts a new range; existing corners remain resize handles.
    await page.keyboard.press("Escape");
    await tool.click();
    await draw();
    // Inside the crop now moves its contents; blank canvas outside it starts a fresh range.
    const click = await location(page, 800, 650);
    await page.mouse.move(click.x, click.y);
    await page.mouse.down();
    await expect(outline).toHaveCount(0);
    await expect(w.locator("[data-selected-annotation-count]")).toHaveCount(0);
    await page.mouse.up();
    await expect(outline).toHaveCount(0);
    await expect(w.getByRole("alert")).toHaveCount(0);
    await expect(w.getByRole("button", { name: "选择 / 移动", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await draw();
    await page.keyboard.press("Escape");
    await expect(outline).toHaveCount(0);
    await expect(tool).toHaveAttribute("aria-pressed", name === "圈选取图" ? "false" : "true");
  }
  await closeWorkbench(app, page);
});

test("drawing style defaults, selected dragging and modal preview", async ({ workbench }) => {
  test.setTimeout(240000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const w = await openWorkspace(page);
  const png = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await w
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "默认样式.png", mimeType: "image/png", buffer: png });
  await expect(w.getByRole("button", { name: "框选取图", exact: true })).toHaveCount(0);
  await w.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(page, 200, 300);
  await clickPoint(page, 500, 200);
  const text = w.locator("[data-annotation] text").first();
  await expect(text).toHaveAttribute("font-size", "12");
  await expect(text).toHaveCSS("font-weight", "400");
  await page.keyboard.press("Escape");
  const readMark = () =>
    w
      .locator("[data-annotation]")
      .first()
      .evaluate((g) => {
        const t = g.querySelector("text")!;
        const line = g.querySelector("polyline")!;
        return {
          x: Number(t.getAttribute("x")),
          y: Number(t.getAttribute("y")),
          points: line
            .getAttribute("points")!
            .split(" ")
            .map((p) => p.split(",").map(Number)),
        };
      });
  const before = await readMark();
  await rectangle(page, before.x, before.y, before.x + 30, before.y + 20);
  expect(await readMark()).toEqual(before);
  await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(1);
  const handle = await w.locator("[data-point-index]").first().boundingBox();
  expect(handle!.width).toBeLessThan(8);
  // Dragging a selected leader places the label above the cursor and carries every point together.
  const midX = (before.points[0]![0]! + before.points[1]![0]!) / 2;
  const midY = (before.points[0]![1]! + before.points[1]![1]!) / 2;
  await rectangle(page, midX, midY, midX + 40, midY + 30);
  const moved = await readMark();
  expect(moved.x).toBeCloseTo(midX + 40, 0);
  expect(moved.y + 12 * 0.55).toBeLessThan(midY + 30);
  for (let i = 0; i < before.points.length; i++) {
    expect(moved.points[i]![0]! - before.points[i]![0]!).toBeCloseTo(moved.x - before.x, 0);
    expect(moved.points[i]![1]! - before.points[i]![1]!).toBeCloseTo(moved.y - before.y, 0);
  }
  await page.keyboard.press("Control+z");
  expect(await readMark()).toEqual(before);
  await text.click();
  await rectangle(page, before.x, before.y, before.x + 30, before.y + 20);
  expect((await readMark()).points[0]).toEqual(before.points[0]);
  await page.keyboard.press("Control+z");
  // Default rectangle gesture on blank canvas, and consistent clipped colors/weight.
  await page.keyboard.press("Escape");
  await rectangle(page, 100, 100, 350, 400);
  await expect(w.locator("[data-region-outline]")).toHaveCount(1);
  await expect(text).toHaveCSS("fill", "rgb(224, 0, 0)");
  await expect(text).toHaveCSS("stroke", "none");
  await expect(text).toHaveCSS("font-weight", "400");
  const line = (await visibleLeader(w));
  await expect(line).toHaveCSS("stroke", "rgb(224, 0, 0)");
  await expectLeaderWeight(line);
  // Auto sizing excludes a label whose number is outside the crop. This fixture
  // is otherwise blank, so the empty crop must report failure, not create a JPEG.
  await w.getByRole("button", { name: "预览成图", exact: true }).click();
  await expect(w.getByRole("alert")).toHaveText("所选范围没有可见图形或标号，请重新取图。");
  await expect(w.getByLabel("CAD标号画布")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(w.locator("[data-region-outline]")).toHaveCount(0);
  await rectangle(page, 100, 100, 800, 650);
  const outline = await w.locator("[data-region-outline]").getAttribute("points");
  await w.getByRole("button", { name: "预览成图", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByAltText("取图导出预览")).toBeVisible();
  await expect(preview.getByRole("button", { name: "导出 JPG", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(w.locator("[data-region-outline]")).toHaveAttribute("points", outline!);
  await page.keyboard.press("Escape");
  await w.getByRole("button", { name: "标号", exact: true }).click();
  await w.getByText("标号样式", { exact: true }).click();
  // 引出线线宽不再允许用户设置：样式面板里只剩字号可调。
  await expect(w.getByLabel("引出线线宽", { exact: true })).toHaveCount(0);
  await w.getByLabel("标号字号数值", { exact: true }).fill("18");
  await w.getByRole("button", { name: "保存为默认", exact: true }).click();
  await expect(w.locator(".drawing-status")).toContainText("标号字号已保存为默认");
  // Unsaved changes to the tool style must not overwrite the explicit default.
  await w.getByLabel("标号字号数值", { exact: true }).fill("28");
  await page.evaluate(() =>
    (window as unknown as { patentApi: PatentApi }).patentApi.settings.update({
      closeToTray: false,
    }),
  );
  const process = app.process();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed())
      ?.close(),
  );
  await expect.poll(() => process.exitCode, { timeout: 30000 }).not.toBeNull();
  const again = await workbench.launch();
  const reopened = await again.firstWindow();
  await reopened.getByText("CAD标号验收", { exact: true }).first().dblclick();
  const restored = await openWorkspace(reopened);
  await restored.getByRole("button", { name: "标号", exact: true }).click();
  await clickPoint(reopened, 300, 500);
  await clickPoint(reopened, 600, 450);
  await expect(restored.locator("[data-annotation] text").last()).toHaveAttribute(
    "font-size",
    "18",
  );
  // 旧版留在默认样式里的 0.5 线宽已不再生效，重启后仍是固定的 0.3 mm 口径。
  await expectLeaderWeight(restored.locator("[data-annotation] polyline").last());
  await expect(restored.locator("[data-annotation] text").first()).toHaveAttribute(
    "font-size",
    "12",
  );
  await again.close();
});

test("directional rectangles expand crossing labels only on release and share the finished outline width", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const w = await openWorkspace(page);
    const png = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await w
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "方向框选.png", mimeType: "image/png", buffer: png });
    await w.getByRole("button", { name: "标号", exact: true }).click();
    await clickPoint(page, 200, 300);
    await clickPoint(page, 700, 300);
    await page.keyboard.press("Escape");
    const preview = w.locator('[data-drawing-preview="range"]');
    const outline = w.locator("[data-region-outline]");
    const start = await location(page, 450, 260),
      left = await location(page, 400, 340),
      right = await location(page, 500, 340);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(right.x, right.y, { steps: 5 });
    await expect(preview).toHaveAttribute("stroke", "#2563eb");
    const width = await preview.getAttribute("stroke-width");
    const blue = await preview.getAttribute("points");
    const blueCoordinates = blue!.split(/[ ,]/u).map(Number);
    for (const [i, value] of [450, 260, 500, 260, 500, 340, 450, 340].entries()) {
      expect(blueCoordinates[i]).toBeCloseTo(value, 3);
    }
    await page.mouse.move(left.x, left.y, { steps: 5 });
    await expect(preview).toHaveAttribute("stroke", "#169447");
    await expect(w.locator("[data-annotation] text")).toHaveCSS("fill", "rgb(0, 122, 255)");
    await expect((await visibleLeader(w))).toHaveCSS(
      "stroke",
      "rgb(0, 122, 255)",
    );
    await expect(w.locator("[data-selected-annotation-count]")).toHaveText("将选中 1 个标号");
    const green = await preview.getAttribute("points");
    const greenCoordinates = green!.split(/[ ,]/u).map(Number);
    for (const [i, value] of [400, 260, 450, 260, 450, 340, 400, 340].entries()) {
      expect(greenCoordinates[i]).toBeCloseTo(value, 3);
    }
    await page.mouse.move(right.x, right.y, { steps: 5 });
    await expect(preview).toHaveAttribute("stroke", "#2563eb");
    await expect(preview).toHaveAttribute("points", blue!);
    await expect(w.locator("[data-annotation] text")).toHaveCSS("fill", "rgb(0, 0, 0)");
    await expect((await visibleLeader(w))).toHaveCSS(
      "stroke",
      "rgb(0, 0, 0)",
    );
    await page.mouse.move(left.x, left.y, { steps: 5 });
    await page.mouse.up();
    await expect(outline).toHaveAttribute("stroke-width", width!);
    const expanded = await outline.getAttribute("points");
    const xs = expanded!.split(" ").map((p) => Number(p.split(",")[0]));
    expect(Math.min(...xs)).toBeLessThan(200);
    expect(Math.max(...xs)).toBeGreaterThan(700);
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(1);
    await expect(w.locator("[data-annotation] .is-clipped")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const digit = w.locator("[data-annotation] text");
    const label = await digit.evaluate((t) => ({
      x: Number(t.getAttribute("x")),
      y: Number(t.getAttribute("y")),
    }));
    // Only the number's right edge intersects; the leader is entirely outside the mouse rectangle.
    const digitStart = await location(page, label.x + 8, label.y - 8);
    const digitEnd = await location(page, label.x + 1, label.y + 8);
    await page.mouse.move(digitStart.x, digitStart.y);
    await page.mouse.down();
    await page.mouse.move(digitEnd.x, digitEnd.y, { steps: 5 });
    await expect(digit).toHaveCSS("fill", "rgb(0, 122, 255)");
    await expect((await visibleLeader(w))).toHaveCSS(
      "stroke",
      "rgb(0, 122, 255)",
    );
    const pendingXs = (await preview.getAttribute("points"))!
      .split(" ")
      .map((p) => Number(p.split(",")[0]));
    expect(Math.min(...pendingXs)).toBeGreaterThan(label.x);
    await page.mouse.up();
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(1);
    await expect(w.locator("[data-annotation] .is-clipped")).toHaveCount(0);
    const digitXs = (await outline.getAttribute("points"))!
      .split(" ")
      .map((p) => Number(p.split(",")[0]));
    expect(Math.min(...digitXs)).toBeLessThan(200);
    await page.keyboard.press("Escape");
    await expect(outline).toHaveCount(0);
    // A crop containing the number but not its leader must stay red despite automatic range selection.
    await rectangle(page, label.x - 18, label.y - 18, label.x + 18, label.y + 18);
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(1);
    await expect(digit).toHaveClass(/is-clipped/);
    await expect(digit).toHaveCSS("fill", "rgb(224, 0, 0)");
    await expect((await visibleLeader(w))).toHaveCSS(
      "stroke",
      "rgb(224, 0, 0)",
    );
    await expect(digit).toHaveAttribute("font-weight", "400");
    await digit.click();
    await expect(digit).toHaveCSS("fill", "rgb(0, 122, 255)");
    await expect((await visibleLeader(w))).toHaveCSS(
      "stroke",
      "rgb(0, 122, 255)",
    );
  } finally {
    await page.mouse.up().catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await closeWorkbench(app, page);
  }
});

test("label tool keeps the next number selected and exits on toggle or right click", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const w = await openWorkspace(page);
    const buffer = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await w
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "focus.png", mimeType: "image/png", buffer });
    const button = w.getByRole("button", { name: "标号", exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    const input = w.getByLabel("标号内容", { exact: true });
    await expect(input).toBeFocused();
    expect(await input.evaluate((e: HTMLInputElement) => e.selectionEnd! - e.selectionStart!)).toBe(
      1,
    );
    await page.keyboard.type("21");
    await clickPoint(page, 200, 300);
    await expect(input).toBeFocused();
    await clickPoint(page, 500, 250);
    await expect(w.locator("[data-annotation] text")).toHaveText(["21"]);
    await expect(input).toHaveValue("22");
    await expect(input).toBeFocused();
    expect(await input.evaluate((e: HTMLInputElement) => e.selectionEnd! - e.selectionStart!)).toBe(
      2,
    );
    await page.keyboard.type("8");
    await clickPoint(page, 200, 500);
    await page.keyboard.type("9");
    await clickPoint(page, 500, 450);
    await expect(w.locator("[data-annotation] text")).toHaveText(["21", "89"]);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await clickPoint(page, 300, 300);
    const destination = await location(page, 600, 300);
    await page.mouse.click(destination.x, destination.y, { button: "right" });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(w.locator('[data-drawing-preview="label"]')).toHaveCount(0);
    await expect(w.locator("[data-annotation]")).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expect(w.locator("[data-annotation]")).toHaveCount(1);
    await page.keyboard.press("Control+y");
    await expect(w.locator("[data-annotation]")).toHaveCount(2);
    const feedback = await w.locator(".drawing-feedback").boundingBox();
    const hint = await w.locator(".drawing-view-hint").boundingBox();
    expect(Math.abs(hint!.y - feedback!.y)).toBeLessThan(5);
  } finally {
    await page.mouse.up();
    await page.keyboard.press("Escape");
    const close = page.getByRole("button", { name: "关闭CAD标号", exact: true });
    if (await close.isVisible()) await close.click();
    await closeWorkbench(app, page);
  }
});

test("Ctrl rectangles and lassos select only labels for group move copy paste and deletion", async ({
  workbench,
}) => {
  test.setTimeout(150000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await createPatent(page);
    const w = await openWorkspace(page);
    const buffer = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await w
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "group.png", mimeType: "image/png", buffer });
    await w.getByRole("button", { name: "标号", exact: true }).click();
    for (const y of [200, 350, 650]) {
      await clickPoint(page, 250, y);
      await clickPoint(page, 500, y);
    }
    await w.getByRole("button", { name: "选择 / 移动" }).click();
    await rectangle(page, 100, 100, 800, 750);
    const crop = await w.locator("[data-region-outline]").getAttribute("points");
    await page.keyboard.down("Control");
    await rectangle(page, 150, 150, 550, 400);
    await page.keyboard.up("Control");
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(2);
    await expect(w.locator("[data-region-outline]")).toHaveAttribute("points", crop!);
    const before = await w
      .locator("[data-annotation] text")
      .evaluateAll((es) =>
        es.map((e) => ({ x: Number(e.getAttribute("x")), y: Number(e.getAttribute("y")) })),
      );
    const box = await w
      .locator('[data-annotation][data-selected="true"] text')
      .first()
      .boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 35, box!.y + box!.height / 2 + 20, {
      steps: 5,
    });
    await page.mouse.up();
    const after = await w
      .locator("[data-annotation] text")
      .evaluateAll((es) =>
        es.map((e) => ({ x: Number(e.getAttribute("x")), y: Number(e.getAttribute("y")) })),
      );
    expect(after[0]!.x).toBeGreaterThan(before[0]!.x);
    expect(after[1]!.x - before[1]!.x).toBeCloseTo(after[0]!.x - before[0]!.x, 3);
    expect(after[2]).toEqual(before[2]);
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    const pastedPreview = w.locator('[data-drawing-preview="paste"], [data-cad-affine-preview]');
    await expect(w.locator("[data-annotation]")).toHaveCount(3);
    const previewAt = await location(page, 650, 520);
    await page.mouse.move(previewAt.x, previewAt.y);
    await expect(pastedPreview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pastedPreview).toHaveCount(0);
    await expect(w.locator("[data-annotation]")).toHaveCount(3);
    await page.keyboard.press("Control+v");
    const pasteAt = await location(page, 650, 520);
    await page.mouse.click(pasteAt.x, pasteAt.y, { button: "right" });
    await expect(pastedPreview).toHaveCount(0);
    await expect(w.locator("[data-annotation]")).toHaveCount(3);
    await page.keyboard.press("Control+v");
    await page.mouse.move(pasteAt.x, pasteAt.y);
    await expect(pastedPreview).toBeVisible();
    const ghostBefore = (await pastedPreview.boundingBox())!;
    await page.mouse.move(pasteAt.x + 30, pasteAt.y + 25, { steps: 4 });
    await expect.poll(async () => (await pastedPreview.boundingBox())!.x).not.toBe(ghostBefore.x);
    await page.mouse.click(pasteAt.x + 30, pasteAt.y + 25);
    await expect(pastedPreview).toHaveCount(0);
    await expect(w.locator("[data-annotation]")).toHaveCount(5);
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(2);
    const pastedPositions = await w
      .locator('[data-annotation][data-selected="true"] text')
      .evaluateAll((es) =>
        es.map((e) => ({ x: Number(e.getAttribute("x")), y: Number(e.getAttribute("y")) })),
      );
    expect(pastedPositions).toHaveLength(2);
    expect(pastedPositions[1]!.x - pastedPositions[0]!.x).toBeCloseTo(after[1]!.x - after[0]!.x, 2);
    expect(pastedPositions[1]!.y - pastedPositions[0]!.y).toBeCloseTo(after[1]!.y - after[0]!.y, 2);
    await expect(w.locator("[data-annotation]")).toHaveCount(5);
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(2);
    await page.keyboard.press("Delete");
    await expect(w.locator("[data-annotation]")).toHaveCount(3);
    await page.keyboard.press("Control+z");
    await expect(w.locator("[data-annotation]")).toHaveCount(5);
    await page.keyboard.press("Control+z");
    await expect(w.locator("[data-annotation]")).toHaveCount(3);
    await w.getByRole("button", { name: "圈选取图" }).click();
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
    await page.keyboard.down("Control");
    const points = await Promise.all(
      [
        [150, 130],
        [650, 130],
        [650, 450],
        [150, 450],
        [150, 130],
      ].map(([x, y]) => location(page, x!, y!)),
    );
    await page.mouse.move(points[0]!.x, points[0]!.y);
    await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(2);
    await expect(w.locator("[data-region-outline]")).toHaveCount(0);
    await w.getByRole("button", { name: "删除选中标号" }).click();
    await expect(w.locator("[data-annotation] text")).toHaveText(["3"]);
    await page.keyboard.press("Escape");
    await expect(w.locator('[data-annotation][data-selected="true"]')).toHaveCount(0);
    await w.locator("[data-annotation] text").click();
    await w.getByRole("button", { name: "复制标号", exact: true }).click();
    await expect(w.locator("[data-annotation]")).toHaveCount(1);
    await w.getByRole("button", { name: "粘贴标号", exact: true }).click();
    await page.mouse.move(pasteAt.x, pasteAt.y);
    await expect(pastedPreview).toBeVisible();
    await expect(w.locator("[data-annotation]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(pastedPreview).toHaveCount(0);
  } finally {
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.keyboard.press("Escape");
    const close = page.getByRole("button", { name: "关闭CAD标号", exact: true });
    if (await close.isVisible()) await close.click();
    await closeWorkbench(app, page);
  }
});

for (const sourceKind of ["image", "pdf"] as const)
  test(`selected base content moves copies previews and survives reopening: ${sourceKind}`, async ({
    workbench,
  }) => {
    test.setTimeout(180000);
    const app = await workbench.launch();
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false);
    });
    const factor = sourceKind === "pdf" ? 1.6 : 1;
    const select = (x1: number, y1: number, x2: number, y2: number) =>
      rectangle(page, x1 * factor, y1 * factor, x2 * factor, y2 * factor);
    const click = (x: number, y: number) => clickPoint(page, x * factor, y * factor);
    try {
      await createPatent(page);
      const w = await openWorkspace(page);
      const png = await sharp(
        Buffer.from(
          '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="200" y="200" width="40" height="40"/><rect x="850" y="600" width="20" height="20"/></svg>',
        ),
      )
        .png()
        .toBuffer();
      await w.getByLabel("选择图纸文件").setInputFiles(
        sourceKind === "pdf"
          ? {
              name: "move.pdf",
              mimeType: "application/pdf",
              buffer: twoPagePdf("0 g 80 204 16 16 re f 340 52 8 8 re f"),
            }
          : { name: "move.png", mimeType: "image/png", buffer: png },
      );
      if (sourceKind === "pdf")
        await expect(w.locator(".drawing-vector-preview").first()).toHaveAttribute(
          "data-render-state",
          "ready",
          { timeout: 45000 },
        );
      await w.getByRole("button", { name: "标号", exact: true }).click();
      await click(230, 230);
      await click(310, 150);
      await page.keyboard.press("Escape");
      const originalX = Number(await w.locator("[data-annotation] text").getAttribute("x"));
      const stageBeforeSelection = await w.locator(".drawing-stage").boundingBox();
      await select(100, 100, 400, 350);
      await expect(w.locator("[data-selected-annotation-count]")).toBeVisible();
      const stageAfterSelection = await w.locator(".drawing-stage").boundingBox();
      expect(stageAfterSelection?.y).toBeCloseTo(stageBeforeSelection?.y ?? 0, 0);
      expect(stageAfterSelection?.height).toBeCloseTo(stageBeforeSelection?.height ?? 0, 0);
      await select(150, 300, 550, 300);
      await expect(w.locator("[data-base-fragments]")).toHaveAttribute("data-base-fragments", "2");
      await expect
        .poll(async () => Number(await w.locator("[data-annotation] text").getAttribute("x")))
        .toBeCloseTo(originalX + 400 * factor, 1);
      await page.screenshot({ path: test.info().outputPath("moved.png") });
      const pixel = async (x: number, y: number) => {
        const p = await location(page, x * factor, y * factor);
        const { data } = await sharp(await page.screenshot({ scale: "css" }))
          .extract({ left: Math.round(p.x), top: Math.round(p.y), width: 1, height: 1 })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return data[0]!;
      };
      await expect.poll(() => pixel(220, 220)).toBeGreaterThan(220);
      await expect.poll(() => pixel(620, 220)).toBeLessThan(30);
      await page.keyboard.press("Control+z");
      await expect.poll(() => pixel(220, 220)).toBeLessThan(30);
      await page.keyboard.press("Control+y");
      await expect.poll(() => pixel(620, 220)).toBeLessThan(30);
      await page.keyboard.press("Escape");
      await select(500, 100, 800, 350);
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await expect(w.locator("[data-base-ghost]")).toHaveCount(1);
      await expect(w.locator("[data-annotation]")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(w.locator("[data-base-ghost]")).toHaveCount(0);
      await page.keyboard.press("Control+v");
      await click(500, 500);
      await expect(w.locator("[data-annotation]")).toHaveCount(2);
      await expect(w.locator("[data-base-ghost]")).toHaveCount(0);
      await page.keyboard.press("Control+z");
      await expect(w.locator("[data-annotation]")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await select(50, 50, 950, 700);
      await w.getByRole("button", { name: "预览成图", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "成图预览", exact: true });
      const ratio = await preview
        .getByAltText("取图导出预览")
        .evaluate(
          (img) => (img as HTMLImageElement).naturalWidth / (img as HTMLImageElement).naturalHeight,
        );
      expect(ratio).toBeLessThan(0.9);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
      await page.getByRole("button", { name: "关闭CAD标号验收", exact: true }).click();
      await expect(page.getByRole("main", { name: "专利库", exact: true })).toBeVisible();
      await page
        .getByRole("main", { name: "专利库", exact: true })
        .getByText("CAD标号验收", { exact: true })
        .first()
        .dblclick();
      await expect(page.getByRole("tab", { name: "CAD标号验收", exact: true })).toBeVisible();
      await openWorkspace(page);
      await expect(w.locator("[data-base-fragments]")).toHaveAttribute("data-base-fragments", "2");
      await expect.poll(() => pixel(220, 220)).toBeGreaterThan(220);
      await expect.poll(() => pixel(620, 220)).toBeLessThan(30);
    } finally {
      await page.mouse.up();
      await page.keyboard.press("Escape");
      const close = page.getByRole("button", { name: "关闭CAD标号", exact: true });
      if (await close.isVisible()) await close.click();
      await closeWorkbench(app, page);
    }
  });

test("DWG base fragments keep vector rendering after movement and tab return", async ({
  workbench,
}) => {
  test.skip(!process.env.PATENT_DWG_TEST_FILE, "Local DWG fixture required");
  test.setTimeout(180000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false);
  });
  try {
    await createPatent(page);
    const w = await openWorkspace(page);
    await w.getByLabel("选择图纸文件").setInputFiles({
      name: "drawing.dwg",
      mimeType: "image/vnd.dwg",
      buffer: await readFile(process.env.PATENT_DWG_TEST_FILE!),
    });
    await expect(w.locator(".drawing-vector-preview").first()).toHaveAttribute(
      "data-render-state",
      "ready",
      { timeout: 120000 },
    );
    await expect(w.locator("[data-base-fragments]")).toHaveCount(0);
    const view = (await w.getByRole("application").getAttribute("viewBox"))!.split(" ").map(Number);
    const width = view[2]! / 1.08,
      height = view[3]! / 1.08;
    await rectangle(page, -1, -1, width + 1, height + 1);
    await rectangle(page, width * 0.3, height * 0.3, width * 0.4, height * 0.4);
    const fragments = w.locator("[data-base-fragments]");
    await expect(fragments).toHaveAttribute("data-render-state", "ready");
    await expect(fragments).toHaveAttribute("data-base-fragments", "1");
    await page.keyboard.press("Control+z");
    await expect(fragments).toHaveCount(0);
    await page.keyboard.press("Control+y");
    await expect(fragments).toHaveAttribute("data-render-state", "ready");
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
    await expect(fragments).toHaveAttribute("data-render-state", "ready");
    await expect(w.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
    await w.getByRole("button", { name: "预览成图", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "成图预览", exact: true }).getByAltText("取图导出预览"),
    ).toBeVisible();
    await expect(w.getByRole("alert")).toHaveCount(0);
  } finally {
    await page.mouse.up();
    await page.keyboard.press("Escape");
    const close = page.getByRole("button", { name: "关闭CAD标号", exact: true });
    if (await close.isVisible()) await close.click();
    await closeWorkbench(app, page);
  }
});

test("detail view creates circular enlargement, exports JPEG and survives reopening", async ({
  workbench,
}) => {
  test.setTimeout(process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1" ? 240000 : 120000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await createPatent(page);
  const workspace = await openWorkspace(page);
  const png = await sharp(
    Buffer.from(
      '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><path d="M280 270 H320 V330 H280 Z M270 300 H330" stroke="black" fill="none" stroke-width="2"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles({ name: "局部图测试.png", mimeType: "image/png", buffer: png });
  await workspace.getByRole("button", { name: "局部放大", exact: true }).click();
  await expect(workspace.getByLabel("局部放大比例", { exact: true })).toHaveValue("2:1");
  const settings = workspace.locator(".drawing-detail-settings");
  await settings.locator("summary").click();
  await settings.getByLabel("默认放大比例").fill("1.5:1");
  await settings.getByRole("button", { name: "保存为默认" }).click();
  await expect(workspace.getByLabel("局部放大比例", { exact: true })).toHaveValue("1.5:1");
  await settings.getByLabel("默认放大比例").fill("1:1");
  await settings.getByRole("button", { name: "保存为默认" }).click();
  await expect(workspace.getByLabel("局部放大比例", { exact: true })).toHaveValue("1:1");
  await settings.locator("summary").click();
  await workspace.getByLabel("局部放大比例").fill("2:1");
  await clickPoint(page, 300, 300);
  const edge = await location(page, 350, 300);
  await page.mouse.move(edge.x, edge.y);
  await expect(workspace.locator("[data-detail-radius-ghost]")).toHaveAttribute("r", /5[0-9]|49/);
  await clickPoint(page, 350, 300);
  await expect(
    workspace.locator('[data-detail="pending-detail"] [data-detail-part="marker"]'),
  ).toBeAttached();
  await expect(workspace.locator('[data-detail-image="pending-detail"]')).toHaveCount(0);
  await clickPoint(page, 200, 200);
  await clickPoint(page, 650, 250);
  await page.keyboard.press("Escape");
  await workspace.locator('[data-detail-part="content"]').click();
  const circle = workspace.locator('[data-detail-part="content"]');
  await expect(circle).toHaveCount(1);
  await expect(circle).toHaveAttribute("r", /100|99/);
  await workspace
    .locator(".drawing-viewport")
    .screenshot({ path: test.info().outputPath("detail-circle.png") });
  await expect(
    workspace.locator('[data-detail-image] [data-render-state="ready"]').first(),
  ).toBeAttached();
  // The circular clip, pixels and SVG outline must move together during live pan.
  const detailImage = workspace.locator("[data-detail-image]").first();
  for (const cancel of [false, true]) {
    const beforeImage = (await detailImage.boundingBox())!;
    const beforeCircle = (await circle.boundingBox())!;
    const start = await location(page, 450, 500);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(start.x + 60, start.y + 30, { steps: 6 });
    const duringImage = (await detailImage.boundingBox())!;
    const duringCircle = (await circle.boundingBox())!;
    expect(duringImage.x - beforeImage.x).toBeCloseTo(60, 0);
    expect(duringImage.y - beforeImage.y).toBeCloseTo(30, 0);
    expect(duringCircle.x - beforeCircle.x).toBeCloseTo(60, 0);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up({ button: "middle" });
    await expect
      .poll(async () => (await detailImage.boundingBox())!.x)
      .toBeCloseTo(beforeImage.x + (cancel ? 0 : 60), 0);
  }
  await circle.click();
  await workspace.getByRole("button", { name: "放大局部图", exact: true }).click();
  await expect(workspace.getByLabel("局部放大比例")).toHaveValue("2.5:1");
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await openWorkspace(page);
  await expect(workspace.locator("[data-detail]")).toHaveCount(1);
  await expect(workspace.locator('[data-detail-part="title"]')).toContainText("2.5:1");
  await workspace.getByRole("button", { name: "局部放大", exact: true }).click();
  await clickPoint(page, 650, 250);
  await clickPoint(page, 675, 250);
  await clickPoint(page, 750, 350);
  await workspace.getByLabel("局部放大比例").fill("2.5:1");
  await clickPoint(page, 300, 600);
  await page.keyboard.press("Escape");
  await expect(workspace.locator("[data-detail]")).toHaveCount(2);
  await expect(workspace.locator('[data-detail-image] [data-render-state="ready"]')).toHaveCount(2);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await openWorkspace(page);
  await expect(workspace.locator("[data-detail]")).toHaveCount(2);
  await workspace
    .locator(".drawing-viewport")
    .screenshot({ path: test.info().outputPath("nested-detail.png") });
  await rectangle(page, 190, 430, 410, 710);
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  // Locate the dedicated preview regardless of its dialog heading.
  const output = page.getByRole("img", { name: "取图导出预览" });
  await expect(output).toBeVisible();
  const result = await output.evaluate(async (img) => {
    const r = await fetch((img as HTMLImageElement).src);
    const blob = await r.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 80) dark++;
    return { type: blob.type, width: bitmap.width, height: bitmap.height, dark };
  });
  expect(result.type).toBe("image/jpeg");
  expect(result.dark).toBeGreaterThan(100);
  expect(result.width).toBeGreaterThan(200);
  expect(result.height).toBeGreaterThan(200);
  await page.keyboard.press("Escape");
  await expect(output).not.toBeVisible();
  await workspace.getByRole("button", { name: "取消选区", exact: true }).click();
  await rectangle(page, 190, 430, 410, 710);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(workspace.locator("[data-detail-image]")).toHaveCount(3);
  await expect(workspace.locator('[data-detail][opacity="1"]')).toHaveCount(2);
  await clickPoint(page, 500, 600);
  await expect(workspace.locator('[data-detail][opacity="1"]')).toHaveCount(3);
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await openWorkspace(page);
  await expect(workspace.locator("[data-detail]")).toHaveCount(3);
  await expect(workspace.locator('[data-detail-image] [data-render-state="ready"]')).toHaveCount(3);
  await rectangle(page, 390, 430, 610, 710);
  await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
  await expect(output).toBeVisible();
  await output.screenshot({ path: test.info().outputPath("copied-detail-export.png") });
  await page.keyboard.press("Escape");

  await closeWorkbench(app, page);
});

test("DWG detail keeps SVG source while enlarging and exporting", async ({ workbench }) => {
  test.skip(!process.env.PATENT_DWG_TEST_FILE, "optional local CAD fixture");
  test.setTimeout(120000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false);
    });
    await createPatent(page);
    const workspace = await openWorkspace(page);
    await workspace.getByLabel("选择图纸文件").setInputFiles({
      name: "detail.dwg",
      mimeType: "image/vnd.dwg",
      buffer: await readFile(process.env.PATENT_DWG_TEST_FILE!),
    });
    await workspace.getByRole("button", { name: "局部放大", exact: true }).click();
    const size = await workspace.getByLabel("CAD标号画布").getAttribute("viewBox");
    const [, , width, height] = size!.split(" ").map(Number);
    const cx = width! * 0.3,
      cy = height! * 0.5,
      radius = Math.min(width!, height!) * 0.08;
    await clickPoint(page, cx, cy);
    await clickPoint(page, cx + radius, cy);
    await clickPoint(page, cx - radius * 1.5, cy - radius * 1.5);
    await clickPoint(page, width! * 0.7, height! * 0.4);
    await page.keyboard.press("Escape");
    await workspace.locator('[data-detail-part="content"]').click();
    const vector = workspace.locator("[data-detail-image] img");
    await expect(vector).toHaveCount(1);
    expect(
      await vector.evaluate(async (img) =>
        (await fetch((img as HTMLImageElement).src)).headers.get("content-type"),
      ),
    ).toBe("image/svg+xml");
    await expect(workspace.locator("[data-detail-image] .drawing-vector-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
    );
    await workspace.getByRole("button", { name: "放大局部图", exact: true }).click();
    await expect(workspace.locator("[data-detail-image] .drawing-vector-preview")).toHaveAttribute(
      "data-render-state",
      "ready",
    );
    await workspace
      .locator(".drawing-viewport")
      .screenshot({ path: test.info().outputPath("dwg-detail.png") });
    await page.keyboard.press("Escape");
    await rectangle(page, width! * 0.5, height! * 0.12, width! * 0.9, height! * 0.7);
    await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
    await expect(page.getByRole("img", { name: "取图导出预览" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("img", { name: "取图导出预览" })).not.toBeVisible();
    await workspace.getByRole("button", { name: "取消选区", exact: true }).click();
    const canvas = workspace.getByLabel("CAD标号画布");
    const before = (await canvas.getAttribute("viewBox"))!.split(" ").map(Number);
    const sources = await workspace
      .locator(".drawing-vector-preview img")
      .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
    // Hidden windows do not provide a reliable frame-rate measurement. Check
    // final geometry here; intermediate frames are covered by the camera tests.
    await workspace.getByRole("button", { name: "放大图纸", exact: true }).click();
    await expect
      .poll(async () => Number((await canvas.getAttribute("viewBox"))!.split(" ")[2]))
      .toBeCloseTo(before[2]! / 1.2, 4);
    const after = (await canvas.getAttribute("viewBox"))!.split(" ").map(Number);
    expect(after[0]! + after[2]! / 2).toBeCloseTo(before[0]! + before[2]! / 2, 4);
    expect(after[1]! + after[3]! / 2).toBeCloseTo(before[1]! + before[3]! / 2, 4);
    expect(
      await workspace
        .locator(".drawing-vector-preview img")
        .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src)),
    ).toEqual(sources);
    await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  } finally {
    await closeWorkbench(app, page);
  }
});
