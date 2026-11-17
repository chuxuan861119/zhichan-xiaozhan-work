import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  computePublicHeaderMac,
  createPasswordCheckBlock,
  derivePackageKeys,
  SAFE_SCRYPT_PARAMS,
} from "../../../src/main/data-transfer/package-crypto.js";
import {
  AuthenticatedFrameWriter,
  computePublicHeaderDigest,
} from "../../../src/main/data-transfer/package-framing.js";
import { computePackageFooterMac } from "../../../src/main/data-transfer/package-writer.js";
import type {
  TransferManifest,
  TransferManifestEntry,
} from "../../../src/shared/data-transfer/model.js";
import { TransferManifestSchema } from "../../../src/shared/data-transfer/model.js";
import {
  canonicalEncodeJson,
  createDataTransferMagicBytes,
  DATA_TRANSFER_PACKAGE_VERSION,
  DataTransferFrameType,
  type DataTransferPublicHeader,
  encodePackageFooter,
  encodePublicHeader,
} from "../../../src/shared/data-transfer/package-format.js";

export const V1_FIXTURE_PASSWORD = "虚构迁移口令用于兼容测试甲乙";
export const V1_FIXTURE_PACKAGE_ID = "9f25a100-7d6c-4ae1-8f10-102030405060";

const FIXED_EXPORTED_AT = "2026-08-16T03:04:05.000Z";
const FIXED_CUTOFF_AT = "2026-08-16T03:03:00.000Z";
const FIXED_SALT = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);
const FIXED_PASSWORD_CHECK_NONCE = Buffer.from("202122232425262728292a2b", "hex");
const FIXED_FRAME_NONCE_PREFIX = Buffer.from("30313233", "hex");
const ASSET_LOGICAL_PATH = `library/assets/${"A1".repeat(32)}.asset`;

const DATABASE_BYTES = Buffer.concat([
  Buffer.from("SQLite format 3\0", "ascii"),
  Buffer.from("FICTIONAL-EMPTY-LIBRARY-V1\n".repeat(16), "ascii"),
]);
// Fixed DEFLATE-raw bytes for DATABASE_BYTES. Keeping this literal makes the golden fixture
// independent of platform zlib versions while PackageReader still proves it can inflate it.
const DATABASE_DEFLATE_BYTES = Buffer.from(
  "0b0ef4c92c495548cb2fca4d2c51306670f3740ef1f4f773f4d175f50d0889d4f5f1740a720c8ad40d33e41a951a845200",
  "hex",
);
const ASSET_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c48946494354494f4e414c",
  "hex",
);
const PORTABLE_SETTINGS_BYTES = Buffer.from(
  canonicalEncodeJson({
    version: 1,
    patentTemplates: {
      invention: { displayName: "虚构发明空白模板" },
      utilityModel: { displayName: "虚构实用新型空白模板" },
    },
    pageMargins: { bottomMm: 20, leftMm: 25, rightMm: 20, topMm: 20 },
  }),
);
const VERIFICATION_BYTES = Buffer.from(
  canonicalEncodeJson({
    fixture: true,
    records: 0,
    statement: "仅用于格式兼容测试的虚构空库",
    version: 1,
  }),
);

export type V1FixtureFrameRole = "deflate" | "stored" | "entry-end" | "manifest";

export type V1FixtureFrame = Readonly<{
  role: V1FixtureFrameRole;
  entryOrdinal: number;
  offset: number;
  headerBytes: number;
  cipherOffset: number;
  tagOffset: number;
  endOffset: number;
}>;

export type V1FixtureExpectedEntry = Readonly<{
  logicalPath: string;
  kind: TransferManifestEntry["kind"];
  bytes: Buffer;
}>;

export type V1FixtureSemanticMutation = Readonly<{
  role: "entry-end" | "manifest";
  entryOrdinal: number;
  field: "sha256" | "payloadSha256";
  before: string;
  after: string;
}>;

export type V1MinimalPackageFixture = Readonly<{
  bytes: Buffer;
  manifest: TransferManifest;
  expectedEntries: readonly V1FixtureExpectedEntry[];
  frames: readonly V1FixtureFrame[];
  publicHeader: DataTransferPublicHeader;
  semanticMutation: V1FixtureSemanticMutation | null;
}>;

export type V1FixtureMutation = "entry-metadata" | "manifest-payload-digest";

type FixtureEntrySource = Readonly<{
  logicalPath: string;
  kind: TransferManifestEntry["kind"];
  compression: TransferManifestEntry["compression"];
  plaintext: Buffer;
  compressed: Buffer;
}>;

