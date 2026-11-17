import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { AI_POLICY_VERSION } from "../../src/shared/ai-correction/policy.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";

const prepareHiddenMain = createRequire(import.meta.url)("./fixtures/background-electron.cjs") as (
  entry?: string,
) => Promise<string>;

// biome-ignore lint/correctness/noEmptyPattern: Test uses an isolated hidden Electron process, not a browser fixture.
test("hidden Electron: selection polish, continuation, icon copying and new conversation", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "text-polish-stability-"));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const input = JSON.parse(
      body.messages.find((message: { role: string }) => message.role === "user").content,
    );
    const revisedText = input.untrustedCurrentInstruction.includes("精简")
      ? "本装置包括主体和连接件。"
      : "本装置包括主体以及与主体连接的连接件。";
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: JSON.stringify({
                kind: "revision",
                message: "已调整",
                revisedText,
                deliverableType: "other",
              }),
            },
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(11434, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("模拟服务地址无效");
  const userData = join(root, "user-data");
  await mkdir(userData);
  const profileId = "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c";
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
            displayName: "隔离模拟模型",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-chat",
          },
        ],
      },
    }),
  );
  await writeFile(
    join(userData, "ai-upload-consent.json"),
    JSON.stringify({
      version: 1,
      origins: [createHash("sha256").update("https://api.deepseek.com").digest("hex")],
    }),
  );
  const hiddenEntry = await prepareHiddenMain(process.env.PATENT_WORKBENCH_E2E_APP_ENTRY);
  const hiddenSource = await readFile(hiddenEntry, "utf8");
  expect(hiddenSource).toContain("const postSse = createHttpsSseClient();");
  expect(hiddenSource).toContain("const postJson = createHttpsJsonClient();");
  // Redirect only the isolated test copy; never send synthetic documents to a real provider.
  await writeFile(
    hiddenEntry,
    hiddenSource
      .replace(
        "const postSse = createHttpsSseClient();",
        `const postSse = createHttpsSseClient({ endpointOverride: new URL("http://127.0.0.1:${address.port}/v1/chat/completions") });`,
      )
      .replace(
        "const postJson = createHttpsJsonClient();",
        'const postJson = async () => { throw new Error("Unexpected external JSON request in synthetic test"); };',
      ),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "PATENT_WORKBENCH_DEVTOOLS"].includes(
          entry[0],
        ),
    ),
  );
  const application = await electron.launch({
    args: [hiddenEntry, `--user-data-dir=${userData}`, "--disable-gpu"],
    cwd: resolve("."),
    env: {
      ...env,
      PATENT_WORKBENCH_TEST: "1",
      PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1",
      PATENT_WORKBENCH_LIBRARY_ROOT: join(root, "library"),
      LOCALAPPDATA: join(root, "local-app-data"),
    },
  });
  try {
    await expect
      .poll(async () => (await application.windows().at(-1)?.url()) ?? "")
      .toContain("index.html");
    const page = application.windows().find((candidate) => candidate.url().includes("index.html"));
    if (!page) throw new Error("主窗口未就绪");
    expect(
      await application.evaluate(
        ({ BaseWindow }) =>
          BaseWindow.getAllWindows().length > 0 &&
          BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const consent = page.getByRole("dialog", { name: "软件使用协议与隐私政策确认", exact: true });
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: "开始使用", exact: true }).click();
    await expect(consent).toBeHidden();
    const keySaved = await page.evaluate(
      (profileId) =>
        window.patentApi.aiCorrection.setApiKey({
          profileId,
          apiKey: "synthetic-stability-test-only",
        }),
      profileId,
    );
    expect(keySaved.ok).toBe(true);
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("润色稳定性隔离验收");
    await dialog.getByRole("radio", { name: "发明" }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    const original = "本装置包括一个主体以及一个和主体连接的连接件。";
    await editor.click();
    await editor.press("Control+A");
    await page.keyboard.type(original);
    await editor.press("Control+A");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "小栈AI助手", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "小栈AI助手" });
    await expect(panel.getByRole("button", { name: "预览选中文字" })).toContainText(
      `已选中 ${original.length} 字`,
    );
    await panel.getByRole("button", { name: "开始润色" }).click();
    await expect(
      panel.getByText("本装置包括主体以及与主体连接的连接件。", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("textbox", { name: "继续对话" }).fill("再精简");
    await panel.getByRole("textbox", { name: "继续对话" }).press("Enter");
    await expect(panel.getByText("本装置包括主体和连接件。", { exact: true })).toBeVisible();
    // Verify the real renderer/preload/IPC path without overwriting the user's OS clipboard.
    await application.evaluate(({ clipboard }) => {
      clipboard.writeText = (text) => {
        (globalThis as typeof globalThis & { polishCopiedText?: string }).polishCopiedText = text;
      };
    });
    const copy = panel.getByRole("button", { name: "复制", exact: true }).last();
    expect(await copy.textContent()).toBe("");
    await copy.click();
    await expect(panel.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(
      await application.evaluate(
        () => (globalThis as typeof globalThis & { polishCopiedText?: string }).polishCopiedText,
      ),
    ).toBe("本装置包括主体和连接件。");
    await expect(editor).toContainText(original);
    await expect(panel.getByRole("button", { name: "替换原文" })).toHaveCount(0);
    await panel.getByRole("button", { name: "查看完整润色稿" }).last().click();
    await panel.getByRole("button", { name: "复制润色稿" }).click();
    await expect(panel.getByRole("button", { name: "已复制" })).toBeVisible();
    await expect(editor).toContainText(original);
    await page.screenshot({ path: testInfo.outputPath("polish-copy-only.png") });
    await panel.getByRole("button", { name: "返回对话" }).click();
    await panel.getByRole("button", { name: "新对话" }).click();
    await expect(panel.getByRole("heading", { name: "从一个想法，到一段好文字。" })).toBeVisible();
    await panel.getByRole("button", { name: "历史对话" }).click();
    await panel.locator("button.polish-history__item").first().click();
    await expect(panel.getByText("本装置包括主体和连接件。", { exact: true })).toBeVisible();
    await panel.getByRole("textbox", { name: "继续对话" }).fill("保留的下一轮草稿");
    await panel.getByRole("button", { name: "历史对话" }).click();
    await panel.locator("button.polish-history__item").first().click();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toHaveValue("保留的下一轮草稿");
    expect(requests).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(
      await application.evaluate(
        ({ BaseWindow }) =>
          BaseWindow.getAllWindows().length > 0 &&
          BaseWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
