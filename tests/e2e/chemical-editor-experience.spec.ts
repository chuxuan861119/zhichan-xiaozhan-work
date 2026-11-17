import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { rasterizeChemicalStructureAsset } from "../../src/main/chemistry/chemical-preview-service.js";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { createChemicalPatentPayload } from "../fixtures/chemical-content.js";
import { writePatdoc } from "./helpers/documents.js";
import { expect, test } from "./helpers/workbench.js";

async function finishMotion(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function importFixture(app: ElectronApplication, page: Page, path: string) {
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
  await app.evaluate(({ dialog }, source) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [source] }),
    });
  }, path);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 PATDOC", exact: true }).click();
  await page
    .getByRole("dialog", { name: "PATDOC 导入须知" })
    .getByRole("button", { name: "继续导入" })
    .click();
  await expect(page.getByRole("textbox", { name: "编辑 说明书" })).toBeVisible();
}

async function openStructure(page: Page) {
  await page
    .getByRole("navigation", { name: "主菜单" })
    .getByRole("button", { name: "插入", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "插入化学结构式", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插入化学结构式", exact: true });
  await expect(dialog.getByRole("button", { name: /清空画布/u })).toBeEnabled({ timeout: 35_000 });
  return dialog;
}

test("keeps a short editor usable, retains or discards drafts explicitly, and inserts a sharp naturally sized structure", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(120_000);
  const source = join(workbench.root, "draft.patdoc");
  await writePatdoc(source, await createChemicalPatentPayload("结构草稿验收", { structures: 0 }));
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await importFixture(app, page, source);
    await page.setViewportSize({ width: 1280, height: 640 });
    let dialog = await openStructure(page);
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "选择复制格式", exact: true })).toBeVisible();
    for (const button of [
      dialog.getByRole("button", { name: /苯环/u }),
      dialog.getByRole("button", { name: "插入", exact: true }),
    ]) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    }
    const shell = dialog.getByRole("region", { name: "化学结构编辑器" });
    await shell.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(shell.locator('[data-testid="reaction-plus"]')).toBeVisible();
    await shell.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(shell.locator('[data-testid="reaction-plus"]')).toBeHidden();
    await shell.getByRole("button", { name: "元素周期表", exact: true }).click();
    const tableBody = shell.locator(
      '[class*="PeriodTable-module_elementsTable"] > [class*="Dialog-module_body"]',
    );
    const horizontal = await tableBody.evaluate((node) => ({
      width: node.clientWidth,
      content: node.scrollWidth,
    }));
    expect(horizontal.content).toBeLessThanOrEqual(horizontal.width + 1);
    const nobelium = shell.getByText("No", { exact: true });
    await nobelium.scrollIntoViewIfNeeded();
    const elementBounds = await nobelium.boundingBox();
    const addBounds = await shell.getByRole("button", { name: "添加", exact: true }).boundingBox();
    expect(elementBounds!.y + elementBounds!.height).toBeLessThanOrEqual(addBounds!.y);
    await finishMotion(page);
    await page.screenshot({ path: testInfo.outputPath("short-periodic-table.png") });
    await shell.getByRole("button", { name: "取消", exact: true }).click();
    await shell.getByRole("button", { name: /苯环/u }).click();
    await shell
      .locator('[class*="intermediateCanvas"] > svg')
      .click({ position: { x: 300, y: 160 } });
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeEnabled();
    await expect(dialog.getByText("未保存", { exact: true })).toBeVisible();
    await shell.getByRole("button", { name: /^撤销（/u }).click();
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeDisabled();
    await shell.getByRole("button", { name: /^重做（/u }).click();
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toBeHidden();
    dialog = await openStructure(page);
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "放弃修改", exact: true }).click();
    await dialog
      .getByRole("alertdialog")
      .getByRole("button", { name: "放弃并关闭", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    dialog = await openStructure(page);
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: /苯环/u }).click();
    await dialog
      .locator('[class*="intermediateCanvas"] > svg')
      .click({ position: { x: 300, y: 160 } });
    await expect(dialog.getByRole("button", { name: "插入", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "插入", exact: true }).click();
    await expect(dialog).toBeHidden();
    const image = page
      .getByRole("textbox", { name: "编辑 说明书" })
      .getByRole("img", { name: "化学结构式" });
    await expect(image).toBeVisible();
    const geometry = await image.evaluate((node: HTMLImageElement) => ({
      widthMm: Number.parseFloat(node.style.width),
      pixels: node.naturalWidth,
    }));
    expect(geometry.widthMm).toBeGreaterThanOrEqual(10);
    expect(geometry.widthMm).toBeLessThan(40);
    expect(geometry.pixels).toBeGreaterThan(250);
    await finishMotion(page);
    await page.screenshot({ path: testInfo.outputPath("natural-structure-size.png") });
  } finally {
    await app.close();
  }
});

