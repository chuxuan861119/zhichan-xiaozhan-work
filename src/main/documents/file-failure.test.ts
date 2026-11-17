import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { normalizeAppError } from "../../shared/ipc/result.js";
import { FileService, mapFileError } from "./file-service.js";
import { PATDOC_FORMAT_VERSION, PatdocError, type PatdocPayload } from "./patdoc-format.js";

const payload = (): PatdocPayload => ({
  document: createBlankDocument("安全保存"),
  settings: {},
  editorState: {},
  assets: [],
});

async function createFuturePatdoc(path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: PATDOC_FORMAT_VERSION + 1,
        documentId: "00000000-0000-4000-8000-000000000001",
        assets: [],
      }),
      "utf8",
    ),
    "manifest.json",
  );
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = zip.outputStream.pipe(createWriteStream(path, { flags: "wx" }));
    output.on("close", resolve);
    output.on("error", reject);
  });
}

describe("Windows file failures", () => {
  test.each([
    ["EACCES", "NO_PERMISSION"],
    ["EPERM", "NO_PERMISSION"],
    ["EBUSY", "FILE_LOCKED"],
    ["ETXTBSY", "FILE_LOCKED"],
    ["ENOSPC", "DISK_FULL"],
    ["ENOENT", "NOT_FOUND"],
  ] as const)("maps %s to %s without exposing the original error", (nativeCode, appCode) => {
    const native = Object.assign(new Error("C:\\Users\\Alice\\secret.patdoc raw failure"), {
      code: nativeCode,
    });

    const result = mapFileError(native);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(appCode);
      expect(result.error.message).not.toContain("Alice");
      expect(result.error.message).not.toContain("raw failure");
    }
  });

  test("maps missing archive assets to a safe corruption error", () => {
    const result = mapFileError(new PatdocError("RESOURCE_MISMATCH", "missing secret-image.png"));

    expect(result).toEqual({
      ok: false,
      error: normalizeAppError({ code: "CORRUPT_FILE", message: "ignored" }),
    });
  });

  test.each([
    ["FILE_LOCKED", "文件正被其他程序占用。", "请关闭占用程序后重试，或使用另存为。"],
    ["DISK_FULL", "磁盘空间不足。原文件没有被修改。", "请释放空间后重试。"],
    [
      "UNSUPPORTED_VERSION",
      "此文件由更新版本的软件创建。当前版本不会覆盖它。",
      "请使用更新版本打开，或另存为其他文件。",
    ],
    ["EXPORT_FAILED", "导出未完成。原文档没有被修改。", "请检查导出报告和目标位置后重试。"],
    ["INTERNAL", "本地操作失败。", "请重试；如果问题持续，请重新启动应用。"],
  ] as const)("normalizes %s to one safe message and next action", (code, message, nextAction) => {
    expect(normalizeAppError({ code, message: "raw stack and user content" })).toEqual({
      code,
      message,
      nextAction,
    });
  });
});

describe("future-format overwrite protection", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patent-future-save-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("never overwrites a future-format target", async () => {
    const target = join(directory, "future-version.patdoc");
    await createFuturePatdoc(target);
    const original = await readFile(target);

    const result = await new FileService().saveDocument(target, payload());

    expect(result).toEqual({
      ok: false,
      error: normalizeAppError({ code: "UNSUPPORTED_VERSION", message: "ignored" }),
    });
    expect(await readFile(target)).toEqual(original);
  });
});
