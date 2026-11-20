import { createHash } from "node:crypto";
import {
  type AssetReferenceRequest,
  AssetReferenceRequestSchema,
  type DesignEditorProjectData,
} from "../../shared/ipc/contract.js";
import type { AssetStore, StoredAsset } from "../assets/asset-store.js";
import { type EditorOperationPool, editorOperationPool } from "./editor-operation-pool.js";
import { decodeEditorPackage } from "./editor-project-package.js";

/** Only session-adopted assets: do not load an arbitrary library asset by caller-supplied UUID. */
export function readEditorProject(
  input: AssetReferenceRequest,
  assets: AssetStore,
  requireActive: () => void,
  admission: EditorOperationPool = editorOperationPool,
): DesignEditorProjectData {
  const request = AssetReferenceRequestSchema.parse(input);
  requireActive();
  return decodeOwnedEditorProject(
    assets.get(request.sessionId, request.assetId),
    requireActive,
    admission,
  );
}

/** Authorize before reading from disk and recheck after the asynchronous read. */
export async function readPersistedEditorProject(
  input: AssetReferenceRequest,
  assets: AssetStore,
  requireOwned: () => void,
): Promise<DesignEditorProjectData> {
  const request = AssetReferenceRequestSchema.parse(input);
  requireOwned();
  const asset = await assets.getOrLoad(request.sessionId, request.assetId);
  requireOwned();
  return decodeOwnedEditorProject(asset, () => undefined, editorOperationPool);
}

function decodeOwnedEditorProject(
  asset: StoredAsset | undefined,
  requireActive: () => void,
  admission: EditorOperationPool,
): DesignEditorProjectData {
  if (asset?.descriptor.kind !== "design-editor-project")
    throw new Error("当前案件中没有此分层工程资产。");
  const release = admission.reserve(32 * 1024 ** 2 + asset.original.byteLength * 6);
  try {
    if (
      asset.original.byteLength !== asset.descriptor.byteLength ||
      createHash("sha256").update(asset.original).digest("hex").toUpperCase() !==
        asset.descriptor.sha256
    )
      throw new Error("分层工程资产完整性校验失败。");
    const project = decodeEditorPackage(asset.original, {
      maxBytes: 50 * 1024 * 1024,
      maxDecodedPixels: 16 * 40000000 * 2,
    });
    if (
      project.metadata.size.width !== asset.descriptor.widthPx ||
      project.metadata.size.height !== asset.descriptor.heightPx
    )
      throw new Error("分层工程资产尺寸不一致。");
    requireActive();
    return {
      metadata: project.metadata,
      psd: Uint8Array.from(project.psd),
      backings: project.backings.map(({ id, bytes }) => ({ id, bytes: Uint8Array.from(bytes) })),
    };
  } finally {
    release();
  }
}
