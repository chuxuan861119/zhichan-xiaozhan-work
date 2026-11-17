import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
for (const kind of ["external", "internal", "rack"] as const) {
  test(`gear meshes with ${kind}: automatic placement, live dragging, history and saved reload`, async ({
    workbench,
  }) => {
    test.setTimeout(180_000);
    const app = await workbench.launch(),
      page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    const title = `啮合验收-${kind}`;
    await dialog.getByRole("textbox", { name: "专利名称" }).fill(title);
    await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
    await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(dialog).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const ws = page.getByRole("region", { name: "CAD标号", exact: true });
    await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
    const panel = page.getByRole("region", { name: "CAD实体编辑" });
    const canvas = ws.getByRole("application", { name: "CAD标号画布" });
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    const settled = () =>
      expect(ws).toHaveAttribute("data-cad-pending", "false", { timeout: 60_000 });
    async function create(label: string, n: number, x: number, y: number, length: number) {
      await panel.getByRole("button", { name: "齿轮选项", exact: true }).click();
      await page.getByRole("menuitemradio", { name: label, exact: true }).click();
      const settings = page.getByRole("region", { name: `${label}设置`, exact: true });
      await settings.getByRole("spinbutton").fill(String(n));
      await settings.getByRole("spinbutton").press("Enter");
      await canvas.click({ position: { x, y } });
      await canvas.click({ position: { x: x + length, y } });
      await expect(settings).toBeHidden();
      await settled();
    }
    // Leave the canvas-local settings palette clear of the test assembly.
    const assemblyY = 450;
    await create("外齿轮", 20, 240, assemblyY, 50);
    await create(
      kind === "internal" ? "内齿圈" : kind === "rack" ? "齿条" : "外齿轮",
      kind === "internal" ? 40 : kind === "rack" ? 12 : 32,
      500,
      assemblyY,
      kind === "rack" ? 160 : 60,
    );
    await canvas.click({ position: { x: 251.5, y: assemblyY } });
    await canvas.click({
      position:
        kind === "rack"
          ? { x: 580, y: assemblyY + 10.6667 }
          : kind === "internal"
            ? { x: 560, y: assemblyY }
            : { x: 513.8, y: assemblyY },
    });
    const settings = page.getByRole("region", { name: "齿轮啮合设置" });
    await expect(settings).toBeVisible();
    const all = canvas.locator("[data-cad-gear-handle]");
    const handles = await all.evaluateAll((nodes) => [
      ...new Set(nodes.map((n) => n.getAttribute("data-cad-gear-handle")!)),
    ]);
    expect(handles).toHaveLength(2);
    const [a, b] = handles as [string, string];
    const control = (h: string, i: number) =>
      canvas.locator(`[data-cad-gear-handle="${h}"][data-cad-gear-grip="${i}"]`);
    const point = async (h: string, i: number) => {
      const box = await control(h, i).boundingBox();
      if (!box) throw new Error("Missing grip");
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const originalA = await point(a, 0),
      originalB = await point(b, 0);
    await settings.getByRole("checkbox", { name: "啮合" }).click();
    await expect(settings.getByRole("checkbox", { name: "啮合" })).toBeChecked();
    await settled();
    const colorA = await control(a, 0).evaluate(element => getComputedStyle(element).stroke),
      colorB = await control(b, 0).evaluate(element => getComputedStyle(element).stroke);
    expect(colorA).toBe("rgb(196, 90, 0)");
    expect(colorB).toBe(colorA);
    await expect(panel.getByRole("button", { name: "取消编组", exact: true })).toBeDisabled();
    const linkedA = await point(a, 0),
      linkedB = await point(b, 0),
      linkedBScale = await point(b, 1);
    expect(linkedA.x).toBeCloseTo(originalA.x, 1);
    expect(linkedA.y).toBeCloseTo(originalA.y, 1);
    expect(Math.hypot(linkedB.x - originalB.x, linkedB.y - originalB.y)).toBeGreaterThan(20);
    const linkedAScale = await point(a, 1);
    await canvas.press("Escape");
    await page.mouse.click(linkedA.x + 11.5, linkedA.y);
    const gearProperties = page.getByRole("region", { name: "齿轮设置", exact: true });
    await gearProperties.getByLabel("齿轮齿数", { exact: true }).fill("12");
    await gearProperties.getByRole("button", { name: "应用", exact: true }).click();
    await settled();
    await expect(gearProperties.getByLabel("齿轮齿数", { exact: true })).toHaveValue("12");
    await expect.poll(async () => {
      const smallerA = await point(a, 0), smallerAScale = await point(a, 1);
      return Math.hypot(smallerAScale.x - smallerA.x, smallerAScale.y - smallerA.y);
    }).toBeCloseTo(Math.hypot(linkedAScale.x - linkedA.x, linkedAScale.y - linkedA.y) * 14 / 22, 1);
    await canvas.press("ControlOrMeta+a");
    expect((await point(b, 0)).x).toBeCloseTo(linkedB.x, 1);
    expect((await point(b, 0)).y).toBeCloseTo(linkedB.y, 1);
    expect((await point(b, 1)).x).toBeCloseTo(linkedBScale.x, 1);
    expect((await point(b, 1)).y).toBeCloseTo(linkedBScale.y, 1);
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await canvas.press("ControlOrMeta+a");
    expect((await point(a, 0)).x).toBeCloseTo(linkedA.x, 1);
    expect((await point(a, 0)).y).toBeCloseTo(linkedA.y, 1);
    await expect(settings.getByRole("checkbox", { name: "啮合" })).toBeChecked();
    let third: string | undefined;
    if (kind === "external") {
      // Pick the independent object FIRST: the established assembly must still stay fixed.
      await create("外齿轮",16,650,assemblyY,40);
      await canvas.click({position:{x:659.2,y:assemblyY}});
      third=(await all.first().getAttribute("data-cad-gear-handle"))!;
      await page.mouse.click(linkedB.x+(linkedBScale.x-linkedB.x)*0.23,linkedB.y);
      await expect(settings.getByRole("checkbox",{name:"啮合"})).toBeEnabled();
      await settings.getByRole("checkbox",{name:"啮合"}).click();
      await settled();
      await expect(settings.getByRole("checkbox",{name:"啮合"})).toBeChecked();
      expect((await point(b,0)).x).toBeCloseTo(linkedB.x,1);
      expect((await point(b,0)).y).toBeCloseTo(linkedB.y,1);
      expect((await point(third,0)).x).toBeLessThan((await canvas.boundingBox())!.x+650);
      await ws.getByRole("button",{name:"撤销标号编辑",exact:true}).click();
      await settled();
      await expect(settings.getByRole("checkbox",{name:"啮合"})).not.toBeChecked();
      await ws.getByRole("button",{name:"重做标号编辑",exact:true}).click();
      await settled();
      await expect(settings.getByRole("checkbox",{name:"啮合"})).toBeChecked();
      // Existing regression below manages the A-B edge while B-C remains attached.
      await canvas.press("Escape");
      await page.mouse.click(linkedA.x+11.5,linkedA.y);
      await page.mouse.click(linkedB.x+(linkedBScale.x-linkedB.x)*0.23,linkedB.y);
    }
    await page.screenshot({ path: test.info().outputPath(`cad-gear-mesh-${kind}.png`) });
    await settings.getByRole("checkbox", { name: "啮合" }).click();
    await expect(settings.getByRole("checkbox", { name: "啮合" })).not.toBeChecked();
    await settled();
    expect((await point(b, 0)).x).toBeCloseTo(linkedB.x, 1);
    expect((await point(b, 0)).y).toBeCloseTo(linkedB.y, 1);
    await settings.getByRole("checkbox", { name: "啮合" }).click();
    await expect(settings.getByRole("checkbox", { name: "啮合" })).toBeChecked();
    await settled();
    await canvas.press("Escape");
    await canvas.click({ position: { x: 251.5, y: assemblyY } });
    await expect(control(a, 3)).toBeVisible();
    await expect(page.getByRole("region", { name: "齿轮啮合关系" })).toBeVisible();
    const c = await point(a, 0),
      r = await point(a, 3),
      distance = Math.hypot(r.x - c.x, r.y - c.y);
    expect(
      await canvas.evaluate((node, p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        return node.contains(hit) ? "canvas" : hit?.outerHTML;
      }, r),
    ).toBe("canvas");
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.waitForTimeout(150);
    const peerPath = canvas
      .locator(`[data-trim-context] polyline[data-cad-preview-handle="${b}"]`)
      .first();
    await expect(peerPath).toBeVisible();
    const old = await peerPath.getAttribute("points");
    const thirdPath=third ? canvas.locator(`[data-trim-context] polyline[data-cad-preview-handle="${third}"]`).first() : undefined;
    if (thirdPath) await expect(thirdPath).toBeVisible();
    const oldThird=await thirdPath?.getAttribute("points");
    await page.mouse.move(c.x - distance, c.y, { steps: 5 });
    await expect.poll(() => peerPath.getAttribute("points")).not.toBe(old);
    if (thirdPath) await expect.poll(()=>thirdPath.getAttribute("points")).not.toBe(oldThird);
    await page.screenshot({ path: test.info().outputPath(`cad-gear-mesh-${kind}-drag.png`) });
    await page.mouse.up();
    await settled();
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    // Keep edit-worker restore slower than the already-painted history scene.
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        this: Worker,
        ...args: Parameters<Worker["postMessage"]>
      ) {
        const message = args[0] as { method?: string };
        if (["checkout", "restore", "load"].includes(message?.method ?? ""))
          setTimeout(() => original.apply(this, args), 400);
        else original.apply(this, args);
      } as Worker["postMessage"];
    });
    await ws.getByRole("button", { name: "重做标号编辑", exact: true }).click();
    await settled();
    await expect(panel).toHaveAttribute("data-cad-ready", "false");
    await canvas.press("Escape");
    // Rack has moved tangentially; round gears retain their centres.
    if (kind === "rack") {
      const cb = await canvas.boundingBox();
      if (!cb) throw new Error("Missing canvas");
      await page.mouse.click(
        linkedB.x + 80 + (((50 * 20) / 22) * Math.PI) / 2,
        linkedB.y + (160 / 12) * 0.8,
      );
    } else {
      await page.mouse.click(
        linkedB.x +
          Math.hypot(linkedBScale.x - linkedB.x, linkedBScale.y - linkedB.y) *
            (kind === "internal" ? 1 : 0.23),
        linkedB.y,
      );
    }
    await expect(control(b, 0)).toBeVisible();
    expect(await control(b, 0).evaluate(element => getComputedStyle(element).stroke)).toBe(colorB);
    const after = await point(b, 0);
    if (kind === "rack") {
      expect(after.x - linkedB.x).toBeCloseTo((((50 * 20) / 22) * Math.PI) / 2, 0);
      expect(after.y).toBeCloseTo(linkedB.y, 1);
    } else {
      expect(after.x).toBeCloseTo(linkedB.x, 1);
      expect(after.y).toBeCloseTo(linkedB.y, 1);
    }
    const relationship = page.getByRole("region", { name: "齿轮啮合关系" });
    const pairStatus = () => third ? relationship.filter({hasText:"20 齿"}) : relationship;
    await pairStatus().getByRole("button", { name: "选中配对对象" }).click();
    await expect(control(a, 0)).toBeVisible();
    await relationship.getByRole("button", { name: "选中配对对象" }).click();
    await expect(control(b, 0)).toBeVisible();
    await pairStatus().getByRole("button", { name: "取消啮合" }).click();
    await expect(pairStatus()).toBeHidden();
    await settled();
    expect((await point(b, 0)).x).toBeCloseTo(after.x, 1);
    await ws.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
    await settled();
    await expect(pairStatus()).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`cad-gear-mesh-${kind}-relationship.png`),
    });
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await app.close();
    const again = await workbench.launch(),
      reopened = await again.firstWindow();
    await dismissWorkbenchWelcome(reopened);
    const safety = reopened.getByRole("button", { name: "稍后设置", exact: true });
    if (await safety.isVisible()) await safety.click();
    await reopened.getByText(title, { exact: true }).first().dblclick();
    await reopened.getByRole("button", { name: "插入", exact: true }).click();
    await reopened.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const rail = reopened.getByRole("button", { name: /展开.*功能栏|显示.*功能栏/ }).first();
    if ((await rail.isVisible()) && (await rail.getAttribute("aria-expanded")) !== "true")
      await rail.click();
    const dismiss = reopened.getByRole("button", { name: "暂时关闭数据安全提示", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    const target = join(workbench.root, `mesh-${kind}.dxf`);
    await again.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await reopened.getByRole("button", { name: "导出 DXF", exact: true }).click();
    await expect(reopened.getByText("已导出 DXF 图纸。", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const runtime = join(process.cwd(), "resources/cadcraft/wasm");
    const { initSync, CadcraftSession } = await import(
      pathToFileURL(join(runtime, "cadcraft.js")).href
    );
    initSync({ module: await readFile(join(runtime, "cadcraft_bg.wasm")) });
    const kernel = new CadcraftSession();
    try {
      kernel.load_dxf(await readFile(target));
      const restored = JSON.parse(kernel.scene()).entities;
      expect(restored.filter((e: { gearMate?: string }) => e.gearMate)).toHaveLength(third ? 3 : 2);
      if (third) expect(restored.find((e:{handle:string})=>e.handle===b).gearMates.sort()).toEqual([third,a].sort());
    } finally {
      kernel.free();
    }
  });
}
