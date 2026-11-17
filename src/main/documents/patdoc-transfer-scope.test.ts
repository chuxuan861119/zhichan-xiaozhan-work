import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";
import yazl from "yazl";
import { createPatdocFidelityPayload } from "../../../tests/fixtures/patdoc-fidelity.js";
import { FileService } from "./file-service.js";
import type { PatentPatdocPayload } from "./patdoc-format.js";
import { encodePatdocHistory } from "./patdoc-history.js";
import { readPatdoc } from "./patdoc-reader.js";
import { portablePatdocPayload } from "./patdoc-transfer-scope.js";
import { writePatdoc } from "./patdoc-writer.js";

test("portable payload excludes superseded resources without changing the source or history", async () => {
  const payload = await createPatdocFidelityPayload();
  const first = payload.assets[0];
  if (!first) throw new Error("fixture");
  const unused = structuredClone(first);
  unused.descriptor.assetId = "00000000-0000-4000-8000-000000000999";
  payload.patent.assets.push(unused.descriptor);
  payload.assets.push(unused);
  const result = portablePatdocPayload(payload);
  expect(result.assets).toHaveLength(1);
  expect(result.patent.assets).toHaveLength(1);
  expect(payload.assets).toHaveLength(2);
  expect(payload.patent.assets).toHaveLength(2);
});

test("old unused CAD-sized resources cannot push a small current export over the archive limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "patdoc-surplus-capacity-"));
  try {
    const payload = await createPatdocFidelityPayload();
    const unusedBytes = new Uint8Array(32 * 1024 * 1024);
    const digest = createHash("sha256").update(unusedBytes).digest("hex").toUpperCase();
    const first = payload.assets[0];
    if (!first) throw new Error("fixture");
    for (let i = 0; i < 10; i++) {
      const old = {
        ...first,
        original: unusedBytes,
        descriptor: {
          ...first.descriptor,
          assetId: `00000000-0000-4000-8000-${(2000 + i).toString(16).padStart(12, "0")}`,
          byteLength: unusedBytes.length,
          sha256: digest,
        },
      };
      payload.patent.assets.push(old.descriptor);
      payload.assets.push(old);
    }
    const path = join(root, "small-current.patdoc");
    const saved = await new FileService().savePatent(path, payload);
    expect(saved.ok).toBe(true);
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.assets).toHaveLength(1);
    expect(restored.patent.books).toEqual(payload.patent.books);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PATDOC exports current editable content without snapshots or DOCX import reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "patdoc-transfer-scope-"));
  try {
    const payload = await createPatdocFidelityPayload();
    const original = structuredClone(payload);
    payload.snapshots = [
      { ...structuredClone(payload), createdAt: payload.patent.createdAt, source: "manual-create" },
    ];
    const path = join(root, "current.patdoc");
    expect((await new FileService().savePatent(path, payload)).ok).toBe(true);
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.snapshots).toBeUndefined();
    expect(restored.patent.docxImportReport).toBeNull();
    expect(restored.patent).toEqual({ ...original.patent, docxImportReport: null });
    expect(restored.assets.map((a) => a.descriptor)).toEqual(
      original.assets.map((a) => a.descriptor),
    );
    expect(Buffer.from(restored.assets[0]!.original)).toEqual(
      Buffer.from(original.assets[0]!.original),
    );
    expect(Buffer.from(restored.assets[0]!.preview)).toEqual(
      Buffer.from(original.assets[0]!.preview),
    );
    for (const item of restored.flowcharts!) {
      expect(Buffer.from(item.source)).toEqual(
        Buffer.from(
          original.flowcharts!.find((source) => source.projectId === item.projectId)!.source,
        ),
      );
    }
    expect(payload.patent.docxImportReport).toEqual(original.patent.docxImportReport);
    expect(payload.snapshots).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function archiveEntries(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("missing archive"));
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error ?? new Error("missing stream"));
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}

test("legacy PATDOC history and reports are validated but excluded from imported payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "patdoc-legacy-scope-"));
  try {
    const payload = await createPatdocFidelityPayload();
    payload.snapshots = [
      { ...structuredClone(payload), createdAt: payload.patent.createdAt, source: "manual-create" },
    ];
    const current = join(root, "current.patdoc");
    await writePatdoc(current, payload);
    const entries = await archiveEntries(current);
    expect([...entries.keys()].some((name) => name.startsWith("history/"))).toBe(false);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString());
    const reference = (path: string, bytes: Buffer) => ({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
      byteLength: bytes.length,
    });
    const metadataPath = manifest.patent.path;
    const metadata = JSON.parse(entries.get(metadataPath)!.toString());
    metadata.docxImportReport = payload.patent.docxImportReport;
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    entries.set(metadataPath, metadataBytes);
    manifest.patent = reference(metadataPath, metadataBytes);
    for (const [name, bytes] of encodePatdocHistory(payload)) entries.set(name, bytes);
    manifest.history = reference("history/index.json", entries.get("history/index.json")!);
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const legacy = join(root, "legacy.patdoc");
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const output = createWriteStream(legacy);
      output.on("close", resolve);
      output.on("error", reject);
      zip.outputStream.on("error", reject);
      zip.outputStream.pipe(output);
      for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
      zip.end();
    });
    const imported = await readPatdoc<PatentPatdocPayload>(legacy);
    expect(imported.snapshots).toBeUndefined();
    expect(imported.patent.docxImportReport).toBeNull();
    expect(imported.patent.books).toEqual(payload.patent.books);
    expect(imported.flowcharts).toHaveLength(payload.flowcharts!.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
