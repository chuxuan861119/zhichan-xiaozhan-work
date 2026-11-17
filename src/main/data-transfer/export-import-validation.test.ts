import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_PARAGRAPH_ATTRIBUTES } from "../../shared/document/defaults.js";
import { canonicalToTiptap } from "../../shared/document/model-adapter.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { FileService } from "../documents/file-service.js";
import { DraftService } from "../drafts/draft-service.js";
import { createLibraryRuntime } from "../library/library-runtime.js";
import { FullDataExportService } from "./full-data-export-service.js";
import { ImportStagingValidator } from "./import-staging-validator.js";
import { PackageReader } from "./package-reader.js";

const roots: string[] = [];
const password = "synthetic-migration-validation-password";
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(nativeSequence = false) {
  const root = await mkdtemp(join(tmpdir(), "export-import-validation-"));
  roots.push(root);
  const libraryRoot = join(root, "Library"),
    userDataRoot = join(root, "user"),
    workRoot = join(root, "work"),
    destination = join(root, "destination");
  await Promise.all([mkdir(userDataRoot), mkdir(workRoot), mkdir(destination)]);
  const runtime = await createLibraryRuntime({
    libraryRoot,
    userDataRoot,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: false,
  });
  const opened = await runtime.patents.create({
    name: "虚构迁移校验专利",
    patentType: "invention",
    templates: DEFAULT_APP_SETTINGS.patentTemplates,
  });
  const book = opened.patent.books.find(
    (book) => book.kind === (nativeSequence ? "claims" : "description"),
  )!;
  const document = {
    ...book.document,
    content: [
      {
        id: nativeSequence ? book.document.content[0]!.id : randomUUID(),
        type: "paragraph" as const,
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [
          { type: "text" as const, text: "当前文档正常，历史快照须同样可恢复。", marks: [] },
        ],
      },
    ],
  };
  const edited = await runtime.patents.applyBookEdit({
    patentId: opened.patentId,
    sessionId: opened.sessionId,
    bookKind: book.kind,
    expectedRevision: opened.revision,
    document,
    editorState: nativeSequence
      ? { selection: { anchor: 1, head: 1 } }
      : canonicalToTiptap({ ...document, assets: [] }),
  });
  if (nativeSequence) await runtime.patents.flush(opened.patentId, edited.revision);
  else await runtime.snapshots.create(opened.patentId, "manual-create");
  await runtime.patents.release(opened.sessionId);
  if (nativeSequence) {
    const saved = await runtime.patents.open(opened.patentId);
    await runtime.patents.release(saved.sessionId);
  }
  const service = new FullDataExportService({
    applicationVersion: "1.1.1",
    database: runtime.database,
    libraryRoot,
    userDataRoot,
    workRoot,
    draftService: new DraftService(join(userDataRoot, "drafts")),
    fileService: new FileService(),
    settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
    quiescence: { acquire: async () => ({ release: async () => undefined }) },
  });
  const finalPath = join(destination, "test.zxwbackup");
  return {
    root,
    runtime,
    opened,
    service,
    workRoot,
    destination,
    finalPath,
    request: {
      operationId: randomUUID(),
      finalPath,
      password,
      passwordHint: null,
      passwordRecorded: true as const,
    },
  };
}

test("rejects a damaged unused historical snapshot before publishing and preserves the source", async () => {
  const f = await fixture();
  try {
    const damaged = Buffer.from("synthetic damaged historical snapshot");
    f.runtime.database.transaction((db) =>
      db
        .prepare("UPDATE snapshots SET payload = ? WHERE patent_id = ? AND revision = 0")
        .run(damaged, f.opened.patentId),
    );
    await expect(f.service.export(f.request)).rejects.toMatchObject({ code: "PACKAGE_TAMPERED" });
    await expect(lstat(f.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.destination)).toEqual([]);
    expect(await readdir(f.workRoot)).toEqual([]);
    const current = await f.runtime.patents.open(f.opened.patentId);
    expect(current.revision).toBe(1);
    await f.runtime.patents.release(current.sessionId);
    const payload = f.runtime.database.read(
      (db) =>
        db
          .prepare("SELECT payload FROM snapshots WHERE patent_id = ? AND revision = 0")
          .get(f.opened.patentId)!.payload as Uint8Array,
    );
    expect(Buffer.from(payload)).toEqual(damaged);
  } finally {
    await f.runtime.close();
  }
});

test("a native create edit flush reopen sequence remains recoverable", async () => {
  const f = await fixture(true);
  try {
    const result = await f.service.export(f.request);
    expect(result).toMatchObject({ fullVerificationPassed: true });
  } finally {
    await f.runtime.close();
  }
});

test("a successful export passes the real full import validator", async () => {
  const f = await fixture();
  try {
    const exported = await f.service.export(f.request);
    expect(exported.fullVerificationPassed).toBe(true);
    const extraction = join(f.root, "independent-import");
    await mkdir(extraction);
    const reader = await PackageReader.open(f.finalPath, { currentImporterVersion: "1.1.1" });
    try {
      await reader.readPublicHeader();
      await reader.unlock(password);
      const result = await reader.extractTo(extraction);
      await expect(
        new ImportStagingValidator().validate(result.stagingPath, result.manifest),
      ).resolves.toEqual(exported.summary);
    } finally {
      await reader.close();
    }
  } finally {
    await f.runtime.close();
  }
});
