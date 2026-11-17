import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import type { ParagraphNode } from "../../shared/document/model.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  PATENT_BOOK_LABELS,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
} from "../../shared/patent/model.js";
import { PATDOC_FORMAT_VERSION } from "./patdoc-format.js";
import { probePatdocFormatVersion, readPatdoc } from "./patdoc-reader.js";

type Entry = [name: string, bytes: Uint8Array];

async function createZip(path: string, entries: Entry[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const [name, bytes] of entries) zip.addBuffer(Buffer.from(bytes), name);
    zip.end();
  });
}

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").toUpperCase();
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

function paragraph(index: number, text: string): ParagraphNode {
  return {
    id: uuid(index),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks: [] }],
  };
}

function bookDocument(kind: PatentBookKind, index: number, formatVersion: 1 | 2 | 3): unknown {
  return {
    formatVersion,
    documentId: uuid(index),
    title: PATENT_BOOK_LABELS[kind],
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:00:00.000Z",
    page: {
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25,
      marginRightMm: 15,
      marginBottomMm: 15,
      marginLeftMm: 25,
    },
    content: [paragraph(index + 100, PATENT_BOOK_LABELS[kind])],
  };
}

function patentEntries(
  manifestFormatVersion: 2 | 3 | 4 | 5 | 6,
  metadataFormatVersion: 2 | 3 | 4 | 5 | 6 = manifestFormatVersion,
  canonicalPatentFormatVersion?: 8 | 9 | 10,
): Entry[] {
  const patentId = uuid(1);
  const books = PATENT_BOOK_ORDER.map((kind, index) => ({
    bookId: uuid(10 + index),
    kind,
    editorState: {},
    localRevision: 0,
    persistedRevision: 0,
  }));
  const patentBytes = json({
    formatVersion: metadataFormatVersion,
    ...(canonicalPatentFormatVersion === undefined ? {} : { canonicalPatentFormatVersion }),
    ...(canonicalPatentFormatVersion === 8
      ? {
          customer: null,
          drawingBooksEnabled: true,
          referenceMarks: [],
          referenceMarkSettings: { synchronizedEditingEnabled: false },
        }
      : {}),
    patentId,
    name: null,
    patentType: "invention",
    createdAt: "2026-08-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:00:00.000Z",
    revision: 0,
    activeBookKind: "description",
    books,
    figures: [],
    abstractDrawingFigureId: null,
    assets: [],
  });
  const bookEntries = PATENT_BOOK_ORDER.map((kind, index) => {
    const path = `books/${kind}.json`;
    const bookVersion = manifestFormatVersion === 3 ? 1 : manifestFormatVersion === 4 ? 2 : 3;
    const bytes = json(bookDocument(kind, 100 + index, bookVersion));
    return { kind, path, bytes };
  });
  const manifest = {
    formatVersion: manifestFormatVersion,
    patentId,
    revision: 0,
    patent: {
      path: "patent.json",
      sha256: sha256(patentBytes),
      byteLength: patentBytes.byteLength,
    },
    books: bookEntries.map(({ kind, path, bytes }) => ({
      kind,
      path,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    })),
    assets: [],
  };
  return [
    ["manifest.json", json(manifest)],
    ["patent.json", patentBytes],
    ...bookEntries.map(({ path, bytes }) => [path, bytes] satisfies Entry),
  ];
}

function v3Entries(): Entry[] {
  return patentEntries(3);
}

function v1Entries(): Entry[] {
  return [
    ["manifest.json", json({ formatVersion: 1, documentId: uuid(1), assets: [] })],
    ["model.json", json({})],
    ["settings.json", json({})],
    ["editor-state.json", json({})],
  ];
}

async function patchNames(path: string, replacements: Array<[string, string]>): Promise<void> {
  const bytes = await readFile(path);
  for (const [from, to] of replacements) {
    expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
    const source = Buffer.from(from);
    const target = Buffer.from(to);
    let offset = bytes.indexOf(source);
    while (offset >= 0) {
      target.copy(bytes, offset);
      offset += target.length;
      offset = bytes.indexOf(source, offset);
    }
  }
  await writeFile(path, bytes);
}

async function patchCentralUncompressedSize(
  path: string,
  entryName: string,
  size: number,
): Promise<void> {
  const bytes = await readFile(path);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = bytes.indexOf(signature);
  let changed = false;
  while (offset >= 0) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      bytes.writeUInt32LE(size, offset + 24);
      changed = true;
      break;
    }
    offset = bytes.indexOf(signature, offset + 46 + nameLength);
  }
  expect(changed).toBe(true);
  await writeFile(path, bytes);
}

