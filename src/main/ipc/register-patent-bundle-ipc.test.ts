import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import type { PatentBundleResult } from "../../shared/ipc/patent-bundle.js";
import { DEFAULT_PATENT_TEMPLATE_SETTINGS } from "../../shared/settings/model.js";
import { AssetStore } from "../library/asset-store.js";
import type { LibraryDatabase } from "../library/library-database.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { PatentService } from "../library/patent-service.js";
import type { RegisterLibraryIpcOptions } from "../library/register-library-ipc.js";
import { registerPatentBundleIpc } from "./register-patent-bundle-ipc.js";

const dialogs = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn(), confirm: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: {
    showSaveDialog: dialogs.save,
    showOpenDialog: dialogs.open,
    showMessageBox: dialogs.confirm,
  },
}));
let root: string;
let database: LibraryDatabase;
afterEach(async () => {
  database?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

test.each(["patdoc", "docx", "pdf"] as const)(
  "exports combined %s files and a batch through the library IPC",
  async (format) => {
    root = await mkdtemp(join(tmpdir(), "bundle-ipc-"));
    const prepared = await new LibraryMigrationService(join(root, "library")).prepare();
    if (prepared.status !== "ready") throw new Error("fixture");
    database = prepared.database;
    const assets = new AssetStore({ root: join(root, "library"), database });
    const patents = new PatentService({ database, assetStore: assets });
    const a = await patents.create({
      name: "相同名称",
      patentType: "invention",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const b = await patents.create({
      name: "相同名称",
      patentType: "utility-model",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    const handlers = new Map<
      string,
      (event: unknown, input?: unknown) => Promise<PatentBundleResult>
    >();
    const options: Pick<
      RegisterLibraryIpcOptions,
      "patents" | "assetStore" | "flowcharts" | "readOnly"
    > = { patents, assetStore: assets };
    registerPatentBundleIpc(
      (channel, handler) => handlers.set(channel, handler),
      options,
      async () => Buffer.from("%PDF-test"),
    );
    const entries = [a, b].map((p) => ({ patentId: p.patentId, expectedRevision: p.revision }));
    const event = { sender: {} };
    dialogs.confirm.mockResolvedValue({ response: 1 });
    const single = join(root, `one.${format}`);
    dialogs.save.mockResolvedValue({ canceled: false, filePath: single });
    const exportHandler = handlers.get(IPC_CHANNELS.patentsExportBundle)!;
    expect(await exportHandler(event, { format, patents: entries.slice(0, 1) })).toEqual({
      ok: true,
      value: { count: 1, path: single },
    });
    expect((await readFile(single)).length).toBeGreaterThan(0);
    const zip = join(root, "batch.zip");
    dialogs.save.mockResolvedValue({ canceled: false, filePath: zip });
    expect(await exportHandler(event, { format, patents: entries })).toEqual({
      ok: true,
      value: { count: 2, path: zip },
    });
    dialogs.open.mockResolvedValue({ canceled: false, filePaths: [zip] });
    const imported = await handlers.get(IPC_CHANNELS.patentsImportBundle)!(event);
    if (format === "pdf") {
      expect(imported.ok).toBe(false);
      expect(await patents.list("active")).toHaveLength(2);
    } else {
      expect(imported).toEqual({ ok: true, value: { count: 2 } });
      expect(await patents.list("active")).toHaveLength(4);
    }
    if (format !== "patdoc") {
      const invalid = structuredClone(a.patent);
      const paragraph = invalid.books
        .find((book) => book.kind === "claims")
        ?.document.content.find((block) => block.type === "paragraph");
      if (!paragraph || paragraph.type !== "paragraph") throw new Error("claims fixture");
      paragraph.content = [{ type: "text", text: "10000. 一种装置。", marks: [] }];
      const load = vi.spyOn(patents, "loadForExport").mockResolvedValue(invalid);
      dialogs.confirm.mockResolvedValueOnce({ response: 0 });
      dialogs.save.mockClear();
      expect(await exportHandler(event, { format, patents: entries })).toEqual({
        ok: true,
        value: null,
      });
      expect(dialogs.save).not.toHaveBeenCalled();
      expect(dialogs.confirm).toHaveBeenCalled();
      load.mockRestore();
    }
    dialogs.save.mockClear();
    expect(
      await exportHandler(event, { format, patents: [{ ...entries[0], expectedRevision: 999 }] }),
    ).toMatchObject({ ok: false });
    expect(dialogs.save).not.toHaveBeenCalled();
    dialogs.save.mockResolvedValue({ canceled: true });
    expect(await exportHandler(event, { format, patents: entries })).toEqual({
      ok: true,
      value: null,
    });
    options.readOnly = true;
    const before = patents.loadSavedPatent(a.patentId);
    const readonlyPath = join(root, `read-only.${format}`);
    dialogs.save.mockResolvedValue({ canceled: false, filePath: readonlyPath });
    expect(await exportHandler(event, { format, patents: entries.slice(0, 1) })).toEqual({
      ok: true,
      value: { count: 1, path: readonlyPath },
    });
    expect((await readFile(readonlyPath)).length).toBeGreaterThan(0);
    expect(patents.loadSavedPatent(a.patentId)).toEqual(before);
    expect(await handlers.get(IPC_CHANNELS.patentsImportBundle)!(event)).toMatchObject({
      ok: false,
      error: { code: "READ_ONLY_RECOVERY" },
    });
  },
);
