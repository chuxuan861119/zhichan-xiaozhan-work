import { writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { begin, end } from "./helpers/cad-performance-probe.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";
const compiledMethods = await build({
  entryPoints: ["src/renderer/src/drawing-markup/cad-draw-methods.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { DRAW_METHODS } = (await import(
  `data:text/javascript;base64,${Buffer.from(compiledMethods.outputFiles[0]!.text).toString("base64")}`
)) as { DRAW_METHODS: Record<string, { id: string; label: string; parameter?: string }[]> };
test("all exposed draw methods preview, commit, save and undo through the real UI", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(600000);
  const app = await workbench.launch(),
    page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("radio", { name: "实用新型", exact: true }).check();
  await dialog.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(dialog).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const ws = page.getByRole("region", { name: "CAD标号", exact: true });
  await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
  const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
  const tool = (name: string) => panel.getByRole("button", { name, exact: true }).click();
  await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  const saved = async () => {
    await expect(ws).toHaveAttribute("data-cad-pending", "false");
    await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
  };
  const click = ([x, y]: number[]) => canvas.click({ position: { x: x!, y: y! } });
  const cancel = async () => {
    await canvas.press("Escape");
    await canvas.press("Escape");
  };
  for (const [a, b] of [
    [
      [150, 250],
      [150, 450],
    ],
    [
      [150, 450],
      [450, 450],
    ],
    [
      [450, 450],
      [450, 250],
    ],
  ]) {
    await tool("直线");
    await click(a!);
    await click(b!);
    await canvas.press("Enter");
    await saved();
  }
  const count = async () => {
    await canvas.press("Control+a");
    // A history restore may ignore this first Ctrl+A while the native scene is
    // loading. Do not block the poll waiting for a selection that was not made.
    return Number((await panel.getByText(/^\d+ 个对象已选中$/).allTextContents()).join("").match(/\d+/)?.[0] ?? 0);
  };
  expect(await count()).toBe(3);
  await cancel();
  const positions: Record<string, number[][]> = {
    rectang: [[220,300],[340,360]],
    "rectang.center": [[280,320],[340,360]],
    "rectang.3p": [[220,300],[340,330],[310,390]],
    "rectang.center-rotated": [[280,320],[340,340],[260,370]],
    circle: [
      [220, 300],
      [280, 300],
    ],
    "circle.cd": [
      [220, 300],
      [280, 300],
    ],
    "circle.2p": [
      [220, 300],
      [340, 300],
    ],
    "circle.3p": [
      [220, 300],
      [280, 260],
      [340, 300],
    ],
    "circle.ttr": [
      [150, 350],
      [250, 450],
    ],
    "circle.ttt": [
      [150, 350],
      [300, 450],
      [450, 350],
    ],
    arc: [
      [220, 300],
      [280, 260],
      [340, 300],
    ],
    "arc.sce": [
      [280, 300],
      [220, 300],
      [220, 360],
    ],
    "arc.ser": [
      [220, 300],
      [340, 300],
    ],
    "arc.sea": [
      [220, 300],
      [340, 300],
    ],
    "arc.continue": [[350, 200]],
    ellipse: [
      [280, 300],
      [350, 300],
      [280, 350],
    ],
    "ellipse.axis": [
      [200, 300],
      [350, 300],
      [275, 350],
    ],
    "ellipse.arc": [
      [200, 300],
      [350, 300],
      [275, 350],
      [350, 300],
      [275, 350],
    ],
    polygon: [
      [280, 300],
      [330, 300],
    ],
    "polygon.out": [
      [280, 300],
      [330, 300],
    ],
    "polygon.edge": [
      [220, 350],
      [300, 350],
    ],
    "gear.external": [
      [280, 300],
      [330, 300],
    ],
    "gear.internal": [
      [280, 300],
      [330, 300],
    ],
    "gear.rack": [
      [200, 300],
      [400, 300],
    ],
    "chain.drive": [
      [200, 300],
      [450, 300],
    ],
    "chain.sprocket": [
      [280, 300],
      [310, 300],
    ],
    spring: [
      [200, 300],
      [450, 300],
      [450, 320],
    ],
    "spring.extension": [
      [200, 300],
      [450, 300],
      [450, 320],
    ],
  };
  const menus: Record<string, string> = {
    circle: "圆",
    arc: "圆弧",
    ellipse: "椭圆",
    rectang: "矩形",
    polygon: "正多边形",
    gear: "齿轮",
    chain: "链条",
    spring: "弹簧",
  };
  const results: Awaited<ReturnType<typeof end>>[] = [];
  for (const [family, methods] of Object.entries(DRAW_METHODS)) {
    for (const method of methods) {
      await cancel();
      await tool(`${menus[family]}选项`);
      await page
        .getByRole("menuitemradio", {
          name: family === "polygon" ? `正多边形 · ${method.label}` : method.label,
          exact: true,
        })
        .click();
      if (method.parameter) {
        const field = page.getByRole("spinbutton", { name: method.parameter, exact: true });
        await field.fill(
          method.id === "arc.ser"
            ? "1000"
            : method.id === "circle.ttr"
              ? "100"
              : family === "polygon"
                ? "6"
                : family === "spring"
                  ? "6"
                  : method.id === "arc.sea"
                    ? "90"
                    : "23",
        );
      }
      if (family === "spring") {
        await page.getByLabel("弹簧线径", { exact: true }).fill("2");
        await page.getByLabel("弹簧线径", { exact: true }).press("Enter");
      } else if (method.parameter)
        await page.getByRole("spinbutton", { name: method.parameter, exact: true }).press("Enter");
      const points = positions[method.id];
      if (!points) throw Error(`Missing acceptance case ${method.id}`);
      for (const p of points.slice(0, -1)) await click(p);
      const last = points.at(-1)!;
      const box = await canvas.boundingBox();
      if (!box) throw Error("Canvas missing");
      await begin(page, ".cad-gesture-preview");
      for (let i = 0; i < 36; i++) {
        await page.mouse.move(
          box.x + last[0]! + Math.sin(i / 5) * 3,
          box.y + last[1]! + Math.cos(i / 5) * 3,
        );
        await page.waitForTimeout(8);
      }
      results.push(await end(page, method.id));
      await expect(canvas.locator(".cad-gesture-preview")).toBeVisible();
      await click(last);
      await expect(ws.getByRole("status", { name: /^选择对象：/ })).toBeVisible();
      await saved();
      await cancel();
      await expect
        .poll(count, { message: `${method.id} must create an object` })
        .toBeGreaterThan(3);
      await cancel();
      await canvas.press("Control+z");
      await saved();
      await expect.poll(count, { message: `${method.id} undo must restore seed geometry` }).toBe(3);
      console.info(JSON.stringify(results.at(-1)));
    }
  }
  expect(results).toHaveLength(Object.values(DRAW_METHODS).flat().length);
  await writeFile(
    testInfo.outputPath("all-draw-methods-performance.json"),
    JSON.stringify(results, null, 2),
  );
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
    ),
  ).toBe(true);
});
