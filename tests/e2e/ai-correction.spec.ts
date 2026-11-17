import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { AI_POLICY_VERSION } from "../../src/shared/ai-correction/policy.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";
import {
  prepareCorrectionFixtureConsent,
  prepareCorrectionFixtureMain,
} from "./fixtures/correction-fixture.js";
import { expect, test } from "./helpers/workbench.js";

// All tests in this file must use the hidden disposable main entry.
process.env.PATENT_WORKBENCH_E2E_BACKGROUND = "1";

async function startProvider(logPath: string): Promise<ChildProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(process.cwd(), "tests", "fixtures", "ai-correction-provider.mjs"),
      logPath,
    ]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`模拟 AI 服务退出：${code}\n${stderr}`)));
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("READY")) resolve(child);
    });
  });
}

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole("dialog", { name: /欢迎使用/u });
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function mainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const ready = await page
        .evaluate(
          () =>
            typeof (globalThis as unknown as { patentApi?: { settings?: { read?: unknown } } })
              .patentApi?.settings?.read === "function",
        )
        .catch(() => false);
      if (ready) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("主应用窗口未在 20 秒内就绪。");
}

async function createPatent(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "专利库" }).click();
  await page.getByRole("button", { name: "新建专利", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建专利" });
  await dialog.getByRole("textbox", { name: "专利名称" }).fill(name);
  await dialog.getByRole("radio", { name: "发明" }).check();
  await dialog.getByRole("button", { name: "创建专利" }).click();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

async function replaceBook(page: Page, tab: string, text: string): Promise<void> {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const editor = page.getByRole("textbox", { name: `编辑 ${tab}` });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}

test("always uses mandatory Thinking for the official DeepSeek provider", async ({ workbench }) => {
  const profileId = "61d36d20-79ae-4fcf-aa37-e6e8a65ee80c";
  await mkdir(workbench.userData, { recursive: true });
  await writeFile(
    join(workbench.userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      welcomeCompleted: true,
      aiCorrection: {
        ...DEFAULT_APP_SETTINGS.aiCorrection,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "DeepSeek · V4 Pro",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-v4-pro",
          },
        ],
      },
    }),
  );
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await createPatent(page, "Thinking 偏好验收");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI 纠错", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "AI 纠错" });
    await expect(panel.getByRole("switch", { name: "深度思考" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "开始思考" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

test("configures DeepSeek and receives a streamed structured correction result", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const logPath = join(workbench.root, "ai-correction-requests.jsonl");
  const provider = await startProvider(logPath);
  await prepareCorrectionFixtureMain(11434, process.env.PATENT_WORKBENCH_E2E_APP_ENTRY);
  await mkdir(workbench.userData, { recursive: true });
  await prepareCorrectionFixtureConsent(workbench.userData);
  await writeFile(
    join(workbench.userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      welcomeCompleted: true,
      aiPolicyAcceptedVersion: AI_POLICY_VERSION,
      aiConnectionsEnabled: true,
    }),
  );
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await createPatent(page, "DeepSeek 流式纠错验收");
    await replaceBook(page, "说明书", "本说明书包含一个错别子，用于验证流式纠错。");

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settingsDialog = page.getByRole("dialog", { name: "设置" });
    await settingsDialog.getByRole("button", { name: "AI 设置（实验功能）", exact: true }).click();
    const settings = settingsDialog.getByTestId("settings-workspace-content");
    await settings.getByRole("button", { name: "添加模型" }).click();
    const modelEditor = page.getByRole("region", { name: "添加新模型" });
    await modelEditor.getByLabel("模型提供商").selectOption("deepseek");
    await modelEditor.getByLabel("模型", { exact: true }).selectOption("deepseek-flash");
    await modelEditor.getByLabel("API Key").fill("isolated-e2e-key");
    await modelEditor.getByRole("button", { name: "保存模型" }).click();
    await expect(settings.getByText("API Key 已安全保存")).toBeVisible();
    await settingsDialog.getByRole("button", { name: "关闭设置" }).last().click();

    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI 纠错", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "AI 纠错" });
    await expect(panel.getByRole("switch", { name: "深度思考" })).toHaveCount(0);
    await panel.getByRole("button", { name: "开始思考" }).click();
    await expect(panel.getByText("此处应为“错别字”。")).toBeVisible();

    const requests = await readFile(logPath, "utf8");
    const requestRecord = JSON.parse(requests.trim()) as { raw: string };
    expect(JSON.parse(requestRecord.raw)).toMatchObject({
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  } finally {
    await application.close().catch(() => undefined);
    provider.kill();
  }
});

test("continues text polish, copies replies and starts a genuinely new conversation", async ({
  workbench,
}) => {
  test.setTimeout(120_000);
  const logPath = join(workbench.root, "text-polish-requests.jsonl");
  const provider = await startProvider(logPath);
  const profileId = "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c";
  await mkdir(workbench.userData, { recursive: true });
  await writeFile(
    join(workbench.userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      welcomeCompleted: true,
      aiCorrection: {
        ...DEFAULT_APP_SETTINGS.aiCorrection,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "ollama",
            displayName: "本地连续润色模型",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "qwen3:8b",
          },
        ],
      },
    }),
  );
  const application = await workbench.launchAllowMultipleInstances();
  try {
    const page = await mainWindow(application);
    await dismissWelcome(page);
    await createPatent(page, "连续小栈AI助手验收");
    await replaceBook(page, "说明书", "本装置包括一个主体以及一个和主体连接的连接件。");
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.getByRole("button", { name: "工具" }).click();
    await page.getByRole("menuitem", { name: "小栈AI助手", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "小栈AI助手" });
    await expect(panel.getByText("已选中文字")).toBeVisible();
    await panel.getByRole("button", { name: "开始润色" }).click();
    const firstDraft = panel.getByText("本装置包括主体以及与主体连接的连接件。");
    await expect(firstDraft).toBeVisible();
    const transcript = panel.getByRole("log", { name: "连续对话记录" });
    expect(await transcript.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(
      220,
    );
    expect(
      await firstDraft.evaluate((element) => {
        const log = element.closest<HTMLElement>('[role="log"]');
        if (!log) return false;
        const item = element.getBoundingClientRect();
        const viewport = log.getBoundingClientRect();
        return item.bottom > viewport.top && item.top < viewport.bottom;
      }),
    ).toBe(true);
    await expect(panel.getByRole("button", { name: "替换原文" })).toBeVisible();

    const composer = panel.getByRole("textbox", { name: "继续对话" });
    await composer.fill("请再精简一些");
    await composer.press("Enter");
    await expect(panel.getByText("本装置包括主体和连接件。")).toBeVisible();
    const copyButtons = panel.getByRole("button", { name: "复制" });
    await copyButtons.last().click();
    await expect(panel.getByRole("button", { name: "已复制" })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "新对话" }).click();
    await expect(panel.getByRole("button", { name: "开始润色" })).toBeVisible();
    await expect(panel.getByText("本装置包括主体和连接件。")).toHaveCount(0);
  } finally {
    await application.close().catch(() => undefined);
    provider.kill();
  }
});
