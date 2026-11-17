// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { LibraryLocation } from "./library-location.js";
import { createLibraryRuntime } from "./library-runtime.js";
import { SelfServiceRecovery } from "./self-service-recovery.js";

vi.mock("electron", () => ({ ipcMain: {}, dialog: {}, BrowserWindow: {} }));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "self-service-recovery-"));
  const source = join(root, "original");
  const runtime = await createLibraryRuntime({
    libraryRoot: source,
    readOnly: false,
    runRecovery: false,
    startBackgroundSchedulers: false,
  });
  await runtime.close();
  await writeFile(join(source, "original-content.txt"), "原库必须保留");
  const parent = join(root, "destination");
  await mkdir(parent);
  const before = await readFile(join(source, "library.sqlite3"));
  const location = new LibraryLocation(join(root, "settings", "location.json"), source);
  const activate = vi.fn((path: string) => location.activateRecovered(path));
  const service = new SelfServiceRecovery({ sourceRoot: source, activate });
  const payload = {
    patent: createBlankPatent({
      patentType: "invention",
      name: "可恢复专利",
      customer: "测试客户",
    }),
    assets: [],
    flowcharts: [],
  };
  return { root, source, parent, before, location, activate, service, payload };
}

test("creates and verifies a complete separate copy, then activates it only on explicit request", async () => {
  const f = await fixture();
  const prepared = await f.service.prepare(f.payload, f.parent);
  expect(f.activate).not.toHaveBeenCalled();
  expect((await f.location.status()).activeRoot).toBe(f.source);
  expect(await readFile(join(f.source, "library.sqlite3"))).toEqual(f.before);
  expect(await readFile(join(f.source, "original-content.txt"), "utf8")).toBe("原库必须保留");
  const target = await createLibraryRuntime({
    libraryRoot: prepared.libraryPath,
    readOnly: false,
    runRecovery: true,
    startBackgroundSchedulers: false,
  });
  try {
    const patents = await target.patents.list("active");
    expect(patents).toHaveLength(1);
    const copy = await target.patents.loadSavedPatent(prepared.documentId);
    expect(copy.customer).toBe("测试客户");
    expect(copy.books.map((book) => book.document.content)).toEqual(
      f.payload.patent.books.map((book) => book.document.content),
    );
    expect(copy.patentId).not.toBe(f.payload.patent.patentId);
    expect(target.recoveryReport.quarantinedPatentIds).toEqual([]);
  } finally {
    await target.close();
  }
  await f.service.activate(prepared.token);
  expect((await f.location.resolveStartup()).root).toBe(prepared.libraryPath);
  expect(await readFile(join(f.source, "library.sqlite3"))).toEqual(f.before);
  await expect(f.service.activate(prepared.token)).rejects.toThrow("失效");
});

test("rejects source overlap and arbitrary activation tokens without changing the source", async () => {
  const f = await fixture();
  await expect(f.service.prepare(f.payload, f.source)).rejects.toThrow("原文档库之外");
  await expect(f.service.activate("00000000-0000-4000-8000-000000000000")).rejects.toThrow("失效");
  expect(f.activate).not.toHaveBeenCalled();
  expect(await readFile(join(f.source, "library.sqlite3"))).toEqual(f.before);
});

test("a failed import keeps both the original library and partial recovery folder without enabling it", async () => {
  const f = await fixture();
  const description = f.payload.patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("fixture");
  description.document.content = [{
    id: "00000000-0000-4000-8000-000000000002",
    type: "chemical-structure",
    ketSource: "(ket) (atom C)",
    previewAssetId: "00000000-0000-4000-8000-000000000001",
    widthMm: 80,
    alignment: "center",
  }];
  await expect(
    f.service.prepare(
      {
        ...f.payload,
        patent: {
          ...f.payload.patent,
          assets: [
            {
              assetId: "00000000-0000-4000-8000-000000000001",
              type: "image",
              mimeType: "image/png",
            },
          ],
        },
      } as never,
      f.parent,
    ),
  ).rejects.toThrow();
  expect(await readdir(f.parent)).toHaveLength(1);
  expect(f.activate).not.toHaveBeenCalled();
  expect(await readFile(join(f.source, "library.sqlite3"))).toEqual(f.before);
});

test("rejects a recovery database corrupted after preparation and retains the active original", async () => {
  const f = await fixture();
  const prepared = await f.service.prepare(f.payload, f.parent);
  await writeFile(join(prepared.libraryPath, "library.sqlite3"), "corrupted database");
  await expect(f.service.activate(prepared.token)).rejects.toThrow();
  expect(f.activate).not.toHaveBeenCalled();
  expect((await f.location.status()).activeRoot).toBe(f.source);
});
