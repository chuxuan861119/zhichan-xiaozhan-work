// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { IPC_CHANNELS, PRELOAD_INVOKE_CHANNELS } from "../../shared/ipc/contract.js";
import { createTutorialSession, readTutorialSession, tutorialAllowsChannel } from "./session.js";

describe("tutorial isolation", () => {
  test("derives fresh private paths without importing parent configuration", async () => {
    const first = await createTutorialSession("clear-format");
    const second = await createTutorialSession("figure-sort");
    try {
      expect(first.root).not.toBe(second.root);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(readTutorialSession([`--tool-tutorial=${first.root}`])).toEqual(first);
      for (const key of ["userData", "library", "localAppData", "cliHome"] as const)
        expect(first[key]).toBe(join(first.root, key));
      expect(readTutorialSession([])).toBeNull();
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });
  test("malformed or redirected tutorial startup fails closed", async () => {
    const session = await createTutorialSession("clear-format");
    const foreign = await mkdtemp(join(tmpdir(), "foreign-profile-"));
    try {
      expect(() => readTutorialSession(["--tool-tutorial="])).toThrow();
      expect(() => readTutorialSession([`--tool-tutorial=${foreign}`])).toThrow();
      const path = join(session.root, "session.json");
      const data = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...data, library: foreign }));
      expect(() => readTutorialSession([`--tool-tutorial=${session.root}`])).toThrow();
    } finally {
      await rm(session.root, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    }
  });
  test("denies external side effects and unknown channels by default", () => {
    for (const channel of PRELOAD_INVOKE_CHANNELS) {
      if (
        /^(exports:|data-transfer:|ai-correction:|text-polish:|automation:|backup:)/u.test(channel)
      )
        expect(tutorialAllowsChannel(channel)).toBe(false);
    }
    for (const channel of [
      IPC_CHANNELS.documentsOpenPath,
      IPC_CHANNELS.patentsOpenPath,
      IPC_CHANNELS.libraryImportPatdoc,
      IPC_CHANNELS.applicationRelocateLibrary,
      IPC_CHANNELS.assetsChooseAndImport,
      IPC_CHANNELS.settingsUpdate,
      "future:new-sensitive-operation",
    ])
      expect(tutorialAllowsChannel(channel)).toBe(false);
    expect(tutorialAllowsChannel(IPC_CHANNELS.patentsApplyBookEdit)).toBe(true);
    expect(tutorialAllowsChannel(IPC_CHANNELS.patentsApplyFigureEdit)).toBe(true);
    expect(tutorialAllowsChannel(IPC_CHANNELS.applicationRequestQuit)).toBe(true);
  });
});
