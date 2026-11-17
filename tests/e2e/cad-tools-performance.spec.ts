import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { begin, end } from "./helpers/cad-performance-probe.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

for (const dense of [false, true]) {
  test(`@performance CAD tool previews and parameter updates (${dense ? "imported" : "blank"})`, async ({
    workbench,
  }, testInfo) => {
    test.setTimeout(240000);
    const app = await workbench.launch();
    const page = await app.firstWindow();
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
    if (dense)
      await ws
        .getByLabel("选择图纸文件")
        .setInputFiles(
          resolve(process.env.CAD_PERFORMANCE_DRAWING ?? "tests/fixtures/cad/sample_AC1032.dwg"),
        );
    else await ws.getByRole("button", { name: "新建图纸", exact: true }).click();
    const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
    if (await opener.isVisible()) await opener.click();
    const pin = page.getByRole("button", { name: "固定", exact: true });
    if (await pin.isVisible()) await pin.click();
    const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
    const canvas = ws.getByRole("application", { name: "CAD标号画布", exact: true });
    await expect(panel.getByRole("button", { name: "直线", exact: true })).toBeEnabled({
      timeout: 60000,
    });
    const box = await canvas.boundingBox();
    if (!box) throw Error("Canvas missing");
    const click = (x: number, y: number) => canvas.click({ position: { x, y } });
    const tool = (name: string) => panel.getByRole("button", { name, exact: true }).click();
    const cancel = async () => {
      await canvas.press("Escape");
      await canvas.press("Escape");
    };
    const results: Awaited<ReturnType<typeof end>>[] = [];
    const commits: { name: string; ms: number }[] = [];
    const sweep = async (
      name: string,
      x: number,
      y: number,
      rx = 55,
      ry = 35,
      selector = ".cad-gesture-preview, [data-cad-affine-preview], [data-cad-detail-live-scene]",
    ) => {
      await page.mouse.move(box.x + x, box.y + y);
      if (process.env.CAD_TOOL_PROFILE && name.includes("whole imported")) console.info("preview complexity", await ws.evaluate(el => ({
        nodes: el.querySelectorAll("svg *").length,
        fallback: el.querySelector("[data-cad-gpu-fallback]")?.getAttribute("data-cad-gpu-fallback"),
        selectionNodes: el.querySelectorAll(".cad-selection-overlay *").length,
        liveNodes: el.querySelectorAll("[data-cad-scene-surface] *").length,
      })));
      const profile = process.env.CAD_TOOL_PROFILE
        ? await page.context().newCDPSession(page)
        : null;
      if (profile) {
        await profile.send("Profiler.enable");
        await profile.send("Profiler.start");
      }
      await begin(page, selector);
      for (let i = 0; i < 72; i++) {
        await page.mouse.move(box.x + x + rx * Math.sin(i / 8), box.y + y + ry * Math.cos(i / 8));
        await page.waitForTimeout(8);
      }
      const result = await end(page, name);
      results.push(result);
      if (profile) {
        const data = await profile.send("Profiler.stop");
        await writeFile(
          testInfo.outputPath(`${name.replaceAll(" ", "-")}.cpuprofile`),
          JSON.stringify(data.profile),
        );
        await profile.detach();
      }
      console.info(JSON.stringify({ dense, ...result }));
    };
    const commit = async (name: string, action: () => Promise<unknown>) => {
      await begin(page, ".drawing-viewport");
      const t = Date.now();
      await action();
      await expect(ws).toHaveAttribute("data-cad-pending", "false");
      await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
      commits.push({ name, ms: Date.now() - t });
      results.push(await end(page, `${name} confirmation`));
    };
    if (!process.env.CAD_TOOL_BULK_ONLY) {
      await tool("链条");
      await click(180, 350);
      await sweep("chain draw", 480, 350, 80, 45);
      await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
      await cancel();
      for (const name of ["压缩弹簧", "拉伸弹簧"]) {
        await tool("弹簧选项");
        await page.getByRole("menuitemradio", { name, exact: true }).click();
        await page
          .getByRole("dialog")
          .getByRole("spinbutton", { name: "弹簧线径", exact: true })
          .fill("2");
        await click(180, 350);
        await click(450, 350);
        await sweep(name, 310, name === "拉伸弹簧" ? 330 : 300, 35, name === "拉伸弹簧" ? 5 : 25);
        await expect(canvas.locator(".cad-gesture-preview :is(polyline:not([data-cad-guide]), [data-cad-curve-preview] path)").first()).toBeVisible();
        await cancel();
      }
      for (const name of ["直线", "矩形", "圆", "椭圆"]) {
        await tool(name);
        await click(180, 350);
        if (name === "椭圆") await click(260, 350);
        await sweep(name, 330, 310);
        await cancel();
      }
      await tool("矩形");
      await click(150, 150);
      await commit("rectangle", () => click(350, 300));
      await cancel();
      for (const name of ["移动", "复制", "缩放", "旋转"]) {
        await click(250, 150);
        await tool(name);
        await click(200, 200);
        await sweep(name, 310, 240, 45, 30);
        await expect(ws.locator("[data-cad-affine-preview]")).toBeVisible();
        await cancel();
      }
      await tool("剖面填充");
      await sweep("hatch hover", 250, 220, 45, 25, "[data-hatch-lines]");
      await sweep("hatch boundary crossing", 250, 220, 170, 25, "[data-hatch-lines]");
      await click(250, 220);
      await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
      await commit("hatch apply", () =>
        page.getByRole("button", { name: "应用", exact: true }).click(),
      );
      await canvas.dblclick({ position: { x: 250, y: 220 } });
      await expect(page.getByLabel("填充比例", { exact: true })).toBeVisible();
      await begin(page, "[data-hatch-lines]");
      for (const value of ["2", "3", "4", "2", "1"]) {
        await page.getByLabel("填充比例", { exact: true }).fill(value);
        await page.waitForTimeout(250);
      }
      results.push(await end(page, "hatch parameter editing"));
      await commit("hatch edit apply", () =>
        page.getByRole("button", { name: "应用", exact: true }).click(),
      );
      await cancel();
      await click(250, 150);
      await tool("阵列");
      await begin(page, ".cad-gesture-preview");
      await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
      for (const value of ["5", "10", "20", "3"]) {
        await page.getByRole("spinbutton", { name: "列数", exact: true }).fill(value);
        await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
      }
      results.push(await end(page, "array initial preview"));
      await cancel();
      for (const method of ["环形阵列", "路径阵列"]) {
        if (method === "路径阵列") {
          await tool("直线");
          await click(500, 300);
          await click(650, 300);
          await canvas.press("Enter");
        }
        await click(250, 150);
        await tool("阵列选项");
        await page.getByRole("menuitemradio", { name: method, exact: true }).click();
        await click(method === "路径阵列" ? 575 : 450, 300);
        await begin(page, ".cad-gesture-preview");
        for (const value of ["6", "12", "24", "6"]) {
          await page
            .getByRole("spinbutton", { name: "项目数（含源对象）", exact: true })
            .fill(value);
          await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
        }
        results.push(await end(page, method));
        await cancel();
      }
      await tool("局部放大");
      await click(250, 220);
      await sweep("detail radius", 320, 220, 25, 15, ".drawing-viewport");
      await click(320, 220);
      await click(380, 180);
      await sweep("detail placement", 550, 450, 55, 35, ".drawing-viewport");
      await cancel();
    }
    if (dense) {
      // A known visible stroke provides a reproducible direct-drag hit in arbitrary imports.
      await tool("直线");
      await click(160, 220);
      await click(360, 220);
      await canvas.press("Enter");
      await expect(ws).toHaveAttribute("data-cad-pending", "false");
      await expect(ws.locator('[data-save-state="saved"]')).toBeVisible();
      await canvas.press("Control+a");
      await page.mouse.move(box.x + 210, box.y + 220);
      await page.mouse.down();
      await page.mouse.move(box.x + 250, box.y + 260);
      await expect(ws.locator("[data-cad-affine-preview]").first()).toBeVisible();
      await sweep("direct drag whole imported drawing", 320, 250, 45, 30);
      await commit("direct drag release", () => page.mouse.up());
      await cancel();
      await canvas.press("Control+a");
      await tool("移动");
      await click(200, 200);
      await sweep("move whole imported drawing", 320, 250, 45, 30);
      if (process.env.PATENT_WORKBENCH_E2E_HARDWARE_GRAPHICS === "1") {
        await ws.locator("[data-cad-gpu-preview]").evaluate(element => {
          const gl = (element as HTMLCanvasElement).getContext("webgl");
          const extension = gl?.getExtension("WEBGL_lose_context");
          if (!extension) throw Error("GPU context loss extension unavailable");
          extension.loseContext();
        });
        await expect(ws.locator("[data-cad-affine-preview]")).toBeVisible();
        await expect(ws.locator("[data-cad-gpu-preview]")).toBeHidden();
      }
      await cancel();
      await canvas.press("Control+a");
      await tool("缩放");
      await click(200, 200);
      await sweep("scale whole imported drawing", 320, 250, 45, 30);
      await cancel();
    }
    const report = testInfo.outputPath("tool-performance.json");
    const graphics = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
    await writeFile(report, JSON.stringify({ dense, graphics, results, commits }, null, 2));
    await testInfo.attach("tool-performance.json", {
      path: report,
      contentType: "application/json",
    });
    console.info(JSON.stringify({ dense, commits }));
    if (dense && process.env.PATENT_WORKBENCH_E2E_HARDWARE_GRAPHICS === "1") {
      for (const result of results.filter(result => result.name.includes("whole imported"))) {
        expect(result.p95, `${result.name}: P95 frame interval`).toBeLessThan(35);
        expect(result.max, `${result.name}: longest frame`).toBeLessThan(100);
      }
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
      ),
    ).toBe(true);
  });
}
