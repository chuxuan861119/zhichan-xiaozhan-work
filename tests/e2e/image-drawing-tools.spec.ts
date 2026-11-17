import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import type { Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function point(page: Page, x: number, y: number) {
  return page.getByRole("application", { name: "CAD标号画布" }).evaluate(
    (el, p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform((el as SVGSVGElement).getScreenCTM()!);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function click(page: Page, x: number, y: number) {
  const p = await point(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function crop(page: Page, from = [50, 50], to = [950, 750]) {
  const a = await point(page, from[0]!, from[1]!);
  const b = await point(page, to[0]!, to[1]!);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

function imagePdf(): Buffer {
  const stream = "0 G 0.75 w 50 220 50 50 re S";
  const secondStream = "0 g 50 50 200 200 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 320] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 320] /Resources << >> /Contents 6 0 R >>",
    `<< /Length ${secondStream.length} >>\nstream\n${secondStream}\nendstream`,
  ];
  let content = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n =>
    `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

for (const source of ["image", "legacy-image", "legacy-pdf"] as const) {
  const legacy = source.startsWith("legacy");
  test(`image tools preserve annotations, detail, history and output (${source})`, async ({
    workbench,
  }, info) => {
    test.setTimeout(180_000);
    const app = await workbench.launch();
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await dismissWorkbenchWelcome(page);
      const name = `图片工具验收-${source}`;
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建专利" });
      await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
      await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
      await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
      await expect(dialog).toBeHidden();
      const later = page.getByRole("button", { name: "稍后设置", exact: true });
      if (await later.isVisible()) await later.click();
      const open = async () => {
        await page.getByRole("button", { name: "插入", exact: true }).click();
        await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
      };
      await open();
      const ws = page.getByRole("region", { name: "CAD标号", exact: true });
      const canvas = ws.getByRole("application", { name: "CAD标号画布" });
      const png = await sharp(
        Buffer.from(
          '<svg width="1000" height="800"><rect width="1000" height="800" fill="white"/><rect x="200" y="200" width="200" height="200" fill="none" stroke="black" stroke-width="3"/></svg>',
        ),
      )
        .png()
        .toBuffer();
      await ws
        .getByLabel("选择图纸文件")
        .setInputFiles(source === "legacy-pdf"
          ? { name: "示意图.pdf", mimeType: "application/pdf", buffer: imagePdf() }
          : { name: "示意图.png", mimeType: "image/png", buffer: png });
      await expect(ws.getByRole("button", { name: "标号", exact: true })).toBeEnabled();
      if (legacy) {
        await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
        await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
        await page.evaluate(async (name) => {
          const all = await window.patentApi.patents.list("active");
          if (!all.ok) throw Error(all.error.message);
          const loaded = await window.patentApi.patents.open(
            all.value.find((p) => p.name === name)!.patentId,
          );
          if (!loaded.ok) throw Error(loaded.error.message);
          const s = loaded.value;
          const p = s.patent.drawingProjects[0]!;
          const result = await window.patentApi.assets.prepareCad({
            sessionId: s.sessionId,
            operationId: crypto.randomUUID(),
            originalName: "旧图片覆盖层.dxf",
            format: "dxf",
            bytes: new TextEncoder().encode(
              "0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n10\n8\n0\n10\n100\n20\n100\n11\n800\n21\n100\n0\nENDSEC\n0\nEOF\n",
            ),
            frame: {
              width: p.width,
              height: p.height,
              mapping: { originX: 0, originY: p.height, scale: 1 },
            },
          });
          if (!result.ok) throw Error(result.error.message);
          const saved = await window.patentApi.patents.applyFigureEdit({
            patentId: s.patentId,
            sessionId: s.sessionId,
            expectedRevision: s.patent.revision,
            figures: s.patent.figures,
            abstractDrawingFigureId: s.patent.abstractDrawingFigureId,
            assets: [...s.patent.assets, ...result.value.assets.map((a) => a.descriptor)],
            drawingProjects: [
              {
                ...p,
                cad: {
                  ...result.value.cad,
                  overlayAssetId: result.value.assets.at(-1)!.descriptor.assetId,
                  backgroundSize: [p.width, p.height],
                },
              },
            ],
          });
          if (!saved.ok) throw Error(saved.error.message);
        }, name);
        await page.reload();
        await dismissWorkbenchWelcome(page);
        await page.getByText(name, { exact: true }).first().dblclick();
        await open();
      }
      const settled = async () => {
        await expect(ws.getByRole("button", { name: "标号", exact: true })).toBeEnabled({
          timeout: 45_000,
        });
        await expect(ws).toHaveAttribute("data-cad-pending", "false");
      };
      await settled();
      const tools = page.getByRole("tab", { name: "图片工具", exact: true });
      await tools.click();
      await expect(page.getByRole("button", { name: "直线", exact: true })).toHaveCount(0);
      await expect(canvas).toHaveAttribute("data-cad-editing", "false");
      await ws.getByRole("button", { name: "标号", exact: true }).click();
      await click(page, 220, 220);
      await click(page, 450, 150);
      await canvas.press("Escape");
      await settled();
      await expect(ws.locator("[data-annotation]")).toHaveCount(1);
      await page.getByRole("button", { name: "局部放大", exact: true }).click();
      await page.getByRole("textbox", { name: "局部放大比例", exact: true }).fill("2:1");
      for (const [x, y] of [
        [220, 220],
        [280, 220],
        [200, 500],
        [700, 300],
      ])
        await click(page, x!, y!);
      await canvas.press("Escape");
      await settled();
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
      await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
      await settled();
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(0);
      await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
      await settled();
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
      await click(page, 700, 300);
      const detailRatio = page.getByRole("textbox", { name: "局部放大比例", exact: true });
      await expect(detailRatio).toBeVisible();
      await detailRatio.fill("3:1");
      await detailRatio.press("Enter");
      await settled();
      // A compatibility checkpoint must not clear the raster editor's selection.
      await expect(detailRatio).toBeVisible();
      await expect(detailRatio).toHaveValue("3:1");
      const viewBeforeSwitch = await canvas.getAttribute("viewBox");
      await page.getByRole("tab", { name: "专利库", exact: true }).click();
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const otherName = `切换对照-${source}`;
      await dialog.getByRole("textbox", { name: "专利名称" }).fill(otherName);
      await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
      await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
      await expect(dialog).toBeHidden();
      if (await later.isVisible()) await later.click();
      await open();
      await ws.getByLabel("选择图纸文件").setInputFiles({
        name: "另一个专利.png", mimeType: "image/png", buffer: png,
      });
      await settled();
      await expect(ws.locator("[data-annotation]")).toHaveCount(0);
      await ws.getByRole("button", { name: "标号", exact: true }).click();
      await click(page, 300, 300);
      await click(page, 500, 100);
      await canvas.press("Escape");
      await settled();
      await page.getByRole("tab", { name, exact: true }).click();
      await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
      await settled();
      await expect(canvas).toHaveAttribute("viewBox", viewBeforeSwitch!);
      await expect(ws.locator("[data-annotation]")).toHaveCount(1);
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
      await expect(detailRatio).toHaveValue("3:1");
      await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
      await settled();
      await click(page, 700, 300);
      await expect(detailRatio).toHaveValue("2:1");
      await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
      await settled();
      await click(page, 700, 300);
      await expect(detailRatio).toHaveValue("3:1");
      await page.getByRole("tab", { name: otherName, exact: true }).click();
      await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
      await settled();
      await expect(ws.locator("[data-annotation]")).toHaveCount(1);
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(0);
      await page.getByRole("tab", { name, exact: true }).click();
      await page.getByRole("tab", { name: "CAD标号", exact: true }).click();
      await settled();
      await canvas.press("Escape");
      await crop(page, [100, 100], [500, 450]);
      await page.getByRole("button", { name: "向右旋转", exact: true }).click();
      await settled();
      await expect(ws.locator("[data-base-fragment]").first()).toBeAttached();
      await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
      await settled();
      await canvas.press("Escape");
      await crop(page);
      await ws.getByRole("button", { name: "预览成图", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "成图预览" });
      const output = preview.getByRole("img", { name: "取图导出预览" });
      await expect(output).toBeVisible({ timeout: 45_000 });
      expect(await output.evaluate((img) => (img as HTMLElement).style.width)).toMatch(/mm$/);
      const target = join(workbench.root, "image-output.jpg");
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, target);
      await preview.getByRole("button", { name: "导出 JPG" }).click();
      await expect(ws.getByRole("status")).toContainText("图片已导出");
      const bytes = await readFile(target);
      expect((await sharp(bytes).metadata()).width).toBeGreaterThan(300);
      expect((await sharp(bytes).stats()).channels[0]!.min).toBeLessThan(50);
      await canvas.press("Escape");
      await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
      await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
      await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: "专利库", exact: true }).click();
      await page.getByText(name, { exact: true }).first().dblclick();
      await open();
      await settled();
      await expect(ws.locator("[data-annotation]")).toHaveCount(1);
      await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
      const saved = await page.evaluate(async (name) => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok) throw Error(list.error.message);
        const opened = await window.patentApi.patents.open(
          list.value.find((p) => p.name === name)!.patentId,
        );
        if (!opened.ok) throw Error(opened.error.message);
        const p = opened.value.patent.drawingProjects[0]!;
        if (!p.cad) return { project: p, native: "" };
        const r = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          p.cad.assetId,
        );
        if (!r.ok) throw Error(r.error.message);
        return { project: p, native: new TextDecoder().decode(r.value) };
      }, name);
      expect(Boolean(saved.project.cad)).toBe(legacy);
      expect(saved.project.annotations).toHaveLength(1);
      expect(saved.project.detailViews).toHaveLength(1);
      if (legacy) {
        initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
        const kernel = new CadcraftSession();
        try {
          kernel.load_dxf(new TextEncoder().encode(saved.native));
          const scene = JSON.parse(kernel.scene());
          expect(
            scene.entities.some(
              (e: { handle: string; type: string }) => e.handle === "10" && e.type === "Line",
            ),
          ).toBe(true);
        } finally {
          kernel.free();
        }
      }
      if (source === "legacy-pdf") {
        await ws.getByLabel("PDF 页码", { exact: false }).fill("2");
        await ws.getByRole("button", { name: "打开此页" }).click();
        await settled();
        await expect(ws.locator(".drawing-project-row")).toHaveCount(2);
        await expect(ws.locator("[data-annotation]")).toHaveCount(0);
        await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(0);
        await ws.getByRole("button", { name: "示意图.pdf", exact: true }).click();
        await settled();
        await expect(ws.locator("[data-annotation]")).toHaveCount(1);
        await expect(ws.locator('[data-detail-part="content"]')).toHaveCount(1);
      }
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(tools).toBeVisible();
      await tools.click();
      await page.screenshot({ path: info.outputPath("image-tools.png") });
    } finally {
      await app.close();
    }
  });
}
