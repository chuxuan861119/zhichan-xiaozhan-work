import { createHash } from "node:crypto";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { z } from "zod";
import { AssetDescriptorSchema } from "../../shared/document/model.js";
import { validateCanonicalDocument } from "../../shared/document/validation.js";
import { DrawingProjectsSchema } from "../../shared/drawing-markup/model.js";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import { FlowchartProjectDescriptorSchema } from "../../shared/flowcharts/model.js";
import { JsonObjectSchema } from "../../shared/ipc/primitives.js";
import { migrateCanonicalPatent } from "../../shared/patent/migrations.js";
import {
  AuxiliaryDocumentSchema,
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  DocxImportReportSchema,
  EDITABLE_CAD_PATENT_FORMAT_VERSION,
  PATENT_BOOK_ORDER,
  type PatentBookKind,
  PatentBookKindSchema,
  PatentFigureSchema,
  PatentTypeSchema,
  TILED_PATENT_FORMAT_VERSION,
  UNIFIED_CAD_PATENT_FORMAT_VERSION,
} from "../../shared/patent/model.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { validateDrawingContainer } from "../assets/drawing-tiles.js";
import {
  assetEntryByteLimit,
  bookEntryName,
  CurrentManifestSchema,
  documentEditorStateEntryName,
  documentEntryName,
  documentSettingsEntryName,
  flowchartEntryName,
  LegacyManifestV2Schema,
  LegacyManifestV3Schema,
  LegacyManifestV4Schema,
  LegacyManifestV5Schema,
  LegacyManifestV6Schema,
  LegacyManifestV7Schema,
  LegacyManifestV8Schema,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_JSON_BYTES,
  MAX_MANIFEST_BYTES,
  originalEntryName,
  PATDOC_FORMAT_VERSION,
  PatdocError,
  type PatdocPayload,
  type PatentPatdocPayload,
  patentEntryName,
  previewEntryName,
} from "./patdoc-format.js";
import { decodePatdocHistory, HISTORY_PATH } from "./patdoc-history.js";

const MAX_FORMAT_PROBE_ENTRIES = 16_384;
const MAX_FORMAT_PROBE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MANIFEST_ENTRY_NAME = Buffer.from("manifest.json", "ascii");

export type PatdocFormatProbe =
  | { kind: "current"; version: "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" }
  | { kind: "future"; version: string }
  | { kind: "not-patdoc" }
  | { kind: "indeterminate" };

const PatentBookMetadataSchema = z
  .object({
    bookId: z.string().uuid(),
    kind: PatentBookKindSchema,
    editorState: JsonObjectSchema,
    localRevision: z.number().int().nonnegative(),
    persistedRevision: z.number().int().nonnegative(),
  })
  .strict();

const CurrentPatentMetadataSchema = z
  .object({
    formatVersion: z.union([
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(PATDOC_FORMAT_VERSION),
    ]),
    canonicalPatentFormatVersion: z
      .number()
      .int()
      .min(3)
      .max(UNIFIED_CAD_PATENT_FORMAT_VERSION)
      .optional(),
    patentId: z.string().uuid(),
    name: z.string().trim().min(1).max(500).nullable(),
    customer: z.string().trim().max(200).nullable().optional(),
    patentType: PatentTypeSchema,
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
    activeBookKind: PatentBookKindSchema,
    drawingBooksEnabled: z.boolean().optional(),
    books: z.array(PatentBookMetadataSchema).length(PATENT_BOOK_ORDER.length),
    auxiliaryDocuments: z.array(AuxiliaryDocumentSchema).max(10_000).optional(),
    docxImportReport: DocxImportReportSchema.nullable().optional(),
    figures: z.array(PatentFigureSchema).max(100_000),
    abstractDrawingFigureId: z.string().uuid().nullable(),
    assets: z.array(AssetDescriptorSchema).max(100_000),
    flowchartProjects: z.array(FlowchartProjectDescriptorSchema).max(100_000).optional(),
    drawingProjects: DrawingProjectsSchema.optional(),

    referenceMarks: z.array(z.unknown()).max(100_000).optional(),
    referenceMarkSettings: z.unknown().optional(),
  })
  .strict();

const PatentMetadataSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) return input;
  const { scientificChartProjects: _retiredProjects, ...metadata } = input as Record<
    string,
    unknown
  >;
  return metadata;
}, CurrentPatentMetadataSchema);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function bytesView(buffer: Buffer): Uint8Array {
  return Uint8Array.from(buffer);
}

