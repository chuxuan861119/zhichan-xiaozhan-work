// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { restartAfterLibraryMove } from "./library-restart.js";

test("installed applications retain the native relaunch path", async () => {
  const relaunch = vi.fn();
  const spawn = vi.fn();
  await restartAfterLibraryMove(
    {
      isPackaged: true,
      rendererUrl: undefined,
      appPath: "D:/app",
      execPath: "D:/app/app.exe",
      args: ["--user-data-dir=D:/profile"],
      pid: 12,
      parentPid: 10,
      logPath: "D:/logs/restart.log",
    },
    { relaunch, spawn },
  );
  expect(relaunch).toHaveBeenCalledWith({ args: ["--user-data-dir=D:/profile"] });
  expect(spawn).not.toHaveBeenCalled();
});

test("HMR restart launches a waiting developer helper and preserves instance arguments", async () => {
  const child = Object.assign(new EventEmitter(), {
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn((_message: string, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    }),
  });
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit("message", "ready"));
    return child;
  });
  const relaunch = vi.fn();
  await restartAfterLibraryMove(
    {
      isPackaged: false,
      rendererUrl: "http://localhost:5173",
      appPath: "D:/project",
      execPath: "D:/electron.exe",
      args: [".", "--instance-tag=test", "--user-data-dir=D:/profile"],
      pid: 12,
      parentPid: 10,
      logPath: "D:/logs/restart.log",
    },
    { relaunch, spawn },
  );
  expect(relaunch).not.toHaveBeenCalled();
  const call = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
  expect(call[1]).toContain("12");
  expect(call[1]).toContain("10");
  expect(call[1]).toContain("--instance-tag=test");
  expect(call[2].env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(child.unref).toHaveBeenCalled();
  expect(child.send).toHaveBeenCalledWith("restart", expect.any(Function));
});

test("a failed developer helper rejects instead of relaunching without its server", async () => {
  const child = Object.assign(new EventEmitter(), {
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
  });
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  });
  const relaunch = vi.fn();
  await expect(
    restartAfterLibraryMove(
      {
        isPackaged: false,
        rendererUrl: "http://localhost:5173",
        appPath: "D:/project",
        execPath: "D:/electron.exe",
        args: ["."],
        pid: 12,
        parentPid: 10,
        logPath: "D:/restart.log",
      },
      { spawn, relaunch },
    ),
  ).rejects.toThrow("spawn failed");
  expect(relaunch).not.toHaveBeenCalled();
  expect(child.send).not.toHaveBeenCalled();
});