describe("patdoc archive security", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "patdoc-security-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("probes version 3 archives without treating damaged manifests as future files", async () => {
    const currentPath = join(directory, "probe-current.patdoc");
    const futurePath = join(directory, "probe-future-bigint.patdoc");
    const invalidManifestPath = join(directory, "probe-invalid-manifest.patdoc");
    const noManifestPath = join(directory, "probe-no-manifest.zip");
    const oversizedManifestPath = join(directory, "probe-oversized-manifest.patdoc");
    await createZip(currentPath, v3Entries());
    await createZip(futurePath, [
      [
        "manifest.json",
        Buffer.from('{"formatVersion":999999999999999999999999999999,"assets":[]}', "utf8"),
      ],
    ]);
    await createZip(invalidManifestPath, [
      ["manifest.json", json({ formatVersion: 3 })],
      ...v3Entries().slice(1),
    ]);
    await createZip(noManifestPath, [["readme.txt", Buffer.from("not a patdoc")]]);
    await createZip(oversizedManifestPath, [
      ["manifest.json", Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)],
    ]);

    expect(await probePatdocFormatVersion(currentPath)).toEqual({
      kind: "current",
      version: "3",
    });
    expect(await probePatdocFormatVersion(futurePath)).toEqual({
      kind: "future",
      version: "999999999999999999999999999999",
    });
    expect(await probePatdocFormatVersion(invalidManifestPath)).toEqual({
      kind: "indeterminate",
    });
    expect(await probePatdocFormatVersion(noManifestPath)).toEqual({ kind: "not-patdoc" });
    expect(await probePatdocFormatVersion(oversizedManifestPath)).toEqual({
      kind: "indeterminate",
    });
  });

  test("rejects old version 1 archives with an unsupported-version error", async () => {
    const path = join(directory, "legacy-v1.patdoc");
    await createZip(path, v1Entries());

    await expect(readPatdoc(path)).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
  });

  test("reads the previous v8 format without a history index", async () => {
    const entries = patentEntries(6, 6, 8);
    const manifest = JSON.parse(Buffer.from(entries[0]![1]).toString());
    const metadataEntry = entries.find(([name]) => name === manifest.patent.path)!;
    const metadata = JSON.parse(Buffer.from(metadataEntry[1]).toString());
    metadata.formatVersion = 8;
    metadata.flowchartProjects = [];
    metadataEntry[1] = json(metadata);
    manifest.formatVersion = 8;
    manifest.flowcharts = [];
    manifest.patent.sha256 = sha256(metadataEntry[1]);
    manifest.patent.byteLength = metadataEntry[1].byteLength;
    entries[0]![1] = json(manifest);
    const path = join(directory, "legacy-v8.patdoc");
    await createZip(path, entries);
    await expect(readPatdoc(path)).resolves.toMatchObject({
      patent: { formatVersion: CANONICAL_PATENT_FORMAT_VERSION },
    });
  });

  test.each([2, 3, 4, 5, 6] as const)(
    "migrates version %i patent archives with drawing books enabled by default",
    async (version) => {
      const path = join(directory, `legacy-v${version}.patdoc`);
      await createZip(path, patentEntries(version));

      await expect(readPatdoc(path)).resolves.toMatchObject({
        patent: { formatVersion: CANONICAL_PATENT_FORMAT_VERSION, drawingBooksEnabled: true },
      });
    },
  );

  test("upgrades a v6 archive whose metadata declares canonical patent format 8", async () => {
    const path = join(directory, "legacy-v6-canonical-v8.patdoc");
    await createZip(path, patentEntries(6, 6, 8));

    await expect(readPatdoc(path)).resolves.toMatchObject({
      patent: { formatVersion: CANONICAL_PATENT_FORMAT_VERSION },
    });
  });

  test("rejects a v6 archive whose metadata declares a future canonical patent format", async () => {
    const path = join(directory, "legacy-v6-canonical-future.patdoc");
    await createZip(path, patentEntries(6, 6, 10));

    await expect(readPatdoc(path)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
  });

  test("migrates a version 3 patent archive to the current patent format", async () => {
    const path = join(directory, "legacy-v3.patdoc");
    await createZip(path, v3Entries());

    const restored = await readPatdoc(path);

    expect(restored).toMatchObject({
      patent: { formatVersion: CANONICAL_PATENT_FORMAT_VERSION, revision: 0 },
    });
  });

  test.each([
    [3, 4],
    [4, 3],
    [4, 6],
    [6, 4],
  ] as const)(
    "rejects manifest version %i with patent metadata version %i",
    async (manifestVersion, metadataVersion) => {
      const path = join(directory, `mismatch-${manifestVersion}-${metadataVersion}.patdoc`);
      await createZip(path, patentEntries(manifestVersion, metadataVersion));

      await expect(readPatdoc(path)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
    },
  );

  test.each([
    ["parent traversal", "ok/escape", "../escape"],
    ["absolute path", "xabsolute", "/absolute"],
    ["backslash traversal", "ok/escape", "..\\escape"],
  ])("rejects %s without writing outside memory", async (_label, safeName, maliciousName) => {
    const path = join(directory, "malicious.patdoc");
    const sentinel = join(directory, "sentinel.txt");
    await writeFile(sentinel, "unchanged");
    await createZip(path, [...v3Entries(), [safeName, Buffer.from("payload")]]);
    await patchNames(path, [[safeName, maliciousName]]);

    await expect(readPatdoc(path)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  test("rejects duplicate entry names", async () => {
    const path = join(directory, "duplicates.patdoc");
    await createZip(path, [
      ...v3Entries(),
      ["same1.txt", Buffer.alloc(0)],
      ["same2.txt", Buffer.alloc(0)],
    ]);
    await patchNames(path, [
      ["same1.txt", "same0.txt"],
      ["same2.txt", "same0.txt"],
    ]);
    await expect(readPatdoc(path)).rejects.toThrow(/重复/u);
  });

  test("identifies a future archive before applying current entry and size limits", async () => {
    const path = join(directory, "future-outside-v6-limits.patdoc");
    await createZip(path, [
      [
        "manifest.json",
        json({ formatVersion: PATDOC_FORMAT_VERSION + 1, patentId: uuid(1), assets: [] }),
      ],
      ["ok/escape", Buffer.alloc(0)],
      ...Array.from(
        { length: 4_096 },
        (_, index) => [`extra/${index.toString().padStart(4, "0")}.bin`, Buffer.alloc(0)] as Entry,
      ),
    ]);
    await patchNames(path, [["ok/escape", "..\\escape"]]);
    await patchCentralUncompressedSize(path, "extra/0000.bin", 256 * 1024 * 1024 + 1);

    await expect(readPatdoc(path)).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
  }, 20_000);

  test("rejects declared total uncompressed size over 256 MiB", async () => {
    const path = join(directory, "too-large.patdoc");
    await createZip(path, v3Entries());
    await patchCentralUncompressedSize(path, "patent.json", 256 * 1024 * 1024 + 1);
    await expect(readPatdoc(path)).rejects.toThrow(/大小/u);
  });

  test("rejects missing required entries and truncated ZIP files", async () => {
    for (const missing of ["manifest.json", "patent.json", "books/claims.json"]) {
      const path = join(directory, `missing-${missing.replaceAll("/", "-")}.patdoc`);
      await createZip(
        path,
        v3Entries().filter(([name]) => name !== missing),
      );
      await expect(readPatdoc(path)).rejects.toThrow(/缺少|清单/u);
    }

    const validPath = join(directory, "valid.patdoc");
    const truncatedPath = join(directory, "truncated.patdoc");
    await createZip(validPath, v3Entries());
    const valid = await readFile(validPath);
    await writeFile(truncatedPath, valid.subarray(0, Math.floor(valid.length / 2)));
    await expect(readPatdoc(truncatedPath)).rejects.toThrow();
  });

  test("rejects an asset whose bytes differ from its descriptor and manifest hash", async () => {
    const path = join(directory, "bad-asset.patdoc");
    const entries = v3Entries();
    const original = Uint8Array.from([1, 2, 3]);
    const preview = Uint8Array.from([4, 5, 6]);
    const assetId = uuid(601);
    const patent = JSON.parse(
      Buffer.from(entries.find(([name]) => name === "patent.json")?.[1] ?? []).toString("utf8"),
    );
    patent.assets = [
      {
        assetId,
        kind: "image",
        originalName: "drawing.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: original.byteLength,
        sha256: sha256(Uint8Array.from([9, 9, 9])),
        widthPx: 1,
        heightPx: 1,
        previewByteLength: preview.byteLength,
        previewSha256: sha256(preview),
      },
    ];
    const patentBytes = json(patent);
    const books = entries
      .filter(([name]) => name.startsWith("books/"))
      .map(([name, bytes]) => ({
        kind: name.slice("books/".length, -".json".length),
        path: name,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
      }));
    await createZip(path, [
      [
        "manifest.json",
        json({
          formatVersion: 3,
          patentId: uuid(1),
          revision: 0,
          patent: {
            path: "patent.json",
            sha256: sha256(patentBytes),
            byteLength: patentBytes.byteLength,
          },
          books,
          assets: [
            {
              assetId,
              original: `assets/${assetId}/original.png`,
              preview: `assets/${assetId}/preview.png`,
              originalSha256: sha256(original),
              originalByteLength: original.byteLength,
              previewSha256: sha256(preview),
              previewByteLength: preview.byteLength,
            },
          ],
        }),
      ],
      ["patent.json", patentBytes],
      ...entries.filter(([name]) => name.startsWith("books/")),
      [`assets/${assetId}/original.png`, original],
      [`assets/${assetId}/preview.png`, preview],
    ]);
    await expect(readPatdoc(path)).rejects.toThrow(/哈希|资源/u);
  });

  test.each([["corrupt-truncated.patdoc", /zip|文件|目录|结束|无效/iu]])(
    "keeps the checked-in %s fixture rejected",
    async (name, message) => {
      const path = join(process.cwd(), "tests", "fixtures", "documents", name);
      await expect(readPatdoc(path)).rejects.toThrow(message);
    },
  );

  test("keeps dynamically generated future version archives rejected", async () => {
    const path = join(directory, "future-version.patdoc");
    await createZip(path, [
      [
        "manifest.json",
        json({
          formatVersion: PATDOC_FORMAT_VERSION + 1,
          patentId: uuid(1),
          revision: 0,
          patent: {},
          books: [],
          assets: [],
        }),
      ],
    ]);

    await expect(readPatdoc(path)).rejects.toThrow(/版本/u);
  });
});
