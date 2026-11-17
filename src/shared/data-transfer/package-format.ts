import { z } from "zod";
import { textPolishHistoryPathPattern } from "./text-polish-history.js";

export const DATA_TRANSFER_PACKAGE_VERSION = 2;
const DATA_TRANSFER_MAGIC_BYTES = [
  0x5a, 0x58, 0x57, 0x42, 0x41, 0x43, 0x4b, 0x55, 0x50, 0x00, 0x01, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;
const DATA_TRANSFER_FOOTER_MAGIC_BYTES = [0x5a, 0x58, 0x57, 0x45, 0x4e, 0x44, 0x31, 0x00] as const;
export const DATA_TRANSFER_MAGIC = Uint8Array.from(DATA_TRANSFER_MAGIC_BYTES);
export const DATA_TRANSFER_FOOTER_MAGIC = Uint8Array.from(DATA_TRANSFER_FOOTER_MAGIC_BYTES);
export const DATA_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const DATA_TRANSFER_HEADER_LIMIT = 64 * 1024;
export const DATA_TRANSFER_FRAME_HEADER_BYTES = 28;
export const DATA_TRANSFER_FOOTER_BYTES = 88;
export const DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES = 12;
export const DATA_TRANSFER_GCM_TAG_BYTES = 16;
export const DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES = 21;
export const DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES =
  DATA_TRANSFER_PASSWORD_CHECK_NONCE_BYTES +
  DATA_TRANSFER_PASSWORD_CHECK_PLAINTEXT_BYTES +
  DATA_TRANSFER_GCM_TAG_BYTES;

const UINT32_MAX = 0xffffffff;
const UINT64_MAX = 0xffffffffffffffffn;
const LowercaseHex32Schema = z.string().regex(/^[0-9a-f]{64}$/);
const PasswordCheckHexSchema = z
  .string()
  .length(DATA_TRANSFER_PASSWORD_CHECK_BLOCK_BYTES * 2)
  .regex(/^[0-9a-f]+$/);
export const SemVer2Schema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

const DataTransferKdfSchema = z
  .object({
    algorithm: z.literal("scrypt"),
    N: z.literal(131_072),
    r: z.literal(8),
    p: z.literal(1),
    maxmemBytes: z.literal(256 * 1024 * 1024),
    derivedKeyBytes: z.literal(32),
  })
  .strict()
  .readonly();

const PasswordHintSchema = z
  .string()
  .max(200)
  .refine((value) => !/[\p{Cc}\\/]/u.test(value), "Invalid password hint")
  .nullable();

const publicHeaderMacPayloadShape = {
  packageFormatVersion: z.literal(DATA_TRANSFER_PACKAGE_VERSION),
  packageId: z.string().uuid(),
  minimumImporterVersion: SemVer2Schema,
  kdf: DataTransferKdfSchema,
  saltHex: LowercaseHex32Schema,
  noncePrefixHex: z.string().regex(/^[0-9a-f]{8}$/),
  passwordCheckHex: PasswordCheckHexSchema,
  passwordHint: PasswordHintSchema,
} as const;

const PublicHeaderMacPayloadSchema = z.object(publicHeaderMacPayloadShape).strict().readonly();

export const DataTransferPublicHeaderSchema = z
  .object({ ...publicHeaderMacPayloadShape, headerMacHex: LowercaseHex32Schema })
  .strict()
  .readonly();
export type DataTransferPublicHeader = z.infer<typeof DataTransferPublicHeaderSchema>;
export type DataTransferPublicHeaderMacPayload = z.infer<typeof PublicHeaderMacPayloadSchema>;

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftCharacter = leftIterator.next();
    const rightCharacter = rightIterator.next();
    if (leftCharacter.done || rightCharacter.done) {
      if (leftCharacter.done && rightCharacter.done) return 0;
      return leftCharacter.done ? -1 : 1;
    }
    const difference =
      Number(leftCharacter.value.codePointAt(0)) - Number(rightCharacter.value.codePointAt(0));
    if (difference !== 0) return difference;
  }
}

