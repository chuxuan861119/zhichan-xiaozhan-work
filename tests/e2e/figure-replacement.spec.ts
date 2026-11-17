import { join } from "node:path";
import type { Page } from "@playwright/test";
import { writePatdoc } from "../../src/main/documents/patdoc-writer.js";
import { CanonicalPatentSchema } from "../../src/shared/patent/model.js";
import { createChemicalPatentPayload } from "../fixtures/chemical-content.js";
import { expect, test } from "./helpers/workbench.js";

async function openTool(page: Page, label: string) {
  const error = page.locator(".operation-feedback.is-error");
  if (await error.isVisible()) throw new Error(await error.innerText());
  const button = page.getByRole("button", { name: label, exact: true });
  if (await button.isVisible()) await button.click();
  else {
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  }
}

test("formula, physics and chemistry keep natural insertion size and replace through the shared comparison", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const payload = await createChemicalPatentPayload("附图替换验收");
  const asset = payload.assets[0];
  if (!asset) throw new Error("Fixture image missing");
  payload.patent.figures = [
    {
      figureId: "00000000-0000-4000-8000-000000900001",
      assetId: asset.descriptor.assetId,
      widthMm: 80,
      rotationDeg: 0,
    },
    {
      figureId: "00000000-0000-4000-8000-000000900002",
      assetId: asset.descriptor.assetId,
      widthMm: 87,
      rotationDeg: 90,
    },
  ];
  const targetFigure = payload.patent.figures[1];
  if (!targetFigure) throw new Error("Fixture target missing");
  payload.patent.abstractDrawingFigureId = targetFigure.figureId;
  const source = join(workbench.root, "replacement.patdoc");
  CanonicalPatentSchema.parse(payload.patent);
  await writePatdoc(source, payload);
  const app = await workbench.launchAllowMultipleInstances();
  let completed = false;
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈Work" });
    await expect(welcome).toBeVisible();
    await welcome.getByRole("button", { name: "关闭欢迎提示" }).click();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, "showOpenDialog", {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      });
    }, source);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
    await page
      .getByRole("dialog", { name: "PATDOC 导入须知" })
      .getByRole("button", { name: "继续导入" })
      .click();
    await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();
    if (await later.isVisible()) await later.click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    const toolCases = [
      {
        entry: "插入数学公式",
        dialog: "插入数学公式",
        field: "可视公式编辑器",
        value: "x^{2}+y^{2}",
      },
      { entry: "插入物理公式", dialog: "物理公式" },
      {
        entry: "插入化学方程式",
        dialog: "插入化学方程式",
        field: "化学方程式编辑器",
        value: "H_{2}+O_{2}",
      },
      { entry: "插入化学结构式", dialog: "插入化学结构式" },
    ];
    const insertedWidths: number[] = [];
    async function prepareTool(item: (typeof toolCases)[number]) {
      await openTool(page, item.entry);
      const editor = page.getByRole("dialog", { name: item.dialog, exact: true });
      await expect(editor.getByRole("button", { name: "插入附图", exact: true })).toBeVisible();
      if (item.field) {
        const field = editor.getByRole("textbox", { name: item.field });
        await expect
          .poll(() => field.evaluate((node) => node.style.pointerEvents))
          .not.toBe("none");
        await field.evaluate((node, value) => {
          if (!value) throw new Error("Fixture formula missing");
          (node as HTMLElement & { value: string }).value = value;
          node.dispatchEvent(new Event("input", { bubbles: true }));
        }, item.value);
      } else if (item.entry === "插入化学结构式") {
        const shell = editor.getByRole("region", { name: "化学结构编辑器" });
        const benzene = shell.getByRole("button", { name: /苯环/u });
        await expect(benzene).toBeEnabled({ timeout: 35_000 });
        await benzene.click();
        await shell
          .locator('[class*="intermediateCanvas"] > svg')
          .click({ position: { x: 180, y: 120 } });
      }
      return editor;
    }
    for (const item of toolCases) {
      let editor = await prepareTool(item);
      await editor.getByRole("button", { name: "插入附图", exact: true }).click();
      const insertion = page.getByRole("dialog", { name: "插入到说明书附图", exact: true });
      const preview = insertion.getByRole("img", { name: /附图预览/u });
      await expect(preview).toBeVisible();
      await expect
        .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      const geometry = await preview.evaluate((node) => {
        const image = node as HTMLImageElement;
        return {
          widthMm: Number.parseFloat(image.style.width),
          widthPx: image.naturalWidth,
          cssWidth: image.getBoundingClientRect().width,
        };
      });
      expect(geometry.widthMm).toBeGreaterThanOrEqual(10);
      expect(geometry.widthMm).toBeLessThan(70);
      expect(geometry.widthPx / geometry.cssWidth).toBeGreaterThan(2.5);
      const figureNumber = 3 + insertedWidths.length;
      insertedWidths.push(geometry.widthMm);
      await page.screenshot({
        path: testInfo.outputPath(`${item.entry}-natural-preview.png`),
        animations: "disabled",
      });
      await insertion
        .getByRole("button", { name: `添加为图 ${figureNumber}`, exact: true })
        .click();
      await expect(insertion).toBeHidden();
      const frame = page
        .getByRole("article", { name: `图${figureNumber}`, exact: true })
        .locator(".drawing-figure-frame");
      await expect
        .poll(() => frame.evaluate((node) => Number.parseFloat((node as HTMLElement).style.width)))
        .toBeCloseTo(geometry.widthMm, 2);
      await expect
        .poll(() =>
          frame.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      const imageWidth = await frame
        .locator("img")
        .evaluate((node) => node.getBoundingClientRect().width);
      expect(imageWidth).toBeLessThan((70 * 96) / 25.4 + 1);
      await frame.screenshot({
        path: testInfo.outputPath(`${item.entry}-inserted.png`),
        animations: "disabled",
      });
      editor = await prepareTool(item);
      await expect(editor.getByRole("button", { name: "替换附图", exact: true })).toBeEnabled();
      await editor.getByRole("button", { name: "替换附图", exact: true }).click();
      const replacement = page.getByRole("dialog", { name: "替换说明书附图", exact: true });
      await expect(replacement).toBeVisible();
      await replacement
        .getByRole("combobox", { name: "选择要替换的附图" })
        .selectOption(targetFigure.figureId);
      await expect(replacement.getByAltText("现有图2")).toBeVisible();
      await expect(replacement.getByRole("button", { name: "替换图2", exact: true })).toBeEnabled();
      await expect(replacement.getByRole("img", { name: /成图预览/u })).toHaveAttribute(
        "style",
        /width: 87mm/u,
      );
      const rendering = await replacement
        .getByRole("img", { name: /成图预览/u })
        .evaluate((node) => {
          const image = node as HTMLImageElement;
          return { pixels: image.naturalWidth, cssWidth: image.getBoundingClientRect().width };
        });
      expect(rendering.pixels).toBeGreaterThan(1010);
      expect(rendering.pixels / rendering.cssWidth).toBeGreaterThan(3);
      await expect(replacement.getByRole("button", { name: "实际尺寸（100%）" })).toHaveCount(2);
      const original = replacement.getByAltText("现有图2");
      expect(await original.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(
        500,
      );
      for (const stage of await replacement.locator(".drawing-replace-stage").all()) {
        expect(await stage.evaluate((node) => getComputedStyle(node).padding)).toBe("0px");
      }
      const panes = await replacement
        .locator(".drawing-replace-pane")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
      if (panes[0] === undefined || panes[1] === undefined)
        throw new Error("Comparison panes missing");
      expect(panes[1]).toBeGreaterThan(panes[0]);
      await page.screenshot({
        path: testInfo.outputPath(`${item.entry}.png`),
        animations: "disabled",
      });
      if (item.entry === "插入数学公式" && item.field) {
        await page.setViewportSize({ width: 620, height: 760 });
        await expect
          .poll(() =>
            replacement.locator(".drawing-replace-stage img").evaluateAll((images) =>
              images.every((image) => {
                const frame = image.closest(".flowchart-image-preview__viewport");
                if (!frame) return false;
                const a = image.getBoundingClientRect(),
                  b = frame.getBoundingClientRect();
                return (
                  a.left >= b.left - 1 &&
                  a.right <= b.right + 1 &&
                  a.top >= b.top - 1 &&
                  a.bottom <= b.bottom + 1
                );
              }),
            ),
          )
          .toBe(true);
        const narrow = await replacement
          .locator(".drawing-replace-pane")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
        expect(narrow[1]?.y).toBeGreaterThan(narrow[0]?.y ?? 0);
        expect(await replacement.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath("replacement-narrow.png"),
          animations: "disabled",
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await replacement.getByRole("button", { name: "取消", exact: true }).click();
        await expect(replacement).toBeHidden();
        await expect(editor).toBeVisible();
        expect(
          await editor
            .getByRole("textbox", { name: item.field })
            .evaluate((node) => (node as HTMLElement & { value: string }).value),
        ).toBe(item.value);
        await editor.getByRole("button", { name: "替换附图", exact: true }).click();
        await replacement
          .getByRole("combobox", { name: "选择要替换的附图" })
          .selectOption(targetFigure.figureId);
        await expect(
          replacement.getByRole("button", { name: "替换图2", exact: true }),
        ).toBeEnabled();
      }
      await replacement.getByRole("button", { name: "替换图2", exact: true }).click();
      await expect(replacement).toBeHidden();
      await expect(
        page.getByRole("article", { name: "图2" }).locator(".drawing-figure-frame"),
      ).toHaveAttribute("style", /width: 87mm/u);
      await expect(page.getByRole("article", { name: "图1" })).toHaveCount(1);
      await expect(page.getByRole("article", { name: "图2" })).toHaveCount(1);
      await expect
        .poll(() =>
          page
            .getByRole("article", { name: "图2" })
            .locator("img")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(1010);
    }
    // The same structure tool can also be opened while editing the description.
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("textbox", { name: "编辑 说明书" }).click();
    const structureCase = toolCases[3];
    if (!structureCase) throw new Error("Structure fixture missing");
    const textEditorStructure = await prepareTool(structureCase);
    await textEditorStructure.getByRole("button", { name: "替换附图", exact: true }).click();
    const textReplacement = page.getByRole("dialog", { name: "替换说明书附图", exact: true });
    await textReplacement
      .getByRole("combobox", { name: "选择要替换的附图" })
      .selectOption(targetFigure.figureId);
    await expect(
      textReplacement.getByRole("button", { name: "替换图2", exact: true }),
    ).toBeEnabled();
    expect(
      await textReplacement
        .getByRole("img", { name: /成图预览/u })
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(1010);
    await textReplacement.getByRole("button", { name: "取消", exact: true }).click();
    await textEditorStructure.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.keyboard.press("Control+s");
    await page.getByRole("button", { name: "关闭附图替换验收", exact: true }).click();
    const saved = await page.evaluate(async () => {
      const list = await window.patentApi.patents.list("active");
      if (!list.ok) throw new Error(list.error.message);
      const target = list.value.find((p) => p.name === "附图替换验收");
      if (!target) throw new Error("Patent not saved");
      const opened = await window.patentApi.patents.open(target.patentId);
      if (!opened.ok) throw new Error(opened.error.message);
      try {
        const figure = opened.value.patent.figures[1];
        if (!figure) throw new Error("Saved target missing");
        const structure = await window.patentApi.chemistry.readStructureSource({
          sessionId: opened.value.sessionId,
          assetId: figure.assetId,
        });
        return {
          figures: opened.value.patent.figures,
          assets: opened.value.patent.assets,
          abstractDrawingFigureId: opened.value.patent.abstractDrawingFigureId,
          structure,
        };
      } finally {
        await window.patentApi.patents.release(opened.value.sessionId);
      }
    });
    expect(saved.figures).toHaveLength(6);
    for (const [index, widthMm] of insertedWidths.entries()) {
      const figure = saved.figures[index + 2];
      expect(figure?.widthMm).toBeCloseTo(widthMm, 2);
      const image = saved.assets.find((asset) => asset.assetId === figure?.assetId);
      expect(((image?.widthPx ?? 0) * 25.4) / widthMm).toBeGreaterThan(295);
    }
    expect(saved.figures[0]).toEqual(payload.patent.figures[0]);
    expect(saved.figures[1]).toMatchObject({
      figureId: targetFigure.figureId,
      widthMm: 87,
      rotationDeg: 0,
    });
    const replacementAsset = saved.assets.find(
      (asset) => asset.assetId === saved.figures[1]?.assetId,
    );
    expect(((replacementAsset?.widthPx ?? 0) * 25.4) / 87).toBeGreaterThan(295);
    expect(saved.abstractDrawingFigureId).toBe(payload.patent.abstractDrawingFigureId);
    expect(saved.structure.ok).toBe(true);
    if (saved.structure.ok) expect(saved.structure.value?.ketSource).toContain("mol");
    completed = true;
  } finally {
    // This application contains only isolated fixture data. Avoid blocking teardown on an error dialog.
    if (!completed)
      await app.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
    else await app.close();
  }
});
