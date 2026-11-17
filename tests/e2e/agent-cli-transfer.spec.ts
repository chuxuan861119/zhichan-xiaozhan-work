import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron, type ElectronApplication, expect, test } from "@playwright/test";
import { acceptAgentCliPolicy, waitForMainWindow } from "./helpers/workbench.js";

const exec = promisify(execFile);

test("hidden CLI full transfer: encrypted import, scheduling response, restart validation and new authorization", async () => {
  // Windows verifies directory ACLs per CLI call and this flow owns four app startups.
  test.setTimeout(process.platform === "win32" ? 240000 : 120000);
  const root = await mkdtemp(join(tmpdir(), "zxw-xfer-"));
  const entry = await createRequire(import.meta.url)("./fixtures/background-electron.cjs")();
  // The test owns restart timing so the replacement remains hidden and under Playwright control.
  await writeFile(
    entry,
    (await readFile(entry, "utf8")).replace(
      "const __filename =",
      "app.relaunch = () => {};\ndialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });\ndialog.showErrorBox = (title, message) => console.error(title, message);\nconst __filename =",
    ),
  );
  const apps: Array<{
    app: ElectronApplication;
    child: ReturnType<ElectronApplication["process"]>;
  }> = [];
  const launched = new Set<string>();
  const make = async (name: string) => {
    const fresh = !launched.has(name);
    launched.add(name);
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const home = join(dir, "home");
    const inputDirectory = join(dir, "inputs");
    await mkdir(inputDirectory, { recursive: true });
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (item): item is [string, string] => item[1] !== undefined,
        ),
      ),
      PATENT_WORKBENCH_TEST: "1",
      PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1",
      PATENT_WORKBENCH_LIBRARY_ROOT: join(dir, "library"),
      LOCALAPPDATA: join(dir, "local"),
      ZXW_HOME: home,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    delete env.PATENT_WORKBENCH_DEVTOOLS;
    const app = await _electron.launch({
      args: [entry, `--user-data-dir=${join(dir, "user")}`, "--disable-gpu"],
      env,
      timeout: 20000,
    });
    apps.push({ app, child: app.process() });
    const cli = async (...args: string[]) => {
      let stdout: string;
      try {
        stdout = (
          await exec(
            resolve(
              process.platform === "win32" ? "out/cli/runtime/node.exe" : "out/cli/runtime/node",
            ),
            [resolve("out/cli/index.cjs"), ...args, "--home", home, "--json"],
            { env, timeout: 20000, windowsHide: true },
          )
        ).stdout;
      } catch (error) {
        stdout = (error as { stdout: string }).stdout;
        if (!stdout) throw error;
      }
      return JSON.parse(stdout);
    };
    const input = async (command: string[], value: unknown) => {
      const path = join(inputDirectory, `input-${Date.now()}-${Math.random()}.json`);
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      return cli(...command, "--input", path);
    };
    const authorize = async () => {
      await expect
        .poll(
          () =>
            app.windows().filter((page) => !page.isClosed() && page.url().startsWith("patent-app:"))
              .length,
          { timeout: 20000 },
        )
        .toBe(1);
      const page = await waitForMainWindow(app);
      const welcome = page.getByRole("button", { name: "关闭欢迎提示", exact: true });
      if (fresh && (await welcome.isVisible())) await welcome.click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "设置", exact: true });
      await settings.getByRole("button", { name: "Agent CLI（实验功能）", exact: true }).click();
      const enabled = page.getByRole("checkbox", { name: "启用 Agent CLI", exact: true });
      await expect(enabled).toBeEnabled();
      if (!(await enabled.isChecked())) {
        await enabled.click();
        await acceptAgentCliPolicy(page);
      }
      await expect(enabled).toBeChecked();
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await cli("instance", "list")).value.instances.length).toBe(1);
      const instance = (await cli("instance", "list")).value.instances[0].instanceId;
      expect(
        (await input(["connect", "--instance", instance], { requested: { createLimit: 1 } })).value
          .status,
      ).toBe("pending");
      const modal = page.getByRole("alertdialog", { name: /请求操作授权$/ });
      await expect(modal.getByText("新建专利（控制）权限", { exact: true })).toBeVisible();
      await expect(modal.getByRole("switch")).toHaveCount(0);
      await modal.locator("summary").filter({ hasText: "全局设置授权" }).click();
      await modal
        .getByRole("combobox", {
          name: "全局权限 完整数据迁移（全部专利、文档、对话与设置）",
          exact: true,
        })
        .selectOption("full");
      await modal.getByRole("button", { name: "用户授权须知", exact: true }).click();
      const notice = page.getByRole("dialog", { name: "Agent 用户授权须知", exact: true });
      await notice
        .getByRole("checkbox", { name: "我已阅读并同意以上授权须知", exact: true })
        .check();
      await notice.getByRole("button", { name: "同意并返回", exact: true }).click();
      await modal.getByRole("button", { name: "授权", exact: true }).click();
      const connected = await cli("connect", "--instance", instance);
      expect(connected.value.status).toBe("authorized");
      return connected.value.scope.workspace;
    };
    const wait = async (response: any) => {
      expect(response.ok).toBe(true);
      let receipt = response.value;
      await expect
        .poll(
          async () => {
            receipt = (await input(["operation", "status"], { id: response.value.operationId }))
              .value;
            return ["accepted", "running"].includes(receipt.status) ? "pending" : "finished";
          },
          { timeout: 30000 },
        )
        .toBe("finished");
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: "committed" });
      return receipt.result;
    };
    return { app, cli, input, authorize, wait, dir };
  };
  try {
    const source = await make("source");
    const workspace = await source.authorize();
    await source.wait(
      await source.input(["patent", "create"], { name: "整库恢复验证", patentType: "invention" }),
    );
    const output = join(workspace.exportDirectory, "all.zxwbackup");
    await source.wait(
      await source.input(["global", "transfer", "export"], {
        output,
        password: "test-package-password",
        passwordRecorded: true,
        persisted: true,
      }),
    );
    const target = await make("target");
    const targetWorkspace = await target.authorize();
    expect((await target.cli("capabilities")).value.platformSupport.transferImportCommit).toBe(
      process.platform === "win32" || process.platform === "darwin",
    );
    const path = join(targetWorkspace.importDirectory, "all.zxwbackup");
    await writeFile(path, await readFile(output));
    // Resolve promises before passing receipts into the polling helper.
    const first = await target.wait(
      await target.input(["global", "transfer", "import", "prepare"], {
        path,
        password: "test-package-password",
      }),
    );
    expect(first.preview.summary.activePatents).toBe(1);
    await target.wait(
      await target.input(["global", "transfer", "import", "discard"], { importId: first.importId }),
    );
    const prepared = await target.wait(
      await target.input(["global", "transfer", "import", "prepare"], {
        path,
        password: "test-package-password",
      }),
    );
    if (process.platform !== "win32" && process.platform !== "darwin") {
      const denied = await target.input(["global", "transfer", "import", "commit"], {
        importId: prepared.importId,
        restart: true,
      });
      expect(denied).toMatchObject({
        ok: true,
        value: { status: "failed", result: { error: { code: "UNSUPPORTED_PLATFORM" } } },
      });
      await target.wait(
        await target.input(["global", "transfer", "import", "discard"], {
          importId: prepared.importId,
        }),
      );
      expect((await target.cli("global", "transfer", "read")).value.summary.activePatents).toBe(0);
      expect(
        await target.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
        ),
      ).toBe(true);
    } else {
      const closing = target.app.waitForEvent("close", { timeout: 20000 });
      const scheduled = await target.input(["global", "transfer", "import", "commit"], {
        importId: prepared.importId,
        restart: true,
      });
      expect(scheduled).toMatchObject({
        ok: true,
        value: { status: "committed", result: { phase: "scheduled", restartPending: true } },
      });
      await closing;
      const restarted = await make("target");
      await restarted.authorize();
      const status = await restarted.cli("global", "transfer", "read");
      expect(status).toMatchObject({
        ok: true,
        value: {
          importCommitSupported: true,
          lastImport: { importId: prepared.importId, phase: "committed" },
          summary: { activePatents: 1 },
        },
      });
      expect((await restarted.cli("patent", "list")).value.items).toEqual([]);
    }

    // Close auto-shown CLI creations through the normal GUI handshake before relocation.
    const visible = await source.cli("patent", "list");
    for (const patent of visible.value.items) {
      const closed = await source.cli("patent", "close", "--patent-id", patent.patentId);
      expect(closed.value.status).toBe("committed");
    }
    const moving = source.app.waitForEvent("close", { timeout: 20000 });
    const move = await source.input(["global", "transfer", "relocate"], {
      parent: workspace.exportDirectory,
      restart: true,
    });
    expect(move).toMatchObject({
      ok: true,
      value: { status: "committed", result: { phase: "scheduled", restartPending: true } },
    });
    await moving;
    const relocated = await make("source");
    await relocated.authorize();
    expect(await relocated.cli("global", "transfer", "read")).toMatchObject({
      ok: true,
      value: {
        location: { activeRoot: move.value.result.target, pending: null },
        summary: { activePatents: 1 },
      },
    });
    expect(
      await relocated.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    for (const { app, child } of apps.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      void app.close().catch(() => {});
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      // Only windowless/closing test-owned processes with disposable data reach this fallback.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
    await rm(entry, { force: true });
  }
});
