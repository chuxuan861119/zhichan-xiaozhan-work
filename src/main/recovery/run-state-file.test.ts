import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RunStateFile } from "./run-state-file.js";

const roots: string[] = [];

async function stateFile() {
  const root = await mkdtemp(join(tmpdir(), "patent-run-state-"));
  roots.push(root);
  return join(root, "last-run-state.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RunStateFile", () => {
  test("distinguishes first, clean, and unclean application runs", async () => {
    const path = await stateFile();
    const first = new RunStateFile(path, {
      now: () => new Date("2026-08-10T08:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000001",
    });

    await expect(first.begin("0.1.0")).resolves.toMatchObject({
      previousShutdown: "first-run",
      runId: "00000000-0000-4000-8000-000000000001",
    });
    await first.markClean();

    const second = new RunStateFile(path, {
      now: () => new Date("2026-08-10T09:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000002",
    });
    await expect(second.begin("0.1.0")).resolves.toMatchObject({ previousShutdown: "clean" });

    const third = new RunStateFile(path, {
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000003",
    });
    await expect(third.begin("0.1.0")).resolves.toMatchObject({ previousShutdown: "unclean" });
  });

  test("treats a malformed previous marker as unknown and replaces it safely", async () => {
    const path = await stateFile();
    await writeFile(path, "{not-json", "utf8");
    const state = new RunStateFile(path, {
      now: () => new Date("2026-08-10T08:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000004",
    });

    await expect(state.begin("0.1.0")).resolves.toMatchObject({ previousShutdown: "unknown" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      runId: "00000000-0000-4000-8000-000000000004",
      cleanShutdown: false,
    });
  });

  test("stores only runtime metadata and no patent content", async () => {
    const path = await stateFile();
    const state = new RunStateFile(path, {
      now: () => new Date("2026-08-10T08:00:00.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000005",
    });

    await state.begin("0.1.0");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("patent");
    expect(Object.keys(JSON.parse(raw))).toEqual([
      "version",
      "runId",
      "appVersion",
      "startedAt",
      "cleanShutdown",
      "finishedAt",
    ]);
  });

  test("does not report a clean shutdown before a run has begun", async () => {
    const state = new RunStateFile(await stateFile());

    await expect(state.markClean()).rejects.toThrow("运行尚未开始");
  });
});
