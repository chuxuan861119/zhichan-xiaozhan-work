import { DesignEditorProjectAssetDescriptorSchema } from "../../../../shared/document/model";
import {
  type ImportedAsset,
  type PatentEditAck,
  type StageDesignEditorProjectRequest,
  StageDesignEditorProjectRequestSchema,
} from "../../../../shared/ipc/contract";
import type { AppResult } from "../../../../shared/ipc/result";
import type { KlecksCaseCheckpoint } from "./klecks-case-checkpoint";

export type KlecksProjectSaveInput = StageDesignEditorProjectRequest &
  Omit<KlecksCaseCheckpoint, "checkpoint" | "asset">;
export type KlecksProjectSaveDependencies = {
  stage(request: StageDesignEditorProjectRequest): Promise<AppResult<ImportedAsset>>;
  commit(request: KlecksCaseCheckpoint): Promise<PatentEditAck>;
  isCurrent(): boolean;
  onSaved(): void;
};
export async function saveKlecksProject(
  input: KlecksProjectSaveInput,
  dependencies: KlecksProjectSaveDependencies,
): Promise<PatentEditAck> {
  const requireCurrent = () => {
    if (!dependencies.isCurrent())
      throw { code: "CANCELLED", message: "图片编辑会话已改变，未提交旧保存结果。" };
  };
  requireCurrent();
  const target = structuredClone({
    viewId: input.viewId,
    sourceAssetId: input.sourceAssetId,
    expectedEditor: input.expectedEditor,
    kind: input.kind,
    preserveApplied: input.preserveApplied,
  });
  const request = StageDesignEditorProjectRequestSchema.parse({
    sessionId: input.sessionId,
    project: input.project,
    thumbnail: input.thumbnail,
  });
  request.project.psd = Uint8Array.from(request.project.psd);
  request.project.backings = request.project.backings.map(({ id, bytes }) => ({
    id,
    bytes: Uint8Array.from(bytes),
  }));
  request.thumbnail = Uint8Array.from(request.thumbnail);
  const staged = await dependencies.stage(request);
  if (!staged.ok) throw staged.error;
  requireCurrent();
  const asset = DesignEditorProjectAssetDescriptorSchema.parse(staged.value.descriptor);
  if (
    asset.widthPx !== request.project.metadata.size.width ||
    asset.heightPx !== request.project.metadata.size.height
  )
    throw { code: "INVALID_INPUT", message: "暂存工程尺寸与冻结工程不一致。" };
  const ack = await dependencies.commit({
    ...target,
    asset,
    checkpoint: {
      revisionId: crypto.randomUUID(),
      projectAssetId: asset.assetId,
      createdAt: new Date().toISOString(),
    },
  });
  if (target.kind === "saved" && dependencies.isCurrent()) dependencies.onSaved();
  return ack;
}