function validateEntryName(name: string): void {
  if (
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/u.test(name) ||
    name.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new PatdocError("INVALID_ARCHIVE", `压缩包包含不安全路径：${name}`);
  }
}

function entryLimit(name: string): number {
  if (name === "manifest.json") return MAX_MANIFEST_BYTES;
  if (
    name === HISTORY_PATH ||
    name === patentEntryName() ||
    name === documentEntryName() ||
    name === documentSettingsEntryName() ||
    name === documentEditorStateEntryName() ||
    PATENT_BOOK_ORDER.some((kind) => name === bookEntryName(kind))
  ) {
    return MAX_JSON_BYTES;
  }
  if (/^flowcharts\/[0-9a-f-]+\.drawio$/iu.test(name)) {
    return FLOWCHART_MAX_SOURCE_XML_BYTES;
  }
  return assetEntryByteLimit(name);
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("ZIP 文件无法打开"));
        else resolve(zip);
      },
    );
  });
}

function openZipForFormatProbe(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        decodeStrings: false,
        lazyEntries: true,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("ZIP 文件无法打开"));
        else resolve(zip);
      },
    );
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("ZIP 条目无法读取"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) {
          stream.destroy(
            new PatdocError("INVALID_ARCHIVE", `条目 ${entry.fileName} 超过大小限制。`),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks, length)));
    });
  });
}

async function readEntries(path: string): Promise<Map<string, Buffer>> {
  const zip = await openZip(path);
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    let count = 0;
    let totalSize = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        try {
          count += 1;
          if (count > MAX_ARCHIVE_ENTRIES) {
            throw new PatdocError("INVALID_ARCHIVE", "压缩包条目数量超过 4096 个。");
          }
          validateEntryName(entry.fileName);
          if (entries.has(entry.fileName)) {
            throw new PatdocError("INVALID_ARCHIVE", `压缩包条目重复：${entry.fileName}`);
          }
          totalSize += entry.uncompressedSize;
          if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
            throw new PatdocError("INVALID_ARCHIVE", "压缩包解压后大小超过 256 MiB。");
          }
          const limit = entryLimit(entry.fileName);
          if (entry.uncompressedSize > limit) {
            const label = entry.fileName === "manifest.json" ? "manifest 清单" : "JSON 或资源条目";
            throw new PatdocError("INVALID_ARCHIVE", `${label} 大小超过限制。`);
          }
          entries.set(entry.fileName, await readEntry(zip, entry, limit));
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      })().catch(fail);
    });
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zip.readEntry();
  });
}

function requiredEntry(entries: Map<string, Buffer>, name: string): Buffer {
  const value = entries.get(name);
  if (!value) throw new PatdocError("INVALID_ARCHIVE", `压缩包缺少 ${name}。`);
  return value;
}

function parseJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PatdocError("INVALID_ARCHIVE", `${name} 不是有效 JSON。`);
  }
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function jsonStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function jsonValueEnd(text: string, start: number): number {
  if (text[start] === '"') return jsonStringEnd(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    let index = start;
    while (index < text.length && text[index] !== "," && text[index] !== "}") index += 1;
    return index;
  }
  const stack = [text[start]];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const character = text[index];
    if (character === '"') {
      index = jsonStringEnd(text, index);
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") stack.pop();
    index += 1;
  }
  return index;
}

function topLevelPropertyValues(text: string, propertyName: string): string[] | null {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") return null;
  index += 1;
  const values: string[] = [];
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return values;
    if (text[index] !== '"') return null;
    const keyEnd = jsonStringEnd(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") return null;
    index = skipJsonWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = jsonValueEnd(text, valueStart);
    if (key === propertyName) values.push(text.slice(valueStart, valueEnd).trim());
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") return values;
    return null;
  }
  return null;
}

