import { type ChildProcess, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TutorialLessonId } from "../../shared/tutorial/model.js";
import { createTutorialSession, readTutorialSession, type TutorialSession } from "./session.js";
import { sendTutorialCommand, tutorialReadyMatches } from "./transport.js";

type LauncherOptions = {
  executable: string;
  entry: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
};
export class TutorialLauncher {
  #child: ChildProcess | undefined;
  #session: TutorialSession | undefined;
  #ready = false;
  #launching: Promise<void> | undefined;
  constructor(readonly options: LauncherOptions) {}
  launch(lessonId: TutorialLessonId): Promise<void> {
    if (this.#launching) return this.#launching;
    if (this.#child && this.#child.exitCode === null) {
      if (this.#ready && this.#session) return sendTutorialCommand(this.#session, "focus");
      return Promise.reject(new Error("教学窗口正在退出，请稍后重试。"));
    }
    this.#launching = this.#start(lessonId).finally(() => {
      this.#launching = undefined;
    });
    return this.#launching;
  }
  async #start(lessonId: TutorialLessonId): Promise<void> {
    const session = await createTutorialSession(lessonId);
    this.#session = session;
    this.#ready = false;
    const env: NodeJS.ProcessEnv = {
      ...this.options.environment,
      LOCALAPPDATA: session.localAppData,
      ZXW_HOME: session.cliHome,
      PATENT_WORKBENCH_LIBRARY_ROOT: session.library,
      ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: session.library,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      this.options.executable,
      [
        this.options.entry,
        `--user-data-dir=${session.userData}`,
        `--tool-tutorial=${session.root}`,
        "--disable-background-networking",
        "--no-first-run",
        ...(env.PATENT_WORKBENCH_TEST === "1" && env.PATENT_WORKBENCH_E2E_BACKGROUND === "1"
          ? ["--remote-debugging-port=0"]
          : []),
      ],
      { env, stdio: ["ignore", "ignore", "ignore"] },
    );
    this.#child = child;
    let failed = false;
    const onError = () => {
      failed = true;
    };
    child.once("error", onError);
    child.once("exit", () => {
      if (this.#child === child) {
        this.#child = undefined;
        this.#ready = false;
      }
      void this.#dispose(session).catch(() => undefined);
    });
    child.unref();
    const started = Date.now();
    try {
      while (Date.now() - started < (this.options.timeoutMs ?? 45_000)) {
        if (failed || child.exitCode !== null) throw new Error("教学窗口准备失败，请重试。");
        const ready = await readFile(join(session.root, "ready.json"), "utf8").catch(() => null);
        if (ready && tutorialReadyMatches(ready, session)) {
          this.#ready = true;
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      await sendTutorialCommand(session, "close").catch(() => undefined);
      throw new Error("教学窗口准备超时，请稍后重试。");
    } catch (error) {
      if (failed) {
        this.#child = undefined;
        await this.#dispose(session).catch(() => undefined);
      }
      throw error;
    } finally {
      child.off("error", onError);
    }
  }
  async #dispose(session: TutorialSession): Promise<void> {
    const verified = readTutorialSession([`--tool-tutorial=${session.root}`]);
    if (verified?.sessionId === session.sessionId)
      await rm(session.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
