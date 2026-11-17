import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";
import { readFile } from "node:fs/promises";
import { initSync, CadcraftSession } from "../../resources/cadcraft/wasm/cadcraft.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

test("a small open boundary shows gap markers and previews after tolerance is set", async ({
  workbench,
}) => {
  test.setTimeout(120000);
  initSync({ module: await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm") });
  const kernel = new CadcraftSession();
  let buffer: Buffer;
  try {
    for (const [a, b] of [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ],
      [
        [10, 10],
        [0, 10],
      ],
      [
        [0, 10],
        [0, 0.05],
      ],
    ])
      kernel.execute("line", JSON.stringify({ points: [a, b] }));
    buffer = Buffer.from(kernel.export_dxf());
  } finally {
    kernel.free();
  }
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    await dismissWorkbenchWelcome(page);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建专利", exact: true });
    await create.getByRole("radio", { name: "实用新型" }).check();
    await create.getByRole("button", { name: "创建专利", exact: true }).click();
    await expect(create).toBeHidden();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole("button", { name: "插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
    const ws = page.getByRole("region", { name: "CAD标号", exact: true });
    await ws
      .getByLabel("选择图纸文件")
      .setInputFiles({ name: "微小缺口.dxf", mimeType: "image/vnd.dxf", buffer });
    const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const hatch = page
      .getByRole("region", { name: "CAD实体编辑" })
      .getByRole("button", { name: "剖面填充", exact: true });
    await expect(hatch).toBeEnabled({ timeout: 60000 });
    await hatch.click();
    const canvas = ws.getByRole("application", { name: "CAD标号画布" });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas missing");
    const hover = () => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await hover();
    await expect(ws.locator('[data-hatch-gap="true"]')).toHaveCount(2);
    await expect(ws.locator('[data-hatch-lines="true"] :is(polyline,path)')).toHaveCount(0);
    await page.getByLabel("缺口容差", { exact: true }).fill("0.1");
    await page.getByLabel("缺口容差", { exact: true }).press("Tab");
    await hover();
    await expect(ws.locator('[data-hatch-lines="true"] :is(polyline,path)').first()).toBeVisible();
    await expect(page.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
    await canvas.press("Enter");
    await expect(hatch).toHaveAttribute("aria-pressed", "false");
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
  } finally {
    await app.close();
  }
});

test("CAD hatch can preview, apply and retain fills from internal points", async ({
  workbench,
}) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("radio", { name: "实用新型" }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  await expect(page.getByRole("button", { name: "取消固定", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "CAD实体编辑" });
  const canvas = workspace.getByRole("application", { name: "CAD标号画布" });
  const rect = panel.getByRole("button", { name: "矩形", exact: true });
  await expect(rect).toBeEnabled({ timeout: 60_000 });
  await rect.click();
  await canvas.click({ position: { x: 150, y: 150 } });
  await canvas.click({ position: { x: 350, y: 300 } });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) return false;
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) return false;
        const cad = opened.value.patent.drawingProjects[0]?.cad;
        if (!cad) return false;
        const source = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          cad.assetId,
        );
        return source.ok && new TextDecoder().decode(source.value).includes("LWPOLYLINE");
      }),
    )
    .toBe(true);
  const hatch = panel.getByRole("button", { name: "剖面填充", exact: true });
  await hatch.click();
  await expect(page.getByLabel("填充比例", { exact: true })).toHaveValue("1");
  // Moving over a closed region previews without picking or adding a persisted hatch.
  const hoverBox = await canvas.boundingBox();
  if (!hoverBox) throw new Error("Canvas missing");
  await page.mouse.move(hoverBox.x + 250, hoverBox.y + 220);
  await expect(workspace.locator('[data-hatch-lines="true"] :is(polyline,path)').first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
  await page.mouse.move(hoverBox.x + 600, hoverBox.y + 400);
  await expect(workspace.locator('[data-hatch-lines="true"] :is(polyline,path)')).toHaveCount(0);
  await canvas.click({ position: { x: 600, y: 400 } });
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(0);
  await expect(workspace.locator('.cad-instruction-card[data-tone="error"]')).toContainText(
    "未闭合",
  );
  await expect(workspace.locator('.cad-instruction-card[data-tone="error"]')).toHaveCSS(
    "color",
    "rgb(180, 35, 24)",
  );
  await canvas.click({ position: { x: 250, y: 220 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await canvas.click({ position: { x: 260, y: 230 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(1);
  await canvas.click({ position: { x: 600, y: 400 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(1);
  await page.getByLabel("填充比例", {exact:true}).fill("2");
  await page.getByLabel("填充角度（°）", {exact:true}).fill("30");
  await page.getByLabel("填充角度（°）", {exact:true}).press("Enter");
  await expect(hatch).toHaveAttribute("aria-pressed", "false");
  await canvas.screenshot({ path: test.info().outputPath("hatch.png") });
  await hatch.click();
  await expect(page.getByLabel("填充比例", {exact:true})).toHaveValue("2");
  await expect(page.getByLabel("填充角度（°）", {exact:true})).toHaveValue("30");
  await canvas.press("Escape");
  await canvas.click({ position: { x: 130, y: 130 } });
  await canvas.click({ position: { x: 370, y: 320 } });
  await expect(workspace.locator(".cad-instruction-card")).toContainText("已选择 2 个对象。");
  await canvas.press("Escape");
  await rect.click();
  await canvas.click({ position: { x: 400, y: 150 } });
  await canvas.click({ position: { x: 550, y: 300 } });
  await hatch.click();
  await expect(
    page.getByRole("group", { name: "填充图案", exact: true }).getByRole("button"),
  ).toHaveCount(23);
  await page.getByRole("button", { name: "选择图案 双交线", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择边界 / 已有填充" })).toHaveCount(0);
  await canvas.click({ position: { x: 450, y: 220 } });
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(hatch).toHaveAttribute("aria-pressed", "false");
  await canvas.press("Escape");
  await canvas.click({ position: { x: 380, y: 130 } });
  await canvas.click({ position: { x: 570, y: 320 } });
  await expect(workspace.locator(".cad-instruction-card")).toContainText("已选择 2 个对象。");
  await canvas.press("Escape");
  await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  await canvas.click({ position: { x: 380, y: 130 } });
  await canvas.click({ position: { x: 570, y: 320 } });
  await expect(workspace.locator(".cad-instruction-card")).toContainText("已选择 1 个对象。");
  await workspace.getByRole("button", { name: "重做标号编辑", exact: true }).click();
  await page.getByRole("button", { name: "关闭CAD标号", exact: true }).click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  await expect(rect).toBeEnabled();
  // Reopening fits the viewport; verify the persisted native file, not old screen coordinates.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) throw new Error("Test patent missing");
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) throw new Error("Open failed");
        const cad = opened.value.patent.drawingProjects[0]?.cad;
        if (!cad) throw new Error("CAD missing");
        const source = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          cad.assetId,
        );
        if (!source.ok) throw new Error("Checkpoint missing");
        return new TextDecoder()
          .decode(source.value)
          .split(/\r?\n/)
          .filter((line) => line === "HATCH").length;
      }),
    )
    .toBe(2);
  const ellipse = panel.getByRole("button", { name: "椭圆", exact: true });
  await ellipse.click();
  await canvas.click({ position: { x: 200, y: 400 } });
  await canvas.click({ position: { x: 230, y: 400 } });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + 200, box.y + 480);
  await canvas.screenshot({ path: test.info().outputPath("ellipse-preview.png") });
  await canvas.click({ position: { x: 200, y: 480 } });
  await expect(ellipse).toHaveAttribute("aria-pressed", "false");
  await rect.click();
  await canvas.click({ position: { x: 420, y: 450 } });
  await canvas.click({ position: { x: 480, y: 510 } });
  await panel.getByRole("button", { name: "局部放大", exact: true }).click();
  await canvas.click({ position: { x: 450, y: 480 } });
  await canvas.click({ position: { x: 510, y: 480 } });
  await canvas.click({ position: { x: 560, y: 390 } });
  await canvas.click({ position: { x: 700, y: 450 } });
  await expect(hatch).toBeEnabled();
  await canvas.press("Escape");
  for (const confirmation of ["apply", "right-click"]) {
    await hatch.click();
    await canvas.click({ position: { x: 700, y: 450 } });
    await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
    if (confirmation === "apply")
      await page.getByRole("button", { name: "应用", exact: true }).click();
    else await canvas.click({ button: "right", position: { x: 700, y: 450 } });
    await expect(hatch).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const list = await window.patentApi.patents.list("active");
          if (!list.ok || !list.value[0]) return false;
          const opened = await window.patentApi.patents.open(list.value[0].patentId);
          if (!opened.ok) return false;
          const project = opened.value.patent.drawingProjects[0];
          if (!project?.cad) return false;
          const source = await window.patentApi.assets.readDrawingSource(
            opened.value.sessionId,
            project.cad.assetId,
          );
          if (!source.ok) return false;
          const records = new TextDecoder().decode(source.value).split(/\r?\n/);
          const body = project.cad.objects?.find((o) => o.kind === "detail")?.body ?? [];
          return records.some(
            (line, i) =>
              line === "HATCH" &&
              records[i + 1]?.trim() === "5" &&
              body.includes(records[i + 2]!.trim()),
          );
        }),
      )
      .toBe(true);
    await expect(workspace.locator('[data-render-state="pending"]:visible')).toHaveCount(0);
    await expect(workspace).toHaveAttribute("data-cad-pending", "false");
    await workspace.screenshot({
      path: test.info().outputPath(`detail-hatch-${confirmation}.png`),
    });
    if (confirmation === "apply")
      await workspace.getByRole("button", { name: "撤销标号编辑", exact: true }).click();
  }
  await hatch.click();
  await expect(page.getByRole("group", { name: "填充图案" }).getByRole("button")).toHaveCount(23);
  await page.getByRole("button", { name: "选择图案 交叉线", exact: true }).click();
  await page.getByLabel("填充策略", { exact: true }).selectOption("ignore");
  await canvas.click({ position: { x: 200, y: 400 } });
  await canvas.click({ position: { x: 450, y: 480 } });
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(2);
  await page.getByRole("button", { name: "移除区域 1", exact: true }).click();
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(1);
  await canvas.click({ position: { x: 200, y: 400 } });
  await expect(page.getByRole("button", { name: /^移除区域 / })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await workspace.screenshot({ path: test.info().outputPath("multi-region-preview.png") });
  await canvas.press("Enter");
  await expect(hatch).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const list = await window.patentApi.patents.list("active");
        if (!list.ok || !list.value[0]) return 0;
        const opened = await window.patentApi.patents.open(list.value[0].patentId);
        if (!opened.ok) return 0;
        const cad = opened.value.patent.drawingProjects[0]?.cad;
        if (!cad) return 0;
        const source = await window.patentApi.assets.readDrawingSource(
          opened.value.sessionId,
          cad.assetId,
        );
        return source.ok
          ? new TextDecoder()
              .decode(source.value)
              .split(/\r?\n/)
              .filter((l) => l === "HATCH").length
          : 0;
      }),
    )
    .toBe(5);
  await canvas.dblclick({ position: { x: 200, y: 400 } });
  await expect(hatch).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "选择图案 交叉线", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(workspace.locator(".cad-selection-overlay circle")).toHaveCount(0);
  await page.getByRole("button", { name: "选择图案 单线", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(hatch).toHaveAttribute("aria-pressed", "false");
  await canvas.dblclick({ position: { x: 200, y: 400 } });
  await expect(page.getByRole("button", { name: "选择图案 单线", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await canvas.press("Escape");
  await expect(page.getByRole("dialog", { name: /操作未完成/ })).toHaveCount(0);
});