function canonicalJsonText(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid canonical JSON value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("Invalid canonical JSON value");
  if (ancestors.has(value)) throw new Error("Invalid canonical JSON value");
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("Invalid canonical JSON value");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error("Invalid canonical JSON value");
        }
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new Error("Invalid canonical JSON value");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("Invalid canonical JSON value");
        }
        items.push(canonicalJsonText(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Invalid canonical JSON value");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (Object.getOwnPropertyNames(record).length !== keys.length) {
      throw new Error("Invalid canonical JSON value");
    }
    const properties = keys.sort(compareUnicodeCodePoints).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("Invalid canonical JSON value");
      }
      return `${JSON.stringify(key)}:${canonicalJsonText(descriptor.value, ancestors)}`;
    });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalEncodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonText(value, new Set()));
}

// The exported magic constants are mutable compatibility snapshots. Writers must use these
// factories so the private protocol tuples remain the sole authority for emitted bytes.
export function createDataTransferMagicBytes(): Uint8Array {
  return new Uint8Array(DATA_TRANSFER_MAGIC_BYTES);
}

export function createDataTransferFooterMagicBytes(): Uint8Array {
  return new Uint8Array(DATA_TRANSFER_FOOTER_MAGIC_BYTES);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function decodePublicHeaderLength(length: number): number {
  if (!Number.isInteger(length) || length < 1 || length > DATA_TRANSFER_HEADER_LIMIT) {
    throw new Error("Invalid package header length");
  }
  return length;
}

export function encodePublicHeader(header: DataTransferPublicHeader): Uint8Array {
  const bytes = canonicalEncodeJson(DataTransferPublicHeaderSchema.parse(header));
  decodePublicHeaderLength(bytes.byteLength);
  return bytes;
}

export function decodePublicHeader(bytes: Uint8Array): DataTransferPublicHeader {
  decodePublicHeaderLength(bytes.byteLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid package header UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid package header JSON");
  }
  const parsed = DataTransferPublicHeaderSchema.parse(value);
  if (!bytesEqual(bytes, canonicalEncodeJson(parsed))) {
    throw new Error("Invalid canonical package header");
  }
  return parsed;
}

export function encodePublicHeaderMacPayload(
  header: DataTransferPublicHeader | DataTransferPublicHeaderMacPayload,
): Uint8Array {
  const parsed = z
    .union([DataTransferPublicHeaderSchema, PublicHeaderMacPayloadSchema])
    .parse(header);
  const payload =
    "headerMacHex" in parsed
      ? {
          packageFormatVersion: parsed.packageFormatVersion,
          packageId: parsed.packageId,
          minimumImporterVersion: parsed.minimumImporterVersion,
          kdf: parsed.kdf,
          saltHex: parsed.saltHex,
          noncePrefixHex: parsed.noncePrefixHex,
          passwordCheckHex: parsed.passwordCheckHex,
          passwordHint: parsed.passwordHint,
        }
      : parsed;
  return canonicalEncodeJson(PublicHeaderMacPayloadSchema.parse(payload));
}

const transferLogicalPathPattern =
  /^(?:library\/library\.sqlite3|library\/assets\/[0-9A-F]{64}\.asset|legacy-drafts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:draft\.json|[0-9]{8}-[0-9]{6}\.patdoc)|portable-settings\.json|verification\/integrity-summary\.json)$/;

export const TransferLogicalPathSchema = z
  .string()
  .refine(
    (value) => transferLogicalPathPattern.test(value) || textPolishHistoryPathPattern.test(value),
    "Invalid transfer logical path",
  )
  .brand<"TransferLogicalPath">();
export type TransferLogicalPath = z.infer<typeof TransferLogicalPathSchema>;

export function isTransferLogicalPath(value: string): value is TransferLogicalPath {
  return TransferLogicalPathSchema.safeParse(value).success;
}

export const DataTransferFrameType = {
  Manifest: 1,
  EntryData: 2,
} as const;
export type DataTransferFrameType =
  (typeof DataTransferFrameType)[keyof typeof DataTransferFrameType];

export type TransferFrameHeader = Readonly<{
  type: DataTransferFrameType;
  flags: number;
  globalSequence: bigint;
  entryOrdinal: number;
  chunkIndex: number;
  plainLength: number;
  cipherLength: number;
}>;

function requireUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`Invalid frame ${field}`);
  }
}

function requireUint64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new Error(`Invalid ${field}`);
  }
}

