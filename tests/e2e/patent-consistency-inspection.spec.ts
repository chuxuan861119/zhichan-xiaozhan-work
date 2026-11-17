import type { ElectronApplication, Page } from "@playwright/test";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function dismissWelcome(page: Page): Promise<void> {
  await dismissWorkbenchWelcome(page);
}

async function disposeInspectionTest(application: ElectronApplication): Promise<void> {
  // This suite verifies inspection, not the quit handshake. Only its disposable
  // isolated process is closed, after all document-integrity assertions finish.
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await application.close().catch(() => undefined);
}

async function createPatent(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "专利库" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "实用新型" }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

test("keeps checking and locating separate from export", async ({ workbench }) => {
  test.setTimeout(90_000);
  const application = await workbench.launch();
  const rendererErrors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await dismissWelcome(page);
    await createPatent(page, "一致性检查验收");

    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const claims = page.getByRole("textbox", { name: "编辑 权利要求书" });
    await claims.click();
    await claims.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await claims.pressSequentially("1. 一种装置，其特征在于，包括壳体。");
    await claims.press("Enter");
    await claims.pressSequentially("3. 根据权利要求1所述的装置，其特征在于，包括支架。");

    const tools = page.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await tools.getByRole("button", { name: "本地检查" }).click();
    const panel = page.getByRole("complementary", { name: "本地检查" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "全文检查" }).click();
    await expect(panel.getByRole("region", { name: "检查结果摘要" })).toBeVisible();

    const totalText = await panel
      .getByRole("region", { name: "检查结果摘要" })
      .locator(".patent-check-panel__total strong")
      .innerText();
    const total = Number.parseInt(totalText, 10);
    expect(total).toBeGreaterThan(0);
    await panel.getByRole("tab", { name: "权利要求" }).click();
    const claimIssue = panel.getByRole("listitem").filter({ hasText: "编号不连续" }).first();
    await expect(claimIssue).toContainText("编号不连续");
    await claimIssue.getByRole("button", { name: /定位文字|前往段落/u }).click();
    await expect(page.getByRole("tab", { name: "权利要求书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // 定位后保留结果，并选中实际出错的段落。
    await expect(page.getByRole("complementary", { name: "本地检查" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .toContain("3. 根据权利要求1");
    await page.getByLabel("说明书", { exact: true }).click();
    await expect(panel).toBeVisible();
    await claimIssue.getByRole("button", { name: /定位文字|前往段落/u }).click();
    await expect(page.getByRole("tab", { name: "权利要求书", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .toContain("3. 根据权利要求1");
    await expect(panel).toBeVisible();
    // BubbleMenu updates after a 250 ms debounce; inspection selections must stay quiet.
    await page.waitForTimeout(400);
    await expect(page.locator(".editor-selection-menu:visible")).toHaveCount(0);
    const checkedVersion = await panel.locator(".patent-check-panel__meta").innerText();
    await claims.press("End");
    await claims.pressSequentially("补充文字");
    await expect(panel.getByText("文档已修改，请重新检查。")).toBeVisible();
    // Allow the debounced lightweight inspection to publish without replacing the full report.
    await page.waitForTimeout(600);
    await expect(panel.locator(".patent-check-panel__meta")).toHaveText(checkedVersion, {
      useInnerText: true,
    });
    await page
      .getByRole("complementary", { name: "本地检查" })
      .getByRole("button", { name: "重新检查" })
      .click();
    await expect(
      page
        .getByRole("complementary", { name: "本地检查" })
        .getByRole("region", { name: "检查结果摘要" }),
    ).toBeVisible();
    await page
      .getByRole("toolbar", { name: "常用工具" })
      .getByRole("button", { name: "导出", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "导出 DOCX" }).click();
    const exportDialog = page.getByRole("dialog", { name: "导出专利文档" });
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.getByRole("region", { name: "导出前检查" })).toHaveCount(0);
    await expect(exportDialog.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
    await exportDialog.getByRole("button", { name: "取消" }).click();

    await expect(page.getByTestId("app-shell")).toBeVisible();
    expect(rendererErrors).toEqual([]);
  } finally {
    await disposeInspectionTest(application);
  }
});

test("closes a patent check report when returning to the patent library", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "检查面板导航验收");

    const tools = page.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await tools.getByRole("button", { name: "本地检查" }).click();
    await expect(page.getByRole("complementary", { name: "本地检查" })).toBeVisible();

    await page.getByRole("tab", { name: "专利库" }).click();
    await expect(page.getByRole("complementary", { name: "本地检查" })).toBeHidden();
  } finally {
    await disposeInspectionTest(application);
  }
});

test("full inspection includes the approved writing checks and real image health", async ({
  workbench,
}) => {
  const { readFile, readdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const application = await workbench.launch();
  let damagedPath: string | null = null;
  let originalBytes: Uint8Array | null = null;
  try {
    const page = await application.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (e) => rendererErrors.push(e.message));
    await dismissWelcome(page);
    const bytes = [...(await readFile("tests/fixtures/images/sample.png"))];
    const seeded = await page.evaluate(async (bytes) => {
      const api = window.patentApi;
      const created = await api.patents.create({
        patentType: "invention",
        name: "新增检查综合验收",
      });
      if (!created.ok) throw Error(created.error.code);
      const opened = created.value;
      const imported = await api.assets.importBytes({
        sessionId: opened.sessionId,
        originalName: "资源验收.png",
        declaredMediaType: "image/png",
        bytes: new Uint8Array(bytes),
      });
      if (!imported.ok) throw Error(imported.error.code);
      const descriptor = imported.value.descriptor;
      const patent = opened.patent;
      const p = (text: string) => ({
        id: crypto.randomUUID(),
        type: "paragraph" as const,
        attrs: {
          alignment: "left" as const,
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 12,
        },
        content: [{ type: "text" as const, text, marks: [] }],
      });
      const t = () => ({
        id: crypto.randomUUID(),
        type: "table" as const,
        tableNameEnabled: false,
        columnWidthsMm: [80],
        rows: [
          {
            id: crypto.randomUUID(),
            cells: [
              {
                id: crypto.randomUUID(),
                rowSpan: 1,
                colSpan: 1,
                horizontalAlignment: "left" as const,
                verticalAlignment: "top" as const,
                borderStyle: "single" as const,
                content: [p("100")],
              },
            ],
          },
        ],
      });
      const long =
        "控制器设置于壳体内部并与传感器连接，根据采集的温度控制冷却流道中的阀门开度，使得冷却介质沿着预定的冷却路径稳定流动。";
      const edits = patent.books
        .filter((b) => b.kind === "description" || b.kind === "claims")
        .map((b) => ({
          bookKind: b.kind,
          editorState: {},
          document: {
            ...b.document,
            content:
              b.kind === "description"
                ? [
                    p("壳体（2）连接传感器。"),
                    p("控制器（设有温度模块。"),
                    p("{{patentName}}【待补充】"),
                    p("如权利要求1所述，控制器调节流量。"),
                    p(long),
                    p(long),
                    p("表1 测试A"),
                    t(),
                    p("表1 测试B"),
                    t(),
                    p("测试结果如表3所示。"),
                    {
                      id: crypto.randomUUID(),
                      type: "block-formula" as const,
                      source: "\\frac{1}{",
                      formulaKind: "math" as const,
                    },
                  ]
                : [
                    p("1. 一种冷却装置，包括壳体。"),
                    p("1. 如图2所示的冷却装置。"),
                    {
                      id: crypto.randomUUID(),
                      type: "figure" as const,
                      assetId: descriptor.assetId,
                      widthMm: 60,
                      alignment: "center" as const,
                    },
                  ],
          },
        }));
      const saved = await api.patents.updateSettings({
        patentId: patent.patentId,
        expectedRevision: opened.revision,
        patentType: "invention",
        referenceMarks: [{ referenceMarkId: crypto.randomUUID(), keyword: "壳体", number: 1 }],
        referenceMarkSettings: patent.referenceMarkSettings,
        assets: [descriptor],
        bookEdits: edits,
      });
      if (!saved.ok) throw Error(saved.error.code);
      await api.patents.release(opened.sessionId);
      return { patentId: patent.patentId, revision: saved.value.revision };
    }, bytes);
    await page.reload();
    await dismissWelcome(page);
    await page.locator(".patent-list-title-button").filter({ hasText: "新增检查综合验收" }).click();
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const expand = page.getByRole("button", { name: "展开功能栏", exact: true });
    if (await expand.isVisible()) await expand.click();
    const later = page.getByRole("button", { name: "稍后设置", exact: true });
    if (await later.isVisible()) await later.click();
    const tools = page.getByRole("complementary", { name: "权利要求书全局功能栏" });
    await tools.getByRole("button", { name: "本地检查", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "本地检查", exact: true });
    await panel.getByRole("button", { name: "全文检查", exact: true }).click();
    await expect(panel.getByRole("region", { name: "检查结果摘要" })).toBeVisible();
    await expect(
      panel.getByText("权利要求编号重复，引用关系检查暂时无法完成。请先修正编号，再重新检查。", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      panel.getByText("图片资源文件尚未核验。请重新进行全文检查。", { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("listitem").filter({ hasText: "权利要求书中包含图片" }),
    ).toBeVisible();
    await expect(panel.getByRole("listitem").filter({ hasText: "数学公式格式有误" })).toBeVisible();
    await panel.getByRole("button", { name: /待核对/u }).click();
    for (const text of ["标为2", "缺少对应的后半符号", "未处理的标记", "跨文档引用", "表1", "表3"])
      await expect(panel.getByRole("listitem").filter({ hasText: text }).first()).toBeVisible();
    await panel.getByRole("button", { name: /写作建议/u }).click();
    await expect(
      panel.getByRole("listitem").filter({ hasText: "相邻两段内容完全相同" }),
    ).toBeVisible();
    // Damage only a resource in this test's isolated library; never a user's instance.
    const baseline = await page.evaluate(async (id) => {
      const opened = await window.patentApi.patents.open(id);
      if (!opened.ok) throw Error(opened.error.code);
      await window.patentApi.patents.release(opened.value.sessionId);
      return opened.value.patent;
    }, seeded.patentId);
    const assetRoot = join(workbench.root, "library", "assets");
    const files = (await readdir(assetRoot)).filter((n) => n.endsWith(".asset"));
    expect(files).toHaveLength(1);
    damagedPath = join(assetRoot, files[0]!);
    originalBytes = await readFile(damagedPath);
    await writeFile(damagedPath, new Uint8Array([0, 1, 2]));
    await panel.getByRole("button", { name: "重新检查", exact: true }).click();
    await panel.getByRole("button", { name: /需处理/u }).click();
    await expect(panel.getByRole("listitem").filter({ hasText: "资源验收.png" })).toBeVisible();
    await writeFile(damagedPath, originalBytes);
    const stored = await page.evaluate(async (id) => {
      const opened = await window.patentApi.patents.open(id);
      if (!opened.ok) throw Error(opened.error.code);
      await window.patentApi.patents.release(opened.value.sessionId);
      return opened.value.patent;
    }, seeded.patentId);
    expect(stored).toEqual(baseline);
    await panel.getByRole("button", { name: "重新检查", exact: true }).click();
    await page.getByRole("button", { name: "关闭新增检查综合验收", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /提示|错误/u })).toHaveCount(0);
    await expect(panel).toBeHidden();
    const known = rendererErrors.filter((error) => error === "Transition was skipped");
    if (known.length)
      test.info().annotations.push({
        type: "known-background",
        description: "快速切页仍有既有 View Transition 警告：Transition was skipped。",
      });
    expect(rendererErrors.filter((error) => error !== "Transition was skipped")).toEqual([]);
  } finally {
    if (damagedPath && originalBytes) await writeFile(damagedPath, originalBytes);
    await disposeInspectionTest(application);
  }
});
