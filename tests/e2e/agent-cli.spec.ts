import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron, expect, test } from "@playwright/test";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import { readPatdoc } from "../../src/main/documents/patdoc-reader.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { collectPatentStructureIssues } from "../../src/shared/patent/document-structure-ruler.js";
import { createDefaultPrintSettings } from "../../src/shared/printing/model.js";
import { acceptAgentCliPolicy, waitForMainWindow } from "./helpers/workbench.js";

const executeFile = promisify(execFile);
test("hidden Electron + real standalone CLI: one authorization, multi-book commit and export", async () => {
  // The full suite invokes the standalone runtime and verifies Windows ACLs per command.
  test.setTimeout(process.platform === "win32" ? 240000 : 120000);
  const root = await mkdtemp(join(tmpdir(), "zxw-e2e-"));
  const home = join(root, "home");
  const outputRoot = process.env.PATENT_WORKBENCH_E2E_OUTPUT ?? "out";
  const entry = await createRequire(import.meta.url)("./fixtures/background-electron.cjs")(
    join(outputRoot, "main/index.js"),
  );
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PATENT_WORKBENCH_TEST: "1",
    PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1",
    PATENT_WORKBENCH_LIBRARY_ROOT: join(root, "library"),
    LOCALAPPDATA: join(root, "local-app-data"),
    ZXW_HOME: home,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.PATENT_WORKBENCH_DEVTOOLS;
  const source = await readFile(entry, "utf8");
  await writeFile(
    entry,
    source
      .replace(
        "const __filename =",
        "dialog.showErrorBox = (title, message) => { console.error(title, message); };\nconst __filename =",
      )
      .replace(
        "return reportStartupFailure(",
        "console.error(error); return reportStartupFailure(",
      ),
  );
  // An interrupted preferences write must not make the CLI settings unrecoverable.
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "preferences.json"), '{"enabled":');
  const application = await _electron.launch({
    args: [entry, `--user-data-dir=${join(root, "user-data")}`, "--disable-gpu"],
    env,
    timeout: 20000,
  });
  // Exercise the native IPC copy bridge without altering the user's system clipboard.
  await application.evaluate(({ clipboard }) => {
    let copiedText = "";
    clipboard.writeText = (text) => {
      copiedText = text;
    };
    clipboard.readText = () => copiedText;
  });
  let lastExitCode = 0;
  const cli = async (...args: string[]) => {
    const commandArgs = [resolve(outputRoot, "cli/index.cjs"), ...args, "--home", home, "--json"];
    // Use the bundled console runtime, without relying on the caller's Node installation.
    const runtime = resolve(
      outputRoot,
      process.platform === "win32" ? "cli/runtime/node.exe" : "cli/runtime/node",
    );
    let stdout: string;
    lastExitCode = 0;
    try {
      stdout = (await executeFile(runtime, commandArgs, { env, timeout: 20000, windowsHide: true }))
        .stdout;
    } catch (error) {
      lastExitCode = Number((error as { code?: number }).code ?? 1);
      stdout = (error as { stdout: string }).stdout;
      if (!stdout) {
        const page = application.windows()[0];
        throw new Error(
          `CLI ${args.slice(0, 2).join(" ")} did not return: ${String(error)}; UI: ${await page?.locator("body").innerText()}`,
        );
      }
    }
    return JSON.parse(stdout);
  };
  try {
    const page = await Promise.race([
      waitForMainWindow(application),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Main page unavailable")), 15000),
      ),
    ]);
    const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "Agent CLI（实验功能）", exact: true }).click();
    await page.getByRole("checkbox", { name: "启用 Agent CLI", exact: true }).click();
    await acceptAgentCliPolicy(page);
    await expect(page.getByRole("checkbox", { name: "启用 Agent CLI", exact: true })).toBeChecked();
    await expect(settings.getByRole("heading", { name: "如何使用", exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "复制 Agent 接入指令", exact: true }).click();
    await expect(settings.getByRole("status")).toHaveText(
      "接入指令已复制，连同任务要求一次发给 Agent 即可。",
    );
    const copiedInstructions = await application.evaluate(({ clipboard }) => clipboard.readText());
    const runCopiedCommand = async (fragment: string, extra = "") => {
      const command = copiedInstructions.split("\n").find((line) => line.includes(` ${fragment}`));
      expect(command).toBeDefined();
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command"] : ["-c"];
      let stdout: string;
      try {
        stdout = (
          await executeFile(shell, [...shellArgs, `${command}${extra}`], {
            env,
            timeout: 20000,
            windowsHide: true,
          })
        ).stdout;
      } catch (error) {
        stdout = (error as { stdout: string }).stdout;
        if (!stdout) throw error;
      }
      return JSON.parse(stdout);
    };
    expect(copiedInstructions).toContain("manual --json");
    expect(copiedInstructions).toContain(home);
    expect(copiedInstructions).toContain("pair poll --instance");
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    const listed = await cli("instance", "list");
    expect(listed.ok).toBe(true);
    expect(listed.value.instances[0].version).toBe((await cli("version")).value.version);
    const instanceId = listed.value.instances[0].instanceId;
    expect(copiedInstructions).toContain(`connect --instance ${instanceId}`);
    expect(copiedInstructions).toContain(
      resolve(outputRoot, process.platform === "win32" ? "cli/zxw.cmd" : "cli/zxw"),
    );
    expect((await runCopiedCommand("manual --json")).value.markdown).toContain(
      "知产小栈Work Agent CLI 手册",
    );
    const requestPath = join(root, "authorization-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({ requested: { task: "新建专利并验证基础编辑", createLimit: 1 } }),
    );
    const pending = await runCopiedCommand(
      "connect --instance",
      ` --label 'E2E agent' --input '${requestPath}'`,
    );
    expect(pending.value.status).toBe("pending");
    expect((await runCopiedCommand("pair poll --instance")).value.pairId).toBe(
      pending.value.pairId,
    );
    const authorization = page.getByRole("alertdialog", { name: /请求操作授权$/ });
    await expect(authorization).toBeVisible();
    expect(await authorization.evaluate((node) => node.closest("dialog")?.matches(":modal"))).toBe(
      true,
    );
    await expect
      .poll(async () => {
        const bounds = await authorization.boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (!bounds) return Infinity;
        return Math.max(
          Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2),
          Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2),
        );
      })
      .toBeLessThan(2);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+s");
    await page.mouse.click(5, 5);
    await expect(authorization).toBeVisible();
    await expect(settings).not.toBeVisible();
    // Native modal blocks focus and real clicks on the underlying application.
    const settingsButton = page.getByRole("button", { name: "设置", exact: true });
    const buttonBounds = await settingsButton.boundingBox();
    await page.mouse.click(buttonBounds!.x + 3, buttonBounds!.y + 3);
    await settingsButton.evaluate((node) => (node as HTMLElement).focus());
    expect(
      await authorization.evaluate((node) =>
        node.closest("dialog")?.contains(document.activeElement),
      ),
    ).toBe(true);
    await expect(settings).not.toBeVisible();
    await expect(authorization.getByText("新建专利（控制）权限", { exact: true })).toBeVisible();
    await expect(authorization.getByRole("switch")).toHaveCount(0);
    await authorization.locator("summary").filter({ hasText: "全局设置授权" }).click();
    await authorization
      .getByRole("combobox", { name: "全局权限 AI 模型配置", exact: true })
      .selectOption("full");
    await authorization
      .getByRole("combobox", { name: "全局权限 整库管理与备份恢复", exact: true })
      .selectOption("full");
    await authorization
      .getByRole("combobox", { name: "全局权限 独立文档管理", exact: true })
      .selectOption("full");
    await authorization
      .getByRole("combobox", {
        name: "全局权限 完整数据迁移（全部专利、文档、对话与设置）",
        exact: true,
      })
      .selectOption("full");
    await authorization.getByRole("button", { name: "用户授权须知", exact: true }).click();
    const notice = page.getByRole("dialog", { name: "Agent 用户授权须知", exact: true });
    await notice.getByRole("checkbox", { name: "我已阅读并同意以上授权须知", exact: true }).check();
    await notice.getByRole("button", { name: "同意并返回", exact: true }).click();
    await page.getByRole("button", { name: "授权", exact: true }).click();
    const connected = await cli("connect", "--instance", instanceId);
    expect(connected.value.status).toBe("authorized");
    await expect(authorization).not.toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "Agent CLI（实验功能）", exact: true }).click();
    await settings.getByRole("button", { name: "调整 E2E agent 授权", exact: true }).click();
    const grantEditor = settings.locator(".agent-grant-editor");
    const scopeEditor = grantEditor.locator(".agent-scope-editor");
    await expect(scopeEditor).toBeVisible();
    await expect
      .poll(async () => {
        const editorBounds = await grantEditor.boundingBox();
        const scopeBounds = await scopeEditor.boundingBox();
        return scopeBounds && editorBounds ? scopeBounds.width / editorBounds.width : 0;
      })
      .toBeGreaterThan(0.8);
    await settings.getByRole("button", { name: "取消调整", exact: true }).click();
    await expect(grantEditor).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    expect(connected.value.scope.global).toEqual({
      models: "full",
      library: "full",
      documents: "full",
      transfer: "full",
    });
    expect((await cli("global", "settings", "read")).error.code).toBe("SCOPE_DENIED");
    const modelSettings = await cli("global", "models", "read");
    expect(modelSettings.ok).toBe(true);
    const modelInput = join(root, "models.json");
    await writeFile(
      modelInput,
      JSON.stringify({
        expectedHash: modelSettings.value.hash,
        patch: { aiConnectionsEnabled: false },
      }),
    );
    expect(
      (
        await cli(
          "global",
          "models",
          "update",
          "--input",
          modelInput,
          "--request-id",
          "e2e-model-settings",
        )
      ).value.status,
    ).toBe("committed");
    expect((await cli("global", "models", "read")).value.settings.aiConnectionsEnabled).toBe(false);
    const modelProbeInput = join(root, "model-probe.json");
    await writeFile(
      modelProbeInput,
      JSON.stringify({ profileId: "00000000-0000-4000-8000-000000000123" }),
    );
    const probe = await cli("global", "models", "test-connection", "--input", modelProbeInput);
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", probe.value.operationId)).value.status,
      )
      .toBe("failed");
    expect(
      (await cli("operation", "status", "--id", probe.value.operationId)).value.result.error.code,
    ).toBe("AI_DISABLED");

    const outputDirectory = connected.value.scope.workspace.exportDirectory;
    const libraryConfig = await cli("global", "library", "read");
    const libraryConfigInput = join(root, "library-config.json");
    await writeFile(
      libraryConfigInput,
      JSON.stringify({
        expectedHash: libraryConfig.value.hash,
        settings: { enabled: true, intervalMinutes: 10 },
      }),
    );
    const configuredSnapshot = await cli(
      "global",
      "library",
      "snapshot",
      "configure",
      "--input",
      libraryConfigInput,
    );
    expect(configuredSnapshot.value.status, JSON.stringify(configuredSnapshot)).toBe("committed");
    await writeFile(
      libraryConfigInput,
      JSON.stringify({
        expectedHash: configuredSnapshot.value.result.hash,
        settings: { enabled: false, folder: null, intervalMinutes: 10 },
      }),
    );
    const configuredBackup = await cli(
      "global",
      "library",
      "backup",
      "configure",
      "--input",
      libraryConfigInput,
    );
    expect(configuredBackup.value.status, JSON.stringify(configuredBackup)).toBe("committed");
    expect((await cli("global", "library", "read")).value.settings.backup.intervalMinutes).toBe(10);
    const created = await cli(
      "patent",
      "create",
      "--patent-type",
      "invention",
      "--name",
      "CLI 隔离测试装置",
      "--request-id",
      "e2e-create",
    );
    expect(created.value.status).toBe("committed");
    const { patentId, revision } = created.value.result;
    // A CLI create must become visible without patent.show or manual refresh.
    await expect(page.getByRole("textbox", { name: "编辑 说明书", exact: true })).toBeVisible();
    await expect(page.getByText("CLI 隔离测试装置", { exact: true }).first()).toBeVisible();
    const printers = await cli("patent", "printers", "--patent-id", patentId);
    expect(printers.ok, JSON.stringify(printers)).toBe(true);
    const unavailablePrinter = `zxw-unavailable-${patentId}`;
    expect(
      printers.value.printers.some(
        (printer: { deviceName: string }) => printer.deviceName === unavailablePrinter,
      ),
    ).toBe(false);
    const printingInput = join(root, "printing.json");
    const printingDefaults = createDefaultPrintSettings();
    await writeFile(
      printingInput,
      JSON.stringify({
        patentId,
        expectedRevision: revision,
        layout: printingDefaults.layout,
        output: { ...printingDefaults.output, printerDeviceName: unavailablePrinter },
      }),
    );
    const printing = await cli("patent", "print", "--input", printingInput);
    let printingStatus: any;
    await expect
      .poll(async () => {
        printingStatus = await cli("operation", "status", "--id", printing.value.operationId);
        return printingStatus.value.status;
      })
      .toBe("failed");
    expect(printingStatus.value.result.error.code).toBe("PRINTER_UNAVAILABLE");
    const formulaInput = join(root, "formula.json");
    await writeFile(
      formulaInput,
      JSON.stringify({ patentId, latex: "x^2+y^2=z^2", outputWidthMm: 100 }),
    );
    const formula = await cli(
      "asset",
      "render-formula",
      "--input",
      formulaInput,
      "--request-id",
      "e2e-formula",
    );
    expect(formula.value.status).toBe("committed");
    expect(formula.value.result.descriptor.kind).toBe("image");
    expect(formula.value.result.descriptor.widthPx).toBeCloseTo((100 * 300) / 25.4, -1);
    const previewInput = join(root, "preview.json");
    await writeFile(
      previewInput,
      JSON.stringify({ assetHandle: formula.value.result.assetHandle }),
    );
    const preview = await cli("asset", "preview", "--input", previewInput);
    expect(Buffer.from(preview.value.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const flagPreview = await cli(
      "asset",
      "preview",
      "--asset-handle",
      formula.value.result.assetHandle,
    );
    expect(flagPreview.value.data).toBe(preview.value.data);
    const invalidPreview = await cli(
      "asset",
      "preview",
      "--asset-handle",
      formula.value.result.assetHandle,
      "--patent-id",
      patentId,
    );
    expect(invalidPreview.error.code).toBe("INVALID_INPUT");
    expect(lastExitCode).toBe(2);
    expect((await cli("asset", "discard", "--input", previewInput)).value.discarded).toBe(true);
    const drawingPath = join(connected.value.scope.workspace.importDirectory, "drawing.png");
    await copyFile(resolve("tests/fixtures/images/sample.png"), drawingPath);
    const drawingInput = join(root, "drawing.json");
    await writeFile(drawingInput, JSON.stringify({ patentId, path: drawingPath }));
    const drawing = await cli(
      "drawing",
      "import",
      "--input",
      drawingInput,
      "--request-id",
      "e2e-drawing",
    );
    expect(drawing.value.status).toBe("committed");
    expect(drawing.value.result.project.sourceKind).toBe("image");
    for (const assetHandle of new Set(
      drawing.value.result.assets.map((asset: { assetHandle: string }) => asset.assetHandle),
    )) {
      await writeFile(previewInput, JSON.stringify({ assetHandle }));
      expect((await cli("asset", "discard", "--input", previewInput)).value.discarded).toBe(true);
    }
    const aiInput = join(root, "ai-correction.json");
    await writeFile(
      aiInput,
      JSON.stringify({
        patentId,
        expectedRevision: revision,
        scope: { kind: "current-book", bookKind: "description" },
      }),
    );
    const aiTask = await cli(
      "ai",
      "correct",
      "--input",
      aiInput,
      "--request-id",
      "e2e-disabled-ai",
    );
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", aiTask.value.operationId)).value.status,
      )
      .toBe("failed");
    expect(
      (await cli("operation", "status", "--id", aiTask.value.operationId)).value.result.error.code,
    ).toBe("AI_DISABLED");
    const conversationHistory = await cli("ai", "conversation", "read", "--patent-id", patentId);
    expect(conversationHistory.value.items).toEqual([]);
    await writeFile(
      aiInput,
      JSON.stringify({
        patentId,
        expectedRevision: revision,
        action: "draft",
        conversationId: null,
        expectedDraftHash: conversationHistory.value.draftHash,
        draft: { text: "待继续的专利说明", presets: [] },
      }),
    );
    const conversationDraft = await cli("ai", "conversation", "run", "--input", aiInput);
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", conversationDraft.value.operationId)).value
            .status,
      )
      .toBe("committed");
    expect(
      (await cli("ai", "conversation", "read", "--patent-id", patentId)).value.draft.text,
    ).toBe("待继续的专利说明");
    await writeFile(
      aiInput,
      JSON.stringify({
        patentId,
        expectedRevision: revision,
        action: "start",
        scope: { kind: "generation", bookKind: "description" },
        instruction: "生成内容",
      }),
    );
    const conversationStart = await cli("ai", "conversation", "run", "--input", aiInput);
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", conversationStart.value.operationId)).value
            .status,
      )
      .toBe("failed");
    expect(
      (await cli("operation", "status", "--id", conversationStart.value.operationId)).value.result
        .error.code,
    ).toBe("AI_DISABLED");
    const refreshPair = await cli(
      "connect",
      "--instance",
      instanceId,
      "--profile",
      "scope-refresh",
      "--label",
      "Scope refresh test",
    );
    expect(refreshPair.value.status).toBe("pending");
    await expect(
      authorization.getByRole("button", { name: "从专利库选择", exact: true }),
    ).toBeVisible();
    await authorization.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(authorization).not.toBeVisible();
    const input = join(root, "change.json");
    await writeFile(
      input,
      JSON.stringify({
        patentId,
        expectedRevision: revision,
        operations: [
          {
            type: "insertParagraph",
            bookKind: "abstract",
            afterBlockId: null,
            text: "CLI E2E 摘要内容",
          },
          {
            type: "insertParagraph",
            bookKind: "claims",
            afterBlockId: null,
            text: "1. 一种自动化测试装置，包括控制器。",
          },
        ],
      }),
    );
    const prepared = await cli("change", "prepare", "--input", input);
    expect(prepared.ok).toBe(true);
    expect(prepared.value.risk.requireApproval).toBe(false);
    const stalePrepared = await cli("change", "prepare", "--input", input);
    expect(stalePrepared.ok).toBe(true);
    await expect(page.getByRole("button", { name: "批准此修改", exact: true })).toHaveCount(0);
    // Exercise real renderer participants by showing the document before applying.
    expect((await cli("patent", "show", "--patent-id", patentId)).ok).toBe(true);
    await page.getByRole("tab", { name: "权利要求书", exact: true }).click();
    const applied = await cli(
      "change",
      "apply",
      "--patent-id",
      patentId,
      "--change-id",
      prepared.value.changeId,
      "--request-id",
      "e2e-apply",
    );
    expect(applied.value.status).toBe("committed");
    expect(applied.value.result.uiSync).toBe("confirmed");
    const conflicting = await cli(
      "change",
      "apply",
      "--patent-id",
      patentId,
      "--change-id",
      stalePrepared.value.changeId,
      "--request-id",
      "e2e-stale-revision",
    );
    expect(conflicting.value.result.error.code).toBe("REVISION_CONFLICT");
    expect(lastExitCode).toBe(5);
    await expect(page.getByRole("textbox", { name: "编辑 权利要求书", exact: true })).toContainText(
      "一种自动化测试装置",
    );
    let read = await cli("patent", "read", "--patent-id", patentId);
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.value.patent.books)).toContain("#FF0000");
    expect(read.value.patent.books.every((book: object) => !("editorState" in book))).toBe(true);
    const scoped = await cli("patent", "read", "--patent-id", patentId, "--book-kind", "abstract");
    expect(scoped.value.patent.books.map((book: { kind: string }) => book.kind)).toEqual([
      "abstract",
    ]);
    expect(scoped.value.patent.auxiliaryDocuments).toEqual([]);
    expect(JSON.stringify(scoped.value)).not.toContain("1. 一种自动化测试装置，包括控制器。");
    const template = await cli("template", "describe", "--patent-type", "invention");
    expect(
      template.value.slots.find((slot: { slot: string }) => slot.slot === "claims").fields,
    ).toContain("patentName");
    expect(template.value).not.toHaveProperty("templates");
    expect((await cli("patent", "inspect", "--patent-id", patentId)).ok).toBe(true);
    // Destructive edits and restoration both use the original grant, without another GUI action.
    const abstract = read.value.patent.books.find(
      (book: { kind: string }) => book.kind === "abstract",
    );
    await writeFile(
      input,
      JSON.stringify({
        patentId,
        expectedRevision: read.value.patent.revision,
        operations: [
          { type: "deleteBlock", bookKind: "abstract", blockId: abstract.document.content[0].id },
        ],
      }),
    );
    const removal = await cli("change", "prepare", "--input", input);
    expect(removal.value.risk.requireApproval).toBe(false);
    const removed = await cli(
      "change",
      "apply",
      "--patent-id",
      patentId,
      "--change-id",
      removal.value.changeId,
      "--request-id",
      "remove-body",
    );
    expect(removed.value.status).toBe("committed");
    const restored = await cli(
      "change",
      "restore-prepare",
      "--patent-id",
      patentId,
      "--expected-revision",
      String(removed.value.result.revision),
      "--revision",
      String(read.value.patent.revision),
    );
    expect(
      (
        await cli(
          "change",
          "apply",
          "--patent-id",
          patentId,
          "--change-id",
          restored.value.changeId,
          "--request-id",
          "restore-body",
        )
      ).value.status,
    ).toBe("committed");
    read = await cli("patent", "read", "--patent-id", patentId);
    expect(JSON.stringify(read.value.patent.books)).toContain("CLI E2E 摘要内容");
    expect((await cli("connect", "--instance", instanceId)).value.grantId).toBe(
      connected.value.grantId,
    );
    await expect(authorization).not.toBeVisible();
    for (const format of ["docx", "pdf", "patdoc"]) {
      const output = join(outputDirectory, `中文 导出.${format}`);
      const exportInput = join(root, `export-${format}.json`);
      const payload = {
        patentId,
        expectedRevision: read.value.patent.revision,
        format,
        output,
        acceptWarnings: [] as string[],
      };
      await writeFile(exportInput, JSON.stringify(payload));
      let received = await cli(
        "patent",
        "export",
        "--input",
        exportInput,
        "--request-id",
        `e2e-${format}`,
      );
      let status: any;
      await expect
        .poll(async () => {
          status = await cli("operation", "status", "--id", received.value.operationId);
          return status.value.status;
        })
        .not.toMatch(/^(accepted|running)$/u);
      if (
        status.value.status === "failed" &&
        status.value.result.error.code === "EXPORT_WARNINGS"
      ) {
        payload.acceptWarnings = status.value.result.error.details.issues.map(
          (issue: { code: string }) => issue.code,
        );
        await writeFile(exportInput, JSON.stringify(payload));
        received = await cli(
          "patent",
          "export",
          "--input",
          exportInput,
          "--request-id",
          `e2e-${format}-approved`,
        );
        await expect
          .poll(async () => {
            status = await cli("operation", "status", "--id", received.value.operationId);
            return status.value.status;
          })
          .not.toMatch(/^(accepted|running)$/u);
      }
      expect(status.value.status, JSON.stringify(status)).toBe("committed");
      const bytes = await readFile(output);
      expect(bytes.length).toBeGreaterThan(100);
      if (format === "pdf") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      if (format === "patdoc")
        expect((await readPatdoc<PatentPatdocPayload>(output)).patent.revision).toBe(
          read.value.patent.revision,
        );
    }
    const wordPath = join(connected.value.scope.workspace.importDirectory, "重新导入.docx");
    await copyFile(join(outputDirectory, "中文 导出.docx"), wordPath);
    const wordInput = join(root, "docx-import.json");
    await writeFile(wordInput, JSON.stringify({ paths: [wordPath] }));
    const wordPreview = await cli("docx", "prepare", "--input", wordInput);
    expect(wordPreview.ok, JSON.stringify(wordPreview)).toBe(true);
    await writeFile(
      wordInput,
      JSON.stringify({
        sessionId: wordPreview.value.sessionId,
        patentType: "invention",
        name: "CLI DOCX 导入",
        customer: null,
        assignments: wordPreview.value.units.map((unit: any) => ({
          unitId: unit.unitId,
          title: unit.title,
          target: unit.target,
        })),
        acknowledgedWarningIds: wordPreview.value.warnings.map((warning: any) => warning.warningId),
      }),
    );
    const wordImported = await cli(
      "docx",
      "commit",
      "--input",
      wordInput,
      "--request-id",
      "e2e-docx-import",
    );
    expect(wordImported.value.status, JSON.stringify(wordImported)).toBe("committed");
    const wordRead = await cli("patent", "read", "--patent-id", wordImported.value.result.patentId);
    expect(JSON.stringify(wordRead.value.patent.books)).toContain("CLI E2E 摘要内容");
    await expect(authorization).not.toBeVisible();
    const nativePath = join(connected.value.scope.workspace.importDirectory, "重新导入.patdoc");
    await copyFile(join(outputDirectory, "中文 导出.patdoc"), nativePath);
    const nativeInput = join(root, "native-import.json");
    await writeFile(nativeInput, JSON.stringify({ path: nativePath, format: "patdoc" }));
    const imported = await cli(
      "patent",
      "import",
      "--input",
      nativeInput,
      "--request-id",
      "e2e-native-import",
    );
    let importStatus: any;
    await expect
      .poll(async () => {
        importStatus = await cli("operation", "status", "--id", imported.value.operationId);
        return importStatus.value.status;
      })
      .not.toMatch(/^(accepted|running)$/u);
    expect(importStatus.value.status, JSON.stringify(importStatus)).toBe("committed");
    const importedId = importStatus.value.result.patents[0].patentId;
    expect(importedId).not.toBe(patentId);
    expect((await cli("patent", "read", "--patent-id", importedId)).value.patent.name).toBe(
      read.value.patent.name,
    );
    const snapshotInput = join(root, "snapshot.json");
    const importedRevision = importStatus.value.result.patents[0].revision;
    await writeFile(
      snapshotInput,
      JSON.stringify({ patentId: importedId, expectedRevision: importedRevision }),
    );
    expect((await cli("history", "create", "--input", snapshotInput)).value.status).toBe(
      "committed",
    );
    await writeFile(
      snapshotInput,
      JSON.stringify({ patentId: importedId, expectedRevision: importedRevision, revision: 0 }),
    );
    const protectedSnapshot = await cli("history", "delete", "--input", snapshotInput);
    expect(protectedSnapshot.value, JSON.stringify(protectedSnapshot)).toMatchObject({
      status: "failed",
      result: { error: { code: "SNAPSHOT_RECOVERY_PROTECTED" } },
    });
    await expect(authorization).not.toBeVisible();
    const bundleInput = join(root, "bundle.json");
    const bundlePatent = await cli("patent", "read", "--patent-id", patentId);
    for (const format of ["patdoc", "docx", "pdf"]) {
      const bundleOutput = join(outputDirectory, `patents-${format}.zip`);
      await writeFile(
        bundleInput,
        JSON.stringify({
          patents: [{ patentId, expectedRevision: bundlePatent.value.patent.revision }],
          format,
          output: bundleOutput,
          acceptWarnings: collectPatentStructureIssues(bundlePatent.value.patent).map(
            (issue) => issue.kind,
          ),
        }),
      );
      const bundle = await cli("patent", "export-bundle", "--input", bundleInput);
      await expect
        .poll(
          async () =>
            (await cli("operation", "status", "--id", bundle.value.operationId)).value.status,
        )
        .toBe("committed");
      expect((await readFile(bundleOutput)).subarray(0, 2).toString()).toBe("PK");
    }
    const closedPatent = await cli(
      "patent",
      "close",
      "--patent-id",
      patentId,
      "--request-id",
      "e2e-patent-close",
    );
    expect(closedPatent.value.status, JSON.stringify(closedPatent)).toBe("committed");
    expect(closedPatent.value.result.closed).toBe(true);
    expect((await cli("patent", "show", "--patent-id", patentId)).ok).toBe(true);
    await expect(page.getByRole("tab", { name: "权利要求书", exact: true })).toBeVisible();
    const beforeTrash = await cli("patent", "read", "--patent-id", patentId);
    const lifecycleInput = join(root, "lifecycle.json");
    await writeFile(
      lifecycleInput,
      JSON.stringify({ patentId, expectedRevision: beforeTrash.value.patent.revision }),
    );
    const trashed = await cli(
      "patent",
      "trash",
      "--input",
      lifecycleInput,
      "--request-id",
      "e2e-trash",
    );
    expect(trashed.value.status, JSON.stringify(trashed)).toBe("committed");
    // Other newly imported patents now remain visible; only the trashed patent must close.
    await expect(page.locator(`[data-patent-tab-id="${patentId}"]`)).not.toBeVisible();
    await writeFile(
      lifecycleInput,
      JSON.stringify({ patentId, expectedDeletedAt: trashed.value.result.deletedAt }),
    );
    expect((await cli("patent", "delete", "--input", lifecycleInput)).error.code).toBe(
      "SCOPE_DENIED",
    );
    expect((await cli("patent", "restore", "--input", lifecycleInput)).error.code).toBe(
      "SCOPE_DENIED",
    );
    expect((await cli("patent", "read", "--patent-id", patentId)).error.code).toBe("SCOPE_DENIED");
    await writeFile(lifecycleInput, JSON.stringify({ scope: "trash" }));
    expect((await cli("patent", "list", "--input", lifecycleInput)).value.items).toHaveLength(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "Agent CLI（实验功能）", exact: true }).click();
    await settings.getByRole("button", { name: "调整 E2E agent 授权", exact: true }).click();
    const activeChoices = await page.evaluate(async () => {
      const result = await (window as unknown as { patentApi: PatentApi }).patentApi.patents.list(
        "active",
      );
      if (!result.ok) throw new Error("Active patent choices unavailable");
      return result.value;
    });
    expect(activeChoices.some((item) => item.patentId === patentId)).toBe(false);
    // Imported copies can have the same title; assert the active count rather than hiding them.
    await expect(settings.getByLabel("权限 CLI 隔离测试装置", { exact: true })).toHaveCount(
      activeChoices.filter((item) => item.name === "CLI 隔离测试装置").length,
    );
    await settings.getByRole("button", { name: "取消调整", exact: true }).click();
    await page.keyboard.press("Escape");
    const restoredFromGui = await page.evaluate(
      (id) => (window as unknown as { patentApi: PatentApi }).patentApi.patents.restore(id),
      patentId,
    );
    expect(restoredFromGui.ok).toBe(true);
    expect((await cli("patent", "read", "--patent-id", patentId)).value.patent.patentId).toBe(
      patentId,
    );
    const backupFolder = join(outputDirectory, "backups");
    await mkdir(backupFolder);
    await writeFile(
      libraryConfigInput,
      JSON.stringify({
        expectedHash: (await cli("global", "library", "read")).value.hash,
        settings: { enabled: true, folder: backupFolder, intervalMinutes: 10 },
      }),
    );
    const enabledBackup = await cli(
      "global",
      "library",
      "backup",
      "configure",
      "--input",
      libraryConfigInput,
    );
    expect(enabledBackup.value.status, JSON.stringify(enabledBackup)).toBe("committed");
    const backupRun = await cli(
      "global",
      "library",
      "backup",
      "run",
      "--expected-hash",
      enabledBackup.value.result.hash,
    );
    expect(backupRun.ok, JSON.stringify(backupRun)).toBe(true);
    let backupReceipt: { value: { status: string; result: { failures: unknown[] } } } | undefined;
    await expect
      .poll(async () => {
        const receipt = await cli("operation", "status", "--id", backupRun.value.operationId);
        backupReceipt = receipt;
        return receipt.value.status;
      })
      .toBe("committed");
    expect(backupReceipt?.value.result.failures).toEqual([]);
    const backups = await cli("global", "library", "backup", "read", "--action", "list");
    expect(backups.value.entries.length).toBeGreaterThan(0);
    const backupFile = backups.value.entries[0].fileName;
    const backupState = await cli(
      "global",
      "library",
      "backup",
      "read",
      "--action",
      "inspect",
      "--file-name",
      backupFile,
    );
    const restoredBackup = await cli(
      "global",
      "library",
      "backup",
      "restore",
      "--file-name",
      backupFile,
      "--expected-state",
      backupState.value.state,
      "--request-id",
      "e2e-backup-restore",
    );
    expect(restoredBackup.ok, JSON.stringify(restoredBackup)).toBe(true);
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", restoredBackup.value.operationId)).value.status,
      )
      .toBe("committed");
    const restoredBackupReceipt = await cli(
      "operation",
      "status",
      "--id",
      restoredBackup.value.operationId,
    );
    const restoredBackupId = restoredBackupReceipt.value.result.patents[0].patentId;
    expect(
      (await cli("patent", "read", "--patent-id", restoredBackupId)).value.patent.patentId,
    ).toBe(restoredBackupId);
    const backupDeleted = await cli(
      "global",
      "library",
      "backup",
      "delete",
      "--file-name",
      backupFile,
      "--expected-state",
      backupState.value.state,
    );
    expect(backupDeleted.value.status, JSON.stringify(backupDeleted)).toBe("committed");
    const independentCreated = await cli(
      "global",
      "documents",
      "create",
      "--title",
      "CLI 独立文档",
    );
    expect(independentCreated.value.status, JSON.stringify(independentCreated)).toBe("committed");
    const independentId = independentCreated.value.result.documentId;
    const independent = await cli(
      "global",
      "documents",
      "read",
      "--action",
      "get",
      "--document-id",
      independentId,
    );
    independent.value.document.content[0].content = [
      { type: "text", text: "CLI 独立文档正文", marks: [] },
    ];
    const independentInput = join(root, "independent.json");
    await writeFile(
      independentInput,
      JSON.stringify({
        documentId: independentId,
        expectedRevision: 0,
        document: independent.value.document,
      }),
    );
    const independentSaved = await cli(
      "global",
      "documents",
      "update",
      "--input",
      independentInput,
    );
    expect(independentSaved.value.status, JSON.stringify(independentSaved)).toBe("committed");
    for (const format of ["patdoc", "docx", "pdf"]) {
      await writeFile(
        independentInput,
        JSON.stringify({
          documentId: independentId,
          expectedRevision: 1,
          format,
          output: join(outputDirectory, `independent.${format}`),
        }),
      );
      const exportedDocument = await cli(
        "global",
        "documents",
        "export",
        "--input",
        independentInput,
      );
      expect(exportedDocument.ok, JSON.stringify(exportedDocument)).toBe(true);
      await expect
        .poll(
          async () =>
            (await cli("operation", "status", "--id", exportedDocument.value.operationId)).value
              .status,
        )
        .toBe("committed");
    }
    const independentPatdoc = join(
      connected.value.scope.workspace.importDirectory,
      "independent.patdoc",
    );
    await copyFile(join(outputDirectory, "independent.patdoc"), independentPatdoc);
    const reimportedDocument = await cli(
      "global",
      "documents",
      "import",
      "--path",
      independentPatdoc,
    );
    await expect
      .poll(
        async () =>
          (await cli("operation", "status", "--id", reimportedDocument.value.operationId)).value
            .status,
      )
      .toBe("committed");
    const pdfDrawingPath = join(connected.value.scope.workspace.importDirectory, "drawing.pdf");
    await copyFile(join(outputDirectory, "independent.pdf"), pdfDrawingPath);
    await writeFile(drawingInput, JSON.stringify({ patentId, path: pdfDrawingPath }));
    const pdfDrawing = await cli("drawing", "import", "--input", drawingInput);
    expect(pdfDrawing.value.status, JSON.stringify(pdfDrawing)).toBe("committed");
    const pdfProject = pdfDrawing.value.result.project;
    expect(pdfProject.sourceKind).toBe("pdf");
    pdfProject.regions = [
      {
        id: "whole-page",
        name: "整页",
        kind: "rectangle",
        points: [
          { x: 0, y: 0 },
          { x: pdfProject.width, y: 0 },
          { x: pdfProject.width, y: pdfProject.height },
          { x: 0, y: pdfProject.height },
        ],
      },
    ];
    const beforeDrawing = await cli("patent", "read", "--patent-id", patentId);
    await writeFile(
      drawingInput,
      JSON.stringify({
        patentId,
        expectedRevision: beforeDrawing.value.patent.revision,
        operations: [
          ...pdfDrawing.value.result.assets.map((asset: { assetId: string }) => ({
            type: "useAsset",
            assetId: asset.assetId,
          })),
          { type: "createDrawingProject", project: pdfProject },
        ],
      }),
    );
    const pdfPrepared = await cli("change", "prepare", "--input", drawingInput);
    expect(pdfPrepared.ok, JSON.stringify(pdfPrepared)).toBe(true);
    expect(
      (
        await cli(
          "change",
          "apply",
          "--patent-id",
          patentId,
          "--change-id",
          pdfPrepared.value.changeId,
        )
      ).value.status,
    ).toBe("committed");
    const withProject = await cli("patent", "read", "--patent-id", patentId);
    const savedPdfProject = withProject.value.patent.drawingProjects.at(-1);
    await writeFile(
      drawingInput,
      JSON.stringify({
        patentId,
        expectedRevision: withProject.value.patent.revision,
        projectId: savedPdfProject.projectId,
        expectedProjectRevision: savedPdfProject.revision,
        regionId: "whole-page",
        widthMm: 80,
        dpi: 300,
      }),
    );
    const renderedDrawing = await cli("drawing", "render", "--input", drawingInput);
    expect(renderedDrawing.value.status, JSON.stringify(renderedDrawing)).toBe("committed");
    expect(renderedDrawing.value.result.descriptor.mediaType).toBe("image/jpeg");
    await writeFile(
      drawingInput,
      JSON.stringify({
        patentId,
        expectedRevision: withProject.value.patent.revision,
        operations: [
          { type: "attachFigure", assetId: renderedDrawing.value.result.assetId, widthMm: 80 },
        ],
      }),
    );
    const drawingAttach = await cli("change", "prepare", "--input", drawingInput);
    expect(drawingAttach.ok, JSON.stringify(drawingAttach)).toBe(true);
    expect(
      (
        await cli(
          "change",
          "apply",
          "--patent-id",
          patentId,
          "--change-id",
          drawingAttach.value.changeId,
        )
      ).value.status,
    ).toBe("committed");
    const beforeFlow = await cli("patent", "read", "--patent-id", patentId);
    await writeFile(
      drawingInput,
      JSON.stringify({
        patentId,
        expectedRevision: beforeFlow.value.patent.revision,
        action: "create",
        name: "自动流程图",
        source:
          '<mxfile><diagram id="cli-page" name="流程"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="step" value="开始" vertex="1" parent="1" style="rounded=0;whiteSpace=wrap;html=1;"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell><mxCell id="other" value="结束" vertex="1" parent="1"><mxGeometry x="20" y="120" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
      }),
    );
    const flowCreated = await cli("flowchart", "write", "--input", drawingInput);
    expect(flowCreated.value.status, JSON.stringify(flowCreated)).toBe("committed");
    const flowProject = flowCreated.value.result.projects.at(-1);
    const flowRequest = {
      patentId,
      expectedRevision: flowCreated.value.result.revision,
      projectId: flowProject.projectId,
      expectedProjectRevision: flowProject.revision,
      selectedCellIds: ["step"],
    };
    await writeFile(drawingInput, JSON.stringify(flowRequest));
    const flowRendered = await cli(
      "flowchart",
      "render",
      "--input",
      drawingInput,
      "--timeout",
      "90000",
    );
    expect(flowRendered.value.status, JSON.stringify(flowRendered)).toBe("committed");
    expect(flowRendered.value.result.flowchartLink.exportScope).toBe("selection");
    await writeFile(
      drawingInput,
      JSON.stringify({
        patentId,
        expectedRevision: flowRequest.expectedRevision,
        operations: [
          {
            type: "attachFlowchartFigure",
            assetId: flowRendered.value.result.assetId,
            link: flowRendered.value.result.flowchartLink,
            widthMm: flowRendered.value.result.outputWidthMm,
          },
        ],
      }),
    );
    const flowAttach = await cli("change", "prepare", "--input", drawingInput);
    expect(flowAttach.ok, JSON.stringify(flowAttach)).toBe(true);
    expect(
      (
        await cli(
          "change",
          "apply",
          "--patent-id",
          patentId,
          "--change-id",
          flowAttach.value.changeId,
        )
      ).value.status,
    ).toBe("committed");
    const flowAsset = await cli(
      "asset",
      "read",
      "--patent-id",
      patentId,
      "--asset-id",
      flowRendered.value.result.assetId,
      "--variant",
      "original",
    );
    const flowSvg = Buffer.from(flowAsset.value.data, "base64").toString("utf8");
    expect(flowSvg).toContain("开始");
    expect(flowSvg).not.toContain("结束");
    await writeFile(
      drawingInput,
      JSON.stringify({
        ...flowRequest,
        expectedRevision: flowRequest.expectedRevision + 1,
        selectedCellIds: ["missing"],
      }),
    );
    expect((await cli("flowchart", "render", "--input", drawingInput)).value.status).toBe("failed");
    expect((await cli("global", "transfer", "read")).value.empty).toBe(false);
    const packageOutput = join(
      connected.value.scope.workspace.exportDirectory,
      "all-data.zxwbackup",
    );
    await writeFile(
      drawingInput,
      JSON.stringify({
        output: packageOutput,
        password: "isolated-e2e-package-password",
        passwordRecorded: true,
        persisted: true,
      }),
    );
    const packageExport = await cli("global", "transfer", "export", "--input", drawingInput);
    let packageReceipt: any;
    await expect
      .poll(
        async () => {
          packageReceipt = (
            await cli("operation", "status", "--id", packageExport.value.operationId)
          ).value;
          return ["accepted", "running"].includes(packageReceipt.status);
        },
        { timeout: 45000 },
      )
      .toBe(false);
    expect(packageReceipt.status, JSON.stringify(packageReceipt)).toBe("committed");
    expect((await readFile(packageOutput)).byteLength).toBeGreaterThan(1000);
    const beforeQuota = (await cli("doctor")).value;
    expect(beforeQuota.scope.createLimit).toBe(5);
    for (let index = 0; index < beforeQuota.creationRemaining; index++) {
      const created = await cli(
        "patent",
        "create",
        "--patent-type",
        "invention",
        "--name",
        `额度测试 ${index}`,
        "--request-id",
        `e2e-quota-${index}`,
      );
      expect(created.value.status).toBe("committed");
    }
    const excess = await cli(
      "patent",
      "create",
      "--patent-type",
      "invention",
      "--name",
      "超过五件",
      "--request-id",
      "e2e-quota-excess",
    );
    expect(excess.value.status).toBe("failed");
    expect(excess.value.result.error.code).toBe("SCOPE_DENIED");
    const renewal = await cli("pair", "renew-create");
    expect(renewal.value.status).toBe("pending");
    expect((await cli("pair", "renew-create")).value.pairId).toBe(renewal.value.pairId);
    expect((await cli("pair", "poll", "--id", renewal.value.pairId)).value.status).toBe("pending");
    await expect(authorization).toBeVisible();
    await expect(authorization.getByRole("spinbutton")).toHaveCount(0);
    await expect(
      authorization.getByRole("button", { name: "从专利库选择", exact: true }),
    ).toHaveCount(0);
    await expect(authorization.getByRole("switch")).toHaveCount(0);
    await page.waitForTimeout(450);
    await authorization.screenshot({ path: test.info().outputPath("agent-creation-renewal.png") });
    await expect(authorization.getByRole("button", { name: "授权", exact: true })).toBeDisabled();
    await authorization
      .getByRole("checkbox", { name: "我已阅读并同意授权须知", exact: true })
      .check();
    await authorization.getByRole("button", { name: "授权", exact: true }).click();
    const renewed = await cli("pair", "poll", "--id", renewal.value.pairId);
    expect(renewed.value.status).toBe("authorized");
    expect(renewed.value.token).toBeUndefined();
    expect(renewed.value.creationRemaining).toBe(5);
    expect(renewed.value.taskId).toBe(beforeQuota.taskId);
    expect(renewed.value.scope.global).toEqual(beforeQuota.scope.global);
    expect(renewed.value.scope.workspace).toEqual(beforeQuota.scope.workspace);
    expect(
      (await cli("patent", "create", "--patent-type", "invention", "--name", "续授权首件")).value
        .status,
    ).toBe("committed");
    expect((await cli("patent", "read", "--patent-id", patentId)).value.patent.patentId).toBe(
      patentId,
    );
    await expect(authorization).not.toBeVisible();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
    const exited = application.waitForEvent("close", { timeout: 20000 });
    void application.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await exited;
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await application.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
