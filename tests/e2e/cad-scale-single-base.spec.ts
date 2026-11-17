import { readFile } from "node:fs/promises";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

type LineGeometry = {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  type: string;
};

test("scale needs one base pick, previews immediately, and preserves undo, cancellation and reopening", async ({
  workbench,
}) => {
  test.setTimeout(180000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    const name = "单基点缩放验收";
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("textbox", { name: "专利名称" }).fill(name);
    await create.getByRole("radio", { name: "实用新型", exact: true }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    const openCad = async () => {
      await page.getByRole("button", { name: "插入", exact: true }).click();
      await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    };
    await openCad();
    const ws = page.getByRole("region", { name: "CAD标号", exact: true });
    await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const panel = page.getByRole("region", { name: "CAD实体编辑" }),
      canvas = ws.getByRole("application", { name: "CAD标号画布" });
    const settle = async () => {
      await expect(ws).toHaveAttribute("data-cad-pending", "false");
      await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
        timeout: 60000,
      });
    };
    const geometry = async () => {
      await settle();
      const bytes = await page.evaluate(async (name) => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok) throw Error(list.error.message);
        const opened = await window.patentApi.patents.open(
          list.value.find((p) => p.name === name)!.patentId,
        );
        if (!opened.ok) throw Error(opened.error.message);
        const project = opened.value.patent.drawingProjects[0]!;
        const source = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          project.cad!.assetId,
        );
        if (!source.ok) throw Error(source.error.message);
        return source.value;
      }, name);
      const kernel = new CadcraftSession();
      try {
        kernel.load_dxf(Uint8Array.from(bytes));
        return (
          JSON.parse(kernel.scene()) as { entities: { geometry: LineGeometry }[] }
        ).entities.map((e) => e.geometry);
      } finally {
        kernel.free();
      }
    };
    await settle();
    await panel.getByRole("button", { name: "直线", exact: true }).click();
    await canvas.click({ position: { x: 200, y: 200 } });
    await canvas.click({ position: { x: 350, y: 200 } });
    await canvas.press("Enter");
    const before = await geometry();
    expect(before).toHaveLength(1);
    await canvas.click({ position: { x: 275, y: 200 } });
    await panel.getByRole("button", { name: "缩放", exact: true }).click();
    await canvas.click({ position: { x: 200, y: 200 } });
    // Reaching 2x now needs 150px instead of the previous 300px travel.
    await canvas.hover({ position: { x: 350, y: 200 } });
    const preview = canvas.locator("[data-cad-affine-preview] > g");
    await expect
      .poll(async () =>
        Number((await preview.getAttribute("transform"))?.match(/scale\(([^)]+)\)/)?.[1]),
      )
      .toBeCloseTo(2, 6);
    expect(await geometry()).toEqual(before);
    await canvas.click({ position: { x: 350, y: 200 } });
    const doubled = await geometry();
    const original = before[0]!,
      scaled = doubled[0]!;
    expect(scaled.a).toEqual(original.a);
    expect(scaled.b!.x - scaled.a!.x).toBeCloseTo((original.b!.x - original.a!.x) * 2, 3);
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    expect(await geometry()).toEqual(before);
    await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    expect(await geometry()).toEqual(doubled);
    await canvas.click({ position: { x: 350, y: 200 } });
    await panel.getByRole("button", { name: "缩放", exact: true }).click();
    await canvas.click({ position: { x: 200, y: 200 } });
    const palette = page.getByRole("dialog", { name: "缩放设置", exact: true });
    const ratio = palette.getByRole("spinbutton", { name: "缩放比例", exact: true });
    await ratio.fill("0.5");
    await ratio.press("Escape");
    await expect(palette).toBeHidden();
    expect(await geometry()).toEqual(doubled);
    await panel.getByRole("button", { name: "缩放", exact: true }).click();
    await canvas.click({ position: { x: 200, y: 200 } });
    await ratio.fill("0.5");
    await ratio.press("Enter");
    const restored = await geometry();
    expect(restored[0]!.a).toEqual(original.a);
    // Mouse coordinates need not produce an exact factor 2; typed 0.5 is exact.
    expect(restored[0]!.b.x).toBeCloseTo(scaled.a.x + (scaled.b.x - scaled.a.x) * 0.5, 8);
    expect(restored[0]!.b.x).toBeCloseTo(original.b.x, 3);
    await canvas.press("Control+a");
    await panel.getByRole("button", {name:"缩放",exact:true}).click();
    await canvas.click({position:{x:200,y:200}});
    await canvas.hover({position:{x:386,y:200}});
    const pointerFactor=Number((await preview.getAttribute("transform"))?.match(/scale\(([^)]+)\)/)?.[1]);
    expect(pointerFactor).toBeGreaterThan(2);
    await palette.getByRole("button",{name:"应用",exact:true}).click();
    const pointerScaled=await geometry();
    expect(pointerScaled[0]!.b.x-pointerScaled[0]!.a.x).toBeCloseTo((restored[0]!.b.x-restored[0]!.a.x)*pointerFactor,6);
    await ws.getByRole("button",{name:"撤销标号编辑",exact:true}).click();
    expect(await geometry()).toEqual(restored);
    await page.getByRole("button", { name: `关闭${name}`, exact: true }).click();
    await page.getByText(name, { exact: true }).first().dblclick();
    if (await later.isVisible()) await later.click();
    await openCad();
    expect(await geometry()).toEqual(restored);
  } finally {
    await app.close();
  }
});
