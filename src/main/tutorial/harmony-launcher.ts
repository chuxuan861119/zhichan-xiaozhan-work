import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, session } from "electron";
import { APPLICATION_NAME } from "../../shared/branding.js";
import type { TutorialLessonId } from "../../shared/tutorial/model.js";
import { installAppProtocol } from "../app-protocol.js";
import { FileService } from "../documents/file-service.js";
import { registerIpcHandlers } from "../ipc/register-ipc.js";
import type { AgreementService } from "../legal/agreement-service.js";
import { createLibraryRuntime } from "../library/library-runtime.js";
import type { SafeLogger } from "../logging/safe-log.js";
import { OpenPathAuthorization } from "../open-path-authorization.js";
import { SettingsService } from "../settings/settings-service.js";
import { createMainWindow, shouldShowMainWindow } from "../window.js";
import { TutorialSeedService } from "./seed.js";
import { createTutorialSession, readTutorialSession } from "./session.js";

/** Harmony cannot launch a second Electron executable. Keep the same isolation in one host. */
export class HarmonyTutorialLauncher {
  #window: BrowserWindow | undefined;
  #launching: Promise<void> | undefined;
  constructor(
    readonly options: {
      logger: SafeLogger;
      rendererRoot: string;
      agreements(root: string): AgreementService;
    },
  ) {}

  launch(lessonId: TutorialLessonId): Promise<void> {
    if (this.#launching) return this.#launching;
    if (this.#window && !this.#window.isDestroyed()) {
      if (shouldShowMainWindow()) {
        this.#window.show();
        this.#window.focus();
      }
      return Promise.resolve();
    }
    this.#launching = this.#start(lessonId).finally(() => {
      this.#launching = undefined;
    });
    return this.#launching;
  }

  async #start(lessonId: TutorialLessonId): Promise<void> {
    const isolated = await createTutorialSession(lessonId);
    let runtime: Awaited<ReturnType<typeof createLibraryRuntime>> | undefined;
    let disposeIpc: (() => Promise<void>) | undefined;
    let disposal: Promise<void> | undefined;
    let window: BrowserWindow | undefined;
    const browserSession = session.fromPartition(`tutorial-${isolated.sessionId}`, {
      cache: false,
    });
    const dispose = () =>
      (disposal ??= (async () => {
        await disposeIpc?.();
        await runtime?.close();
        await browserSession.clearStorageData();
        browserSession.protocol.unhandle("patent-app");
        const verified = readTutorialSession([`--tool-tutorial=${isolated.root}`]);
        if (verified?.sessionId === isolated.sessionId)
          await rm(isolated.root, { recursive: true, force: true, maxRetries: 3 });
      })());
    let ready: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const whenReady = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    // Observe early renderer failure while createMainWindow is still loading.
    void whenReady.catch(() => undefined);
    const timeout = setTimeout(
      () => rejectReady?.(new Error("教学窗口准备超时，请稍后重试。")),
      45_000,
    );
    try {
      const settings = new SettingsService(join(isolated.userData, "settings.json"));
      await settings.update({
        welcomeCompleted: true,
        editorIntroductionSeen: true,
        closeToTray: false,
        trayIntroDismissed: true,
        autoCheckUpdates: false,
        contentSearchEnabled: false,
      });
      runtime = await createLibraryRuntime({
        libraryRoot: isolated.library,
        userDataRoot: isolated.userData,
        readOnly: false,
        runRecovery: false,
        startBackgroundSchedulers: false,
      });
      const tutorial = new TutorialSeedService(isolated.sessionId, runtime);
      await tutorial.prepare(lessonId);
      installAppProtocol(this.options.rendererRoot, browserSession.protocol);
      window = await createMainWindow(this.options.logger, {
        hidden: true,
        tutorial: true,
        closeWindowOnly: true,
        isolatedSession: browserSession,
        initializeWindow: (created) => {
          window = created;
          const services = runtime!;
          disposeIpc = registerIpcHandlers(
            this.options.logger,
            new OpenPathAuthorization(),
            {
              library: services.library,
              patents: services.patents,
              patentTemplates: services.patentTemplates,
              flowcharts: services.flowcharts,
              recovery: services.recovery,
              assetStore: services.assetStore,
              snapshots: services.snapshots,
              fileService: new FileService(),
              readOnly: false,
            },
            undefined,
            false,
            () => undefined,
            {
              settings,
              userDataPath: isolated.userData,
              tutorial,
              agreements: this.options.agreements(isolated.userData),
              onCloseToTrayChanged: () => undefined,
              onTutorialReady: async () => {
                ready?.();
              },
            },
            created.webContents.ipc,
          );
          created.once("closed", () => {
            if (this.#window === created) this.#window = undefined;
            rejectReady?.(new Error("教学窗口已关闭。"));
            void dispose().catch(() =>
              this.options.logger.log("error", { event: "app.error", errorCode: "INTERNAL" }),
            );
          });
        },
      });
      await whenReady;
      this.#window = window;
      window.setTitle(`${APPLICATION_NAME} · 快速工具教程`);
      if (shouldShowMainWindow()) {
        window.show();
        window.focus();
      }
    } catch (error) {
      if (window && !window.isDestroyed()) window.destroy();
      await dispose();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
