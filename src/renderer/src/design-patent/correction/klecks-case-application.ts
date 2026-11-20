import {
  type AssetDescriptor,
  AssetDescriptorSchema,
  DesignEditorProjectAssetDescriptorSchema,
} from "../../../../shared/document/model";
import { DesignImageSubjectBoundsSchema } from "../../../../shared/ipc/contract";
import {
  DesignEditorCheckpointSchema,
  DesignEditorStateSchema,
} from "../../../../shared/patent/design-editor-state";
import type { DesignPatent } from "../../../../shared/patent/design-patent";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import type { PatentSaveCoordinator } from "../../patents/patent-save-coordinator";
import type { KlecksCaseCheckpoint } from "./klecks-case-checkpoint";
export type KlecksCaseApplication = Omit<KlecksCaseCheckpoint, "kind"> & {
  image: AssetDescriptor;
  subjectBounds?: {
    leftPx: number;
    topPx: number;
    widthPx: number;
    heightPx: number;
  } | null;
};
/** One existing case transaction adopts both immutable assets; the original image is retained. */
export async function commitKlecksCaseApplication(
  queue: PatentSaveCoordinator,
  input: KlecksCaseApplication,
) {
  const next = withKlecksCaseApplication(queue.snapshot().patent, input);
  return queue.saveDesignPatent(next.designPatent, next.assets);
}

export function withKlecksCaseApplication(
  patent: CanonicalPatent,
  input: KlecksCaseApplication,
): CanonicalPatent & { designPatent: DesignPatent } {
  const design = patent.designPatent,
    view = design?.views.find((item) => item.viewId === input.viewId);
  if (patent.patentType !== "design" || !design || !view || view.assetId !== input.sourceAssetId)
    throw {
      code: "CANCELLED",
      message: "图片已移除或来源已改变，未应用旧编辑。",
    };
  const previous = view.editor ? DesignEditorStateSchema.parse(view.editor) : undefined,
    expected = input.expectedEditor
      ? DesignEditorStateSchema.parse(input.expectedEditor)
      : undefined;
  if (JSON.stringify(previous) !== JSON.stringify(expected))
    throw {
      code: "REVISION_CONFLICT",
      message: "工程保存点已改变，未应用旧编辑。",
    };
  const checkpoint = DesignEditorCheckpointSchema.parse(input.checkpoint),
    project = DesignEditorProjectAssetDescriptorSchema.parse(input.asset),
    image = AssetDescriptorSchema.parse(input.image);
  if (
    checkpoint.projectAssetId !== project.assetId ||
    image.kind !== "image" ||
    image.mediaType !== "image/png" ||
    image.widthPx !== project.widthPx ||
    image.heightPx !== project.heightPx
  )
    throw { code: "INVALID_INPUT", message: "应用图片与冻结工程不一致。" };
  const bounds = input.subjectBounds
    ? DesignImageSubjectBoundsSchema.parse(input.subjectBounds)
    : null;
  if (
    bounds &&
    (bounds.leftPx + bounds.widthPx > image.widthPx ||
      bounds.topPx + bounds.heightPx > image.heightPx)
  )
    throw { code: "INVALID_INPUT", message: "主体边界超出应用图片尺寸。" };
  const assets = [...patent.assets];
  for (const asset of [project, image]) {
    const existing = assets.find((item) => item.assetId === asset.assetId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(asset))
      throw { code: "INVALID_INPUT", message: "应用资产描述与案件不一致。" };
    if (!existing) assets.push(asset);
  }
  const editor = DesignEditorStateSchema.parse({
    version: 1,
    sourceAssetId: view.assetId,
    saved: checkpoint,
    recovery: null,
    applied: {
      ...checkpoint,
      imageAssetId: image.assetId,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
    },
  });
  return {
    ...patent,
    designPatent: {
      ...design,
      views: design.views.map((item) =>
        item.viewId === view.viewId
          ? {
              ...item,
              editor,
              subjectBounds: bounds,
              subjectBoundsSource: bounds ? "automatic" : null,
              subjectBoundsConfirmed: false,
            }
          : item,
      ),
    },
    assets,
  };
}
