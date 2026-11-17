// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TutorialLauncher } from "./launcher.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
class Child extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  unref = vi.fn();
  exit() {
    this.connected = false;
    this.exitCode = 0;
    this.emit("exit", 0);
  }
}
const children: Child[] = [];
const roots: string[] = [];
beforeEach(() => {
  mocked.spawn.mockReset();
  mocked.spawn.mockImplementation((_executable: string, args: string[]) => {
    const root = args
      .find((argument) => argument.startsWith("--tool-tutorial="))
      ?.slice("--tool-tutorial=".length);
    if (!root) throw new Error("No isolated root");
    roots.push(root);
    const child = new Child();
    children.push(child);
    void readFile(join(root, "session.json"), "utf8").then((json) => {
      const manifest = JSON.parse(json);
      return writeFile(
        join(root, "ready.json"),
        JSON.stringify({ ready: true, sessionId: manifest.sessionId }),
      );
    });
    return child;
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.exit();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function launcher() {
  return new TutorialLauncher({
    executable: "/test/electron",
    entry: "/test/app",
    environment: {
      ELECTRON_RUN_AS_NODE: "1",
      LOCALAPPDATA: "/normal",
      PATENT_WORKBENCH_LIBRARY_ROOT: "/normal/library",
      ZXW_HOME: "/normal/cli",
    },
    timeoutMs: 500,
  });
}
describe("tutorial launcher", () => {
  test("coalesces simultaneous launch requests and focuses the existing exercise", async () => {
    const service = launcher();
    await Promise.all([service.launch("clear-format"), service.launch("figure-sort")]);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const options = mocked.spawn.mock.calls[0]?.[2];
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.LOCALAPPDATA).toBe(join(roots[0]!, "localAppData"));
    expect(options.env.ZXW_HOME).toBe(join(roots[0]!, "cliHome"));
    await service.launch("cad-label");
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(roots[0]!, "command.json"), "utf8")).command).toBe(
      "focus",
    );
  });
  test("re-entry after exit starts from a new private session", async () => {
    const service = launcher();
    await service.launch("clear-format");
    children[0]?.exit();
    await service.launch("clear-format");
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    expect(roots[1]).not.toBe(roots[0]);
  });
  test("startup failure rejects the request and permits a fresh retry", async () => {
    mocked.spawn.mockImplementationOnce((_executable: string, args: string[]) => {
      const root = args
        .find((argument) => argument.startsWith("--tool-tutorial="))!
        .slice("--tool-tutorial=".length);
      roots.push(root);
      const child = new Child();
      children.push(child);
      queueMicrotask(() => child.exit());
      return child;
    });
    const service = launcher();
    await expect(service.launch("clear-format")).rejects.toThrow("准备失败");
    await expect(service.launch("clear-format")).resolves.toBeUndefined();
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
  });
});
