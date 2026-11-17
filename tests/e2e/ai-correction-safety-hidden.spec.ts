import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { AI_POLICY_VERSION } from "../../src/shared/ai-correction/policy.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";
import {
  prepareCorrectionFixtureConsent,
  prepareCorrectionFixtureMain,
} from "./fixtures/correction-fixture.js";
import { waitForMainWindow } from "./helpers/workbench.js";

test("local fixture correction locates, replaces in red and retains results in hidden Electron", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "patent-ai-safety-"));
  const userData = join(root, "user-data");
  const logPath = join(root, "fixture-requests.jsonl");
  const profileId = "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c";
  await mkdir(userData);
  await prepareCorrectionFixtureConsent(userData);
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      welcomeCompleted: true,
      aiConnectionsEnabled: true,
      aiPolicyAcceptedVersion: AI_POLICY_VERSION,
      aiCorrection: {
        ...DEFAULT_APP_SETTINGS.aiCorrection,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "DeepSeek fixture",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-flash",
          },
        ],
      },
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          "ELECTRON_RUN_AS_NODE",
          "ELECTRON_RENDERER_URL",
          "PATENT_WORKBENCH_DEVTOOLS",
          "ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT",
        ].includes(entry[0]),
    ),
  );
  Object.assign(env, {
    PATENT_WORKBENCH_TEST: "1",
    PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1",
    PATENT_WORKBENCH_LIBRARY_ROOT: join(root, "library"),
    LOCALAPPDATA: join(root, "local-app-data"),
  });
  let provider: ChildProcess | undefined;
  let providerPort = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      provider = spawn(process.execPath, [
        join(process.cwd(), "tests/fixtures/ai-correction-provider.mjs"),
        logPath,
        "0",
        "3000",
        "30000",
      ]);
      provider.once("error", reject);
      provider.once("exit", (code) => reject(new Error(`Fixture provider exited: ${code}`)));
      provider.stdout?.on("data", (chunk) => {
        const ready = /READY (\d+)/u.exec(String(chunk));
        if (ready) {
          providerPort = Number(ready[1]);
          resolve();
        }
      });
    });
    const application = await electron.launch({
      args: [
        await prepareCorrectionFixtureMain(
          providerPort,
          process.env.PATENT_WORKBENCH_E2E_APP_ENTRY,
        ),
        `--user-data-dir=${userData}`,
      ],
      env,
    });
    try {
      const page = await waitForMainWindow(application);
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { patentApi: PatentApi }).patentApi?.settings?.read ===
          "function",
      );
      const windows = await application.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
      expect(windows.length).toBeGreaterThan(0);
      expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
      const keyResult = await page.evaluate(
        (id) =>
          (window as unknown as { patentApi: PatentApi }).patentApi.aiCorrection.setApiKey({
            profileId: id,
            apiKey: "isolated-fixture-key",
          }),
        profileId,
      );
      expect(keyResult.ok).toBe(true);
      // The key was installed through IPC, outside the settings UI refresh callback.
      await page.reload();
      await page.getByRole("button", { name: "新建专利", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建专利" });
      await dialog.getByRole("textbox", { name: "专利名称" }).fill("纠错安全回归");
      await dialog.getByRole("radio", { name: "发明", exact: true }).check();
      await dialog.getByRole("button", { name: "创建专利" }).click();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "编辑 说明书" });
      await editor.fill("本说明书包含一个错别子，用于验证纠错安全。");
      await editor.press("Control+A");
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "AI 纠错", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "AI 纠错" });
      await expect(panel).toBeVisible();
      const panelBounds = await panel.boundingBox();
      if (!panelBounds) throw new Error("Correction panel is not laid out");
      expect(panelBounds.width).toBeGreaterThanOrEqual(360);
      expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(
        await page.evaluate(() => window.innerWidth),
      );
      await expect(panel).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(panel.locator(".ai-scope-options")).toHaveCSS("gap", "0px");
      await expect(panel.getByRole("button", { name: "模型配置" })).toHaveAttribute(
        "title",
        "模型配置",
      );
      await panel.screenshot({ path: test.info().outputPath("correction-minimal-ready.png") });
      const selectionRadio = panel.getByRole("radio", { name: /选中文字/ });
      const documentRadio = panel.getByRole("radio", { name: /当前文档/ });
      await panel.getByText("选中文字", { exact: true }).click();
      await expect(selectionRadio).toBeChecked();
      await panel.getByText("检查当前打开的文字文档", { exact: true }).click();
      await expect(documentRadio).toBeChecked();
      await panel.getByText("只检查当前选区", { exact: true }).click();
      await expect(selectionRadio).toBeChecked();
      await documentRadio.locator("..").click({ position: { x: 5, y: 5 } });
      await expect(documentRadio).toBeChecked();
      await selectionRadio.locator("..").click({ position: { x: 5, y: 5 } });
      await expect(selectionRadio).toBeChecked();
      await panel.getByText("当前文档", { exact: true }).click();
      await expect(documentRadio).toBeChecked();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("错别子");
      await selectionRadio.press("Space");
      await expect(selectionRadio).toBeChecked();
      await documentRadio.press("Space");
      await expect(documentRadio).toBeChecked();
      await panel.getByRole("button", { name: "开始思考", exact: true }).click();
      await expect(panel.getByText("此处应为“错别字”。"))
        .toBeVisible()
        .catch(async (error) => {
          throw new Error(`${error}\nPanel: ${await panel.innerText()}`);
        });
      await expect(panel.getByRole("button", { name: "展开思考过程", exact: true })).toBeVisible();
      const headingLayout = await panel.evaluate((element) => {
        const header = element.querySelector(".assistant-side-panel__header") as HTMLElement;
        return {
          scrollTop: element.scrollTop,
          top: element.getBoundingClientRect().top,
          headerTop: header.getBoundingClientRect().top,
        };
      });
      expect(headingLayout.headerTop).toBeGreaterThanOrEqual(headingLayout.top);
      const resultList = panel.getByRole("region", { name: "纠错建议" });
      await expect(resultList).toHaveCSS("overflow-y", "auto");
      await expect(panel.getByRole("button", { name: "定位", exact: true })).toHaveText("");
      const resultBounds = await resultList.boundingBox();
      const footerBounds = await panel.locator(".ai-correction-results-footer").boundingBox();
      if (!resultBounds || !footerBounds) throw new Error("Correction results are not laid out");
      expect(resultBounds.y + resultBounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
      await panel.screenshot({ path: test.info().outputPath("correction-minimal-results.png") });
      await panel.getByRole("button", { name: "定位", exact: true }).click();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("子");
      // Keep an unrelated edit, then change and undo only the reported occurrence.
      await editor.press("Control+End");
      await editor.press("Enter");
      await editor.pressSequentially("保留这段额外编辑");
      await panel.getByRole("button", { name: "定位", exact: true }).click();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("子");
      await editor.pressSequentially("误");
      await expect(editor).toContainText("错别误");
      await editor.press("Control+z");
      await expect(editor).toContainText("错别子");
      await expect(editor).toContainText("保留这段额外编辑");
      await panel.getByRole("button", { name: "定位", exact: true }).click();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("子");
      await panel.getByRole("button", { name: "接受", exact: true }).click();
      await expect(editor).toContainText("错别字");
      const changed = editor.locator('span[style*="color"]').filter({ hasText: "字" });
      await expect(changed).toHaveCount(1);
      await expect(changed).toHaveCSS("color", "rgb(217, 45, 32)");
      await expect(panel.getByText("建议已全部处理。")).toBeVisible();
      await editor.press("Control+z");
      await expect(editor).toContainText("错别子");
      await expect(panel.getByRole("button", { name: "接受", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "定位", exact: true }).click();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("子");
      await editor.press("Control+y");
      await expect(editor).toContainText("错别字");
      await expect(panel.getByText("建议已全部处理。")).toBeVisible();
      await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole("tab", { name: "说明书", exact: true }).click();
      await expect(panel.getByText("建议已全部处理。")).toBeVisible();
      const records = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.method === "POST")).toHaveLength(1);
      expect(JSON.parse(records[0].raw)).toMatchObject({
        stream: true,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        model: "deepseek-flash",
      });
      // A normal panel close preserves the running request, unlike a renderer reload.
      await panel.getByRole("button", { name: "重新检查", exact: true }).click();
      await panel.getByRole("button", { name: "开始思考", exact: true }).click();
      await expect(panel.getByRole("button", { name: "停止思考", exact: true })).toBeVisible();
      await expect
        .poll(async () => (await readFile(logPath, "utf8")).split('"method":"POST"').length - 1)
        .toBe(2);
      await panel.getByRole("button", { name: "关闭 AI 纠错", exact: true }).click();
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "AI 纠错", exact: true }).click();
      await expect(panel.getByRole("button", { name: "停止思考", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "停止思考", exact: true }).click();
      await expect
        .poll(async () => (await readFile(logPath, "utf8")).split('"event":"aborted"').length - 1)
        .toBe(1);
      await panel.getByRole("button", { name: "开始思考", exact: true }).click();
      await expect
        .poll(async () => (await readFile(logPath, "utf8")).split('"method":"POST"').length - 1)
        .toBe(3);
      await page.reload();
      await expect
        .poll(async () => (await readFile(logPath, "utf8")).split('"event":"aborted"').length - 1)
        .toBe(2);
    } finally {
      await application.close();
    }
  } finally {
    provider?.kill();
  }
});