function changeDigest(digest: string): string {
  return `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
}

function createPreamble(publicHeaderBytes: Buffer): Buffer {
  const magic = Buffer.from(createDataTransferMagicBytes());
  const bytes = Buffer.alloc(magic.byteLength + 4 + publicHeaderBytes.byteLength);
  magic.copy(bytes, 0);
  bytes.writeUInt32BE(publicHeaderBytes.byteLength, magic.byteLength);
  publicHeaderBytes.copy(bytes, magic.byteLength + 4);
  return bytes;
}

export async function createV1MinimalPackageFixture(
  mutation?: V1FixtureMutation,
): Promise<V1MinimalPackageFixture> {
  const salt = Buffer.from(FIXED_SALT);
  const passwordCheckNonce = Buffer.from(FIXED_PASSWORD_CHECK_NONCE);
  const noncePrefix = Buffer.from(FIXED_FRAME_NONCE_PREFIX);
  const keys = await derivePackageKeys(V1_FIXTURE_PASSWORD, salt);
  try {
    const passwordCheck = createPasswordCheckBlock(keys.passwordCheckKey, passwordCheckNonce);
    const unsignedHeader: DataTransferPublicHeader = {
      packageFormatVersion: DATA_TRANSFER_PACKAGE_VERSION,
      packageId: V1_FIXTURE_PACKAGE_ID,
      minimumImporterVersion: "0.1.0",
      kdf: SAFE_SCRYPT_PARAMS,
      saltHex: salt.toString("hex"),
      noncePrefixHex: noncePrefix.toString("hex"),
      passwordCheckHex: passwordCheck.toString("hex"),
      passwordHint: "虚构测试提示",
      headerMacHex: "00".repeat(32),
    };
    const headerMac = computePublicHeaderMac(keys.headerAuthKey, unsignedHeader);
    const publicHeader: DataTransferPublicHeader = {
      ...unsignedHeader,
      headerMacHex: headerMac.toString("hex"),
    };
    const publicHeaderBytes = Buffer.from(encodePublicHeader(publicHeader));
    const preamble = createPreamble(publicHeaderBytes);
    const frameWriter = new AuthenticatedFrameWriter({
      payloadKey: keys.payloadKey,
      packageId: V1_FIXTURE_PACKAGE_ID,
      publicHeaderDigest: computePublicHeaderDigest(publicHeaderBytes),
      noncePrefix,
    });

    const entrySources: readonly FixtureEntrySource[] = [
      {
        logicalPath: "library/library.sqlite3",
        kind: "database",
        compression: "deflate-raw",
        plaintext: DATABASE_BYTES,
        compressed: DATABASE_DEFLATE_BYTES,
      },
      {
        logicalPath: ASSET_LOGICAL_PATH,
        kind: "asset",
        compression: "stored",
        plaintext: ASSET_BYTES,
        compressed: ASSET_BYTES,
      },
      {
        logicalPath: "portable-settings.json",
        kind: "settings",
        compression: "stored",
        plaintext: PORTABLE_SETTINGS_BYTES,
        compressed: PORTABLE_SETTINGS_BYTES,
      },
      {
        logicalPath: "verification/integrity-summary.json",
        kind: "verification",
        compression: "stored",
        plaintext: VERIFICATION_BYTES,
        compressed: VERIFICATION_BYTES,
      },
    ];

    const parts: Buffer[] = [preamble];
    const frames: V1FixtureFrame[] = [];
    const entries: TransferManifestEntry[] = [];
    const payloadHash = createHash("sha256");
    let position = preamble.byteLength;
    let semanticMutation: V1FixtureSemanticMutation | null = null;

    const appendFrame = (
      role: V1FixtureFrameRole,
      input: Parameters<AuthenticatedFrameWriter["encrypt"]>[0],
    ): void => {
      const encoded = frameWriter.encrypt(input);
      const serialized = Buffer.concat([
        encoded.headerBytes,
        encoded.ciphertext,
        encoded.authenticationTag,
      ]);
      const cipherOffset = position + encoded.headerBytes.byteLength;
      frames.push(
        Object.freeze({
          role,
          entryOrdinal: input.entryOrdinal,
          offset: position,
          headerBytes: encoded.headerBytes.byteLength,
          cipherOffset,
          tagOffset: cipherOffset + encoded.ciphertext.byteLength,
          endOffset: position + serialized.byteLength,
        }),
      );
      parts.push(serialized);
      position += serialized.byteLength;
      encoded.nonce.fill(0);
      encoded.ciphertext.fill(0);
      encoded.authenticationTag.fill(0);
      encoded.authenticationChainDigest.fill(0);
    };

    for (const [ordinal, source] of entrySources.entries()) {
      payloadHash.update(source.plaintext);
      appendFrame(source.compression === "deflate-raw" ? "deflate" : "stored", {
        type: DataTransferFrameType.EntryData,
        flags: 0,
        entryOrdinal: ordinal,
        chunkIndex: 0,
        plainLength: source.plaintext.byteLength,
        compressedBytes: source.compressed,
      });
      const baseEntry: TransferManifestEntry = {
        ordinal,
        logicalPath: source.logicalPath,
        kind: source.kind,
        compression: source.compression,
        originalBytes: source.plaintext.byteLength,
        compressedBytes: source.compressed.byteLength,
        sha256: createHash("sha256").update(source.plaintext).digest("hex"),
        chunkCount: 1,
      };
      const entry =
        mutation === "entry-metadata" && ordinal === 1
          ? { ...baseEntry, sha256: changeDigest(baseEntry.sha256) }
          : baseEntry;
      if (entry.sha256 !== baseEntry.sha256) {
        semanticMutation = Object.freeze({
          role: "entry-end",
          entryOrdinal: ordinal,
          field: "sha256",
          before: baseEntry.sha256,
          after: entry.sha256,
        });
      }
      const entryEndBytes = Buffer.from(canonicalEncodeJson(entry));
      appendFrame("entry-end", {
        type: DataTransferFrameType.EntryData,
        flags: 1,
        entryOrdinal: ordinal,
        chunkIndex: 1,
        plainLength: entryEndBytes.byteLength,
        compressedBytes: entryEndBytes,
      });
      entries.push(entry);
      entryEndBytes.fill(0);
    }

    const basePayloadSha256 = payloadHash.digest("hex");
    const payloadSha256 =
      mutation === "manifest-payload-digest" ? changeDigest(basePayloadSha256) : basePayloadSha256;
    if (payloadSha256 !== basePayloadSha256) {
      semanticMutation = Object.freeze({
        role: "manifest",
        entryOrdinal: 0,
        field: "payloadSha256",
        before: basePayloadSha256,
        after: payloadSha256,
      });
    }
    const totalOriginalBytes = entrySources.reduce(
      (sum, entry) => sum + entry.plaintext.byteLength,
      0,
    );
    const manifest = TransferManifestSchema.parse({
      packageFormatVersion: DATA_TRANSFER_PACKAGE_VERSION,
      packageId: V1_FIXTURE_PACKAGE_ID,
      exportedByVersion: "0.1.0-fixture",
      minimumImporterVersion: "0.1.0",
      databaseSchemaVersion: 9,
      databaseSchemaFingerprint: "fixture-empty-schema-v9",
      canonicalPatentFormatVersion: 2,
      exportedAt: FIXED_EXPORTED_AT,
      cutoffAt: FIXED_CUTOFF_AT,
      summary: {
        activePatents: 0,
        trashedPatents: 0,
        documents: 0,
        legacyDrafts: 0,
        snapshots: 0,
        assets: 1,
        flowchartProjects: 0,
        scientificChartProjects: 0,
        totalBytes: totalOriginalBytes,
      },
      entries,
      portableSettingKeys: ["pageMargins", "patentTemplates"],
      excludedMachineSettingCategories: [
        "ai-credentials",
        "backup-folder",
        "printer",
        "recent-paths",
        "window-state",
      ],
      totalOriginalBytes,
      totalChunkCount: entrySources.length,
      payloadSha256,
    });
    // Keep the historical bytes frozen; readers discard this retired summary field.
    const manifestBytes = Buffer.from(
      canonicalEncodeJson({
        ...manifest,
        summary: { ...manifest.summary, scientificChartProjects: 0 },
      }),
    );
    const manifestFrameOffset = BigInt(position);
    appendFrame("manifest", {
      type: DataTransferFrameType.Manifest,
      flags: 1,
      entryOrdinal: 0,
      chunkIndex: 0,
      plainLength: manifestBytes.byteLength,
      compressedBytes: manifestBytes,
    });
    manifestBytes.fill(0);

    const finalAuthenticationChainDigest = frameWriter.finalAuthenticationChainDigest;
    const footerMac = computePackageFooterMac(
      keys.headerAuthKey,
      manifestFrameOffset,
      frameWriter.totalFrames,
      finalAuthenticationChainDigest,
    );
    const footer = Buffer.from(
      encodePackageFooter({
        manifestFrameOffset,
        totalFrames: frameWriter.totalFrames,
        finalAuthenticationChainDigest: Uint8Array.from(finalAuthenticationChainDigest),
        footerMac: Uint8Array.from(footerMac),
      }),
    );
    parts.push(footer);

    const expectedEntries = entrySources.map((entry) =>
      Object.freeze({
        logicalPath: entry.logicalPath,
        kind: entry.kind,
        bytes: Buffer.from(entry.plaintext),
      }),
    );
    return Object.freeze({
      bytes: Buffer.concat(parts),
      manifest,
      expectedEntries,
      frames,
      publicHeader,
      semanticMutation,
    });
  } finally {
    keys.destroy();
    salt.fill(0);
    passwordCheckNonce.fill(0);
    noncePrefix.fill(0);
  }
}
