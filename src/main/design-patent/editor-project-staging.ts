import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  type StageDesignEditorProjectRequest,
  StageDesignEditorProjectRequestSchema,
} from "../../shared/ipc/contract.js";
import type { AssetStore } from "../assets/asset-store.js";
import { type EditorOperationPool, editorOperationPool } from "./editor-operation-pool.js";
import { encodeEditorPackage } from "./editor-project-package.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

/** Stages immutable bytes only; the existing case transaction must adopt their reference. */
export async function stageEditorProject(
  input: StageDesignEditorProjectRequest,
  assets: AssetStore,
  requireActive: () => void,
  admission: EditorOperationPool = editorOperationPool,
) {
  const request = StageDesignEditorProjectRequestSchema.parse(input);
  requireActive();
  const binaryBytes =
    request.project.psd.byteLength +
    request.project.backings.reduce((sum, asset) => sum + asset.bytes.byteLength, 0) +
    request.thumbnail.byteLength;
  // Bounded manifest parsing/copies plus package, IPC and preview work buffers; no PSD pixel decode here.
  const release = admission.reserve(36 * 1024 ** 2 + binaryBytes * 6);
  try {
    const original = Uint8Array.from(
      encodeEditorPackage(request.project, {
        maxBytes: 50 * 1024 * 1024,
        maxDecodedPixels: 16 * 40000000 * 2,
      }),
    );
    const thumbnail = Buffer.from(request.thumbnail);
    const image = sharp(thumbnail, { limitInputPixels: 512 * 512, failOn: "error" });
    const info = await image.metadata();
    if (
      info.format !== "png" ||
      !info.width ||
      !info.height ||
      info.width > 512 ||
      info.height > 512 ||
      (info.pages ?? 1) !== 1
    )
      throw new Error("工程缩略图必须是单帧且不超过512×512的PNG。");
    const preview = Uint8Array.from(await image.png().toBuffer());
    requireActive();
    const descriptor = {
      assetId: randomUUID(),
      kind: "design-editor-project" as const,
      originalName: "image.klecks",
      mediaType: "application/vnd.patent-workbench.klecks-project" as const,
      extension: "klecks" as const,
      byteLength: original.byteLength,
      sha256: hash(original),
      widthPx: request.project.metadata.size.width,
      heightPx: request.project.metadata.size.height,
      previewByteLength: preview.byteLength,
      previewSha256: hash(preview),
    };
    const staged = await assets.putPersistentManyStaged(request.sessionId, [
      { descriptor, original, preview },
    ]);
    const result = staged[0];
    if (!result) throw new Error("工程资产暂存未返回结果。");
    try {
      requireActive();
    } catch (error) {
      await assets
        .discardPersistentStages(request.sessionId, [result.descriptor.assetId])
        .catch(() => undefined);
      throw error;
    }
    return result;
  } finally {
    release();
  }
}
