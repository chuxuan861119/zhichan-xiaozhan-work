import { readFile } from "node:fs/promises";
import { basename, extname, posix } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export const DOCX_MAX_ENTRIES = 10_000;
export const DOCX_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const DOCX_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DOCX_MAX_COMPRESSION_RATIO = 1_000;
const DOCX_COMPRESSION_RATIO_MIN_BYTES = 1024 * 1024;

export type DocxPackageErrorCode =
  | "UNSUPPORTED_EXTENSION"
  | "INVALID_ZIP"
  | "UNSAFE_PATH"
  | "DUPLICATE_ENTRY"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "PACKAGE_TOO_LARGE"
  | "SUSPICIOUS_COMPRESSION"
  | "ENCRYPTED_PACKAGE"
  | "MACRO_ENABLED"
  | "MISSING_CONTENT_TYPES"
  | "MISSING_DOCUMENT";

export class DocxPackageError extends Error {
  constructor(
    readonly code: DocxPackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocxPackageError";
  }
}

export type DocxSecurityFinding = Readonly<{
  code: "UNSUPPORTED_OLE" | "UNSUPPORTED_ACTIVEX";
  severity: "blocking";
  partName: string;
  message: string;
}>;

export type DocxExternalRelationship = Readonly<{
  sourcePart: string;
  relationshipId: string;
  target: string;
}>;

export type DocxPackage = Readonly<{
  sourceFileName: string;
  parts: ReadonlyMap<string, Uint8Array>;
  externalRelationships: readonly DocxExternalRelationship[];
  findings: readonly DocxSecurityFinding[];
}>;

export type DocxEntryBudget = {
  entryCount: number;
  totalBytes: number;
  normalizedNames: Set<string>;
};

export function createDocxEntryBudget(): DocxEntryBudget {
  return { entryCount: 0, totalBytes: 0, normalizedNames: new Set() };
}

export function normalizeDocxEntryName(name: string): string {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/u.test(name) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    throw new DocxPackageError("UNSAFE_PATH", `DOCX 包含不安全路径：${name}`);
  }
  const directory = name.endsWith("/");
  const normalized = posix.normalize(directory ? name.slice(0, -1) : name);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new DocxPackageError("UNSAFE_PATH", `DOCX 包含不安全路径：${name}`);
  }
  return directory ? `${normalized}/` : normalized;
}

export function validateDocxEntryLimits(
  entry: Readonly<{
    fileName: string;
    uncompressedSize: number;
    compressedSize: number;
    generalPurposeBitFlag: number;
  }>,
  budget: DocxEntryBudget,
): string {
  budget.entryCount += 1;
  if (budget.entryCount > DOCX_MAX_ENTRIES) {
    throw new DocxPackageError("TOO_MANY_ENTRIES", "DOCX 条目数量超过 10000 个。");
  }
  const normalizedName = normalizeDocxEntryName(entry.fileName);
  const duplicateKey = normalizedName.toLowerCase();
  if (budget.normalizedNames.has(duplicateKey)) {
    throw new DocxPackageError("DUPLICATE_ENTRY", `DOCX 包含重复条目：${normalizedName}`);
  }
  budget.normalizedNames.add(duplicateKey);
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new DocxPackageError("ENCRYPTED_PACKAGE", "不允许导入加密的 DOCX 文件。");
  }
  if (duplicateKey === "encryptedpackage" || duplicateKey === "encryptioninfo") {
    throw new DocxPackageError("ENCRYPTED_PACKAGE", "不允许导入加密的 DOCX 文件。");
  }
  budget.totalBytes += entry.uncompressedSize;
  if (entry.uncompressedSize > DOCX_MAX_ENTRY_BYTES) {
    throw new DocxPackageError("ENTRY_TOO_LARGE", `DOCX 条目 ${normalizedName} 超过 64 MiB。`);
  }
  if (budget.totalBytes > DOCX_MAX_UNCOMPRESSED_BYTES) {
    throw new DocxPackageError("PACKAGE_TOO_LARGE", "DOCX 解压后总大小超过 256 MiB。");
  }
  const ratio =
    entry.compressedSize === 0
      ? entry.uncompressedSize > 0
        ? Number.POSITIVE_INFINITY
        : 1
      : entry.uncompressedSize / entry.compressedSize;
  if (
    entry.uncompressedSize >= DOCX_COMPRESSION_RATIO_MIN_BYTES &&
    ratio > DOCX_MAX_COMPRESSION_RATIO
  ) {
    throw new DocxPackageError(
      "SUSPICIOUS_COMPRESSION",
      `DOCX 条目 ${normalizedName} 的压缩比异常。`,
    );
  }
  return normalizedName;
}

export async function readDocxPackage(path: string): Promise<DocxPackage> {
  const bytes = await readFile(path);
  return readDocxPackageBuffer(bytes, basename(path));
}