function classifyManifestProbe(bytes: Buffer | null): PatdocFormatProbe {
  if (!bytes) return { kind: "indeterminate" };
  try {
    const text = bytes.toString("utf8");
    const input: unknown = JSON.parse(text);
    const versionValues = topLevelPropertyValues(text, "formatVersion");
    if (versionValues?.length !== 1) return { kind: "indeterminate" };
    const version = versionValues[0] ?? "";
    if (!/^(?:0|[1-9]\d*)$/u.test(version)) return { kind: "indeterminate" };
    const numericVersion = BigInt(version);
    if (numericVersion > BigInt(PATDOC_FORMAT_VERSION)) return { kind: "future", version };
    if (
      numericVersion !== 2n &&
      numericVersion !== 3n &&
      numericVersion !== 4n &&
      numericVersion !== 5n &&
      numericVersion !== 6n &&
      numericVersion !== 7n &&
      numericVersion !== 8n &&
      numericVersion !== 9n &&
      numericVersion !== 10n &&
      numericVersion !== 11n &&
      numericVersion !== BigInt(PATDOC_FORMAT_VERSION)
    ) {
      return { kind: "indeterminate" };
    }
    return manifestSchemaForVersion(Number(numericVersion)).safeParse(input).success
      ? {
          kind: "current",
          version: String(numericVersion) as
            | "2"
            | "3"
            | "4"
            | "5"
            | "6"
            | "7"
            | "8"
            | "9"
            | "10"
            | "11"
            | "12",
        }
      : { kind: "indeterminate" };
  } catch {
    return { kind: "indeterminate" };
  }
}

export async function probePatdocFormatVersion(path: string): Promise<PatdocFormatProbe> {
  let zip: ZipFile;
  try {
    zip = await openZipForFormatProbe(path);
  } catch {
    return { kind: "indeterminate" };
  }
  return new Promise((resolve) => {
    let entryCount = 0;
    let manifestCount = 0;
    let manifestBytes: Buffer | null = null;
    let settled = false;
    const finish = (result: PatdocFormatProbe) => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve(result);
    };
    zip.on("error", () => finish({ kind: "indeterminate" }));
    zip.on("entry", (entry: Entry) => {
      entryCount += 1;
      if (entryCount > MAX_FORMAT_PROBE_ENTRIES) {
        finish({ kind: "indeterminate" });
        return;
      }
      if (!entry.fileNameRaw.equals(MANIFEST_ENTRY_NAME)) {
        zip.readEntry();
        return;
      }
      manifestCount += 1;
      if (manifestCount > 1 || entry.uncompressedSize > MAX_FORMAT_PROBE_MANIFEST_BYTES) {
        finish({ kind: "indeterminate" });
        return;
      }
      void readEntry(zip, entry, MAX_FORMAT_PROBE_MANIFEST_BYTES)
        .then((bytes) => {
          manifestBytes = bytes;
          zip.readEntry();
        })
        .catch(() => finish({ kind: "indeterminate" }));
    });
    zip.on("end", () => {
      if (manifestCount === 0) finish({ kind: "not-patdoc" });
      else if (manifestCount === 1) finish(classifyManifestProbe(manifestBytes));
      else finish({ kind: "indeterminate" });
    });
    zip.readEntry();
  });
}

