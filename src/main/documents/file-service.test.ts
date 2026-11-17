import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  type FileHandle,
  link,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { DocumentRegistry } from "./document-registry.js";
import { FileService, toDocumentPatdocPayload } from "./file-service.js";
import {
  PATDOC_FORMAT_VERSION,
  type PatdocPayload,
  type PatentPatdocPayload,
} from "./patdoc-format.js";

function emptyPatentPayload(name = "原子专利"): PatentPatdocPayload {
  return {
    patent: createBlankPatent({ patentType: "invention", name }),
    assets: [],
    flowcharts: [],
  };
}

type ExtendedFileServiceConstructor = new (
  renameFile: typeof rename,
  beforeFinalTargetCheck: (targetPath: string) => Promise<void>,
  beforeNoClobberInstall: (targetPath: string) => Promise<void>,
  linkFile: typeof link,
  beforeValidatedFinalSnapshot: (targetPath: string) => Promise<void>,
  copyContents: (sourcePath: string, targetHandle: FileHandle) => Promise<void>,
  afterBackupMove: (backupPath: string) => Promise<void>,
  beforeOwnedRemoval?: (targetPath: string) => Promise<void>,
  afterOwnedSnapshot?: (recoveryPath: string) => Promise<void>,
  writePatdocFile?: (
    targetPath: string,
    payload: PatdocPayload | PatentPatdocPayload,
  ) => Promise<void>,
) => FileService;

const unsupportedLink: typeof link = async () => {
  throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" });
};

const exclusiveCopy = async (sourcePath: string, targetHandle: FileHandle) => {
  await targetHandle.writeFile(await readFile(sourcePath));
};

async function createZip(path: string, entries: Array<[string, Uint8Array]>): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of entries) zip.addBuffer(Buffer.from(bytes), name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = zip.outputStream.pipe(createWriteStream(path, { flags: "wx" }));
    output.on("close", resolve);
    output.on("error", reject);
  });
}

async function createFuturePatdoc(path: string): Promise<void> {
  await createZip(path, [
    [
      "manifest.json",
      Buffer.from(
        JSON.stringify({
          formatVersion: PATDOC_FORMAT_VERSION + 1,
          patentId: "00000000-0000-4000-8000-000000000001",
          revision: 0,
          patent: {},
          books: [],
          assets: [],
        }),
        "utf8",
      ),
    ],
  ]);
}

describe("document registry", () => {
  test("deduplicates Windows paths case-insensitively", () => {
    const registry = new DocumentRegistry();
    registry.register("session-1", "C:\\Work\\Draft.PATDOC");

    expect(registry.findSessionByPath("c:/work/draft.patdoc")).toBe("session-1");
    expect(() => registry.register("session-2", "c:\\work\\DRAFT.patdoc")).toThrow(/已打开/u);
    registry.release("session-1");
    expect(registry.findSessionByPath("C:\\WORK\\DRAFT.PATDOC")).toBeUndefined();
  });

  test("reserves a save path before I/O and can roll the reservation back", () => {
    const registry = new DocumentRegistry();
    registry.register("session-1", "C:\\Work\\first.patdoc");
    registry.register("session-2", "C:\\Work\\second.patdoc");

    expect(() => registry.reserve("session-1", "c:\\work\\SECOND.patdoc")).toThrow(/已打开/u);
    const reservation = registry.reserve("session-1", "C:\\Work\\renamed.patdoc");
    expect(registry.findSessionByPath("C:\\Work\\renamed.patdoc")).toBe("session-1");
    expect(registry.findSessionByPath("C:\\Work\\first.patdoc")).toBe("session-1");
    reservation.rollback();
    expect(registry.findSessionByPath("C:\\Work\\first.patdoc")).toBe("session-1");

    const releasedReservation = registry.reserve("session-1", "C:\\Work\\later.patdoc");
    registry.release("session-1");
    expect(() => releasedReservation.commit()).toThrow(/已释放/u);
    expect(registry.findSessionByPath("C:\\Work\\later.patdoc")).toBeUndefined();
  });
});

