import { z } from "zod";
import type { CanonicalDocument } from "../../shared/document/model.js";
import { MAX_DRAWING_INPUT_BYTES } from "../../shared/drawing-markup/model.js";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import type { JsonObject } from "../../shared/ipc/primitives.js";
import {
  type CanonicalPatent,
  EDITABLE_CAD_PATENT_FORMAT_VERSION,
  type PatentBookKind,
  UNIFIED_CAD_PATENT_FORMAT_VERSION,
} from "../../shared/patent/model.js";

import type { StoredAsset } from "../assets/asset-store.js";

export const PATDOC_FORMAT_VERSION = 12 as const;

export function patentArchiveVersion(patent: CanonicalPatent): 9 | 10 | 11 | 12 {
  if (patent.formatVersion >= UNIFIED_CAD_PATENT_FORMAT_VERSION) return 12;
  if (patent.formatVersion >= EDITABLE_CAD_PATENT_FORMAT_VERSION) return 11;
  return patent.assets.some((asset) => asset.kind === "drawing-tiles") ? 10 : 9;
}
export const MAX_ARCHIVE_ENTRIES = 4_096;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_ASSET_ENTRY_BYTES = 50 * 1024 * 1024;

export function assetEntryByteLimit(name: string): number {
  if (/^assets\/[0-9a-f-]+\/original\.cadtiles$/iu.test(name)) return 256 * 1024 * 1024;
  return /^assets\/[0-9a-f-]+\/original\.(?:dwg|dxf)$/iu.test(name)
    ? MAX_DRAWING_INPUT_BYTES
    : MAX_ASSET_ENTRY_BYTES;
}

const FileReferenceSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[0-9A-F]{64}$/u),
    byteLength: z.number().int().nonnegative().max(MAX_JSON_BYTES),
  })
  .strict();

export const ManifestSchema = z
  .object({
    formatVersion: z.union([
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(PATDOC_FORMAT_VERSION),
    ]),
    patentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    patent: FileReferenceSchema,
    history: FileReferenceSchema.optional(),
    books: z
      .array(
        z
          .object({
            kind: z.enum([
              "claims",
              "description",
              "description-drawings",
              "abstract",
              "abstract-drawing",
            ]),
            path: z.string().min(1).max(1_024),
            sha256: z.string().regex(/^[0-9A-F]{64}$/u),
            byteLength: z.number().int().nonnegative().max(MAX_JSON_BYTES),
          })
          .strict(),
      )
      .length(5),
    assets: z.array(
      z
        .object({
          assetId: z.string().uuid(),
          original: z.string().min(1).max(1_024),
          preview: z.string().min(1).max(1_024),
          originalSha256: z.string().regex(/^[0-9A-F]{64}$/u),
          originalByteLength: z
            .number()
            .int()
            .nonnegative()
            .max(256 * 1024 * 1024),
          previewSha256: z.string().regex(/^[0-9A-F]{64}$/u),
          previewByteLength: z.number().int().nonnegative().max(MAX_ASSET_ENTRY_BYTES),
        })
        .strict()
        .refine(
          (asset) => asset.originalByteLength <= assetEntryByteLimit(asset.original),
          "资源原文件超过大小限制。",
        ),
    ),
    flowcharts: z
      .array(
        z
          .object({
            projectId: z.string().uuid(),
            path: z.string().min(1).max(1_024),
            sha256: z.string().regex(/^[0-9A-F]{64}$/u),
            byteLength: z.number().int().nonnegative().max(FLOWCHART_MAX_SOURCE_XML_BYTES),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type PatdocManifest = z.infer<typeof ManifestSchema>;

export const DocumentManifestSchema = z
  .object({
    formatVersion: z.union([
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(PATDOC_FORMAT_VERSION),
    ]),
    kind: z.literal("document"),
    documentId: z.string().uuid(),
    document: FileReferenceSchema,
    settings: FileReferenceSchema,
    editorState: FileReferenceSchema,
    assets: ManifestSchema.shape.assets,
  })
  .strict();
export type DocumentPatdocManifest = z.infer<typeof DocumentManifestSchema>;
export const CurrentManifestSchema = z.union([ManifestSchema, DocumentManifestSchema]);

/** The v2–v7 patent archive manifests omit editable flowchart sources. */
const LegacyManifestSchema = ManifestSchema.omit({ flowcharts: true, history: true });
export const LegacyManifestV8Schema = z.union([
  ManifestSchema.omit({ history: true }).extend({ formatVersion: z.literal(8) }),
  DocumentManifestSchema.extend({ formatVersion: z.literal(8) }),
]);
export const LegacyManifestV3Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(3),
});
export type LegacyPatdocManifestV3 = z.infer<typeof LegacyManifestV3Schema>;

export const LegacyManifestV4Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(4),
});
export type LegacyPatdocManifestV4 = z.infer<typeof LegacyManifestV4Schema>;

export const LegacyManifestV5Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(5),
});
export type LegacyPatdocManifestV5 = z.infer<typeof LegacyManifestV5Schema>;

export const LegacyManifestV2Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(2),
});
export type LegacyPatdocManifestV2 = z.infer<typeof LegacyManifestV2Schema>;

export const LegacyManifestV6Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(6),
});
export type LegacyPatdocManifestV6 = z.infer<typeof LegacyManifestV6Schema>;

export const LegacyManifestV7Schema = LegacyManifestSchema.extend({
  formatVersion: z.literal(7),
});

export type PatentPatdocPayload = {
  patent: CanonicalPatent;
  assets: StoredAsset[];
  flowcharts?: Array<{ projectId: string; source: Uint8Array }>;
  snapshots?: PatdocSnapshot[];
};

export type PatdocSnapshot = Omit<PatentPatdocPayload, "snapshots"> & {
  createdAt: string;
  source: import("../../shared/snapshot/model.js").SnapshotSource;
};

export type PatdocPayload = {
  document: CanonicalDocument;
  settings: JsonObject;
  editorState: JsonObject;
  assets: StoredAsset[];
};

export class PatdocError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARCHIVE"
      | "UNSUPPORTED_VERSION"
      | "RESOURCE_MISMATCH"
      | "PATDOC_CAPACITY_LIMIT"
      | "PATDOC_HISTORY_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "PatdocError";
  }
}

export function patentEntryName(): string {
  return "patent.json";
}

export function documentEntryName(): string {
  return "document.json";
}

export function documentSettingsEntryName(): string {
  return "settings.json";
}

export function documentEditorStateEntryName(): string {
  return "editor-state.json";
}

export function bookEntryName(kind: PatentBookKind): string {
  return `books/${kind}.json`;
}

export function originalEntryName(asset: StoredAsset["descriptor"]): string {
  return `assets/${asset.assetId}/original.${asset.extension}`;
}

export function previewEntryName(assetId: string): string {
  return `assets/${assetId}/preview.png`;
}

export function flowchartEntryName(projectId: string): string {
  return `flowcharts/${projectId}.drawio`;
}