export async function readPatdoc<T extends PatdocPayload | PatentPatdocPayload = PatdocPayload>(
  path: string,
): Promise<T> {
  const probedVersion = await probePatdocFormatVersion(path);
  if (probedVersion.kind === "future") {
    throw new PatdocError("UNSUPPORTED_VERSION", "此文件由更新版本的软件创建。");
  }
  const entries = await readEntries(path);
  let manifestInput = parseJson(requiredEntry(entries, "manifest.json"), "manifest.json");
  if (typeof manifestInput === "object" && manifestInput !== null) {
    const { scientificProjects: _retiredProjects, ...ordinaryManifest } = manifestInput as Record<
      string,
      unknown
    >;
    manifestInput = ordinaryManifest;
  }
  assertSupportedManifestVersion(manifestInput);
  const manifestResult = manifestSchemaForVersion(getManifestVersion(manifestInput)).safeParse(
    manifestInput,
  );
  if (!manifestResult.success) {
    throw new PatdocError("INVALID_ARCHIVE", "manifest.json 清单无效。");
  }
  const manifest = manifestResult.data;
  const expectedEntries = new Set(["manifest.json"]);

  if ("kind" in manifest) {
    const documentPath = documentEntryName();
    const settingsPath = documentSettingsEntryName();
    const editorStatePath = documentEditorStateEntryName();
    if (
      manifest.document.path !== documentPath ||
      manifest.settings.path !== settingsPath ||
      manifest.editorState.path !== editorStatePath
    ) {
      throw new PatdocError("INVALID_ARCHIVE", "单文档数据路径与格式不一致。");
    }
    expectedEntries.add(documentPath);
    expectedEntries.add(settingsPath);
    expectedEntries.add(editorStatePath);
    const documentResult = validateCanonicalDocument(
      parseJson(verifiedEntry(entries, manifest.document), documentPath),
    );
    const settingsResult = JsonObjectSchema.safeParse(
      parseJson(verifiedEntry(entries, manifest.settings), settingsPath),
    );
    const editorStateResult = JsonObjectSchema.safeParse(
      parseJson(verifiedEntry(entries, manifest.editorState), editorStatePath),
    );
    if (!documentResult.ok || !settingsResult.success || !editorStateResult.success) {
      throw new PatdocError("INVALID_ARCHIVE", "单文档数据无效。");
    }
    const document = documentResult.value;
    if (document.documentId !== manifest.documentId) {
      throw new PatdocError("INVALID_ARCHIVE", "清单与单文档数据不一致。");
    }
    const descriptors = new Map(document.assets.map((asset) => [asset.assetId, asset]));
    const manifestIds = new Set<string>();
    const assets: StoredAsset[] = [];
    for (const item of manifest.assets) {
      if (manifestIds.has(item.assetId)) {
        throw new PatdocError("INVALID_ARCHIVE", "清单包含重复资源编号。");
      }
      manifestIds.add(item.assetId);
      const descriptor = descriptors.get(item.assetId);
      if (!descriptor) throw new PatdocError("RESOURCE_MISMATCH", "清单包含未知资源。");
      if (
        item.original !== originalEntryName(descriptor) ||
        item.preview !== previewEntryName(descriptor.assetId)
      ) {
        throw new PatdocError("INVALID_ARCHIVE", "资源路径与描述不一致。");
      }
      const original = bytesView(
        verifiedEntry(entries, {
          path: item.original,
          sha256: item.originalSha256,
          byteLength: item.originalByteLength,
        }),
      );
      const preview = bytesView(
        verifiedEntry(entries, {
          path: item.preview,
          sha256: item.previewSha256,
          byteLength: item.previewByteLength,
        }),
      );
      if (descriptor.kind === "drawing-tiles") await validateDrawingContainer(original);
      expectedEntries.add(item.original);
      expectedEntries.add(item.preview);
      if (
        original.byteLength !== descriptor.byteLength ||
        preview.byteLength !== descriptor.previewByteLength ||
        sha256(original) !== descriptor.sha256 ||
        sha256(preview) !== descriptor.previewSha256
      ) {
        throw new PatdocError("RESOURCE_MISMATCH", "资源大小或哈希不一致。");
      }
      assets.push({ descriptor, original, preview });
    }
    if (manifestIds.size !== descriptors.size) {
      throw new PatdocError("RESOURCE_MISMATCH", "文档资源未完整写入清单。");
    }
    const unexpected = [...entries.keys()].find((name) => !expectedEntries.has(name));
    if (unexpected) {
      throw new PatdocError("INVALID_ARCHIVE", `压缩包包含未知条目：${unexpected}`);
    }
    assets.sort((left, right) => left.descriptor.assetId.localeCompare(right.descriptor.assetId));
    return {
      document,
      settings: settingsResult.data,
      editorState: editorStateResult.data,
      assets,
    } as T;
  }

  const patentBytes = verifiedEntry(entries, manifest.patent);
  expectedEntries.add(manifest.patent.path);
  if (manifest.patent.path !== patentEntryName()) {
    throw new PatdocError("INVALID_ARCHIVE", "专利元数据路径与格式不一致。");
  }
  const metadataResult = PatentMetadataSchema.safeParse(parseJson(patentBytes, "patent.json"));
  if (!metadataResult.success) {
    throw new PatdocError("INVALID_ARCHIVE", "patent.json 专利元数据无效或版本不受支持。");
  }
  const metadata = metadataResult.data;
  if (
    metadata.formatVersion !== manifest.formatVersion ||
    metadata.patentId !== manifest.patentId ||
    metadata.revision !== manifest.revision
  ) {
    throw new PatdocError("INVALID_ARCHIVE", "清单与专利元数据不一致。");
  }

  const bookDocuments = new Map<PatentBookKind, unknown>();
  const seenBooks = new Set<PatentBookKind>();
  for (const item of manifest.books) {
    if (seenBooks.has(item.kind)) {
      throw new PatdocError("INVALID_ARCHIVE", "清单包含重复书册。");
    }
    seenBooks.add(item.kind);
    const expectedPath = bookEntryName(item.kind);
    if (item.path !== expectedPath) {
      throw new PatdocError("INVALID_ARCHIVE", "书册路径与格式不一致。");
    }
    expectedEntries.add(item.path);
    bookDocuments.set(item.kind, parseJson(verifiedEntry(entries, item), item.path));
  }

  const {
    canonicalPatentFormatVersion,
    formatVersion: archiveFormatVersion,
    ...patentMetadata
  } = metadata;
  const migrated = migrateCanonicalPatent({
    ...patentMetadata,
    flowchartProjects: metadata.flowchartProjects ?? [],

    auxiliaryDocuments: metadata.auxiliaryDocuments ?? [],
    docxImportReport: null,
    formatVersion: canonicalPatentFormatVersion ?? archiveFormatVersion,
    books: metadata.books.map((book) => {
      return { ...book, document: bookDocuments.get(book.kind) };
    }),
  });
  if (!migrated.ok)
    throw new PatdocError(
      migrated.error.code === "UNSUPPORTED_VERSION" ? "UNSUPPORTED_VERSION" : "INVALID_ARCHIVE",
      migrated.error.message,
    );
  const patent: CanonicalPatent = migrated.value;
  if (
    patent.assets.some((a) => a.kind === "drawing-tiles") &&
    (manifest.formatVersion < 10 ||
      (metadata.canonicalPatentFormatVersion ?? 0) < TILED_PATENT_FORMAT_VERSION)
  )
    throw new PatdocError("INVALID_ARCHIVE", "分块图纸与文件版本不一致。");
  if (
    patent.formatVersion === EDITABLE_CAD_PATENT_FORMAT_VERSION &&
    (manifest.formatVersion < 11 ||
      metadata.canonicalPatentFormatVersion !== EDITABLE_CAD_PATENT_FORMAT_VERSION)
  )
    throw new PatdocError("INVALID_ARCHIVE", "可编辑 CAD 与文件版本不一致。");
  if (
    patent.formatVersion === UNIFIED_CAD_PATENT_FORMAT_VERSION &&
    (manifest.formatVersion < 12 ||
      metadata.canonicalPatentFormatVersion !== UNIFIED_CAD_PATENT_FORMAT_VERSION)
  )
    throw new PatdocError("INVALID_ARCHIVE", "统一 CAD 与文件版本不一致。");

  if (patent.books.map((book) => book.kind).join("|") !== PATENT_BOOK_ORDER.join("|")) {
    throw new PatdocError("INVALID_ARCHIVE", "专利五书不完整。");
  }

  const descriptors = new Map(patent.assets.map((asset) => [asset.assetId, asset]));
  const manifestIds = new Set<string>();
  const assets: StoredAsset[] = [];
  for (const item of manifest.assets) {
    if (manifestIds.has(item.assetId)) {
      throw new PatdocError("INVALID_ARCHIVE", "清单包含重复资源编号。");
    }
    manifestIds.add(item.assetId);
    const descriptor = descriptors.get(item.assetId);
    if (!descriptor) throw new PatdocError("RESOURCE_MISMATCH", "清单包含未知资源。");
    if (
      item.original !== originalEntryName(descriptor) ||
      item.preview !== previewEntryName(descriptor.assetId)
    ) {
      throw new PatdocError("INVALID_ARCHIVE", "资源路径与描述不一致。");
    }
    const original = bytesView(
      verifiedEntry(entries, {
        path: item.original,
        sha256: item.originalSha256,
        byteLength: item.originalByteLength,
      }),
    );
    const preview = bytesView(
      verifiedEntry(entries, {
        path: item.preview,
        sha256: item.previewSha256,
        byteLength: item.previewByteLength,
      }),
    );
    if (descriptor.kind === "drawing-tiles") await validateDrawingContainer(original);
    expectedEntries.add(item.original);
    expectedEntries.add(item.preview);
    if (
      original.byteLength !== descriptor.byteLength ||
      preview.byteLength !== descriptor.previewByteLength ||
      sha256(original) !== descriptor.sha256 ||
      sha256(preview) !== descriptor.previewSha256
    ) {
      throw new PatdocError("RESOURCE_MISMATCH", "资源大小或哈希不一致。");
    }
    assets.push({ descriptor, original, preview });
  }
  if (manifestIds.size !== descriptors.size) {
    throw new PatdocError("RESOURCE_MISMATCH", "专利资源未完整写入清单。");
  }
  const flowcharts: NonNullable<PatentPatdocPayload["flowcharts"]> = [];
  const projectsById = new Map(
    patent.flowchartProjects.map((project) => [project.projectId, project]),
  );
  const manifestFlowchartIds = new Set<string>();
  for (const item of "flowcharts" in manifest ? manifest.flowcharts : []) {
    if (manifestFlowchartIds.has(item.projectId)) {
      throw new PatdocError("INVALID_ARCHIVE", "清单包含重复流程图编号。");
    }
    manifestFlowchartIds.add(item.projectId);
    const descriptor = projectsById.get(item.projectId);
    if (!descriptor) {
      throw new PatdocError("RESOURCE_MISMATCH", "清单包含未知流程图源文件。");
    }
    if (item.path !== flowchartEntryName(item.projectId)) {
      throw new PatdocError("INVALID_ARCHIVE", "流程图源文件路径与格式不一致。");
    }
    const source = bytesView(verifiedEntry(entries, item));
    expectedEntries.add(item.path);
    if (sha256(source) !== descriptor.sourceSha256) {
      throw new PatdocError("RESOURCE_MISMATCH", "流程图源文件哈希与专利描述不一致。");
    }
    flowcharts.push({ projectId: item.projectId, source });
  }
  if (manifestFlowchartIds.size !== projectsById.size) {
    throw new PatdocError("RESOURCE_MISMATCH", "专利流程图源文件未完整写入清单。");
  }
  if ("history" in manifest && manifest.history) {
    if (manifest.history.path !== HISTORY_PATH)
      throw new PatdocError("INVALID_ARCHIVE", "历史清单路径无效。");
    expectedEntries.add(HISTORY_PATH);
    // Validate legacy history for archive integrity, but never import it.
    decodePatdocHistory(verifiedEntry(entries, manifest.history), entries, expectedEntries, {
      patent,
      assets,
      flowcharts,
    });
  }
  const unexpected = [...entries.keys()].find(
    (name) =>
      !expectedEntries.has(name) &&
      !/^scientific\/[0-9a-f-]+\/(?:revisions\/[0-9a-f-]+\.json|sources\/[0-9a-f-]+\.bin)$/iu.test(
        name,
      ),
  );
  if (unexpected) throw new PatdocError("INVALID_ARCHIVE", `压缩包包含未知条目：${unexpected}`);

  assets.sort((left, right) => left.descriptor.assetId.localeCompare(right.descriptor.assetId));
  flowcharts.sort((left, right) => left.projectId.localeCompare(right.projectId));

  return {
    patent,
    assets,
    flowcharts,
  } as T;
}