describe("atomic patdoc file service", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patdoc-files-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("keeps a legacy single-document payload unchanged", () => {
    const legacy: PatdocPayload = {
      document: createBlankDocument("旧普通草稿"),
      settings: { fixture: true },
      editorState: { selection: { anchor: 1, head: 1 } },
      assets: [],
    };

    expect(toDocumentPatdocPayload(legacy)).toBe(legacy);
  });

  test("writes, verifies, and reopens a complete patent aggregate", async () => {
    const service = new FileService();
    const path = join(directory, "patent.patdoc");
    const payload = emptyPatentPayload("折叠式支架");

    const saved = await service.savePatent(path, payload);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const reopened = await service.openPatent(path);
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (reopened.ok) expect(reopened.value).toEqual(payload);
  });

  test("writes, verifies, and reopens a standalone library document", async () => {
    const service = new FileService();
    const path = join(directory, "document.patdoc");
    const payload: PatdocPayload = {
      document: createBlankDocument("定时备份文档"),
      settings: { backupSource: { documentType: "library_document" } },
      editorState: { selection: { anchor: 1, head: 1 } },
      assets: [],
    };

    const saved = await service.saveDocument(path, payload);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const reopened = await service.openDocument(path);
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (reopened.ok) expect(reopened.value).toEqual(payload);
    expect((await service.openPatent(path)).ok).toBe(false);
  });

  test("maps a current patent aggregate to its active book for legacy document callers", async () => {
    const service = new FileService();
    const path = join(directory, "current-patent-draft.patdoc");
    const payload = emptyPatentPayload("历史专利草稿");
    const activeBook = payload.patent.books.find(
      (book) => book.kind === payload.patent.activeBookKind,
    );
    expect(activeBook).toBeDefined();
    expect((await service.savePatent(path, payload)).ok).toBe(true);

    const reopened = await service.openDocument(path);

    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (!reopened.ok || !activeBook) return;
    expect(reopened.value).toEqual({
      document: {
        ...activeBook.document,
        documentId: payload.patent.patentId,
        title: payload.patent.name,
        patentType: payload.patent.patentType,
        createdAt: payload.patent.createdAt,
        modifiedAt: payload.patent.modifiedAt,
        assets: payload.patent.assets,
      },
      settings: {},
      editorState: activeBook.editorState,
      assets: payload.assets,
    });
  });

  test("writes, verifies, replaces, and reopens a document", async () => {
    const renameCalls: Array<[string, string]> = [];
    const service = new FileService(async (from, to) => {
      renameCalls.push([from, to]);
      await rename(from, to);
    });
    const path = join(directory, "draft.patdoc");
    const first = emptyPatentPayload("第一版");
    const second = emptyPatentPayload("第二版");

    const firstSave = await service.savePatent(path, first);
    expect(firstSave.ok, JSON.stringify(firstSave)).toBe(true);
    if (firstSave.ok) expect(firstSave.value.previousVersionRetained).toBe(false);
    const firstBytes = await readFile(path);
    const secondSave = await service.savePatent(path, second);
    expect(secondSave.ok, JSON.stringify(secondSave)).toBe(true);
    if (secondSave.ok) expect(secondSave.value.previousVersionRetained).toBe(true);
    const reopened = await service.openPatent(path);

    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.patent.name).toBe("第二版");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]?.[0]).toBe(path);
    expect(renameCalls[0]?.[1]).toMatch(/\.bak$/u);
    const names = await readdir(directory);
    expect(names).toContain("draft.patdoc");
    const recoveryNames = names.filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames).toHaveLength(1);
    expect(await readFile(join(directory, recoveryNames[0] ?? ""))).toEqual(firstBytes);
  });

  test("maps a future file version without treating it as generic corruption", async () => {
    const service = new FileService();
    const path = join(directory, "future-version.patdoc");
    await createFuturePatdoc(path);
    const result = await service.openPatent(path);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: "此文件由更新版本的软件创建。当前版本不会覆盖它。",
        nextAction: "请使用更新版本打开，或另存为其他文件。",
      },
    });
  });

  test("leaves an existing target untouched when resource validation fails", async () => {
    const service = new FileService();
    const path = join(directory, "protected.patdoc");
    await writeFile(path, "existing target");
    const payload = emptyPatentPayload("无效资源");
    const bytes = Uint8Array.from([1, 2, 3]);
    const assetId = "00000000-0000-4000-8000-000000000701";
    const descriptor = {
      assetId,
      kind: "image" as const,
      originalName: "drawing.png",
      mediaType: "image/png" as const,
      extension: "png" as const,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
      widthPx: 1,
      heightPx: 1,
      previewByteLength: bytes.byteLength,
      previewSha256: "0".repeat(64),
    };
    payload.patent.assets = [descriptor];
    payload.assets = [{ descriptor, original: bytes, preview: bytes }];

    const result = await service.savePatent(path, payload);
    expect(result.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("existing target");
  });

  test("leaves the target in place when the atomic replacement is refused", async () => {
    const locked = Object.assign(new Error("locked"), { code: "EBUSY" });
    const path = join(directory, "locked.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原内容"))).ok).toBe(true);
    const originalBytes = await readFile(path);
    const service = new FileService(async () => Promise.reject(locked));

    const result = await service.savePatent(path, emptyPatentPayload("新内容"));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "FILE_LOCKED",
        message: "文件正被其他程序占用。",
        nextAction: "请关闭占用程序后重试，或使用另存为。",
      },
    });
    expect(await readFile(path)).toEqual(originalBytes);
  });

  test("conservatively refuses to overwrite an existing target whose format is indeterminate", async () => {
    const path = join(directory, "unknown-target.patdoc");
    await writeFile(path, "not a valid patdoc");

    const result = await new FileService().savePatent(path, emptyPatentPayload("新内容"));

    expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_OVERWRITE" } });
    expect(await readFile(path, "utf8")).toBe("not a valid patdoc");
  });

  test("conservatively refuses to overwrite a valid archive with no patdoc manifest", async () => {
    const path = join(directory, "not-patdoc.patdoc");
    await createZip(path, [["readme.txt", Buffer.from("not a patdoc", "utf8")]]);
    const originalBytes = await readFile(path);

    const result = await new FileService().savePatent(path, emptyPatentPayload("新内容"));

    expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_OVERWRITE" } });
    expect(await readFile(path)).toEqual(originalBytes);
  });

  test("conservatively refuses to overwrite an archive with an invalid manifest", async () => {
    const path = join(directory, "invalid-manifest.patdoc");
    await createZip(path, [
      ["manifest.json", Buffer.from('{"formatVersion":1}', "utf8")],
      ["model.json", Buffer.from("{}", "utf8")],
    ]);
    const originalBytes = await readFile(path);

    const result = await new FileService().savePatent(path, emptyPatentPayload("新内容"));

    expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_OVERWRITE" } });
    expect(await readFile(path)).toEqual(originalBytes);
  });

  test("refuses replacement when the target becomes a future format after the initial check", async () => {
    const futurePath = join(directory, "future-version.patdoc");
    await createFuturePatdoc(futurePath);
    const futureBytes = await readFile(futurePath);
    const path = join(directory, "changed-before-replace.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原内容"))).ok).toBe(true);
    const service = new FileService(rename, async (targetPath) => {
      await writeFile(targetPath, futureBytes);
    });

    const result = await service.savePatent(path, emptyPatentPayload("不得覆盖未来格式"));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: "此文件由更新版本的软件创建。当前版本不会覆盖它。",
        nextAction: "请使用更新版本打开，或另存为其他文件。",
      },
    });
    expect(await readFile(path)).toEqual(futureBytes);
  });

  test("refuses replacement when a non-patdoc target changes after the initial check", async () => {
    const path = join(directory, "externally-changed.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原内容"))).ok).toBe(true);
    const service = new FileService(rename, async (targetPath) => {
      await writeFile(targetPath, "external change");
    });

    const result = await service.savePatent(path, emptyPatentPayload("不得覆盖外部修改"));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "FILE_LOCKED",
        message: "文件正被其他程序占用。",
        nextAction: "请关闭占用程序后重试，或使用另存为。",
      },
    });
    expect(await readFile(path, "utf8")).toBe("external change");
  });

  test("never overwrites a target created inside the final no-clobber install window", async () => {
    const futurePath = join(directory, "future-version.patdoc");
    await createFuturePatdoc(futurePath);
    const futureBytes = await readFile(futurePath);
    const path = join(directory, "install-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原文件"))).ok).toBe(true);
    const FileServiceWithInstallHook = FileService as unknown as new (
      renameFile: typeof rename,
      beforeFinalTargetCheck: (targetPath: string) => Promise<void>,
      beforeNoClobberInstall: (targetPath: string) => Promise<void>,
    ) => FileService;
    const service = new FileServiceWithInstallHook(
      rename,
      async () => undefined,
      async (targetPath) => {
        await writeFile(targetPath, futureBytes);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("新文件"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        nextAction: expect.stringContaining("恢复副本"),
      },
    });
    if (!result.ok) expect(result.error.nextAction).not.toContain(path);
    expect(await readFile(path)).toEqual(futureBytes);
    const artifacts = await readdir(directory);
    expect(artifacts.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(artifacts.filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  });

  test("does not accept a different current patdoc during the final validation window", async () => {
    const path = join(directory, "current-validation-race.patdoc");
    const replacementPath = join(directory, "replacement-current.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原文件"))).ok).toBe(true);
    expect(
      (await new FileService().savePatent(replacementPath, emptyPatentPayload("并发文件"))).ok,
    ).toBe(true);
    const replacementBytes = await readFile(replacementPath);
    const service = new FileService(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async (targetPath) => writeFile(targetPath, replacementBytes),
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得覆盖"));

    expect(result).toMatchObject({ ok: false, error: { code: "FILE_LOCKED" } });
    expect(await readFile(path)).toEqual(replacementBytes);
  });

  test("restores the verified backup and retains an explicit recovery copy when install fails", async () => {
    const path = join(directory, "recover-install.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原内容"))).ok).toBe(true);
    const originalBytes = await readFile(path);
    let linkCall = 0;
    const service = new FileService(
      rename,
      async () => undefined,
      async () => undefined,
      async (existingPath, newPath) => {
        linkCall += 1;
        if (linkCall === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
        await link(existingPath, newPath);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得安装"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED", nextAction: expect.stringContaining("恢复副本") },
    });
    expect(await readFile(path)).toEqual(originalBytes);
    const artifacts = await readdir(directory);
    expect(artifacts.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(artifacts.some((name) => name.endsWith(".recovery"))).toBe(true);
  });

  test("falls back to exclusive copy when hard links are unsupported for a new file", async () => {
    const path = join(directory, "copy-new.patdoc");
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      unsupportedLink,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
    );

    const result = await service.savePatent(path, emptyPatentPayload("复制新建"));

    expect(result.ok).toBe(true);
    const reopened = await service.openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("复制新建");
    expect(await readdir(directory)).toEqual(["copy-new.patdoc"]);
  });

  test("falls back to exclusive copy when hard links are unsupported for replacement", async () => {
    const path = join(directory, "copy-replace.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("复制前"))).ok).toBe(true);
    const originalBytes = await readFile(path);
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      unsupportedLink,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
    );

    const result = await service.savePatent(path, emptyPatentPayload("复制后"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.previousVersionRetained).toBe(true);
    const reopened = await service.openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("复制后");
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames).toHaveLength(1);
    expect(await readFile(join(directory, recoveryNames[0] ?? ""))).toEqual(originalBytes);
  });

  test("isolates a partial exclusive copy and restores the original target", async () => {
    const path = join(directory, "copy-failure.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("复制失败前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    let copyCall = 0;
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      unsupportedLink,
      async () => undefined,
      async (sourcePath, targetHandle) => {
        copyCall += 1;
        if (copyCall === 1) {
          await targetHandle.writeFile("partial");
          throw Object.assign(new Error("copy failed"), { code: "EIO" });
        }
        await exclusiveCopy(sourcePath, targetHandle);
      },
      async () => undefined,
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得保留部分复制"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED", nextAction: expect.stringContaining("恢复副本") },
    });
    expect(await readFile(path)).toEqual(originalBytes);
    const artifacts = await readdir(directory);
    expect(artifacts.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(artifacts.some((name) => name.endsWith(".recovery"))).toBe(true);
  });

  test("never moves or deletes a concurrent target during nested partial-copy recovery", async () => {
    const path = join(directory, "copy-cleanup-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("清理竞态前"))).ok).toBe(
      true,
    );
    const concurrentBytes = Buffer.from("concurrent target", "utf8");
    const secondConcurrentBytes = Buffer.from("second concurrent target", "utf8");
    const displacedPartial = join(directory, "displaced-partial");
    const displacedRecoveryPartial = join(directory, "displaced-recovery-partial");
    let copyCall = 0;
    let targetIsolation = 0;
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      unsupportedLink,
      async () => undefined,
      async (sourcePath, targetHandle) => {
        copyCall += 1;
        if (copyCall === 1 || copyCall === 2) {
          await targetHandle.writeFile("partial");
          throw Object.assign(new Error("copy failed"), { code: "EIO" });
        }
        await exclusiveCopy(sourcePath, targetHandle);
      },
      async () => undefined,
      async (targetPath) => {
        if (targetPath !== path) return;
        targetIsolation += 1;
        if (targetIsolation === 1) {
          await rename(targetPath, displacedPartial);
          await writeFile(targetPath, concurrentBytes);
        } else if (targetIsolation === 2) {
          await rename(targetPath, displacedRecoveryPartial);
          await writeFile(targetPath, secondConcurrentBytes);
        }
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得误删并发文件"));

    expect(result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(await readFile(path)).toEqual(secondConcurrentBytes);
    expect(await readFile(displacedPartial, "utf8")).toBe("partial");
    expect(await readFile(displacedRecoveryPartial, "utf8")).toBe("partial");
    expect((await readdir(directory)).some((name) => name.endsWith(".bak"))).toBe(true);
  });

  test("retains a concurrently replaced backup instead of deleting or restoring it", async () => {
    const path = join(directory, "backup-cleanup-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("备份竞态前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    const concurrentBackupBytes = Buffer.from("concurrent backup", "utf8");
    const retainedOriginalBackup = join(directory, "retained-original-backup");
    let backupRemoval = 0;
    let concurrentBackupPath = "";
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
      async (targetPath) => {
        if (!targetPath.endsWith(".bak")) return;
        backupRemoval += 1;
        if (backupRemoval !== 1) return;
        concurrentBackupPath = targetPath;
        await rename(targetPath, retainedOriginalBackup);
        await writeFile(targetPath, concurrentBackupBytes);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("已安装的新内容"));

    expect(result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    await expect(readFile(concurrentBackupPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(retainedOriginalBackup)).toEqual(originalBytes);
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    const recoveryBytes = await Promise.all(
      recoveryNames.map((name) => readFile(join(directory, name))),
    );
    expect(recoveryBytes.some((bytes) => bytes.equals(concurrentBackupBytes))).toBe(true);
    const reopened = await new FileService().openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("已安装的新内容");
  });

  test("retains a backup mutated in place after the new target is installed", async () => {
    const path = join(directory, "backup-in-place-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("原备份内容"))).ok).toBe(
      true,
    );
    let backupRemoval = 0;
    let mutatedBackupBytes = Buffer.alloc(0);
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
      async (targetPath) => {
        if (!targetPath.endsWith(".bak")) return;
        backupRemoval += 1;
        if (backupRemoval !== 1) return;
        const handle = await open(targetPath, "r+");
        try {
          await handle.write(Buffer.from("same-inode mutation", "utf8"), 0, 19, 0);
          await handle.sync();
        } finally {
          await handle.close();
        }
        mutatedBackupBytes = await readFile(targetPath);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("已安装目标"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED", nextAction: expect.stringContaining("恢复副本") },
    });
    const reopened = await new FileService().openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("已安装目标");
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames.length).toBeGreaterThan(0);
    const recoveryBytes = await Promise.all(
      recoveryNames.map((name) => readFile(join(directory, name))),
    );
    expect(recoveryBytes.some((bytes) => bytes.equals(mutatedBackupBytes))).toBe(true);
  });

  test("retains and reports a backup mutated after the final isolated snapshot", async () => {
    const path = join(directory, "backup-final-snapshot-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("最终快照前"))).ok).toBe(
      true,
    );
    let mutatedRecoveryBytes = Buffer.alloc(0);
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
      async () => undefined,
      async (recoveryPath) => {
        const mutation = Buffer.from("post-snapshot mutation", "utf8");
        const handle = await open(recoveryPath, "r+");
        try {
          await handle.write(mutation, 0, mutation.byteLength, 0);
          await handle.sync();
        } finally {
          await handle.close();
        }
        mutatedRecoveryBytes = await readFile(recoveryPath);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("最终快照后的新目标"));

    expect(result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    const reopened = await new FileService().openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("最终快照后的新目标");
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames).toHaveLength(1);
    expect(await readFile(join(directory, recoveryNames[0] ?? ""))).toEqual(mutatedRecoveryBytes);
  });

  test("restores the original when backup verification itself fails", async () => {
    const path = join(directory, "backup-check-failure.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("校验失败前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    const ServiceWithCopy = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithCopy(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async () => undefined,
      exclusiveCopy,
      async () => {
        throw Object.assign(new Error("backup read failed"), { code: "EIO" });
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得丢失原文件"));

    expect(result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(await readFile(path)).toEqual(originalBytes);
    const artifacts = await readdir(directory);
    expect(artifacts.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(artifacts.some((name) => name.endsWith(".recovery"))).toBe(true);
  });

  test("recovers a unique crash backup before continuing the requested save", async () => {
    const path = join(directory, "crash-recovery.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("崩溃前"))).ok).toBe(true);
    const originalBytes = await readFile(path);
    const backupPath = join(
      directory,
      ".crash-recovery.patdoc.00000000-0000-4000-8000-000000000999.bak",
    );
    await rename(path, backupPath);

    const result = await new FileService().savePatent(path, emptyPatentPayload("恢复后"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.previousVersionRetained).toBe(true);
    const reopened = await new FileService().openPatent(path);
    expect(reopened.ok && reopened.value.patent.name).toBe("恢复后");
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames.length).toBeGreaterThan(0);
    const recoveryBytes = await Promise.all(
      recoveryNames.map((name) => readFile(join(directory, name))),
    );
    expect(recoveryBytes.every((bytes) => bytes.equals(originalBytes))).toBe(true);
  });

  test("restores a crash backup before a temporary write runs out of disk space", async () => {
    const path = join(directory, "crash-before-temp-write.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("临时写入前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    const backupPath = join(
      directory,
      ".crash-before-temp-write.patdoc.00000000-0000-4000-8000-000000000991.bak",
    );
    await rename(path, backupPath);
    const ServiceWithWriter = FileService as unknown as ExtendedFileServiceConstructor;
    const service = new ServiceWithWriter(
      rename,
      async () => undefined,
      async () => undefined,
      link,
      async () => undefined,
      exclusiveCopy,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得丢失旧文件"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "DISK_FULL", nextAction: expect.stringContaining("释放空间") },
    });
    expect(await readFile(path)).toEqual(originalBytes);
    const recoveryNames = (await readdir(directory)).filter((name) => name.endsWith(".recovery"));
    expect(recoveryNames.length).toBeGreaterThan(0);
  });

  test("keeps restored crash bytes at the target when the later install fails", async () => {
    const path = join(directory, "crash-before-install.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("安装失败前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    const backupPath = join(
      directory,
      ".crash-before-install.patdoc.00000000-0000-4000-8000-000000000992.bak",
    );
    await rename(path, backupPath);
    let linkCall = 0;
    const service = new FileService(
      rename,
      async () => undefined,
      async () => undefined,
      async (existingPath, newPath) => {
        linkCall += 1;
        if (linkCall === 2) throw Object.assign(new Error("locked"), { code: "EBUSY" });
        await link(existingPath, newPath);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("安装不得破坏恢复文件"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED", nextAction: expect.stringContaining("恢复副本") },
    });
    expect(await readFile(path)).toEqual(originalBytes);
    expect((await readdir(directory)).some((name) => name.endsWith(".recovery"))).toBe(true);
  });

  test("never overwrites a target created while restoring a crash backup", async () => {
    const path = join(directory, "crash-restore-race.patdoc");
    expect((await new FileService().savePatent(path, emptyPatentPayload("恢复竞态前"))).ok).toBe(
      true,
    );
    const originalBytes = await readFile(path);
    const backupPath = join(
      directory,
      ".crash-restore-race.patdoc.00000000-0000-4000-8000-000000000993.bak",
    );
    await rename(path, backupPath);
    const concurrentBytes = Buffer.from("concurrent recovery target", "utf8");
    let linkCall = 0;
    const service = new FileService(
      rename,
      async () => undefined,
      async () => undefined,
      async (existingPath, newPath) => {
        linkCall += 1;
        if (linkCall === 1) await writeFile(newPath, concurrentBytes);
        await link(existingPath, newPath);
      },
    );

    const result = await service.savePatent(path, emptyPatentPayload("不得覆盖并发目标"));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED", nextAction: expect.stringContaining("恢复副本") },
    });
    if (!result.ok) expect(result.error.nextAction).not.toContain(path);
    expect(await readFile(path)).toEqual(concurrentBytes);
    expect(await readFile(backupPath)).toEqual(originalBytes);
  });
});
