import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from "@playwright/test";
import { APPLICATION_DATA_DIRECTORY } from "../../../src/shared/branding.js";

const OUTBOUND_PROTOCOL = /^(?:https?|wss?):/iu;

export async function dismissWorkbenchWelcome(page: Page): Promise<void> {
  await page.getByTestId("app-shell").waitFor();
  const welcome = page.getByRole("dialog", { name: /^欢迎使用知产小栈/u });
  if (await welcome.isVisible()) {
    await welcome.getByRole("button", { name: "关闭欢迎提示", exact: true }).click();
    await expect(welcome).toBeHidden();
  }
}

export type ObservedConnection = {
  url: string;
  netError: number | null;
};

export type WorkbenchProfile = {
  name: string;
  root: string;
  userData: string;
  localAppData: string;
  libraryRoot: string;
  netLog: string;
  application: ElectronApplication;
};

export type WorkbenchHarness = {
  root: string;
  userData: string;
  netLog: string;
  launch(...arguments_: string[]): ReturnType<typeof electron.launch>;
  launchAllowMultipleInstances(...arguments_: string[]): ReturnType<typeof electron.launch>;
  launchWithoutTestPolicy(...arguments_: string[]): ReturnType<typeof electron.launch>;
  launchProfile(name: string, ...arguments_: string[]): Promise<WorkbenchProfile>;
  relaunchProfile(profile: WorkbenchProfile, ...arguments_: string[]): Promise<WorkbenchProfile>;
  removeTransientProfileMarkers(profile: WorkbenchProfile): Promise<void>;
  launchSecondInstance(argument: string): Promise<void>;
  readObservedRequestUrls(): Promise<string[]>;
  readObservedConnections(): Promise<ObservedConnection[]>;
};

export async function enterDualView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "同屏双显", exact: true }).click();
  await expect(page.getByRole("region", { name: "同屏双文档工作区" })).toBeVisible();
}
export async function acceptAgentCliPolicy(page: Page): Promise<void> {
  const policy = page.getByRole("dialog", { name: "Agent CLI 使用协议与隐私说明", exact: true });
  await expect(policy).toBeVisible();
  await policy.locator(".standard-dialog__body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  const agree = policy.getByRole("checkbox", {
    name: "我已阅读并同意 Agent CLI 使用协议与隐私说明",
  });
  await expect(agree).toBeEnabled();
  await agree.check();
  await policy.getByRole("button", { name: "同意并开启", exact: true }).click();
  await expect(policy).toBeHidden();
}

export async function selectDualPane(page: Page, pane: "left" | "right"): Promise<void> {
  const label = pane === "left" ? "左侧文档" : "右侧文档";
  await page.getByRole("region", { name: label }).dispatchEvent("pointerdown");
}

export async function choosePaneBook(
  page: Page,
  pane: "left" | "right",
  patentName: string,
  bookLabel: string,
): Promise<void> {
  const paneRegion = page.getByRole("region", {
    name: pane === "left" ? "左侧文档" : "右侧文档",
  });
  await paneRegion.getByRole("button", { name: patentName, exact: true }).click();
  await paneRegion.getByRole("button", { name: bookLabel, exact: true }).click();
}

export async function swapDualPanes(page: Page): Promise<void> {
  await page.getByRole("button", { name: "交换左右文档" }).click();
}

export async function expectActivePane(page: Page, pane: "left" | "right"): Promise<void> {
  const active = page.getByRole("region", {
    name: pane === "left" ? "左侧文档" : "右侧文档",
  });
  await expect(active).toHaveAttribute("data-active", "true");
}

