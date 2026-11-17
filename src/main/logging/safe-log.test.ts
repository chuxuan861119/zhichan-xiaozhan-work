import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeLogger, redactWindowsPath } from "./safe-log.js";

describe("safe operational logging", () => {
  test("persists correction response metadata without arbitrary response or credential fields", async () => {
    const logger = createSafeLogger(directory, "0.1.0");
    expect(
      await logger.log("info", {
        event: "ai.correction_response",
        aiCorrection: {
          attempt: 1,
          finishReason: "stop",
          reasoningCharacters: 1240,
          contentCharacters: 0,
          streamCompleted: true,
          content: "private-document",
          apiKey: "private-key",
        },
        model: "private-model",
        reasoning: "private-reasoning",
      }),
    ).toBe(true);
    const text = await readFile(join(directory, "app.log"), "utf8");
    expect(JSON.parse(text).aiCorrection).toEqual({
      attempt: 1,
      finishReason: "stop",
      reasoningCharacters: 1240,
      contentCharacters: 0,
      streamCompleted: true,
    });
    expect(text).not.toContain("private-");
  });

  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patent-safe-log-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("writes only allow-listed operational fields and redacts Windows paths", async () => {
    const logger = createSafeLogger(directory, "0.1.0", () => new Date("2026-08-01T00:00:00.000Z"));
    const secrets = {
      canonicalText: "一种绝不能进入日志的专利装置",
      clipboardText: "剪贴板里的客户秘密",
      formulaSource: "\\frac{秘密}{2}",
      fullPath: "C:\\Users\\Alice\\案件\\绝密申请书.patdoc",
      imageBytes: Uint8Array.from([137, 80, 78, 71, 99, 42]),
    };

    expect(
      await logger.log("error", {
        event: "document.save_failed",
        errorCode: "DISK_FULL",
        path: secrets.fullPath,
        ...secrets,
      } as never),
    ).toBe(true);

    const text = await readFile(join(directory, "app.log"), "utf8");
    const record = JSON.parse(text.trim());
    expect(record).toEqual({
      timestamp: "2026-08-01T00:00:00.000Z",
      level: "error",
      event: "document.save_failed",
      appVersion: "0.1.0",
      errorCode: "DISK_FULL",
      redactedPath: "<drive>:\\…\\绝密申请书.patdoc",
    });
    for (const secret of [
      secrets.canonicalText,
      secrets.clipboardText,
      secrets.formulaSource,
      secrets.fullPath,
      JSON.stringify([...secrets.imageBytes]),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("rejects arbitrary event text instead of turning it into log content", async () => {
    const logger = createSafeLogger(directory, "0.1.0");

    expect(
      await logger.log("info", { event: "客户正文不应成为事件名", path: "relative-secret.txt" }),
    ).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  test("persists a bounded renderer failure kind without exception text", async () => {
    const logger = createSafeLogger(directory, "0.1.0");
    expect(
      await logger.log("error", {
        event: "window.renderer_failure",
        failureKind: "type-error",
        locations: [{ bundle: "index-AbC_1234.js", line: 123, column: 45 }],
        message: "private document",
      }),
    ).toBe(true);
    const text = await readFile(join(directory, "app.log"), "utf8");
    expect(JSON.parse(text).failureKind).toBe("type-error");
    expect(JSON.parse(text).locations).toEqual([
      { bundle: "index-AbC_1234.js", line: 123, column: 45 },
    ]);
    expect(text).not.toContain("private document");
    expect(
      await logger.log("error", {
        event: "window.renderer_failure",
        failureKind: "private document",
      }),
    ).toBe(false);
    expect(
      await logger.log("error", {
        event: "window.renderer_failure",
        locations: [{ bundle: "C:\\private\\secret.js", line: 1, column: 1 }],
      }),
    ).toBe(false);
  });

  test("allows startup events without persisting raw failure details", async () => {
    const logger = createSafeLogger(directory, "0.1.0", () => new Date("2026-08-01T00:00:00.000Z"));
    const raw = "C:\\Users\\Alice\\renderer\\index.html raw stack";

    for (const event of ["app.start_failed", "window.load_failed"] as const) {
      expect(
        await logger.log("error", {
          event,
          errorCode: "INTERNAL",
          raw,
        } as never),
      ).toBe(true);
    }

    const text = await readFile(join(directory, "app.log"), "utf8");
    expect(text).not.toContain(raw);
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        level: "error",
        event: "app.start_failed",
        appVersion: "0.1.0",
        errorCode: "INTERNAL",
      },
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        level: "error",
        event: "window.load_failed",
        appVersion: "0.1.0",
        errorCode: "INTERNAL",
      },
    ]);
  });

  test("logs library events without retaining document content or full internal identifiers", async () => {
    const logger = createSafeLogger(directory, "0.1.0", () => new Date("2026-08-01T00:00:00.000Z"));
    const secrets = {
      title: "一种不能进入日志的专利标题",
      content: "实施例里的客户秘密结构",
      formula: "E=秘密",
      assetBytes: Uint8Array.from([1, 2, 3, 4]),
      fullInternalId: "00000000-0000-4000-8000-000000abcdef",
      fullPath: "C:\\Users\\Alice\\AppData\\Local\\PatentWorkbench\\Library\\library.sqlite3",
    };

    expect(
      await logger.log("info", {
        event: "library.edit_saved",
        libraryDocumentId: secrets.fullInternalId,
        revision: 42,
        path: secrets.fullPath,
        ...secrets,
      } as never),
    ).toBe(true);

    const text = await readFile(join(directory, "app.log"), "utf8");
    const record = JSON.parse(text.trim());
    expect(record).toEqual({
      timestamp: "2026-08-01T00:00:00.000Z",
      level: "info",
      event: "library.edit_saved",
      appVersion: "0.1.0",
      libraryDocumentId: "00000000…cdef",
      revision: 42,
    });
    for (const secret of [
      secrets.title,
      secrets.content,
      secrets.formula,
      secrets.fullInternalId,
      secrets.fullPath,
      JSON.stringify([...secrets.assetBytes]),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("rotates at one MiB and keeps seven local files", async () => {
    await writeFile(join(directory, "app.log"), "x".repeat(1024 * 1024));
    for (let index = 1; index <= 8; index += 1) {
      await writeFile(join(directory, `app.${index}.log`), `old-${index}`);
    }
    const logger = createSafeLogger(directory, "0.1.0");

    expect(await logger.log("info", { event: "app.started" })).toBe(true);

    const files = (await readdir(directory)).sort();
    expect(files).toEqual([
      "app.1.log",
      "app.2.log",
      "app.3.log",
      "app.4.log",
      "app.5.log",
      "app.6.log",
      "app.log",
    ]);
    expect((await stat(join(directory, "app.1.log"))).size).toBe(1024 * 1024);
  });
});

test("redacts drive and UNC paths without retaining parent directories", () => {
  expect(redactWindowsPath("D:\\客户\\案件一\\draft.patdoc")).toBe("<drive>:\\…\\draft.patdoc");
  expect(redactWindowsPath("\\\\server\\share\\客户\\draft.patdoc")).toBe(
    "<network>:\\…\\draft.patdoc",
  );
  expect(redactWindowsPath("draft.patdoc")).toBeUndefined();
});
