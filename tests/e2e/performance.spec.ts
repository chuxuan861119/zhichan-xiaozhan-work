import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { cpus, release, totalmem, type, version } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ElectronApplication, Page } from "@playwright/test";
import { createPerformancePayload, writePatdoc } from "./helpers/documents.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

const MEBIBYTE = 1024 * 1024;

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function measureTabSwitch(page: Page, title: string): Promise<number> {
  return await page.evaluate(async (targetTitle) => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (candidate) => candidate.textContent?.includes(targetTitle),
    );
    if (!tab) throw new Error(`找不到性能标签：${targetTitle}`);
    const started = performance.now();
    tab.click();
    while (tab.getAttribute("aria-selected") !== "true") {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return performance.now() - started;
  }, title);
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("性能样本为空。");
  return value;
}

function powershell(script: string): string {
  return execFileSync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function storageType(): string {
  try {
    const physicalDisk = powershell(
      "@(Get-PhysicalDisk -ErrorAction Stop | Select-Object -ExpandProperty MediaType -Unique) -join ','",
    );
    if (physicalDisk) return physicalDisk;
  } catch {
    // Fall through to a model-based CIM record when the Storage module is unavailable.
  }
  try {
    return (
      powershell(
        "@(Get-CimInstance Win32_DiskDrive -ErrorAction Stop | ForEach-Object { \"$($_.MediaType): $($_.Model)\" }) -join '; '",
      ) || "Unknown"
    );
  } catch {
    return "Unknown";
  }
}

async function currentAppWorkingSet(application: ElectronApplication): Promise<number> {
  return await application.evaluate(({ app }) =>
    app.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize * 1024, 0),
  );
}

async function startContinuousMemorySampling(
  application: ElectronApplication,
  samples: number[],
): Promise<() => Promise<void>> {
  await application.evaluate(({ app }) => {
    const holder = globalThis as typeof globalThis & {
      patentWorkbenchMemorySamples?: number[];
      patentWorkbenchMemoryTimer?: ReturnType<typeof setInterval>;
    };
    holder.patentWorkbenchMemorySamples = [];
    holder.patentWorkbenchMemoryTimer = setInterval(() => {
      holder.patentWorkbenchMemorySamples?.push(
        app
          .getAppMetrics()
          .reduce((total, metric) => total + metric.memory.workingSetSize * 1024, 0),
      );
    }, 20);
  });
  return async () => {
    const captured = await application.evaluate(() => {
      const holder = globalThis as typeof globalThis & {
        patentWorkbenchMemorySamples?: number[];
        patentWorkbenchMemoryTimer?: ReturnType<typeof setInterval>;
      };
      if (holder.patentWorkbenchMemoryTimer) clearInterval(holder.patentWorkbenchMemoryTimer);
      const values = holder.patentWorkbenchMemorySamples ?? [];
      delete holder.patentWorkbenchMemorySamples;
      delete holder.patentWorkbenchMemoryTimer;
      return values;
    });
    samples.push(...captured);
  };
}

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

async function importPatentFixture(
  application: ElectronApplication,
  page: Page,
  path: string,
  title: string,
): Promise<void> {
  await application.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [selectedPath] }),
    });
  }, path);
  await page.getByRole("button", { name: "导入 PATDOC" }).first().click();
  await expect(page.getByRole("tab", { name: title })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "已保存", exact: true }).last()).toBeVisible();
}

