import {
  type AssetDescriptor,
  DesignEditorProjectAssetDescriptorSchema,
} from "../../../../shared/document/model";
import {
  DesignEditorCheckpointSchema,
  type DesignEditorState,
  DesignEditorStateSchema,
} from "../../../../shared/patent/design-editor-state";
import type { PatentSaveCoordinator } from "../../patents/patent-save-coordinator";

export type KlecksCaseCheckpoint = {
  viewId: string;
  sourceAssetId: string;
  expectedEditor: DesignEditorState | undefined;
  checkpoint: NonNullable<DesignEditorState["saved"]>;
  asset: AssetDescriptor;
  kind: "saved" | "recovery";
  /** Frozen pixels already match the applied image; updating session state must not invalidate it. */
  preserveApplied?: boolean | undefined;
};
export async function discardKlecksCaseRecovery(
  queue: PatentSaveCoordinator,
  input: Pick<KlecksCaseCheckpoint, "viewId" | "sourceAssetId" | "expectedEditor">,
) {
  const patent = queue.snapshot().patent;
  const design = patent.designPatent;
  const view = design?.views.find((item) => item.viewId === input.viewId);
  if (patent.patentType !== "design" || !design || !view || view.assetId !== input.sourceAssetId)
    throw { code: "CANCELLED", message: "图片已移除或来源已改变，未舍弃恢复版本。" };
  const previous = view.editor ? DesignEditorStateSchema.parse(view.editor) : undefined;
  const expected = input.expectedEditor
    ? DesignEditorStateSchema.parse(input.expectedEditor)
    : undefined;
  if (JSON.stringify(previous) !== JSON.stringify(expected))
    throw { code: "REVISION_CONFLICT", message: "此图片的工程保存点已改变，未舍弃新恢复版本。" };
  if (!previous?.recovery) throw { code: "CANCELLED", message: "此图片没有待舍弃的恢复版本。" };
  const editor: DesignEditorState = { ...previous, recovery: null };
  return queue.saveDesignPatent(
    {
      ...design,
      views: design.views.map((item) => (item.viewId === view.viewId ? { ...item, editor } : item)),
    },
    patent.assets,
  );
}
export async function commitKlecksCaseCheckpoint(
  queue: PatentSaveCoordinator,
  input: KlecksCaseCheckpoint,
) {
  const patent = queue.snapshot().patent;
  const design = patent.designPatent;
  const view = design?.views.find((item) => item.viewId === input.viewId);
  if (patent.patentType !== "design" || !design || !view || view.assetId !== input.sourceAssetId)
    throw { code: "CANCELLED", message: "图片已移除或来源已改变，未覆盖案件。" };
  const previous = view.editor ? DesignEditorStateSchema.parse(view.editor) : undefined;
  const expected = input.expectedEditor
    ? DesignEditorStateSchema.parse(input.expectedEditor)
    : undefined;
  if (JSON.stringify(previous) !== JSON.stringify(expected))
    throw { code: "REVISION_CONFLICT", message: "此图片的工程保存点已改变，请重试。" };
  const checkpoint = DesignEditorCheckpointSchema.parse(input.checkpoint);
  const asset = DesignEditorProjectAssetDescriptorSchema.parse(input.asset);
  if (checkpoint.projectAssetId !== asset.assetId || !["saved", "recovery"].includes(input.kind))
    throw { code: "INVALID_INPUT", message: "工程引用与资产不一致。" };
  const existing = patent.assets.find((item) => item.assetId === asset.assetId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(asset))
    throw { code: "INVALID_INPUT", message: "工程资产描述与案件不一致。" };
  const source = patent.assets.find((item) => item.assetId === view.assetId);
  // An untouched raster is already the exported image; no synthetic applied PNG is needed.
  const applied =
    previous?.applied ??
    (input.preserveApplied &&
    !view.operations.length &&
    source?.kind === "image" &&
    source.widthPx === asset.widthPx &&
    source.heightPx === asset.heightPx
      ? {
          ...checkpoint,
          imageAssetId: source.assetId,
          widthPx: source.widthPx,
          heightPx: source.heightPx,
        }
      : undefined);
  const editor: DesignEditorState = {
    version: 1,
    sourceAssetId: view.assetId,
    saved: input.kind === "saved" ? checkpoint : (previous?.saved ?? null),
    recovery: input.kind === "recovery" ? checkpoint : null,
    ...(applied
      ? {
          applied:
            input.kind === "saved" && input.preserveApplied
              ? { ...applied, ...checkpoint }
              : applied,
        }
      : {}),
  };
  return queue.saveDesignPatent(
    {
      ...design,
      views: design.views.map((item) => (item.viewId === view.viewId ? { ...item, editor } : item)),
    },
    existing ? patent.assets : [...patent.assets, asset],
  );
}