export async function readDocxPackageBuffer(
  bytes: Uint8Array,
  sourceFileName: string,
): Promise<DocxPackage> {
  if (extname(sourceFileName).toLowerCase() !== ".docx") {
    throw new DocxPackageError(
      "UNSUPPORTED_EXTENSION",
      "仅支持导入 .docx 文件；.doc、.docm 和其他格式不受支持。",
    );
  }
  if (bytes.byteLength > DOCX_MAX_UNCOMPRESSED_BYTES) {
    throw new DocxPackageError("PACKAGE_TOO_LARGE", "DOCX 文件大小超过 256 MiB。");
  }
  const zip = await openZip(Buffer.from(bytes));
  const parts = await readEntries(zip);
  const contentTypes = parts.get("[Content_Types].xml");
  if (!contentTypes) {
    throw new DocxPackageError("MISSING_CONTENT_TYPES", "DOCX 缺少 [Content_Types].xml。");
  }
  const contentTypeText = Buffer.from(contentTypes).toString("utf8").toLowerCase();
  if (
    contentTypeText.includes("macroenabled") ||
    [...parts.keys()].some((partName) => partName.toLowerCase() === "word/vbaproject.bin")
  ) {
    throw new DocxPackageError("MACRO_ENABLED", "不允许导入包含宏的 Word 文档。");
  }
  if (!parts.has("word/document.xml")) {
    throw new DocxPackageError("MISSING_DOCUMENT", "DOCX 中找不到正文 word/document.xml。");
  }

  const findings = collectSecurityFindings(parts);
  const externalRelationships = collectExternalRelationships(parts);
  return {
    sourceFileName,
    parts,
    externalRelationships,
    findings,
  };
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      {
        autoClose: true,
        lazyEntries: true,
        strictFileNames: false,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) {
          reject(
            new DocxPackageError(
              "INVALID_ZIP",
              error instanceof Error
                ? `DOCX 压缩包无法打开：${error.message}`
                : "DOCX 压缩包无法打开。",
            ),
          );
          return;
        }
        resolve(zip);
      },
    );
  });
}

function readEntries(zip: ZipFile): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const parts = new Map<string, Uint8Array>();
    const budget = createDocxEntryBudget();
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", (error) =>
      fail(
        error instanceof DocxPackageError
          ? error
          : new DocxPackageError("INVALID_ZIP", `DOCX 压缩包读取失败：${error.message}`),
      ),
    );
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        const normalizedName = validateDocxEntryLimits(entry, budget);
        if (!entry.fileName.endsWith("/")) {
          parts.set(normalizedName, await readEntry(zip, entry));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(parts);
    });
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new DocxPackageError(
            "INVALID_ZIP",
            error instanceof Error ? error.message : `无法读取 DOCX 条目 ${entry.fileName}。`,
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > DOCX_MAX_ENTRY_BYTES) {
          stream.destroy(
            new DocxPackageError("ENTRY_TOO_LARGE", `DOCX 条目 ${entry.fileName} 超过 64 MiB。`),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Uint8Array.from(Buffer.concat(chunks, length))));
    });
  });
}

function collectSecurityFindings(parts: ReadonlyMap<string, Uint8Array>): DocxSecurityFinding[] {
  const findings: DocxSecurityFinding[] = [];
  for (const partName of parts.keys()) {
    const lower = partName.toLowerCase();
    if (lower.startsWith("word/embeddings/")) {
      findings.push({
        code: "UNSUPPORTED_OLE",
        severity: "blocking",
        partName,
        message: "文档包含不受支持的嵌入对象（OLE）。",
      });
    } else if (lower.startsWith("word/activex/")) {
      findings.push({
        code: "UNSUPPORTED_ACTIVEX",
        severity: "blocking",
        partName,
        message: "文档包含不受支持的 ActiveX 控件。",
      });
    }
  }
  return findings;
}

function collectExternalRelationships(
  parts: ReadonlyMap<string, Uint8Array>,
): DocxExternalRelationship[] {
  const relationships: DocxExternalRelationship[] = [];
  for (const [partName, bytes] of parts) {
    if (!partName.toLowerCase().endsWith(".rels")) continue;
    const document = new DOMParser().parseFromString(
      Buffer.from(bytes).toString("utf8"),
      "text/xml",
    );
    const sourcePart = relationshipSourcePart(partName);
    for (const relationship of Array.from(document.getElementsByTagName("Relationship"))) {
      if (relationship.getAttribute("TargetMode")?.toLowerCase() !== "external") continue;
      relationships.push({
        sourcePart,
        relationshipId: relationship.getAttribute("Id") ?? "",
        target: relationship.getAttribute("Target") ?? "",
      });
    }
  }
  return relationships;
}

function relationshipSourcePart(relationshipPart: string): string {
  if (relationshipPart === "_rels/.rels") return "";
  const marker = "/_rels/";
  const index = relationshipPart.lastIndexOf(marker);
  if (index < 0 || !relationshipPart.endsWith(".rels")) return relationshipPart;
  return `${relationshipPart.slice(0, index)}/${relationshipPart.slice(index + marker.length, -5)}`;
}
