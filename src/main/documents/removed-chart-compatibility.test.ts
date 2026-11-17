import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yauzl from "yauzl";
import yazl from "yazl";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import {
  decodePatentRecoverySnapshot,
  encodePatentRecoverySnapshot,
  hashJson,
} from "../library/edit-journal.js";
import { encodeJson } from "../library/plaintext-codec.js";
import { parsePatentEditPayload } from "../library/recovery-service.js";
import { readPatdoc } from "./patdoc-reader.js";
import { writePatdoc } from "./patdoc-writer.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
async function entries(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("zip"));
      const result = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolveEntries(result));
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error ?? new Error("stream"));
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            result.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}
async function archive(path: string, content: Map<string, Buffer>) {
  await new Promise<void>((done, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path, { flags: "wx" });
    output.on("close", done);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const [name, bytes] of content) zip.addBuffer(bytes, name);
    zip.end();
  });
}

test("old chart archives preserve ordinary patent content and static images, without retaining chart payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "retired-chart-patdoc-"));
  try {
    const patent = createBlankPatent({ name: "保留正文及附图", patentType: "invention" });
    const original = await readFile(resolve("tests/fixtures/vector-image/patent-black-output.svg"));
    const preview = await readFile(resolve("tests/fixtures/vector-image/patent-black-output.png"));
    const descriptor: AssetDescriptor = {
      assetId: "00000000-0000-4000-8000-000000000901",
      kind: "vector-image",
      originalName: "静态图片.svg",
      mediaType: "image/svg+xml",
      extension: "svg",
      byteLength: original.length,
      sha256: hash(original),
      widthPx: 1200,
      heightPx: 800,
      previewByteLength: preview.length,
      previewSha256: hash(preview),
    };
    patent.assets = [descriptor];
    patent.figures = [
      {
        figureId: "00000000-0000-4000-8000-000000000902",
        assetId: descriptor.assetId,
        widthMm: 100,
        rotationDeg: 0,
      },
    ];
    const clean = join(root, "clean.patdoc");
    await writePatdoc(clean, { patent, assets: [{ descriptor, original, preview }] });
    const content = await entries(clean);
    const manifest = JSON.parse(content.get("manifest.json")!.toString());
    const metadata = JSON.parse(content.get(manifest.patent.path)!.toString());
    metadata.scientificChartProjects = { broken: true };
    metadata.figures[0].scientificChartLink = { broken: true };
    metadata.assets[0].kind = "scientific-chart-preview";
    const bytes = Buffer.from(JSON.stringify(metadata));
    content.set(manifest.patent.path, bytes);
    manifest.patent.sha256 = hash(bytes);
    manifest.patent.byteLength = bytes.length;
    manifest.scientificProjects = { broken: true };
    content.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    content.set(
      "scientific/00000000-0000-4000-8000-000000000903/revisions/00000000-0000-4000-8000-000000000904.json",
      Buffer.from("invalid JSON"),
    );
    const old = join(root, "old.patdoc");
    await archive(old, content);
    const loaded = await readPatdoc(old);
    if (!("patent" in loaded)) throw new Error("not patent");
    expect(loaded.patent).toEqual(patent);
    expect(loaded.assets[0]?.original).toEqual(Uint8Array.from(original));
    const saved = join(root, "saved.patdoc");
    await writePatdoc(saved, loaded);
    const savedEntries = await entries(saved);
    expect([...savedEntries.keys()].some((name) => name.startsWith("scientific/"))).toBe(false);
    expect(savedEntries.get("manifest.json")!.toString()).not.toContain("scientific");
    expect(savedEntries.get(manifest.patent.path)!.toString()).not.toContain("scientific");
    content.set(manifest.books[0].path, Buffer.from("tampered ordinary book"));
    const tampered = join(root, "tampered.patdoc");
    await archive(tampered, content);
    await expect(readPatdoc(tampered)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy recovery snapshots verify their original hash before stripping retired fields", () => {
  const patent = createBlankPatent({ name: "恢复普通专利", patentType: "invention" });
  const legacy = {
    formatVersion: 1,
    patent: { ...patent, scientificChartProjects: { broken: true } },
    scientificChartArchive: { broken: true },
  };
  const snapshot = {
    revision: 0,
    model_version: 3,
    payload: encodeJson(legacy),
    content_hash: hashJson(legacy),
  };
  expect(decodePatentRecoverySnapshot(snapshot)).toEqual({ patent });
  expect(() => decodePatentRecoverySnapshot({ ...snapshot, content_hash: "wrong" })).toThrow();
  expect(encodePatentRecoverySnapshot(patent).payload.toString()).not.toContain("scientific");
  const edit = parsePatentEditPayload({
    type: "scientific-chart-edit",
    patentId: patent.patentId,
    baseRevision: 0,
    targetRevision: 1,
    patent: legacy.patent,
    scientificChartArchive: {},
  });
  expect(edit).toMatchObject({ baseRevision: 0, targetRevision: 1, patent });
  expect(JSON.stringify(edit)).not.toContain("scientific");
});