test("re-edits a chemical figure while preserving its identity, rotation, width and persisted source", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const name = "附图结构验收";
  const payload: PatentPatdocPayload = await createChemicalPatentPayload(name, { structures: 0 });
  const originalSource = {
    ketSource: JSON.stringify({
      root: { nodes: [{ $ref: "mol0" }] },
      mol0: {
        type: "molecule",
        atoms: [
          { label: "C", location: [0, 0, 0] },
          { label: "O", location: [1, 0, 0] },
        ],
        bonds: [{ type: 1, atoms: [0, 1] }],
      },
    }),
    editorMode: "molecule" as const,
  };
  const asset = await rasterizeChemicalStructureAsset(
    '<svg xmlns="http://www.w3.org/2000/svg" width="76" height="87"><path d="M10 20H60" stroke="black"/></svg>',
    originalSource,
  );
  const figureId = "00000000-0000-4000-8000-000000000111";
  payload.assets.push(asset);
  payload.patent.assets.push(asset.descriptor);
  payload.patent.figures = [
    { figureId, assetId: asset.descriptor.assetId, widthMm: 42, rotationDeg: 90 },
  ];
  payload.patent.abstractDrawingFigureId = figureId;
  const source = join(workbench.root, "figure.patdoc");
  await writePatdoc(source, payload);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await importFixture(app, page, source);
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await page.getByRole("button", { name: "选择图1", exact: true }).click();
    await page.getByRole("button", { name: "编辑结构式", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑化学结构式", exact: true });
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled({
      timeout: 35_000,
    });
    await dialog.getByRole("button", { name: /苯环/u }).click();
    await dialog
      .locator('[class*="intermediateCanvas"] > svg')
      .click({ position: { x: 230, y: 160 } });
    await expect(dialog.getByText("未保存", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "重做", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    const restored = await page.evaluate(
      async ({ name, figureId }) => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const list = await api.patents.list("active");
        if (!list.ok) throw new Error("Cannot list saved patents");
        const summary = list.value.find((p) => p.name === name);
        if (!summary) throw new Error("Missing saved patent");
        const opened = await api.patents.open(summary.patentId);
        if (!opened.ok) throw new Error("Cannot reopen saved patent");
        try {
          const figure = opened.value.patent.figures.find((f) => f.figureId === figureId);
          if (!figure) throw new Error("Missing saved figure");
          const source = await api.chemistry.readStructureSource({
            sessionId: opened.value.sessionId,
            assetId: figure.assetId,
          });
          if (!source.ok) throw new Error("Cannot read saved structure source");
          return {
            figure,
            abstractId: opened.value.patent.abstractDrawingFigureId,
            source: source.value,
          };
        } finally {
          await api.patents.release(opened.value.sessionId);
        }
      },
      { name, figureId },
    );
    expect(restored.figure.figureId).toBe(figureId);
    expect(restored.figure.widthMm).toBe(42);
    expect(restored.figure.rotationDeg).toBe(90);
    expect(restored.abstractId).toBe(figureId);
    expect(restored.figure.assetId).not.toBe(asset.descriptor.assetId);
    expect(restored.source?.ketSource).not.toBe(originalSource.ketSource);
    expect(JSON.parse(restored.source!.ketSource).root.nodes.length).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
