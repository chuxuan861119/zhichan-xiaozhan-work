import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import yazl from "yazl";
import { validateCanonicalDocument } from "../../shared/document/validation.js";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import { CanonicalPatentSchema, PATENT_BOOK_ORDER } from "../../shared/patent/model.js";
import {
  assetEntryByteLimit,
  bookEntryName,
  type DocumentPatdocManifest,
  documentEditorStateEntryName,
  documentEntryName,
  documentSettingsEntryName,
  flowchartEntryName,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_ASSET_ENTRY_BYTES,
  MAX_JSON_BYTES,
  MAX_MANIFEST_BYTES,
  originalEntryName,
  PatdocError,
  type PatdocManifest,
  type PatdocPayload,
  type PatentPatdocPayload,
  patentArchiveVersion,
  patentEntryName,
  previewEntryName,
} from "./patdoc-format.js";
import { portablePatdocPayload } from "./patdoc-transfer-scope.js";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

function validateArchiveCapacity(
  manifestBytes: Uint8Array,
  jsonEntries: readonly Uint8Array[],
  assets: PatdocPayload["assets"],
  sources: readonly Uint8Array[],
  maximumBytes: number,
): void {
  const binaryEntries = [...assets.flatMap((asset) => [asset.original, asset.preview]), ...sources];
  if (
    manifestBytes.byteLength > MAX_MANIFEST_BYTES ||
    jsonEntries.some((bytes) => bytes.byteLength > MAX_JSON_BYTES) ||
    assets.some(
      (asset) =>
        asset.original.byteLength > assetEntryByteLimit(originalEntryName(asset.descriptor)) ||
        asset.preview.byteLength > MAX_ASSET_ENTRY_BYTES,
    ) ||
    1 + jsonEntries.length + binaryEntries.length > MAX_ARCHIVE_ENTRIES ||
    manifestBytes.byteLength +
      [...jsonEntries, ...binaryEntries].reduce((sum, bytes) => sum + bytes.byteLength, 0) >
      maximumBytes
  ) {
    throw new PatdocError(
      "PATDOC_CAPACITY_LIMIT",
      `文档内容超过归档安全容量（解压后 ${maximumBytes / 1024 / 1024} MiB）。未生成文件，请减少资源大小后重试。`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function fileReference(
  path: string,
  bytes: Uint8Array,
): {
  path: string;
  sha256: string;
  byteLength: number;
} {
  return { path, sha256: sha256(bytes), byteLength: bytes.byteLength };
}

function isPatentPatdocPayload(
  payload: PatdocPayload | PatentPatdocPayload,
): payload is PatentPatdocPayload {
  return "patent" in payload;
}

function validateAssets(
  assets: PatdocPayload["assets"],
  descriptors: PatdocPayload["document"]["assets"],
): void {
  const storedById = new Map(assets.map((asset) => [asset.descriptor.assetId, asset]));
  if (storedById.size !== assets.length || storedById.size !== descriptors.length) {
    throw new PatdocError("RESOURCE_MISMATCH", "资源列表与文档描述不一致。");
  }
  for (const descriptor of descriptors) {
    const stored = storedById.get(descriptor.assetId);
    if (!stored || JSON.stringify(stored.descriptor) !== JSON.stringify(descriptor)) {
      throw new PatdocError("RESOURCE_MISMATCH", "资源描述与文档不一致。");
    }
    if (
      stored.original.byteLength !== descriptor.byteLength ||
      stored.preview.byteLength !== descriptor.previewByteLength ||
      sha256(stored.original) !== descriptor.sha256 ||
      sha256(stored.preview) !== descriptor.previewSha256
    ) {
      throw new PatdocError("RESOURCE_MISMATCH", "资源大小或哈希不一致。");
    }
  }
}

function validatePayload(payload: PatentPatdocPayload): PatentPatdocPayload {
  const patent = CanonicalPatentSchema.parse(payload.patent);
  validateAssets(payload.assets, patent.assets);
  const flowcharts = payload.flowcharts ?? [];
  const sourceByProjectId = new Map(
    flowcharts.map((flowchart) => [flowchart.projectId, flowchart]),
  );
  if (
    sourceByProjectId.size !== flowcharts.length ||
    sourceByProjectId.size !== patent.flowchartProjects.length
  ) {
    throw new PatdocError("RESOURCE_MISMATCH", "流程图源文件列表与专利描述不一致。");
  }
  for (const descriptor of patent.flowchartProjects) {
    const stored = sourceByProjectId.get(descriptor.projectId);
    if (
      !stored ||
      stored.source.byteLength > FLOWCHART_MAX_SOURCE_XML_BYTES ||
      sha256(stored.source) !== descriptor.sourceSha256
    ) {
      throw new PatdocError("RESOURCE_MISMATCH", "流程图源文件哈希与专利描述不一致。");
    }
  }
  return {
    patent,
    assets: payload.assets,
    flowcharts,
    ...(payload.snapshots === undefined ? {} : { snapshots: payload.snapshots }),
  };
}

function patentMetadata(patent: PatentPatdocPayload["patent"]): unknown {
  return {
    formatVersion: patentArchiveVersion(patent),
    canonicalPatentFormatVersion: patent.formatVersion,
    patentId: patent.patentId,
    name: patent.name,
    customer: patent.customer,
    patentType: patent.patentType,
    createdAt: patent.createdAt,
    modifiedAt: patent.modifiedAt,
    revision: patent.revision,
    activeBookKind: patent.activeBookKind,
    drawingBooksEnabled: patent.drawingBooksEnabled,
    books: patent.books.map((book) => ({
      bookId: book.bookId,
      kind: book.kind,
      editorState: book.editorState,
      localRevision: book.localRevision,
      persistedRevision: book.persistedRevision,
    })),
    auxiliaryDocuments: patent.auxiliaryDocuments,
    figures: patent.figures,
    abstractDrawingFigureId: patent.abstractDrawingFigureId,
    assets: patent.assets,
    flowchartProjects: patent.flowchartProjects,
    drawingProjects: patent.drawingProjects,

    referenceMarks: patent.referenceMarks,
    referenceMarkSettings: patent.referenceMarkSettings,
  };
}

export async function writePatdoc(
  path: string,
  input: PatdocPayload | PatentPatdocPayload,
): Promise<void> {
  if (!isPatentPatdocPayload(input)) {
    const documentResult = validateCanonicalDocument(input.document);
    if (!documentResult.ok) throw new PatdocError("INVALID_ARCHIVE", documentResult.error.message);
    const document = documentResult.value;
    if (document.assets.some((a) => a.kind === "drawing-tiles"))
      throw new PatdocError("RESOURCE_MISMATCH", "分块图纸只能保存于专利图纸工作稿。");
    const settings = JsonObjectSchema.parse(input.settings);
    const editorState = JsonObjectSchema.parse(input.editorState);
    validateAssets(input.assets, document.assets);
    const assets = [...input.assets].sort((left, right) =>
      left.descriptor.assetId.localeCompare(right.descriptor.assetId),
    );
    const documentBytes = jsonBytes(document);
    const settingsBytes = jsonBytes(settings);
    const editorStateBytes = jsonBytes(editorState);
    const manifest: DocumentPatdocManifest = {
      formatVersion: 9,
      kind: "document",
      documentId: document.documentId,
      document: fileReference(documentEntryName(), documentBytes),
      settings: fileReference(documentSettingsEntryName(), settingsBytes),
      editorState: fileReference(documentEditorStateEntryName(), editorStateBytes),
      assets: assets.map((asset) => ({
        assetId: asset.descriptor.assetId,
        original: originalEntryName(asset.descriptor),
        preview: previewEntryName(asset.descriptor.assetId),
        originalSha256: sha256(asset.original),
        originalByteLength: asset.original.byteLength,
        previewSha256: sha256(asset.preview),
        previewByteLength: asset.preview.byteLength,
      })),
    };
    const manifestBytes = jsonBytes(manifest);
    validateArchiveCapacity(
      manifestBytes,
      [documentBytes, settingsBytes, editorStateBytes],
      assets,
      [],
      256 * 1024 * 1024,
    );
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const output = createWriteStream(path, { flags: "wx" });
      const fail = (error: Error) => reject(error);
      output.on("close", resolve);
      output.on("error", fail);
      zip.outputStream.on("error", fail);
      zip.outputStream.pipe(output);
      const options = { mtime: ZIP_EPOCH, mode: 0o100600 };
      zip.addBuffer(manifestBytes, "manifest.json", options);
      zip.addBuffer(documentBytes, documentEntryName(), options);
      zip.addBuffer(settingsBytes, documentSettingsEntryName(), options);
      zip.addBuffer(editorStateBytes, documentEditorStateEntryName(), options);
      for (const asset of assets) {
        zip.addBuffer(Buffer.from(asset.original), originalEntryName(asset.descriptor), options);
        zip.addBuffer(
          Buffer.from(asset.preview),
          previewEntryName(asset.descriptor.assetId),
          options,
        );
      }
      zip.end();
    });
    return;
  }
  const payload = validatePayload(portablePatdocPayload(input));
  const assets = [...payload.assets].sort((left, right) =>
    left.descriptor.assetId.localeCompare(right.descriptor.assetId),
  );
  const flowcharts = [...(payload.flowcharts ?? [])].sort((left, right) =>
    left.projectId.localeCompare(right.projectId),
  );
  const patentBytes = jsonBytes(patentMetadata(payload.patent));
  const bookFiles = PATENT_BOOK_ORDER.map((kind) => {
    const book = payload.patent.books.find((candidate) => candidate.kind === kind);
    if (!book) throw new PatdocError("INVALID_ARCHIVE", "专利五书不完整。");
    const path = bookEntryName(kind);
    const bytes = jsonBytes(book.document);
    return { kind, path, bytes };
  });

  const manifest: PatdocManifest = {
    formatVersion: patentArchiveVersion(payload.patent),
    patentId: payload.patent.patentId,
    revision: payload.patent.revision,
    patent: fileReference(patentEntryName(), patentBytes),
    books: bookFiles.map(({ kind, path, bytes }) => ({
      kind,
      ...fileReference(path, bytes),
    })),
    assets: assets.map((asset) => ({
      assetId: asset.descriptor.assetId,
      original: originalEntryName(asset.descriptor),
      preview: previewEntryName(asset.descriptor.assetId),
      originalSha256: sha256(asset.original),
      originalByteLength: asset.original.byteLength,
      previewSha256: sha256(asset.preview),
      previewByteLength: asset.preview.byteLength,
    })),
    flowcharts: flowcharts.map((flowchart) => ({
      projectId: flowchart.projectId,
      ...fileReference(flowchartEntryName(flowchart.projectId), flowchart.source),
    })),
  };

  const manifestBytes = jsonBytes(manifest);
  const jsonEntries = [patentBytes, ...bookFiles.map((book) => book.bytes)];
  validateArchiveCapacity(
    manifestBytes,
    jsonEntries,
    assets,
    flowcharts.map((source) => source.source),
    payload.patent.assets.some((a) => a.kind === "drawing-tiles")
      ? MAX_ARCHIVE_UNCOMPRESSED_BYTES
      : 256 * 1024 * 1024,
  );
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path, { flags: "wx" });
    const fail = (error: Error) => reject(error);
    output.on("close", resolve);
    output.on("error", fail);
    zip.outputStream.on("error", fail);
    zip.outputStream.pipe(output);
    const options = { mtime: ZIP_EPOCH, mode: 0o100600 };
    zip.addBuffer(manifestBytes, "manifest.json", options);
    zip.addBuffer(patentBytes, patentEntryName(), options);
    for (const book of bookFiles) zip.addBuffer(book.bytes, book.path, options);
    for (const asset of assets) {
      zip.addBuffer(Buffer.from(asset.original), originalEntryName(asset.descriptor), options);
      zip.addBuffer(
        Buffer.from(asset.preview),
        previewEntryName(asset.descriptor.assetId),
        options,
      );
    }
    for (const flowchart of flowcharts) {
      zip.addBuffer(
        Buffer.from(flowchart.source),
        flowchartEntryName(flowchart.projectId),
        options,
      );
    }

    zip.end();
  });
}