function validateFrameHeader(header: TransferFrameHeader): void {
  if (
    header.type !== DataTransferFrameType.Manifest &&
    header.type !== DataTransferFrameType.EntryData
  ) {
    throw new Error("Invalid frame type");
  }
  if (header.flags !== 0 && header.flags !== 1) throw new Error("Invalid frame flags");
  if (header.type === DataTransferFrameType.Manifest && header.flags !== 1) {
    throw new Error("Invalid manifest frame flags");
  }
  requireUint64(header.globalSequence, "frame globalSequence");
  requireUint32(header.entryOrdinal, "entryOrdinal");
  requireUint32(header.chunkIndex, "chunkIndex");
  requireUint32(header.plainLength, "plainLength");
  requireUint32(header.cipherLength, "cipherLength");
  if (header.plainLength > DATA_TRANSFER_CHUNK_BYTES) throw new Error("Invalid frame plainLength");
  if (
    header.cipherLength < DATA_TRANSFER_GCM_TAG_BYTES ||
    header.cipherLength > DATA_TRANSFER_CHUNK_BYTES + DATA_TRANSFER_GCM_TAG_BYTES
  ) {
    throw new Error("Invalid frame cipherLength");
  }
  if (header.plainLength === 0 && header.flags !== 1) throw new Error("Invalid empty frame");
}

export function encodeFrameHeader(header: TransferFrameHeader): Uint8Array {
  validateFrameHeader(header);
  const bytes = new Uint8Array(DATA_TRANSFER_FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, header.type);
  view.setUint8(1, header.flags);
  view.setUint16(2, 0, false);
  view.setBigUint64(4, header.globalSequence, false);
  view.setUint32(12, header.entryOrdinal, false);
  view.setUint32(16, header.chunkIndex, false);
  view.setUint32(20, header.plainLength, false);
  view.setUint32(24, header.cipherLength, false);
  return bytes;
}

export function decodeFrameHeader(bytes: Uint8Array): TransferFrameHeader {
  if (bytes.byteLength !== DATA_TRANSFER_FRAME_HEADER_BYTES) {
    throw new Error("Invalid frame header length");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, false) !== 0) throw new Error("Invalid frame reserved field");
  const header: TransferFrameHeader = {
    type: view.getUint8(0) as DataTransferFrameType,
    flags: view.getUint8(1),
    globalSequence: view.getBigUint64(4, false),
    entryOrdinal: view.getUint32(12, false),
    chunkIndex: view.getUint32(16, false),
    plainLength: view.getUint32(20, false),
    cipherLength: view.getUint32(24, false),
  };
  validateFrameHeader(header);
  return Object.freeze(header);
}

export type PackageFooter = Readonly<{
  manifestFrameOffset: bigint;
  totalFrames: bigint;
  finalAuthenticationChainDigest: Uint8Array;
  footerMac: Uint8Array;
}>;

function requireBytes32(value: Uint8Array, field: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`Invalid package footer ${field}`);
  }
}

export function encodePackageFooter(footer: PackageFooter): Uint8Array {
  requireUint64(footer.manifestFrameOffset, "package footer manifestFrameOffset");
  requireUint64(footer.totalFrames, "package footer totalFrames");
  requireBytes32(footer.finalAuthenticationChainDigest, "finalAuthenticationChainDigest");
  requireBytes32(footer.footerMac, "footerMac");

  const bytes = new Uint8Array(DATA_TRANSFER_FOOTER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(DATA_TRANSFER_FOOTER_MAGIC_BYTES, 0);
  view.setBigUint64(8, footer.manifestFrameOffset, false);
  view.setBigUint64(16, footer.totalFrames, false);
  bytes.set(footer.finalAuthenticationChainDigest, 24);
  bytes.set(footer.footerMac, 56);
  return bytes;
}

export function decodePackageFooter(bytes: Uint8Array): PackageFooter {
  if (bytes.byteLength !== DATA_TRANSFER_FOOTER_BYTES) {
    throw new Error("Invalid package footer length");
  }
  for (let index = 0; index < DATA_TRANSFER_FOOTER_MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== DATA_TRANSFER_FOOTER_MAGIC_BYTES[index]) {
      throw new Error("Invalid package footer magic");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({
    manifestFrameOffset: view.getBigUint64(8, false),
    totalFrames: view.getBigUint64(16, false),
    finalAuthenticationChainDigest: Uint8Array.from(bytes.subarray(24, 56)),
    footerMac: Uint8Array.from(bytes.subarray(56, 88)),
  });
}
