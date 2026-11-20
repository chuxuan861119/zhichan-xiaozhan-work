import { createHash } from "node:crypto";
import { z } from "zod";
import { validateEditorBinaryHeader } from "../../shared/patent/design-editor-binary.js";
import {
  type DesignEditorMetadata,
  DesignEditorMetadataSchema,
} from "../../shared/patent/design-editor-project.js";
import { validateEditorPsdLayout } from "../../shared/patent/design-editor-psd.js";

const MAGIC = Buffer.from("KLECKSP1", "ascii");
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const reference = z
  .object({
    id: z.string().min(1).max(208),
    byteLength: z.number().int().positive().max(0x7fffffff),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    metadata: DesignEditorMetadataSchema,
    assets: z.array(reference).min(1).max(17),
  })
  .strict();
export type EditorPackageBudget = { maxBytes: number; maxDecodedPixels: number };
export type EditorProjectPackage = {
  metadata: DesignEditorMetadata;
  psd: Buffer;
  backings: { id: string; bytes: Buffer }[];
};
type Input = { metadata: unknown; psd: Uint8Array; backings: { id: string; bytes: Uint8Array }[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function validateBinaries(
  metadata: DesignEditorMetadata,
  psd: Uint8Array,
  backings: { id: string; bytes: Uint8Array }[],
): void {
  validateEditorBinaryHeader(psd, "psd", metadata.size);
  if (metadata.layers.some((layer) => layer.mask))
    validateEditorPsdLayout(
      psd,
      metadata.size,
      metadata.layers.length,
      metadata.layers.map((layer) => layer.mask),
    );
  for (const asset of backings) {
    const bounds = metadata.layers.find((layer) => layer.id === asset.id)?.backing;
    if (!bounds) throw new Error("工程外围资产引用不一致。");
    validateEditorBinaryHeader(asset.bytes, "png", bounds);
  }
}

function validateBudget(budget: EditorPackageBudget): void {
  if (
    !Number.isSafeInteger(budget.maxBytes) ||
    budget.maxBytes < 12 ||
    budget.maxBytes > 0x7fffffff ||
    !Number.isSafeInteger(budget.maxDecodedPixels) ||
    budget.maxDecodedPixels < 1
  )
    throw new Error("工程资源预算无效。");
}

function validateReferences(
  metadata: DesignEditorMetadata,
  ids: string[],
  budget: EditorPackageBudget,
): void {
  const expected = metadata.layers.filter((layer) => layer.backing).map((layer) => layer.id);
  if (
    new Set(ids).size !== ids.length ||
    expected.length !== ids.length ||
    expected.some((id) => !ids.includes(id))
  )
    throw new Error("工程外围资产引用不一致。");
  const pixels =
    metadata.size.width * metadata.size.height * metadata.layers.length +
    metadata.layers.reduce(
      (total, layer) =>
        total +
        (layer.backing ? layer.backing.width * layer.backing.height : 0) +
        (layer.mask ? layer.mask.width * layer.mask.height : 0),
      0,
    );
  if (pixels > budget.maxDecodedPixels) throw new Error("工程解码像素总量超过本次操作预算。");
}

/** Length-prefixed JSON manifest followed by raw binary assets; no filesystem paths or base64. */
export function encodeEditorPackage(input: Input, budget: EditorPackageBudget): Buffer {
  validateBudget(budget);
  const metadata = DesignEditorMetadataSchema.parse(input.metadata);
  validateReferences(
    metadata,
    input.backings.map((item) => item.id),
    budget,
  );
  const assets = [
    { id: "psd", bytes: input.psd },
    ...input.backings.map((item) => ({ id: `backing:${item.id}`, bytes: item.bytes })),
  ];
  const byteLength = assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
  if (byteLength > budget.maxBytes || assets.some((asset) => !asset.bytes.byteLength))
    throw new Error("工程二进制资源超限或为空。");
  validateBinaries(metadata, input.psd, input.backings);
  const manifest = manifestSchema.parse({
    version: 1,
    metadata,
    assets: assets.map((asset) => ({
      id: asset.id,
      byteLength: asset.bytes.byteLength,
      sha256: hash(asset.bytes),
    })),
  });
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  if (json.length > MAX_MANIFEST_BYTES || 12 + json.length + byteLength > budget.maxBytes)
    throw new Error("工程包大小超过本次操作预算。");
  const header = Buffer.alloc(12);
  MAGIC.copy(header);
  header.writeUInt32BE(json.length, 8);
  return Buffer.concat([header, json, ...assets.map((asset) => asset.bytes)]);
}

/** Checks associations, lengths, digests and binary headers before returning independent buffers.
 * Complete PSD/PNG structure and actual decoded dimensions still require decoder validation.
 */
export function decodeEditorPackage(
  input: Uint8Array,
  budget: EditorPackageBudget,
): EditorProjectPackage {
  validateBudget(budget);
  if (input.byteLength < 12 || input.byteLength > budget.maxBytes)
    throw new Error("工程包大小无效。");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 8).equals(MAGIC)) throw new Error("不支持的编辑工程格式。");
  const jsonLength = bytes.readUInt32BE(8);
  if (!jsonLength || jsonLength > MAX_MANIFEST_BYTES || 12 + jsonLength > bytes.length)
    throw new Error("工程清单长度无效。");
  const manifest = manifestSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + jsonLength)),
    ),
  );
  if (manifest.assets[0]?.id !== "psd") throw new Error("缺少分层工程资源。");
  const ids = manifest.assets.slice(1).map((asset) => {
    if (!asset.id.startsWith("backing:")) throw new Error("未知工程资源类型。");
    return asset.id.slice(8);
  });
  validateReferences(manifest.metadata, ids, budget);
  let offset = 12 + jsonLength;
  const slices = manifest.assets.map((asset) => {
    const end = offset + asset.byteLength;
    if (end > bytes.length) throw new Error("工程资源被截断。");
    const part = bytes.subarray(offset, end);
    offset = end;
    if (hash(part) !== asset.sha256) throw new Error("工程资源摘要不一致。");
    return part;
  });
  if (offset !== bytes.length) throw new Error("工程包存在未声明内容。");
  const psd = slices[0];
  if (!psd) throw new Error("缺少分层工程资源。");
  const backings = ids.map((id, index) => {
    const part = slices[index + 1];
    if (!part) throw new Error("缺少外围像素资源。");
    return { id, bytes: part };
  });
  validateBinaries(manifest.metadata, psd, backings);
  return {
    metadata: manifest.metadata,
    psd: Buffer.from(psd),
    backings: backings.map(({ id, bytes: part }) => ({ id, bytes: Buffer.from(part) })),
  };
}