function assertSupportedManifestVersion(manifestInput: unknown): void {
  const version =
    typeof manifestInput === "object" && manifestInput !== null && "formatVersion" in manifestInput
      ? (manifestInput as { formatVersion: unknown }).formatVersion
      : undefined;
  if (Number.isInteger(version) && typeof version === "number") {
    if (
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10 &&
      version !== 11 &&
      version !== PATDOC_FORMAT_VERSION
    ) {
      throw new PatdocError("UNSUPPORTED_VERSION", "此文件格式版本不受当前软件支持。");
    }
    return;
  }
  throw new PatdocError("INVALID_ARCHIVE", "manifest.json 清单无效。");
}

function getManifestVersion(manifestInput: unknown): number | undefined {
  return typeof manifestInput === "object" &&
    manifestInput !== null &&
    "formatVersion" in manifestInput
    ? ((manifestInput as { formatVersion: unknown }).formatVersion as number)
    : undefined;
}

function manifestSchemaForVersion(version: number | undefined) {
  if (version === 2) return LegacyManifestV2Schema;
  if (version === 3) return LegacyManifestV3Schema;
  if (version === 4) return LegacyManifestV4Schema;
  if (version === 5) return LegacyManifestV5Schema;
  if (version === 6) return LegacyManifestV6Schema;
  if (version === 7) return LegacyManifestV7Schema;
  if (version === 8) return LegacyManifestV8Schema;
  return CurrentManifestSchema;
}

function verifiedEntry(
  entries: Map<string, Buffer>,
  reference: { path: string; sha256: string; byteLength: number },
): Buffer {
  const bytes = requiredEntry(entries, reference.path);
  if (bytes.byteLength !== reference.byteLength || sha256(bytes) !== reference.sha256) {
    throw new PatdocError("RESOURCE_MISMATCH", "条目大小或哈希不一致。");
  }
  return bytes;
}
