import { readFile } from "node:fs/promises";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

test("appearance defaults and selected properties survive undo and reopening", async ({
  workbench,
}, info) => {
  test.setTimeout(180000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    const name = "CAD特性验收";
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill(name);
    await create.getByRole("radio", { name: "实用新型", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    const open = async () => {
      await page.getByRole("button", { name: "插入", exact: true }).click();
      await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    };
    await open();
    const ws = page.getByRole("region", { name: "CAD标号", exact: true });
    await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const panel = page.getByRole("region", { name: "CAD实体编辑" });
    const canvas = ws.getByRole("application", { name: "CAD标号画布" });
    const chooseColor = async (color: string) => {
      await panel.getByRole("button", { name: "颜色", exact: true }).click();
      const palette = page.getByRole("dialog", { name: "颜色", exact: true });
      await expect(palette).toBeVisible();
      const preset = palette.getByRole("button", {
        name: `标准色 ${color.toUpperCase()}`,
        exact: true,
      });
      if (await preset.count()) await preset.click();
      else {
        await palette.getByRole("button", { name: "其他颜色", exact: true }).click();
        const custom = page.getByRole("dialog", { name: "其他颜色", exact: true });
        await custom.getByRole("textbox", { name: "HEX", exact: true }).fill(color);
        await custom.getByRole("button", { name: "应用", exact: true }).click();
      }
    };
    const settle = async () => {
      await expect(ws).toHaveAttribute("data-cad-pending", "false");
      await expect(panel.getByLabel("线型", { exact: true })).toBeEnabled({ timeout: 60000 });
    };
    const state = async () => {
      await settle();
      const bytes = await page.evaluate(async (name) => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok) throw Error(list.error.message);
        const opened = await window.patentApi.patents.open(
          list.value.find((p) => p.name === name)!.patentId,
        );
        if (!opened.ok) throw Error(opened.error.message);
        const p = opened.value.patent.drawingProjects[0]!;
        const data = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          p.cad!.assetId,
        );
        if (!data.ok) throw Error(data.error.message);
        return data.value;
      }, name);
      const kernel = new CadcraftSession();
      try {
        kernel.load_dxf(Uint8Array.from(bytes));
        return JSON.parse(kernel.scene());
      } finally {
        kernel.free();
      }
    };
    await settle();
    await chooseColor("#ff0000");
    await settle();
    await panel.getByLabel("线宽", { exact: true }).selectOption("0.7");
    await settle();
    await panel.getByLabel("线型", { exact: true }).selectOption("DASHED");
    await settle();
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await canvas.click({ position: { x: 200, y: 200 } });
    await canvas.click({ position: { x: 400, y: 200 } });
    await canvas.press("Enter");
    const drawn = await state();
    expect(drawn.entities).toHaveLength(1);
    expect(drawn.entities[0].appearance).toEqual({
      color: "#ff0000",
      lineweight: 0.7,
      linetype: "DASHED",
    });
    await canvas.press("Control+a");
    await chooseColor("#0000ff");
    expect((await state()).entities[0].appearance.color).toBe("#0000ff");
    expect((await state()).appearance.color).toBe("#ff0000");
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    expect((await state()).entities[0].appearance.color).toBe("#ff0000");
    await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    expect((await state()).entities[0].appearance.color).toBe("#0000ff");
    await canvas.press("Escape");
    // Smart labels must accept properties in a mixed selection and retain them in history.
    await ws.locator('[data-drawing-tool="label"]').click();
    await canvas.click({ position: { x: 250, y: 200 } });
    await canvas.click({ position: { x: 450, y: 170 } });
    await ws.locator('[data-drawing-tool="select"]').click();
    await settle();
    expect((await state()).appearance).toEqual({
      color: "#ff0000",
      lineweight: 0.7,
      linetype: "DASHED",
    });
    await canvas.press("Control+a");
    await chooseColor("#008000");
    await expect(ws.locator('.drawing-annotation text').first()).toHaveAttribute("opacity","0");
    await expect(ws.locator('[data-cad-label] path[stroke="#007AFF"]').first()).toBeVisible();
    await settle();
    await panel.getByLabel("线宽", { exact: true }).selectOption("1");
    await settle();
    await panel.getByLabel("线型", { exact: true }).selectOption("DOT");
    const styled = await state();
    expect(styled.entities.every((e: any) => e.appearance.color === "#008000")).toBe(true);
    expect(styled.primitives.some((p: any) => p.kind === "point")).toBe(true);
    expect(
      styled.primitives
        .filter((p: any) => p.kind === "point")
        .every((p: any) => p.lineweight === 1),
    ).toBe(true);
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settle();
    await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    expect((await state()).entities.map((e: any) => e.appearance)).toEqual(
      styled.entities.map((e: any) => e.appearance),
    );
    await canvas.press("Escape");
    await chooseColor("#123456");
    await settle();
    const before = await state();
    await page.screenshot({ path: info.outputPath("cad-appearance.png") });
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    await page.getByText(name, { exact: true }).first().dblclick();
    if (await later.isVisible()) await later.click();
    await open();
    const after = await state();
    expect(after.entities.map((e: any) => e.appearance)).toEqual(
      before.entities.map((e: any) => e.appearance),
    );
    expect(after.appearance).toEqual(before.appearance);
  } finally {
    await app.close();
  }
});
