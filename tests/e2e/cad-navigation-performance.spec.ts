import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

type ProbeWindow = Window & {
  navigationProbe: {
    frames: number[];
    longTasks: number[];
    previous: number;
    running: boolean;
    observer: PerformanceObserver;
  };
};

async function startFrames(page: Page) {
  await page.evaluate(() => {
    const probe = { frames: [] as number[], longTasks: [] as number[], previous: 0, running: true };
    const observer = new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => entry.duration));
    });
    observer.observe({ type: "longtask" });
    Object.assign(window, { navigationProbe: { ...probe, observer } });
    const state = (window as unknown as ProbeWindow).navigationProbe;
    const sample = (time: number) => {
      if (!state.running) return;
      if (state.previous) state.frames.push(time - state.previous);
      state.previous = time;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function finishFrames(page: Page, name: string) {
  return page.evaluate((name) => {
    const probe = (window as unknown as ProbeWindow).navigationProbe;
    probe.running = false;
    probe.observer.disconnect();
    const frames = (probe.frames as number[]).sort((a, b) => a - b);
    return {
      name,
      samples: frames.length,
      p50: frames[Math.floor(frames.length * 0.5)] ?? 0,
      p95: frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] ?? 0,
      max: frames.at(-1) ?? 0,
      longTasks: probe.longTasks as number[],
    };
  }, name);
}

test("@performance CAD navigation, selection and cancelled drawing retain geometry", async ({
  workbench,
}, testInfo) => {
  test.setTimeout(180_000);
  const app = await workbench.launch();
  const page = await app.firstWindow();
  await dismissWorkbenchWelcome(page);
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建专利" });
  await create.getByRole("radio", { name: "实用新型", exact: true }).check();
  await create.getByRole("button", { name: "创建专利", exact: true }).click();
  await expect(create).toBeHidden();
  const later = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await page.getByRole("menuitem", { name: "CAD标号", exact: true }).click();
  const workspace = page.getByRole("region", { name: "CAD标号", exact: true });
  await workspace
    .getByLabel("选择图纸文件")
    .setInputFiles(
      resolve(process.env.CAD_PERFORMANCE_DRAWING ?? "tests/fixtures/cad/sample_AC1032.dwg"),
    );
  const panel = page.getByRole("region", { name: "CAD实体编辑", exact: true });
  await expect(panel).toHaveAttribute("data-cad-ready", "true", { timeout: 60_000 });
  const opener = page.getByRole("button", { name: "展开功能栏", exact: true });
  if (await opener.isVisible()) await opener.click();
  const pin = page.getByRole("button", { name: "固定", exact: true });
  if (await pin.isVisible()) await pin.click();
  const canvas = workspace.getByRole("application", { name: "CAD标号画布", exact: true });
  const box = await canvas.boundingBox();
  if (!box) throw Error("CAD viewport is not visible");
  const x = box.x + box.width * 0.4,
    y = box.y + box.height * 0.45;
  const view = await canvas.getAttribute("viewBox");
  const geometry = async () =>
    page.evaluate(async () => {
      const patents = await window.patentApi.patents.list("active");
      if (!patents.ok) throw Error(patents.error.message);
      const patent = patents.value[0];
      if (!patent) throw Error("Test patent is missing");
      const opened = await window.patentApi.patents.open(patent.patentId);
      if (!opened.ok) throw Error(opened.error.message);
      return opened.value.patent.drawingProjects.map((p) => ({
        projectId: p.projectId,
        cad: p.cad,
        annotations: p.annotations,
        detailViews: p.detailViews,
      }));
    });
  // First entering an editing tool upgrades imported CAD to the editable native
  // checkpoint. Establish the baseline after this intentional format transition.
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.press("Escape");
  await expect.poll(async () => (await geometry())[0]?.cad?.unified).toBe(1);
  await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible();
  const before = await geometry();
  const results = [];
  for (const name of ["hover", "pan", "zoom"] as const) {
    await page.mouse.move(x, y);
    if (name === "pan") await page.mouse.down({ button: "middle" });
    await startFrames(page);
    for (let i = 0; i < 48; i++) {
      if (name === "zoom") await page.mouse.wheel(0, i < 24 ? -20 : 20);
      else
        await page.mouse.move(
          x + 120 * Math.sin((i * 2 * Math.PI) / 47),
          y + 70 * Math.sin((i * 4 * Math.PI) / 47),
        );
    }
    if (name === "pan") await page.mouse.up({ button: "middle" });
    results.push(await finishFrames(page, name));
  }
  await expect(canvas).toHaveCSS("transform", "none");
  await canvas.press("Control+a");
  await canvas.press("Escape");
  await panel.getByRole("button", { name: "直线", exact: true }).click();
  await canvas.click({ position: { x: box.width * 0.25, y: box.height * 0.4 } });
  await startFrames(page);
  for (let i = 0; i < 48; i++)
    await page.mouse.move(x + 120 * Math.sin(i / 8), y + 80 * Math.cos(i / 8));
  results.push(await finishFrames(page, "line preview with snapping"));
  await canvas.press("Escape");
  await expect(workspace.locator('[data-save-state="saved"]')).toBeVisible();
  expect(await geometry()).toEqual(before);
  expect(view).not.toBeNull();
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })),
  );
  expect(windows.every((w) => !w.visible && !w.focused)).toBe(true);
  console.info(JSON.stringify({ backgroundSoftwareRendering: true, results }));
  await testInfo.attach("navigation-metrics.json", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
});