function isolatedEnvironment(
  testPolicy = true,
  libraryRoot?: string,
  allowMultipleInstances = false,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (testPolicy) environment.PATENT_WORKBENCH_TEST = "1";
  else delete environment.PATENT_WORKBENCH_TEST;
  if (libraryRoot) environment.PATENT_WORKBENCH_LIBRARY_ROOT = libraryRoot;
  if (allowMultipleInstances) environment.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES = "1";
  else delete environment.PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.PATENT_WORKBENCH_DEVTOOLS;
  // WorkBuddy sets ELECTRON_RUN_AS_NODE=1 for its own Node.js tasks.
  // If inherited by the Electron test process, Electron runs as plain
  // Node.js — the built-in "electron" module is never registered, so
  // require("electron") returns the npm package path string and the
  // app cannot start.  Must be removed before launching Electron.
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/** 在隔离环境基础上额外隔离 LOCALAPPDATA（应用数据根/恢复 journal 所在目录）。 */
function isolatedLaunchEnvironment(
  testPolicy: boolean,
  libraryRoot: string,
  localAppData: string,
  allowMultipleInstances = false,
): Record<string, string> {
  const environment = isolatedEnvironment(testPolicy, libraryRoot, allowMultipleInstances);
  environment.LOCALAPPDATA = localAppData;
  return environment;
}

function launchArguments(
  userData: string,
  netLog: string,
  arguments_: readonly string[],
  appEntry = process.cwd(),
): string[] {
  return [
    appEntry,
    `--user-data-dir=${userData}`,
    `--log-net-log=${netLog}`,
    "--net-log-capture-mode=Everything",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-features=AutofillServerCommunication,CertificateTransparencyComponentUpdater,OptimizationHints,MediaRouter",
    "--disable-sync",
    "--no-first-run",
    // Headless/software rendering fallback: virtual Windows hosts without a GPU
    // crash the GPU process otherwise. With a real GPU these flags are no-ops.
    ...(process.env.PATENT_WORKBENCH_E2E_HARDWARE_GRAPHICS === "1"
      ? []
      : ["--disable-gpu", "--disable-gpu-compositing", "--use-gl=swiftshader"]),
    ...arguments_,
  ];
}

export async function waitForMainWindow(
  application: ElectronApplication,
  confirmAgreements = true,
): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const ready = await page
        .evaluate(
          () =>
            typeof (globalThis as unknown as { patentApi?: { settings?: { read?: unknown } } })
              .patentApi?.settings?.read === "function",
        )
        .catch(() => false);
      if (ready) {
        if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1") {
          const windows = await application.evaluate(({ BrowserWindow, BaseWindow }) => ({
            count: BrowserWindow.getAllWindows().length,
            hidden: BaseWindow.getAllWindows().every(
              (window) => !window.isVisible() && !window.isFocused(),
            ),
          }));
          expect(windows.count).toBeGreaterThan(0);
          expect(windows.hidden).toBe(true);
        }
        if (confirmAgreements) {
          const agreement = await page.evaluate(() => window.patentApi.agreements?.read());
          if (agreement?.ok && agreement.value.needsConfirmation) {
            const gate = page.getByRole("dialog", {
              name: "软件使用协议与隐私政策确认",
              exact: true,
            });
            await gate
              .getByRole("button", { name: /^(开始使用|继续使用|同意更新并继续)$/ })
              .click();
            await expect(gate).toBeHidden();
          }
        }
        return page;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("主应用窗口未在 30 秒内就绪。");
}

function attachMainWindowFirstWindow(application: ElectronApplication): ElectronApplication {
  Object.defineProperty(application, "firstWindow", {
    configurable: true,
    value: () => waitForMainWindow(application),
  });
  return application;
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("第二实例未在 10 秒内退出。"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(`第二实例退出码：${String(code)}`));
    });
  });
}

