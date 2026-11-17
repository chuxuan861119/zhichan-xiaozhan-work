import { createHash } from "node:crypto";
import { z } from "zod";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import { CanonicalPatentSchema } from "../../shared/patent/model.js";
import { SnapshotSourceSchema } from "../../shared/snapshot/model.js";
import { PatdocError, type PatdocSnapshot, type PatentPatdocPayload } from "./patdoc-format.js";

export const HISTORY_PATH = "history/index.json";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const HashSchema = z.string().regex(/^[0-9A-F]{64}$/u);
const IndexSchema = z
  .array(
    z
      .object({
        patent: CanonicalPatentSchema,
        createdAt: z.string().datetime(),
        source: SnapshotSourceSchema,
        flowcharts: z.array(z.object({ projectId: z.string().uuid(), hash: HashSchema }).strict()),
      })
      .strict(),
  )
  .max(4096);

function assertConsistentAssetIds(payload: PatentPatdocPayload) {
  const identities = new Map<string, string>();
  for (const patent of [
    payload.patent,
    ...(payload.snapshots ?? []).map((snapshot) => snapshot.patent),
  ]) {
    for (const asset of patent.assets) {
      const identity = `${asset.sha256}:${asset.previewSha256}:${asset.byteLength}:${asset.previewByteLength}`;
      const previous = identities.get(asset.assetId);
      if (previous && previous !== identity)
        throw new PatdocError("RESOURCE_MISMATCH", "不同快照中同一资源的内容不一致。");
      identities.set(asset.assetId, identity);
    }
  }
}

function currentBlobs(payload: PatentPatdocPayload) {
  const blobs = new Map<string, Uint8Array>();
  for (const asset of payload.assets) {
    blobs.set(hash(asset.original), asset.original);
    blobs.set(hash(asset.preview), asset.preview);
  }
  for (const source of payload.flowcharts ?? []) blobs.set(hash(source.source), source.source);
  return blobs;
}

export function encodePatdocHistory(payload: PatentPatdocPayload): Map<string, Buffer> {
  assertConsistentAssetIds(payload);
  const blobs = currentBlobs(payload);
  const entries = new Map<string, Buffer>();
  const add = (bytes: Uint8Array, expected: string) => {
    if (hash(bytes) !== expected) throw new PatdocError("RESOURCE_MISMATCH", "历史资源校验失败。");
    if (!blobs.has(expected)) {
      blobs.set(expected, bytes);
      entries.set(`history/blobs/${expected}.bin`, Buffer.from(bytes));
    }
    return expected;
  };
  const index = (payload.snapshots ?? []).map((snapshot) => {
    if (snapshot.patent.patentId !== payload.patent.patentId)
      throw new PatdocError("RESOURCE_MISMATCH", "历史快照不属于当前专利。");
    const assets = new Map(snapshot.assets.map((item) => [item.descriptor.assetId, item]));
    for (const descriptor of snapshot.patent.assets) {
      const asset = assets.get(descriptor.assetId);
      if (
        !asset ||
        JSON.stringify(asset.descriptor) !== JSON.stringify(descriptor) ||
        asset.original.byteLength !== descriptor.byteLength ||
        asset.preview.byteLength !== descriptor.previewByteLength
      )
        throw new PatdocError("RESOURCE_MISMATCH", "历史快照资源缺失或不一致。");
      add(asset.original, descriptor.sha256);
      add(asset.preview, descriptor.previewSha256);
    }
    const sources = new Map(
      (snapshot.flowcharts ?? []).map((item) => [item.projectId, item.source]),
    );
    const flowcharts = snapshot.patent.flowchartProjects.map((project) => {
      const source = sources.get(project.projectId);
      if (!source || source.byteLength > FLOWCHART_MAX_SOURCE_XML_BYTES)
        throw new PatdocError("RESOURCE_MISMATCH", "历史流程图源文件缺失或过大。");
      return { projectId: project.projectId, hash: add(source, project.sourceSha256) };
    });
    return {
      patent: snapshot.patent,
      createdAt: snapshot.createdAt,
      source: snapshot.source,
      flowcharts,
    };
  });
  if (payload.snapshots !== undefined)
    entries.set(HISTORY_PATH, Buffer.from(JSON.stringify(IndexSchema.parse(index))));
  return entries;
}

export function decodePatdocHistory(
  bytes: Buffer,
  entries: Map<string, Buffer>,
  expected: Set<string>,
  payload: PatentPatdocPayload,
): PatdocSnapshot[] {
  const index = IndexSchema.parse(JSON.parse(bytes.toString("utf8")));
  const blobs = currentBlobs(payload);
  const read = (digest: string, size?: number) => {
    let value = blobs.get(digest);
    if (!value) {
      const path = `history/blobs/${digest}.bin`;
      value = entries.get(path);
      if (!value || hash(value) !== digest)
        throw new PatdocError("RESOURCE_MISMATCH", "历史资源缺失或损坏。");
      expected.add(path);
      blobs.set(digest, value);
    }
    if (size !== undefined && value.byteLength !== size)
      throw new PatdocError("RESOURCE_MISMATCH", "历史资源大小不一致。");
    return value;
  };
  const snapshots = index.map((item) => {
    if (item.patent.patentId !== payload.patent.patentId)
      throw new PatdocError("RESOURCE_MISMATCH", "历史快照归属不一致。");
    const sources = new Map(item.flowcharts.map((source) => [source.projectId, source.hash]));
    return {
      ...item,
      assets: item.patent.assets.map((descriptor) => ({
        descriptor,
        original: read(descriptor.sha256, descriptor.byteLength),
        preview: read(descriptor.previewSha256, descriptor.previewByteLength),
      })),
      flowcharts: item.patent.flowchartProjects.map((project) => {
        if (sources.get(project.projectId) !== project.sourceSha256)
          throw new PatdocError("RESOURCE_MISMATCH", "历史流程图描述不一致。");
        const source = read(project.sourceSha256);
        if (source.byteLength > FLOWCHART_MAX_SOURCE_XML_BYTES)
          throw new PatdocError("RESOURCE_MISMATCH", "历史流程图源文件过大。");
        return { projectId: project.projectId, source };
      }),
    };
  });
  assertConsistentAssetIds({ ...payload, snapshots });
  return snapshots;
}

export function patdocRestoreBytes(payload: PatentPatdocPayload): number {
  return (
    Buffer.byteLength(JSON.stringify(payload.patent)) +
    payload.assets.reduce(
      (sum, asset) => sum + asset.original.byteLength + asset.preview.byteLength,
      0,
    ) +
    (payload.flowcharts ?? []).reduce((sum, source) => sum + source.source.byteLength, 0) +
    [...encodePatdocHistory(payload).values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)
  );
}
