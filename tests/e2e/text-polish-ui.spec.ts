import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Locator, type Page, test } from "@playwright/test";
import { AI_POLICY_VERSION } from "../../src/shared/ai-correction/policy.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings/model.js";

const prepareHiddenMain = createRequire(import.meta.url)(
  "./fixtures/background-electron.cjs",
) as () => Promise<string>;

async function selectTextWithMouse(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(async (element) => {
    const log = element.closest('[role="log"]');
    const stickyHeading = element.closest(".polish-completed-reasoning")?.querySelector("summary");
    const topInset = 12 + (stickyHeading?.getBoundingClientRect().height ?? 0);
    if (log)
      log.scrollTop +=
        element.getBoundingClientRect().top - log.getBoundingClientRect().top - topInset;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const range = await target.evaluate((element) => {
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    if (!node?.textContent) throw new Error("Missing selectable text");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(6, node.textContent.length));
    const rect = range.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);
    if (!hit || !element.contains(hit)) throw new Error("Selectable text is obscured");
    return {
      left: rect.left,
      right: rect.right,
      y: rect.top + rect.height / 2,
      text: range.toString(),
    };
  });
  await page.mouse.move(range.left, range.y);
  await page.mouse.down();
  await page.mouse.move(range.right, range.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(range.text);
}

async function expectActionInPanel(page: Page, name: string) {
  const panel = page.getByRole("complementary", { name: "小栈AI助手" });
  const action = panel.getByRole("button", { name, exact: true });
  const bounds = await panel.boundingBox();
  const box = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(box).not.toBeNull();
  if (!bounds || !box) throw new Error(`Missing panel/action bounds: ${name}`);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

// biome-ignore lint/correctness/noEmptyPattern: This test launches a hidden Electron application without browser fixtures.
test("hidden Electron polish UI: reading, navigation, cancellation and responsive actions", async ({}, info) => {
  test.setTimeout(600_000);
  const root = await mkdtemp(join(tmpdir(), "polish-ui-release-"));
  let release: (() => void) | undefined;
  let mode: "hold" | "ok" | "fail" = "hold";
  let requests = 0;
  const requestBodies: string[] = [];
  const paragraph =
    "本装置包括主体、连接件和通风通道。连接件设置于主体内，通风通道用于引导气流经过主体，从而带走热量。";
  const draft = Array.from({ length: 12 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBodies.push(Buffer.concat(chunks).toString("utf8"));
    requests++;
    if (mode === "hold")
      await new Promise<void>((done) => {
        release = done;
        response.once("close", done);
      });
    if (response.destroyed) return;
    response.setHeader("Content-Type", "application/json");
    if (mode === "fail") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "synthetic unavailable" } }));
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: JSON.stringify({
                kind: "revision",
                deliverableType: "other",
                message: "已统一术语并调整语序，保留原有技术内容。",
                revisedText: draft,
              }),
            },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(11434, "127.0.0.1", done);
  });
  const userData = join(root, "profile");
  await mkdir(userData);
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
        activeProfileId: "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c",
        profiles: [
          {
            profileId: "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c",
            providerId: "deepseek",
            displayName: "界面验收模型",
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
  const hiddenEntry = await prepareHiddenMain();
  const hiddenSource = await readFile(hiddenEntry, "utf8");
  if (!hiddenSource.includes("const postSse = createHttpsSseClient();"))
    throw new Error("Missing transport test seam");
  // Only this isolated test copy redirects transport; production policy remains unchanged.
  await writeFile(
    hiddenEntry,
    hiddenSource
      .replace(
        "const postSse = createHttpsSseClient();",
        'const postSse = createHttpsSseClient({ endpointOverride: new URL("http://127.0.0.1:11434/v1/chat/completions") });',
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
  const launchOptions = {
    args: [hiddenEntry, `--user-data-dir=${userData}`, "--disable-gpu"],
    env: {
      ...env,
      PATENT_WORKBENCH_TEST: "1",
      PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1",
      PATENT_WORKBENCH_LIBRARY_ROOT: join(root, "library"),
      LOCALAPPDATA: join(root, "local-app-data"),
    },
  };
  let app = await electron.launch(launchOptions);
  try {
    await expect.poll(() => app.windows().at(-1)?.url() ?? "").toContain("index.html");
    const initialPage = app.windows().find((p) => p.url().includes("index.html"));
    if (!initialPage) throw new Error("Main page not ready");
    let page: Page = initialPage;
    const keySaved = await page.evaluate(() =>
      window.patentApi.aiCorrection.setApiKey({
        profileId: "71d36d20-79ae-4fcf-aa37-e6e8a65ee80c",
        apiKey: "synthetic-ui-test-only",
      }),
    );
    expect(keySaved.ok).toBe(true);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("Hidden assistant renderer:", e.message);
    });
    // Capture a real turn identity, then simulate reasoning events for layout QA.
    await app.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes("index.html"));
      if (!contents) throw new Error("Missing hidden window");
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        const event = args[0];
        if (channel === "text-polish:conversation-event" && event?.type === "phase") {
          (
            globalThis as typeof globalThis & { polishPhase?: Record<string, unknown> }
          ).polishPhase = event;
        }
        send(channel, ...args);
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const consent = page.getByRole("dialog", { name: "软件使用协议与隐私政策确认", exact: true });
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: "开始使用", exact: true }).click();
    await expect(consent).toBeHidden();
    await page
      .getByRole("button", { name: "新建专利", exact: true })
      .click()
      .catch(async (error) => {
        console.error("Synthetic startup UI:", await page.locator("body").innerText());
        await page.screenshot({ path: info.outputPath("startup-blocker.png") });
        throw error;
      });
    const dialog = page.getByRole("dialog", { name: "新建专利" });
    await dialog.getByRole("textbox", { name: "专利名称" }).fill("小栈AI助手界面验收");
    await dialog.getByRole("radio", { name: "发明" }).check();
    await dialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑 说明书" });
    await editor.press("Control+A");
    await page.keyboard.type(paragraph.repeat(8));
    await editor.press("Control+A");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "小栈AI助手", exact: true }).click();
    let panel = page.getByRole("complementary", { name: "小栈AI助手" });
    await expect(panel.getByRole("button", { name: "预览选中文字" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: /从一个想法/ })).toBeVisible();
    const closeBounds = await panel.getByRole("button", { name: "关闭小栈AI助手" }).boundingBox();
    const settingsBounds = await panel
      .getByRole("button", { name: "小栈AI助手设置" })
      .boundingBox();
    const historyBounds = await panel.getByRole("button", { name: "历史对话" }).boundingBox();
    if (!closeBounds || !settingsBounds || !historyBounds)
      throw new Error("Missing header actions");
    expect(Math.abs(closeBounds.y - settingsBounds.y)).toBeLessThan(2);
    expect(settingsBounds.x).toBeLessThan(closeBounds.x);
    expect(Math.abs(historyBounds.y - closeBounds.y)).toBeLessThan(2);
    expect(historyBounds.x).toBeLessThan(settingsBounds.x);
    await panel.locator(".polish-launch-presets summary").click();
    await panel.getByRole("button", { name: "专业严谨", exact: true }).click();
    await panel.getByRole("button", { name: "专业严谨", exact: true }).click();
    const input = panel.getByRole("textbox", { name: "润色需求" });
    await expect(input).toHaveValue("专业严谨");
    await input.fill("字".repeat(2001));
    await expect(input).toHaveValue("专业严谨");
    await expect(panel.getByRole("alert")).toContainText("未写入");
    await input.fill("专业严谨，请精简");
    expect(await input.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    expect(await input.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    const presetBounds = await panel
      .getByRole("button", { name: "专业严谨", exact: true })
      .boundingBox();
    const inputBounds = await input.boundingBox();
    if (!presetBounds || !inputBounds) throw new Error("Missing composer bounds");
    expect(presetBounds.y + presetBounds.height).toBeLessThanOrEqual(inputBounds.y);
    await panel.screenshot({ path: info.outputPath("00-presets-focused.png") });
    await panel.locator(".polish-launch-presets summary").click();
    await expectActionInPanel(page, "开始润色");
    await panel.screenshot({ path: info.outputPath("01-selected.png") });
    await panel.getByRole("button", { name: "开始润色" }).click();
    await expect
      .poll(() => requests)
      .toBe(1)
      .catch(async (error) => {
        console.error("Synthetic request UI:", await panel.innerText());
        await panel.screenshot({ path: info.outputPath("request-blocker.png") });
        throw error;
      });
    await expectActionInPanel(page, "停止本轮");
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toBeEditable();
    await panel.getByRole("textbox", { name: "继续对话" }).fill("思考期间保留的下一轮草稿");
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
    await panel.screenshot({ path: info.outputPath("02-thinking.png") });
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
    await expectActionInPanel(page, "停止本轮");
    await panel.screenshot({ path: info.outputPath("03-thinking-small.png") });
    const thinkingText = `${paragraph}\n`.repeat(24);
    await app.evaluate(({ webContents }, delta) => {
      const phase = (globalThis as typeof globalThis & { polishPhase?: Record<string, unknown> })
        .polishPhase;
      const contents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes("index.html"));
      if (!phase || !contents) throw new Error("Missing live turn");
      contents.send("text-polish:conversation-event", { ...phase, phase: "thinking" });
      const { phase: _phase, ...identity } = phase;
      contents.send("text-polish:conversation-event", { ...identity, type: "reasoning", delta });
    }, thinkingText);
    const thinkingContent = panel.locator(".ai-thinking-feedback__content");
    await expect(thinkingContent).toHaveCount(0);
    await panel.getByRole("button", { name: "展开思考过程" }).click();
    await expect(thinkingContent).toContainText(paragraph);
    expect(await thinkingContent.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect((await thinkingContent.boundingBox())?.height).toBeLessThanOrEqual(280);
    await expectActionInPanel(page, "停止本轮");
    await panel.screenshot({ path: info.outputPath("03b-long-thinking-small.png") });
    mode = "ok";
    release?.();
    await expect(
      panel.getByText("已统一术语并调整语序，保留原有技术内容。", { exact: true }),
    ).toBeAttached();
    // Expanding/reading reasoning may intentionally suspend automatic following.
    const newReply = panel.getByRole("button", { name: "有新回复", exact: true });
    await expect(async () => {
      if (await newReply.isVisible()) await newReply.click();
      await expect(
        panel.getByText("已统一术语并调整语序，保留原有技术内容。", { exact: true }),
      ).toBeInViewport({ timeout: 200 });
    }).toPass({ timeout: 10000 });
    await expectActionInPanel(page, "发送");
    await expect(panel.locator(".is-assistant").first()).toHaveCSS("border-top-width", "0px");
    await expect(panel.locator(".is-assistant").first()).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toHaveText("");
    const completedThinking = panel.locator(".polish-completed-reasoning").first();
    await expect(completedThinking).toBeVisible();
    await expect(completedThinking).not.toHaveAttribute("open");
    await completedThinking.locator("summary").click();
    await expect(completedThinking.locator("pre")).toHaveText(thinkingText);
    await selectTextWithMouse(page, completedThinking.locator("pre"));
    await completedThinking.locator("summary").click();
    await panel.screenshot({ path: info.outputPath("04-result-small.png") });
    await selectTextWithMouse(page, panel.locator(".is-user > p").first());
    await selectTextWithMouse(
      page,
      panel.getByText("已统一术语并调整语序，保留原有技术内容。", { exact: true }),
    );
    await selectTextWithMouse(
      page,
      panel.getByRole("region", { name: "润色稿", exact: true }).locator("p").first(),
    );
    await panel.getByRole("button", { name: "查看完整润色稿" }).click();
    const reader = panel.getByRole("region", { name: "完整文本" });
    await expect(reader).toContainText(`1. ${paragraph}`);
    await panel.screenshot({ path: info.outputPath("05-full-draft.png") });
    await panel.getByRole("button", { name: "查看原文", exact: true }).click();
    await expect(reader).toContainText(paragraph.repeat(8));
    await selectTextWithMouse(page, reader.locator("p"));
    await panel.screenshot({ path: info.outputPath("06-original.png") });
    await panel.getByRole("button", { name: "返回对话", exact: true }).click();
    const log = panel.getByRole("log");
    await log.evaluate((el) => {
      el.scrollTop = 140;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const previousTop = await log.evaluate((el) => el.scrollTop);
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toBeVisible();
    await page.getByRole("tab", { name: "说明书附图", exact: true }).click();
    await expect(panel).toBeVisible();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeCloseTo(previousTop, 0);
    await expectActionInPanel(page, "发送");
    await panel.getByRole("textbox", { name: "继续对话" }).fill("请再精简");
    await panel.getByText("参考文字（可选）", { exact: true }).click();
    await panel.getByRole("textbox", { name: "本轮参考文字" }).fill("本轮主动添加的合成参考材料");
    await expectActionInPanel(page, "发送");
    await panel.screenshot({ path: info.outputPath("06b-reference-material.png") });
    await panel.locator(".polish-capacity summary").click();
    await expectActionInPanel(page, "发送");
    await panel.locator(".polish-capacity summary").click();
    mode = "fail";
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("AI 服务暂时不可用");
    expect(requestBodies.at(-1)).toContain("本轮主动添加的合成参考材料");
    await expectActionInPanel(page, "重试本轮");
    await panel.screenshot({ path: info.outputPath("07-error.png") });
    mode = "hold";
    await panel.getByRole("button", { name: "重试本轮" }).click();
    await expectActionInPanel(page, "停止本轮");
    await panel.getByRole("button", { name: "停止本轮" }).click();
    await expect(panel.getByRole("status")).toContainText("本轮已停止");
    await expectActionInPanel(page, "发送");
    await panel.screenshot({ path: info.outputPath("08-cancelled.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await editor.press("Control+Home");
    await editor.press("ArrowRight");
    await page.keyboard.type("修改");
    const editedText = await editor.textContent();
    await expect(panel.getByRole("button", { name: "替换原文" })).toHaveCount(0);
    await panel.getByRole("button", { name: "查看完整润色稿" }).first().click();
    await expect(panel.getByRole("button", { name: "复制润色稿" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "替换原文" })).toHaveCount(0);
    await panel.getByRole("button", { name: "返回对话" }).click();
    expect(await editor.textContent()).toBe(editedText);
    await expectActionInPanel(page, "发送");
    await panel.screenshot({ path: info.outputPath("09-source-edit-copy-only.png") });
    await panel.getByRole("button", { name: "展开小栈AI助手面板" }).click();
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(724);
    await expectActionInPanel(page, "关闭小栈AI助手");
    await panel.screenshot({ path: info.outputPath("09b-expanded.png") });
    await panel.getByRole("textbox", { name: "继续对话" }).fill("重启后保留的未发送草稿");
    await panel.locator(".polish-reference").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await panel.getByRole("textbox", { name: "本轮参考文字" }).fill("重启后保留的参考文字");
    await panel.getByRole("button", { name: "新对话" }).click();
    await expect(panel.getByRole("button", { name: /开始生成|开始润色/ })).toBeVisible();
    await expect(panel.getByRole("textbox", { name: /^(生成需求|润色需求)$/ })).toHaveValue("");
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    await panel.locator(".polish-history__item").first().click();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "重启后保留的未发送草稿",
    );
    // Independent tasks within this same patent: navigation never cancels either task.
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    const originalHistory = await panel
      .locator(".polish-history__item strong")
      .first()
      .textContent();
    if (!originalHistory) throw new Error("Missing original conversation");
    await panel.locator(".polish-history__item").first().click();
    await panel.getByRole("button", { name: "新对话" }).click();
    await editor.press("Control+Home");
    mode = "hold";
    const beforeParallel = requests;
    await panel.getByRole("textbox", { name: /^(生成需求|润色需求)$/ }).fill("独立任务 A");
    await panel.getByRole("button", { name: /开始生成|开始润色/ }).click();
    await expect.poll(() => requests).toBe(beforeParallel + 1);
    await expect(panel.getByRole("button", { name: "停止本轮" })).toBeVisible();
    await panel.getByRole("button", { name: "新对话" }).click();
    await panel.getByRole("textbox", { name: /^(生成需求|润色需求)$/ }).fill("独立任务 B");
    await panel.getByRole("button", { name: /开始生成|开始润色/ }).click();
    await expect.poll(() => requests).toBe(beforeParallel + 2);
    const releaseB = release;
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    await expect(panel.getByRole("button", { name: "删除独立任务 A" })).toBeDisabled();
    await panel.getByRole("button", { name: "停止独立任务 A" }).click();
    await expect(panel.getByRole("button", { name: "停止独立任务 A" })).toHaveCount(0);
    await panel.locator(".polish-history__item").filter({ hasText: "独立任务 A" }).click();
    await expect(panel.getByRole("log")).not.toContainText("独立任务 B");
    await expect(panel.getByRole("status")).toContainText("本轮已停止");
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    await panel.locator(".polish-history__item").filter({ hasText: "独立任务 B" }).click();
    await expect(panel.getByRole("button", { name: "停止本轮" })).toBeVisible();
    await expect(panel.getByRole("log")).not.toContainText("独立任务 A");
    releaseB?.();
    await expect(panel.getByRole("button", { name: "停止本轮" })).toHaveCount(0);
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toBeVisible();
    await panel.getByRole("textbox", { name: "继续对话" }).fill("B 专属草稿");
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    await panel.locator(".polish-history__item").filter({ hasText: originalHistory }).click();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "重启后保留的未发送草稿",
    );
    await panel.screenshot({ path: info.outputPath("09d-independent-conversations.png") });
    const beforeRestartRequests = requests;
    await app.close();
    app = await electron.launch(launchOptions);
    await expect.poll(() => app.windows().at(-1)?.url() ?? "").toContain("index.html");
    const restartedPage = app.windows().find((p) => p.url().includes("index.html"));
    if (!restartedPage) throw new Error("Restarted main page not ready");
    await restartedPage
      .getByRole("article", { name: "小栈AI助手界面验收", exact: true })
      .dblclick();
    await restartedPage.getByRole("button", { name: "工具", exact: true }).click();
    await restartedPage.getByRole("menuitem", { name: "小栈AI助手", exact: true }).click();
    const restoredPanel = restartedPage.getByRole("complementary", { name: "小栈AI助手" });
    await expect(restoredPanel.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "重启后保留的未发送草稿",
    );
    await restoredPanel.locator(".polish-reference summary").click();
    await expect(restoredPanel.getByRole("textbox", { name: "本轮参考文字" })).toHaveValue(
      "重启后保留的参考文字",
    );
    await expect(
      restoredPanel.getByText("已统一术语并调整语序，保留原有技术内容。", { exact: true }),
    ).toHaveCount(1);
    expect(requests).toBe(beforeRestartRequests);
    await restoredPanel.getByRole("button", { name: "历史对话", exact: true }).click();
    await expect(restoredPanel.locator(".polish-history__item")).toHaveCount(3);
    await restoredPanel.locator(".polish-history__item").filter({ hasText: "独立任务 B" }).click();
    await expect(restoredPanel.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "B 专属草稿",
    );
    await restoredPanel.getByRole("button", { name: "历史对话", exact: true }).click();
    await restoredPanel
      .locator(".polish-history__item")
      .filter({ hasText: originalHistory })
      .click();
    await restoredPanel.screenshot({ path: info.outputPath("09c-restored-after-restart.png") });
    page = restartedPage;
    panel = restoredPanel;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "关闭小栈AI助手界面验收", exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByRole("article", { name: "小栈AI助手界面验收", exact: true }).dblclick();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toHaveValue(
      "重启后保留的未发送草稿",
    );
    // The remaining settings checks use the fresh renderer after a real process restart.
    await panel.getByRole("button", { name: "历史对话", exact: true }).click();
    await panel.getByRole("button", { name: "重命名独立任务 B" }).click();
    const rename = page.getByRole("dialog", { name: "修改名称" });
    await rename.getByRole("textbox").fill("已命名的技术讨论");
    await rename.getByRole("button", { name: "确定", exact: true }).click();
    await panel.getByRole("searchbox").fill("已命名的技术讨论");
    await expect(panel.locator(".polish-history__item")).toHaveCount(1);
    await panel.getByRole("button", { name: "删除已命名的技术讨论" }).click();
    await page
      .getByRole("dialog", { name: "请确认" })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(panel.locator(".polish-history__item")).toHaveCount(1);
    await panel.getByRole("button", { name: "删除已命名的技术讨论" }).click();
    await page
      .getByRole("dialog", { name: "请确认" })
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await expect(panel.getByText("没有匹配的对话")).toBeVisible();
    await panel.getByRole("searchbox").fill("");
    await expect(panel.locator(".polish-history__item")).toHaveCount(2);
    await panel.locator(".polish-history__item").filter({ hasText: originalHistory }).click();
    await panel.getByText("对话容量与参考材料", { exact: true }).click();
    await panel.getByRole("button", { name: "携带约定开启新对话" }).click();
    const continuation = page.getByRole("dialog", { name: "衔接到新对话" });
    await continuation
      .getByRole("textbox", { name: "衔接约定" })
      .fill("保留主体和连接件术语，只讨论散热结构。");
    await continuation.getByRole("button", { name: "确认并新建" }).click();
    await expect(panel.getByRole("textbox", { name: "继续对话" })).toHaveValue("");
    expect(requests).toBe(beforeRestartRequests);
    await panel.screenshot({ path: info.outputPath("11-continued-conversation.png") });
    const cleared = await restartedPage.evaluate(async () => {
      const api = (window as unknown as { patentApi: PatentApi }).patentApi;
      const state = await api.aiCorrection.getSettings();
      if (!state.ok) throw new Error(state.error.message);
      return api.aiCorrection.updateSettings({
        ...state.value.settings,
        enabled: false,
        profiles: [],
        activeProfileId: null,
      });
    });
    expect(cleared.ok).toBe(true);
    await restartedPage.reload();
    await page.getByRole("button", { name: "新建专利", exact: true }).click();
    const nextDialog = page.getByRole("dialog", { name: "新建专利" });
    await nextDialog.getByRole("textbox", { name: "专利名称" }).fill("未配置模型界面验收");
    await nextDialog.getByRole("radio", { name: "发明" }).check();
    await nextDialog.getByRole("button", { name: "创建专利" }).click();
    await page.getByRole("tab", { name: "说明书", exact: true }).click();
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "小栈AI助手", exact: true }).click();
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(panel.getByText("尚未配置模型")).toBeInViewport();
    await expect(panel.getByRole("button", { name: "开始生成" })).toBeDisabled();
    await expectActionInPanel(page, "开始生成");
    await panel.screenshot({ path: info.outputPath("10-no-model.png") });
    await panel.getByRole("button", { name: "配置模型" }).click();
    await expect(page.getByRole("button", { name: "添加模型", exact: true })).toBeVisible();
    // Same pre-existing library/editor navigation warning recorded by the consistency suite.
    if (errors.includes("Transition was skipped"))
      info.annotations.push({
        type: "known-background",
        description:
          "快速切页的既有 View Transition 警告：Transition was skipped；助手业务流程已独立断言。",
      });
    expect(errors.filter((error) => error !== "Transition was skipped")).toEqual([]);
    expect(
      await app.evaluate(
        ({ BaseWindow }) =>
          BaseWindow.getAllWindows().length > 0 &&
          BaseWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
      ),
    ).toBe(true);
  } catch (error) {
    const failedPage = app.windows().find((page) => page.url().includes("index.html"));
    if (failedPage) {
      console.error("Synthetic failure UI:", await failedPage.locator("body").innerText());
      await failedPage.screenshot({ path: info.outputPath("failure.png") });
    }
    throw error;
  } finally {
    release?.();
    // This process owns only synthetic data. Try normal close before bounded teardown.
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!closed) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