export const test = base.extend<{ workbench: WorkbenchHarness }>({
  workbench: async ({ browserName: _browserName }, use, testInfo) => {
    const appEntry =
      process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1"
        ? await createRequire(import.meta.url)("../fixtures/background-electron.cjs")(
            process.env.PATENT_WORKBENCH_E2E_APP_ENTRY,
          )
        : process.cwd();
    const root = await mkdtemp(join(tmpdir(), "patent-workbench-e2e-"));
    const userData = join(root, "user-data");
    const libraryRoot = join(root, "library");
    // 每次测试使用全新隔离的 LOCALAPPDATA：应用数据根与数据导入恢复 journal
    // 位于该目录下，隔离后测试实例不会读取/复用真实环境或其他实例的旧 journal。
    const localAppData = join(root, "local-app-data");
    mkdirSync(localAppData, { recursive: true });
    const netLog = join(root, "net-log.json");
    const electronExecutable = createRequire(import.meta.url)("electron") as string;
    const resolvedRoot = resolve(root);
    const resolvedTemp = resolve(tmpdir());
    const profileLaunchCounts = new Map<string, number>();
    const launchedApplications = new Set<ElectronApplication>();
    const trackApplication = (application: ElectronApplication): ElectronApplication => {
      launchedApplications.add(application);
      return application;
    };
    if (
      !resolvedRoot.startsWith(`${resolvedTemp}${sep}`) ||
      !resolvedRoot.includes("patent-workbench-e2e-")
    ) {
      throw new Error(`拒绝使用意外临时路径：${resolvedRoot}`);
    }
    const harness: WorkbenchHarness = {
      root,
      userData,
      netLog,
      launch: async (...arguments_) =>
        trackApplication(
          attachMainWindowFirstWindow(
            await electron.launch({
              args: launchArguments(userData, netLog, arguments_, appEntry),
              env: isolatedLaunchEnvironment(true, libraryRoot, localAppData),
            }),
          ),
        ),
      launchAllowMultipleInstances: async (...arguments_) =>
        trackApplication(
          attachMainWindowFirstWindow(
            await electron.launch({
              args: launchArguments(userData, netLog, arguments_, appEntry),
              env: isolatedLaunchEnvironment(true, libraryRoot, localAppData, true),
            }),
          ),
        ),
      launchWithoutTestPolicy: async (...arguments_) =>
        trackApplication(
          attachMainWindowFirstWindow(
            await electron.launch({
              args: launchArguments(userData, netLog, arguments_, appEntry),
              env: isolatedLaunchEnvironment(false, libraryRoot, localAppData),
            }),
          ),
        ),
      launchProfile: async (name, ...arguments_) => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
          throw new Error(`隔离配置名称无效：${name}`);
        }
        const profileRoot = join(root, "profiles", name);
        const profileUserData = join(profileRoot, "user-data");
        const profileLocalAppData = join(profileRoot, "local-app-data");
        const profileLibraryRoot = join(profileRoot, "library");
        const launchCount = (profileLaunchCounts.get(name) ?? 0) + 1;
        profileLaunchCounts.set(name, launchCount);
        const profileNetLog = join(profileRoot, `net-log-${launchCount}.json`);
        await Promise.all([
          mkdir(profileUserData, { recursive: true }),
          mkdir(profileLocalAppData, { recursive: true }),
          mkdir(join(profileLocalAppData, APPLICATION_DATA_DIRECTORY), { recursive: true }),
          mkdir(profileLibraryRoot, { recursive: true }),
        ]);
        const environment = isolatedEnvironment(true, profileLibraryRoot, true);
        environment.LOCALAPPDATA = profileLocalAppData;
        const application = trackApplication(
          attachMainWindowFirstWindow(
            await electron.launch({
              args: launchArguments(profileUserData, profileNetLog, arguments_, appEntry),
              env: environment,
            }),
          ),
        );
        return {
          name,
          root: profileRoot,
          userData: profileUserData,
          localAppData: profileLocalAppData,
          libraryRoot: profileLibraryRoot,
          netLog: profileNetLog,
          application,
        };
      },
      relaunchProfile: async (profile, ...arguments_) => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(profile.name)) {
          throw new Error(`隔离配置名称无效：${profile.name}`);
        }
        const profileContainer = resolve(root, "profiles");
        const expectedRoot = resolve(profileContainer, profile.name);
        if (
          !expectedRoot.startsWith(`${profileContainer}${sep}`) ||
          resolve(profile.root) !== expectedRoot ||
          resolve(profile.userData) !== resolve(expectedRoot, "user-data") ||
          resolve(profile.localAppData) !== resolve(expectedRoot, "local-app-data") ||
          resolve(profile.libraryRoot) !== resolve(expectedRoot, "library")
        ) {
          throw new Error(`拒绝重启意外隔离配置：${profile.name}`);
        }
        const launchCount = (profileLaunchCounts.get(profile.name) ?? 0) + 1;
        profileLaunchCounts.set(profile.name, launchCount);
        const profileNetLog = join(profile.root, `net-log-${launchCount}.json`);
        const environment = isolatedEnvironment(true, profile.libraryRoot, true);
        environment.LOCALAPPDATA = profile.localAppData;
        const application = trackApplication(
          attachMainWindowFirstWindow(
            await electron.launch({
              args: launchArguments(profile.userData, profileNetLog, arguments_, appEntry),
              env: environment,
            }),
          ),
        );
        return { ...profile, netLog: profileNetLog, application };
      },
      removeTransientProfileMarkers: async (profile) => {
        for (const name of ["DevToolsActivePort", "lockfile"] as const) {
          const target = resolve(profile.userData, name);
          if (resolve(target).startsWith(`${resolve(profile.userData)}${sep}`) === false) {
            throw new Error(`拒绝移除隔离配置目录之外的自动化标记：${name}`);
          }
          await unlink(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      },
      launchSecondInstance: async (argument) => {
        const child = spawn(
          electronExecutable,
          launchArguments(
            userData,
            join(root, "second-instance-net-log.json"),
            [argument],
            appEntry,
          ),
          { env: isolatedEnvironment(true, libraryRoot), stdio: "ignore", windowsHide: true },
        );
        await waitForChild(child);
      },
      readObservedRequestUrls: async () => {
        const raw = JSON.parse(await readFile(netLog, "utf8")) as {
          events?: Array<{ params?: unknown }>;
        };
        const urls = new Set<string>();
        for (const event of raw.events ?? []) {
          const pending: unknown[] = [event.params];
          while (pending.length > 0) {
            const value = pending.pop();
            if (typeof value === "string") {
              if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) urls.add(value);
            } else if (Array.isArray(value)) {
              pending.push(...value);
            } else if (value && typeof value === "object") {
              const record = value as Record<string, unknown>;
              if (typeof record.url === "string") urls.add(record.url);
              pending.push(...Object.values(record));
            }
          }
        }
        return [...urls].sort();
      },
      readObservedConnections: async () => {
        const raw = JSON.parse(await readFile(netLog, "utf8")) as {
          events?: Array<{ params?: unknown }>;
        };
        const unique = new Map<string, ObservedConnection>();
        for (const event of raw.events ?? []) {
          const pending: unknown[] = [event.params];
          while (pending.length > 0) {
            const value = pending.pop();
            if (typeof value === "string") {
              if (!OUTBOUND_PROTOCOL.test(value)) continue;
              const previous = unique.get(value);
              if (!previous) unique.set(value, { url: value, netError: null });
            } else if (Array.isArray(value)) {
              pending.push(...value);
            } else if (value && typeof value === "object") {
              const record = value as Record<string, unknown>;
              const url = record.url;
              if (typeof url === "string" && OUTBOUND_PROTOCOL.test(url)) {
                const error = record.net_error;
                const netError = typeof error === "number" ? error : null;
                const previous = unique.get(url);
                if (previous?.netError !== 0) unique.set(url, { url, netError });
              }
              pending.push(...Object.values(record));
            }
          }
        }
        return [...unique.values()];
      },
    };
    try {
      await use(harness);
    } finally {
      for (const application of launchedApplications) {
        // Failed UI tests can leave a modal or close guard open. These apps use
        // this fixture's isolated test data only; do not let teardown mask the
        // original assertion with a second, indefinite close timeout.
        if (testInfo.status !== testInfo.expectedStatus) {
          await application.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
        }
        await application.close().catch(() => undefined);
      }
      let cleanupError: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await rm(resolvedRoot, { recursive: true, force: true });
          cleanupError = undefined;
          break;
        } catch (error) {
          cleanupError = error;
          if ((error as NodeJS.ErrnoException).code !== "EBUSY") break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
        }
      }
      if (cleanupError) console.warn(`无法清理隔离测试目录：${String(cleanupError)}`);
    }
  },
});

export { expect };
