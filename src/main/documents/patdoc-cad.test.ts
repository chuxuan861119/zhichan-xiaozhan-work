import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { type PatentPatdocPayload, patentArchiveVersion } from "./patdoc-format.js";
import { probePatdocFormatVersion, readPatdoc } from "./patdoc-reader.js";
import { writePatdoc } from "./patdoc-writer.js";
import { fiveBookPatent } from "./patent-bundle-service.js";

test("PATDOC retains editable CAD bytes and fixed mapping in a version-gated archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "cad-patdoc-"));
  try {
    const assetId = "00000000-0000-4000-8000-000000000811";
    const original = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
    const preview = Buffer.from("preview");
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const descriptor = {
      assetId,
      kind: "drawing-source" as const,
      originalName: "draft.dxf",
      extension: "dxf" as const,
      mediaType: "image/vnd.dxf" as const,
      widthPx: 100,
      heightPx: 100,
      byteLength: original.length,
      sha256: digest(original),
      previewByteLength: preview.length,
      previewSha256: digest(preview),
    };
    const patent = CanonicalPatentSchema.parse({
      ...createBlankPatent({ patentType: "invention", name: null }),
      assets: [descriptor],
      drawingProjects: [
        {
          ...drawingProjectFixture(assetId),
          cad: {
            version: 1,
            engine: "cadcraft",
            engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
            assetId,
            mapping: { originX: -50, originY: 300, scale: 2 },
          },
        },
      ],
    });
    const path = join(root, "editable.patdoc");
    expect(fiveBookPatent(patent).assets).toEqual(patent.assets);
    await writePatdoc(path, {
      patent,
      assets: [{ descriptor: patent.assets[0]!, original, preview }],
    });
    expect(await probePatdocFormatVersion(path)).toEqual({ kind: "current", version: "11" });
    const restored = await readPatdoc<PatentPatdocPayload>(path);
    expect(restored.patent.formatVersion).toBe(14);
    expect(restored.patent.drawingProjects).toEqual(patent.drawingProjects);
    expect(Buffer.from(restored.assets[0]!.original)).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function unifiedCadPayload(
  location: "project" | "detail",
  objectsOnly = false,
): PatentPatdocPayload {
  const assetId = "00000000-0000-4000-8000-000000000811";
  const original = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  const preview = Buffer.from("preview");
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const descriptor = {
    assetId,
    kind: "drawing-source" as const,
    originalName: "unified.dxf",
    extension: "dxf" as const,
    mediaType: "image/vnd.dxf" as const,
    widthPx: 100,
    heightPx: 100,
    byteLength: original.length,
    sha256: digest(original),
    previewByteLength: preview.length,
    previewSha256: digest(preview),
  };
  const checkpoint = {
    version: 1 as const,
    engine: "cadcraft" as const,
    engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
    assetId,
    mapping: { originX: -50, originY: 300, scale: 2 },
    ...(objectsOnly ? {} : { unified: 1 as const }),
    objects: [
      { id: "label-1", kind: "label" as const, label: ["A1", "A2"] },
      { id: "detail-1", kind: "detail" as const, body: ["B1"], frame: ["B2"], source: ["B3"] },
    ],
  };
  const project = drawingProjectFixture(assetId);
  if (location === "project") project.cad = checkpoint;
  else {
    const detail = project.detailViews?.[0];
    if (!detail) throw new Error("Missing detail fixture");
    detail.cadSource = { ...checkpoint, baseAssetId: assetId };
  }
  const patent = CanonicalPatentSchema.parse({
    ...createBlankPatent({ patentType: "invention", name: null }),
    assets: [descriptor],
    drawingProjects: [project],
  });
  const asset = patent.assets[0];
  if (!asset) throw new Error("Missing CAD asset fixture");
  return { patent, assets: [{ descriptor: asset, original, preview }] };
}

test.each(["project", "detail"] as const)(
  "PATDOC 12 preserves unified %s CAD objects and bytes",
  async (location) => {
    const root = await mkdtemp(join(tmpdir(), "unified-cad-patdoc-"));
    try {
      for (const objectsOnly of [false, true]) {
        const payload = unifiedCadPayload(location, objectsOnly);
        expect(patentArchiveVersion(payload.patent)).toBe(12);
        const path = join(root, `${location}-${objectsOnly}.patdoc`);
        await writePatdoc(path, payload);
        expect(await probePatdocFormatVersion(path)).toEqual({ kind: "current", version: "12" });
        const restored = await readPatdoc<PatentPatdocPayload>(path);
        expect(restored.patent.formatVersion).toBe(15);
        expect(restored.patent.drawingProjects).toEqual(payload.patent.drawingProjects);
        const restoredAsset = restored.assets[0];
        const sourceAsset = payload.assets[0];
        if (!restoredAsset || !sourceAsset) throw new Error("Missing CAD asset fixture");
        expect(Buffer.from(restoredAsset.original)).toEqual(Buffer.from(sourceAsset.original));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function writeVersionedCadArchive(
  path: string,
  payload: PatentPatdocPayload,
  archiveVersion: number,
  canonicalVersion: number | undefined,
): Promise<void> {
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const fileReference = (path: string, bytes: Uint8Array) => ({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    byteLength: bytes.byteLength,
  });
  const { patent } = payload;
  const patentBytes = json({
    ...patent,
    formatVersion: archiveVersion,
    canonicalPatentFormatVersion: canonicalVersion,
    books: patent.books.map(({ document: _document, ...book }) => book),
  });
  const books = patent.books.map((book) => ({
    kind: book.kind,
    path: `books/${book.kind}.json`,
    bytes: json(book.document),
  }));
  const manifest = {
    formatVersion: archiveVersion,
    patentId: patent.patentId,
    revision: patent.revision,
    patent: fileReference("patent.json", patentBytes),
    books: books.map(({ kind, path, bytes }) => ({ kind, ...fileReference(path, bytes) })),
    assets: payload.assets.map(({ descriptor, original, preview }) => ({
      assetId: descriptor.assetId,
      original: `assets/${descriptor.assetId}/original.${descriptor.extension}`,
      preview: `assets/${descriptor.assetId}/preview.png`,
      originalSha256: descriptor.sha256,
      originalByteLength: original.byteLength,
      previewSha256: descriptor.previewSha256,
      previewByteLength: preview.byteLength,
    })),
    flowcharts: [],
  };
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    zip.addBuffer(json(manifest), "manifest.json");
    zip.addBuffer(patentBytes, "patent.json");
    for (const book of books) zip.addBuffer(book.bytes, book.path);
    for (const asset of payload.assets) {
      zip.addBuffer(
        Buffer.from(asset.original),
        `assets/${asset.descriptor.assetId}/original.${asset.descriptor.extension}`,
      );
      zip.addBuffer(Buffer.from(asset.preview), `assets/${asset.descriptor.assetId}/preview.png`);
    }
    zip.end();
  });
}

test.each([
  [11, 15],
  [11, 14],
  [12, 14],
  [12, undefined],
] as const)(
  "rejects unified CAD at archive %i with canonical version %s",
  async (archiveVersion, canonicalVersion) => {
    const root = await mkdtemp(join(tmpdir(), "unified-cad-version-"));
    try {
      const path = join(root, "mismatched.patdoc");
      await writeVersionedCadArchive(
        path,
        unifiedCadPayload("detail"),
        archiveVersion,
        canonicalVersion,
      );
      await expect(readPatdoc(path)).rejects.toMatchObject({
        code: "INVALID_ARCHIVE",
        message: "统一 CAD 与文件版本不一致。",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