test.describe("@performance patent workbench benchmark", () => {
  test("measures the deterministic reference workload and enforces release thresholds", async ({
    workbench,
  }) => {
    // The deterministic workload includes five full patent imports and both
    // DOCX/PDF export paths. Keep the operation-level gates strict, but leave
    // enough wall-clock budget for a loaded CI or developer machine to finish
    // the workload before Playwright tears down the Electron process.
    test.setTimeout(240_000);
    const paths: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const path = join(workbench.root, `性能会话${index}.patdoc`);
      await writePatdoc(path, await createPerformancePayload(`性能会话${index}`));
      paths.push(path);
    }
    const launchStarted = performance.now();
    const application = await workbench.launch();
    const memorySamples: number[] = [];
    try {
      const page = await application.firstWindow();
      await dismissWelcome(page);
      const firstPath = paths[0];
      if (!firstPath) throw new Error("性能夹具缺少首个文档。");
      await importPatentFixture(application, page, firstPath, "性能会话1");
      await expect(page.getByRole("tab", { name: "性能会话1" })).toBeVisible({
        timeout: 30_000,
      });
      const launchMs = performance.now() - launchStarted;
      memorySamples.push(await currentAppWorkingSet(application));

      for (const [index, path] of paths.slice(1).entries()) {
        await importPatentFixture(application, page, path, `性能会话${index + 2}`);
      }
      await expect(page.getByRole("tab", { name: /^性能会话/u })).toHaveCount(5);
      await expect(page.getByRole("tablist", { name: "专利标签栏" }).getByRole("tab")).toHaveCount(
        6,
      );

      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "设置" });
      await settings.getByRole("button", { name: "快捷键" }).click();
      const shortcutDialog = settings.getByRole("region", { name: "快捷键设置" });
      const checkProblemsShortcut = shortcutDialog.getByRole("button", {
        name: "设置本地检查快捷键",
      });
      await checkProblemsShortcut.click();
      await checkProblemsShortcut.press("F7");
      await shortcutDialog.getByRole("button", { name: "保存" }).click();
      await settings.getByRole("button", { name: "关闭设置" }).last().click();
      await expect(settings).toBeHidden();

      // Warm each heavy editor tree once so the benchmark measures repeated user switching,
      // rather than one-time lazy module/font initialization.
      for (let index = 1; index <= 5; index += 1) {
        await measureTabSwitch(page, `性能会话${index}`);
      }
      const tabSwitchSamplesMs: number[] = [];
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const title = `性能会话${(iteration % 5) + 1}`;
        tabSwitchSamplesMs.push(await measureTabSwitch(page, title));
      }
      memorySamples.push(await currentAppWorkingSet(application));

      await page.getByRole("tab", { name: "性能会话1" }).click();
      const editor = page.getByRole("textbox", { name: "编辑 说明书" });
      await editor.press("Control+End");
      const typingSamplesMsPerEvent: number[] = [];
      for (let iteration = 0; iteration < 100; iteration += 1) {
        const started = performance.now();
        await page.keyboard.insertText("测");
        typingSamplesMsPerEvent.push(performance.now() - started);
      }
      await expect(editor).toContainText("测".repeat(100));
      memorySamples.push(await currentAppWorkingSet(application));

      const saveStarted = performance.now();
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(
        page.getByText(/已保存，(?:并成功创建快照|当前版本已有快照)/).last(),
      ).toBeVisible();
      const saveMs = performance.now() - saveStarted;

      await editor.click();
      const inspectionStarted = performance.now();
      await page.keyboard.press("F7");
      const inspectionPanel = page.getByRole("complementary", { name: "本地检查" });
      await expect(inspectionPanel).toBeVisible();
      const inspectionMs = performance.now() - inspectionStarted;
      await inspectionPanel.getByRole("button", { name: "关闭本地检查" }).click();

      const docxPath = join(workbench.root, "性能基准.docx");
      const pdfPath = join(workbench.root, "性能基准.pdf");
      await application.evaluate(
        ({ dialog }, outputPaths) => {
          let index = 0;
          Object.defineProperty(dialog, "showSaveDialog", {
            configurable: true,
            value: async () => ({ canceled: false, filePath: outputPaths[index++] }),
          });
        },
        [docxPath, pdfPath],
      );

      let docxMs: number;
      let pdfMs: number;
      const docxMemorySamples: number[] = [];
      const stopDocxMemorySampling = await startContinuousMemorySampling(
        application,
        docxMemorySamples,
      );
      try {
        const docxStarted = performance.now();
        await page.getByRole("button", { name: "文件" }).click();
        await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
        await page
          .getByRole("dialog", { name: "导出专利文档" })
          .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
          .click();
        await expect.poll(() => fileSize(docxPath), { timeout: 30_000 }).toBeGreaterThan(0);
        docxMs = performance.now() - docxStarted;
        const docxReport = page.getByRole("dialog", {
          name: /DOCX 导出(?:成功|报告|失败)/u,
        });
        await expect(docxReport).toBeVisible();
        await docxReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
      } finally {
        await stopDocxMemorySampling();
      }
      const pdfMemorySamples: number[] = [];
      const stopPdfMemorySampling = await startContinuousMemorySampling(
        application,
        pdfMemorySamples,
      );
      try {
        const pdfStarted = performance.now();
        await page.getByRole("button", { name: "文件" }).click();
        await page.getByRole("menuitem", { name: "导出 PDF" }).click();
        await page
          .getByRole("dialog", { name: "导出专利文档" })
          .getByRole("button", { name: /^(?:导出|仍导出草稿|仍然继续)$/u })
          .click();
        await expect.poll(() => fileSize(pdfPath), { timeout: 30_000 }).toBeGreaterThan(0);
        pdfMs = performance.now() - pdfStarted;
        const pdfReport = page.getByRole("dialog", { name: /PDF 导出(?:成功|报告|失败)/u });
        await expect(pdfReport).toBeVisible();
        await pdfReport.getByRole("button", { name: /^(?:确认|关闭)$/u }).click();
      } finally {
        await stopPdfMemorySampling();
      }
      expect(docxMemorySamples.length).toBeGreaterThan(1);
      expect(pdfMemorySamples.length).toBeGreaterThan(1);
      memorySamples.push(...docxMemorySamples, ...pdfMemorySamples);
      memorySamples.push(await currentAppWorkingSet(application));

      const tabSwitchP95Ms = p95(tabSwitchSamplesMs);
      const typingP95MsPerEvent = p95(typingSamplesMsPerEvent);
      const peakWorkingSetBytes = Math.max(...memorySamples);
      const electronVersion = await application.evaluate(
        () => process.versions.electron ?? "Unknown",
      );
      const record = {
        environment: {
          cpu: cpus()[0]?.model ?? "Unknown",
          logicalCpuCount: cpus().length,
          memoryBytes: totalmem(),
          os: `${type()} ${release()} ${version()}`,
          storageType: storageType(),
          electron: electronVersion,
        },
        workload: {
          chineseCharacters: 50_000,
          images: 30,
          tables: 20,
          mathFormulas: 30,
          chemicalEquations: 20,
          chemicalStructures: 10,
          sessions: 5,
        },
        measurements: {
          launchMs,
          tabSwitchP95Ms,
          typingP95MsPerEvent,
          saveMs,
          inspectionMs,
          docxMs,
          pdfMs,
          docxPeakWorkingSetBytes: Math.max(...docxMemorySamples),
          pdfPeakWorkingSetBytes: Math.max(...pdfMemorySamples),
          peakWorkingSetBytes,
          peakWorkingSetMiB: peakWorkingSetBytes / MEBIBYTE,
        },
        rawSamples: {
          tabSwitchSamplesMs,
          typingSamplesMsPerEvent,
          peakWorkingSetBytes: memorySamples,
          docxWorkingSetBytes: docxMemorySamples,
          pdfWorkingSetBytes: pdfMemorySamples,
        },
      };
      console.log(`PERFORMANCE_BENCHMARK ${JSON.stringify(record)}`);

      expect(launchMs).toBeLessThanOrEqual(30_000);
      expect(tabSwitchP95Ms).toBeLessThanOrEqual(250);
      expect(typingP95MsPerEvent).toBeLessThanOrEqual(100);
      expect(saveMs).toBeLessThanOrEqual(5_000);
      expect(inspectionMs).toBeLessThanOrEqual(500);
      expect(docxMs).toBeLessThanOrEqual(30_000);
      expect(pdfMs).toBeLessThanOrEqual(30_000);
      // Electron's PDF renderer retains the generated document buffers until its
      // export task settles. Keep a generous absolute ceiling above the measured
      // deterministic workload while the transfer gate separately enforces a
      // tight relative-growth limit.
      expect(peakWorkingSetBytes).toBeLessThanOrEqual(1.75 * 1024 * MEBIBYTE);
    } finally {
      await application.close().catch(() => undefined);
    }
  });
});
