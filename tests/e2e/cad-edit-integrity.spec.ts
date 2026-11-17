import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { expect, test } from "./helpers/workbench.js";

async function createPatent(page: Page, name: string) {
  const welcome = page.getByRole("dialog", { name: /^欢迎使用/ });
  if (await welcome.isVisible())
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("textbox", { name: "专利名称" }).fill(name);
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
}

async function openWorkspace(page: Page) {
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  return page.getByRole("region", { name: "CAD标号", exact: true });
}

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
    await new Promise(requestAnimationFrame);
  });
}

async function location(page: Page, x: number, y: number) {
  await settleLayout(page);
  return page.getByRole("application", { name: "CAD标号画布" }).evaluate(
    (svg, p) => {
      const matrix = (svg as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error("CAD canvas transform unavailable");
      const point = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    },
    { x, y },
  );
}

async function clickPoint(page: Page, x: number, y: number) {
  const point = await location(page, x, y);
  await page.mouse.click(point.x, point.y);
}

async function importImage(workspace: Locator, name: string) {
  // setInputFiles bypasses the visible button's disabled/import-in-progress guard.
  await expect(workspace.getByRole("button", { name: "导入图纸", exact: true })).toBeEnabled();
  const buffer = await sharp({
    create: { width: 1000, height: 800, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await workspace.getByLabel("选择图纸文件").setInputFiles({ name, mimeType: "image/png", buffer });
  await expect(workspace.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(workspace.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
  await expect(workspace.getByRole("button", { name: "导入图纸", exact: true })).toBeEnabled();
}

async function editLabel(workspace: Locator, text: string) {
  await workspace.getByRole("button", { name: "选择 / 移动", exact: true }).click();
  await workspace.locator("[data-annotation] text").dblclick();
  const input = workspace.getByLabel("直接修改标号");
  await expect(input).toBeFocused();
  await input.fill(text);
  await input.press("Enter");
  await expect(workspace.locator("[data-annotation] text")).toHaveText(text);
  await expect(workspace).toHaveAttribute("data-cad-pending", "false");
}

async function selectDrawing(workspace: Locator, name: string) {
  const button = workspace.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function deleteNumber(page: Page, workspace: Locator) {
  await page.getByRole("tab", { name: "附图标记", exact: true }).click();
  await page.getByRole("button", { name: "选中标号1", exact: true }).click();
  await workspace.getByRole("application", { name: "CAD标号画布" }).press("Delete");
  const confirmation = page.getByRole("dialog", { name: "请确认", exact: true });
  await expect(confirmation).toContainText("2 张图纸中的 2 个选中标号");
  await confirmation.getByRole("button", { name: "确定", exact: true }).click();
  await expect(workspace.locator("[data-annotation]")).toHaveCount(0);
}

async function saveAndReopen(page: Page, name: string) {
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
  await page
    .getByRole("article", { name, exact: true })
    .getByRole("button", { name: "更多操作" })
    .click();
  await page.getByRole("menuitem", { name: "继续编辑", exact: true }).click();
  return openWorkspace(page);
}

test("cross-drawing deletion preserves local undo and invalidates stale redo after another drawing is edited", async ({
  workbench,
}) => {
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const name = "CAD跨图历史回归";
    await createPatent(page, name);
    const editor = page.getByRole("textbox", { name: "编辑 权利要求书", exact: true });
    await editor.click();
    await page.keyboard.insertText("部件");
    await editor.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const offset = node.textContent?.indexOf("部件") ?? -1;
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 2);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      throw new Error("Fixture keyword not found");
    });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("部件");
    await page.getByRole("button", { name: "顺序编号", exact: true }).click();
    await expect(editor).toContainText("部件(1)");
    const workspace = await openWorkspace(page);
    for (const filename of ["甲图.png", "乙图.png"]) {
      await importImage(workspace, filename);
      await workspace.getByRole("button", { name: "标号", exact: true }).click();
      await clickPoint(page, 300, 400);
      await clickPoint(page, 400, 200);
      await page.keyboard.press("Escape");
      await expect(workspace.locator("[data-annotation] text")).toHaveText("1");
    }
    await editLabel(workspace, "1x");
    await editLabel(workspace, "1");
    await selectDrawing(workspace, "甲图.png");
    await deleteNumber(page, workspace);
    await selectDrawing(workspace, "乙图.png");
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(workspace.locator("[data-annotation] text")).toHaveText("1");
    await selectDrawing(workspace, "甲图.png");
    await expect(workspace.locator("[data-annotation] text")).toHaveText("1");
    await selectDrawing(workspace, "乙图.png");
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await expect(workspace.locator("[data-annotation] text")).toHaveText("1x");
    await editLabel(workspace, "1");
    await selectDrawing(workspace, "甲图.png");
    await deleteNumber(page, workspace);
    await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await selectDrawing(workspace, "乙图.png");
    await editLabel(workspace, "88");
    await selectDrawing(workspace, "甲图.png");
    await expect(
      workspace.getByRole("button", { name: "重做标号编辑", exact: true }),
    ).toBeDisabled();
    await workspace.getByRole("application", { name: "CAD标号画布" }).press("Control+y");
    await expect(workspace.locator("[data-annotation] text")).toHaveText("1");
    const reopened = await saveAndReopen(page, name);
    await selectDrawing(reopened, "乙图.png");
    await expect(reopened.locator("[data-annotation] text")).toHaveText("88");
    await reopened.getByRole("button", { name: "甲图.png", exact: true }).click();
    await expect(reopened.locator("[data-annotation] text")).toHaveText("1");
  } finally {
    await app.close();
  }
});

test("detail input rejection resets fields; captions and reopened controls use one decimal", async ({
  workbench,
}) => {
  test.setTimeout(process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1" ? 180000 : 60000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const name = "CAD比例与输入回归";
    await createPatent(page, name);
    const workspace = await openWorkspace(page);
    await importImage(workspace, "比例测试.png");
    await workspace.getByRole("button", { name: "局部放大", exact: true }).first().click();
    for (const [x, y] of [
      [300, 300],
      [350, 300],
      [200, 200],
      [650, 250],
      [300, 500],
      [325, 500],
      [200, 500],
      [700, 600],
    ] as const) {
      await clickPoint(page, x, y);
    }
    await page.keyboard.press("Escape");
    await expect(workspace.locator("[data-detail-part=content]")).toHaveCount(2);
    await workspace.locator("[data-detail-part=content]").first().click();
    const label = workspace.getByLabel("局部放大字母", { exact: true });
    const ratio = workspace.getByLabel("局部放大比例", { exact: true });
    await label.fill("B");
    await label.press("Tab");
    await expect(label).toHaveValue("A");
    await expect(workspace).toContainText("该字母已被使用。");
    await ratio.fill("0:1");
    await ratio.press("Tab");
    await expect(ratio).toHaveValue("2:1");
    await ratio.fill("1.25:1");
    await ratio.press("Tab");
    await expect(workspace.locator("[data-detail-part=title]").first()).toContainText("1.3:1");
    await page.evaluate(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      const captured: string[] = [];
      (window as unknown as { cadExportTexts: string[] }).cadExportTexts = captured;
      CanvasRenderingContext2D.prototype.fillText = function (
        ...args: Parameters<typeof original>
      ) {
        captured.push(args[0]);
        return original.apply(this, args);
      };
    });
    await workspace.getByRole("button", { name: "圈选取图", exact: true }).click();
    const start = await location(page, 450, 100),
      topRight = await location(page, 800, 100),
      end = await location(page, 800, 420),
      bottomLeft = await location(page, 450, 420);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Real drag must exceed the click-vs-drag time threshold, not complete in one frame.
    await page.waitForTimeout(200);
    await page.mouse.move(topRight.x, topRight.y, { steps: 5 });
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.move(bottomLeft.x, bottomLeft.y, { steps: 5 });
    await page.mouse.move(start.x, start.y, { steps: 5 });
    await page.mouse.up();
    await workspace.getByRole("button", { name: "预览成图", exact: true }).click();
    await expect(page.getByRole("img", { name: "取图导出预览", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { cadExportTexts: string[] }).cadExportTexts),
      )
      .toContain("1.3:1");
    await page.keyboard.press("Escape");
    const reopened = await saveAndReopen(page, name);
    await expect(reopened.locator("[data-detail-part=title]").first()).toContainText("1.3:1");
    await reopened.locator("[data-detail-part=content]").first().click();
    await expect(reopened.getByLabel("局部放大比例", { exact: true })).toHaveValue("1.3:1");
    await expect(reopened.getByLabel("局部放大字母", { exact: true })).toHaveValue("A");
  } finally {
    await app.close();
  }
});

function zoomPdf() {
  const stream = "0 g 298 498 4 4 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(content);
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 5\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

for (const sourceKind of ["image", "pdf", "dwg"] as const)
  test(`detail source landmarks follow their circle on every continuous zoom frame: ${sourceKind}`, async ({
    workbench,
  }) => {
    const app = await workbench.launch();
    try {
      const page = await app.firstWindow();
      await createPatent(page, "CAD局部图缩放回归");
      const workspace = await openWorkspace(page);
      let factor = { x: sourceKind === "pdf" ? 1.6 : 1, y: sourceKind === "pdf" ? 1.6 : 1 };
      if (sourceKind === "image") await importImage(workspace, "缩放测试.png");
      else if (sourceKind === "pdf") {
        await workspace
          .getByLabel("选择图纸文件")
          .setInputFiles({ name: "缩放测试.pdf", mimeType: "application/pdf", buffer: zoomPdf() });
        await expect(workspace.locator(".drawing-vector-preview").first()).toHaveAttribute(
          "data-render-state",
          "ready",
        );
      } else {
        await workspace.getByLabel("选择图纸文件").setInputFiles({
          name: "缩放测试.dwg",
          mimeType: "image/vnd.dwg",
          buffer: await readFile(resolve("tests/fixtures/cad/sample_AC1032.dwg")),
        });
        await expect(workspace.locator(".drawing-vector-preview").first()).toHaveAttribute(
          "data-render-state",
          "ready",
        );
        const view = await workspace.getByLabel("CAD标号画布").getAttribute("viewBox");
        const dimensions = view?.split(" ").map(Number);
        if (!dimensions) throw Error("CAD viewport missing");
        factor = { x: (dimensions[2] ?? 0) / 1080, y: (dimensions[3] ?? 0) / 864 };
      }
      await workspace.getByRole("button", { name: "局部放大", exact: true }).first().click();
      for (const [x, y] of [
        [300, 300],
        [350, 300],
        [200, 200],
        [650, 250],
      ] as const)
        await clickPoint(page, x * factor.x, y * factor.y);
      await page.keyboard.press("Escape");
      const image = workspace
        .locator(`[data-detail-image] ${sourceKind === "pdf" ? "canvas" : "img"}`)
        .first();
      await expect(image).toBeAttached();
      if (sourceKind === "pdf") await expect(image).toHaveAttribute("data-render-state", "ready");
      if (sourceKind === "dwg") {
        await expect(
          workspace.locator("[data-detail-image] .drawing-vector-preview"),
        ).toHaveAttribute("data-preview-region", "full");
        await image.evaluate((img) => (img as HTMLImageElement).decode());
      }
      const retainedSource = await image.getAttribute("src");
      await settleLayout(page);
      await page.evaluate(() => {
        const state = {
          frames: [] as number[],
          blankFrames: 0,
          nativeReference: null as [number, number] | null,
          running: true,
        };
        (window as unknown as { cadZoomFrames: typeof state }).cadZoomFrames = state;
        const sample = (scheduleNext = true) => {
          const image = document.querySelector<HTMLImageElement | HTMLCanvasElement>(
            "[data-detail-image] img, [data-detail-image] canvas",
          );
          const nativePath = document.querySelector<SVGPathElement>(
            "[data-cad-detail-live-body] path",
          );
          const circle = document.querySelector<SVGCircleElement>('[data-detail-part="content"]');
          const matrix = circle?.getScreenCTM();
          if (circle && matrix && (image || nativePath)) {
            const center = new DOMPoint(
              Number(circle.getAttribute("cx")),
              Number(circle.getAttribute("cy")),
            ).matrixTransform(matrix);
            if (!image && nativePath) {
              const pathMatrix = nativePath.getScreenCTM();
              if (!pathMatrix) state.blankFrames++;
              else {
                const vertex = nativePath.getPointAtLength(0).matrixTransform(pathMatrix);
                const radius = Math.max(1, circle.getBoundingClientRect().width / 2);
                const position: [number, number] = [
                  (vertex.x - center.x) / radius,
                  (vertex.y - center.y) / radius,
                ];
                state.nativeReference ??= position;
                state.frames.push(
                  Math.max(
                    Math.abs(position[0] - state.nativeReference[0]),
                    Math.abs(position[1] - state.nativeReference[1]),
                  ) * radius,
                );
              }
              if (state.running && scheduleNext) requestAnimationFrame(() => sample());
              return;
            }
            if (!image) throw Error("Detail rendering source disappeared");
            const box = image.getBoundingClientRect();
            let x = 0.3,
              y = 0.375;
            if (image instanceof HTMLCanvasElement) {
              const context = image.getContext("2d");
              if (!context) throw Error("PDF bitmap unavailable");
              const pixels = context.getImageData(0, 0, image.width, image.height).data;
              let weight = 0,
                xx = 0,
                yy = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                const ink = ((1 - (pixels[i] ?? 255) / 255) * (pixels[i + 3] ?? 0)) / 255;
                weight += ink;
                xx += (((i / 4) % image.width) + 0.5) * ink;
                yy += (Math.floor(i / 4 / image.width) + 0.5) * ink;
              }
              if (weight === 0) state.blankFrames++;
              else {
                x = xx / weight / image.width;
                y = yy / weight / image.height;
              }
            }
            const error = Math.max(
              Math.abs(box.x + box.width * x - center.x),
              Math.abs(box.y + box.height * y - center.y),
            );
            state.frames.push(error);
          } else state.blankFrames++;
          if (state.running && scheduleNext) requestAnimationFrame(() => sample());
        };
        (window as unknown as { cadZoomSample: () => void }).cadZoomSample = () => sample(false);
        sample();
      });
      const anchor = await location(page, 650 * factor.x, 250 * factor.y);
      await page.mouse.move(anchor.x, anchor.y);
      await page.keyboard.down("Control");
      for (const direction of [-1, 1, -1])
        for (let i = 0; i < (sourceKind === "dwg" ? 12 : 24); i++) {
          await page.mouse.wheel(0, direction * (sourceKind === "dwg" ? 8 : 16));
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => {
                  (window as unknown as { cadZoomSample: () => void }).cadZoomSample();
                  resolve();
                }),
              ),
          );
        }
      await page.keyboard.up("Control");
      await settleLayout(page);
      const result = await page.evaluate(() => {
        const state = (
          window as unknown as {
            cadZoomFrames: {
              frames: number[];
              blankFrames: number;
              running: boolean;
            };
          }
        ).cadZoomFrames;
        state.running = false;
        return {
          frames: state.frames,
          blankFrames: state.blankFrames,
        };
      });
      const { frames, blankFrames } = result;
      console.log("detail-zoom-landmark", {
        frames: frames.length,
        maxError: Math.max(...frames),
      });
      expect(frames.length).toBeGreaterThan(24);
      expect(blankFrames).toBe(0);
      if (sourceKind === "dwg") {
        if (await image.count()) expect(await image.getAttribute("src")).toBe(retainedSource);
        else await expect(workspace.locator("[data-cad-detail-live-body] path").first()).toBeVisible();
      }
      // PDF pixel centroids include raster rounding; image geometry does not.
      expect(Math.max(...frames)).toBeLessThan(sourceKind === "pdf" ? 1.5 : 0.6);
    } finally {
      await app.close();
    }
  });
