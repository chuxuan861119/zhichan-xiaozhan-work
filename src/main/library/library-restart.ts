import { type SpawnOptions, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { join } from "node:path";

type RestartOptions = {
  isPackaged: boolean;
  rendererUrl: string | undefined;
  appPath: string;
  execPath: string;
  args: string[];
  pid: number;
  parentPid: number;
  logPath: string;
};
type Helper = EventEmitter & {
  unref(): void;
  disconnect(): void;
  send(message: string, callback: (error: Error | null) => void): boolean;
};
type Dependencies = {
  relaunch(options: { args: string[] }): void;
  spawn?(exe: string, args: string[], options: SpawnOptions): Helper;
};

/** A dev child cannot relaunch alone: electron-vite exits with its original child. */
export async function restartAfterLibraryMove(options: RestartOptions, dependencies: Dependencies) {
  if (options.isPackaged || !options.rendererUrl) {
    dependencies.relaunch({ args: options.args });
    return;
  }
  const child = (dependencies.spawn ?? spawn)(
    options.execPath,
    [
      join(options.appPath, "scripts", "restart-library-dev.mjs"),
      String(options.pid),
      String(options.parentPid),
      options.appPath,
      options.logPath,
      ...options.args.slice(1),
    ],
    {
      cwd: options.appPath,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("开发实例重启准备超时")), 15_000);
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error("开发实例重启助手未能启动"));
    const ready = (message: unknown) => {
      if (message === "ready") finish();
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
      child.removeListener("message", ready);
      if (error) {
        try {
          child.disconnect();
        } catch {
          /* already disconnected */
        }
        reject(error);
      } else {
        child.unref();
        resolve();
      }
    }
    child.once("error", failed);
    child.once("exit", exited);
    child.on("message", ready);
  });
  // The helper only proceeds once it receives approval, then waits for both old processes.
  await new Promise<void>((resolve, reject) =>
    child.send("restart", (error) => (error ? reject(error) : resolve())),
  );
  child.disconnect();
}
