import {
  AssetDescriptorSchema,
  DesignEditorProjectAssetDescriptorSchema,
} from "../../../../shared/document/model";
import {
  DesignImageProcessResultSchema,
  type PatentApi,
  type PatentEditAck,
  StageDesignEditorProjectRequestSchema,
} from "../../../../shared/ipc/contract";
import { validateEditorBinaryHeader } from "../../../../shared/patent/design-editor-binary";
import type { KlecksCaseApplication } from "./klecks-case-application";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksFrameSaveInput } from "./klecks-frame-save";
import type { KlecksFrozenProject } from "./klecks-project-port";

type Dependencies = {
  projects: KlecksFrameClient["projects"];
  assets: Pick<
    PatentApi["assets"],
    "stageDesignEditorProject" | "importMany" | "processDesignImage"
  >;
  isCurrent(): boolean;
  commit(input: KlecksCaseApplication): Promise<PatentEditAck>;
};
type ApplicationInput = Omit<KlecksFrameSaveInput, "kind">;

/** Keep only confirmation tickets after staging; no view references change before the single commit. */
export async function applyKlecksFrameBatch(
  targets: readonly ApplicationInput[],
  dependencies: Pick<Dependencies, "assets" | "projects"> & {
    prepare(target: ApplicationInput): Promise<boolean>;
    requireCurrent(target?: ApplicationInput): void;
    commit(items: KlecksCaseApplication[]): Promise<unknown>;
  },
) {
  const staged: KlecksCaseApplication[] = [];
  const tickets: { identity: ApplicationInput["identity"]; ticket: number }[] = [];
  const confirm = dependencies.projects.confirmApplied;
  if (!confirm) throw new Error("当前环境不支持应用分层图片。");
  try {
    for (const target of targets) {
      dependencies.requireCurrent(target);
      if (!(await dependencies.prepare(target))) continue;
      const frozen = await dependencies.projects.freeze(target.identity);
      tickets.push({ identity: target.identity, ticket: frozen.ticket });
      staged.push(
        await stageKlecksFrameApplication(
          {
            sessionId: target.identity.sessionId,
            viewId: target.identity.viewId,
            sourceAssetId: target.sourceAssetId,
            expectedEditor: target.expectedEditor,
          },
          frozen,
          dependencies.assets,
          () => dependencies.requireCurrent(target),
        ),
      );
    }
    dependencies.requireCurrent();
    if (!staged.length) return 0;
    await dependencies.commit(staged);
    const confirmations = await Promise.allSettled(
      tickets.map(({ identity, ticket }) => confirm(identity, ticket)),
    );
    for (let index = confirmations.length - 1; index >= 0; index--) {
      const result = confirmations[index]!;
      if (result.status === "fulfilled" && result.value) tickets.splice(index, 1);
    }
    if (tickets.length)
      throw new Error("整批图片已应用到视图，但编辑器确认未完成，请重新打开案件核对。");
    return staged.length;
  } finally {
    await Promise.allSettled(
      tickets.map(({ identity, ticket }) => dependencies.projects.discard(identity, ticket)),
    );
  }
}
/** Freeze once, stage both representations, then adopt both in one durable case transaction. */
export async function applyKlecksFrameRevision(
  input: Omit<KlecksFrameSaveInput, "kind">,
  dependencies: Dependencies,
) {
  const captured = structuredClone(input),
    target = captured.identity;
  const requireCurrent = () => {
    if (!dependencies.isCurrent())
      throw {
        code: "CANCELLED",
        message: "图片编辑会话已改变，未应用旧编辑。",
      };
  };
  requireCurrent();
  const stage = dependencies.assets.stageDesignEditorProject;
  if (!stage || !dependencies.projects.confirmApplied)
    throw new Error("当前环境不支持应用分层图片。");
  const frozen = await dependencies.projects.freeze(target);
  const discard = () => {
    void dependencies.projects.discard(target, frozen.ticket).catch(() => {});
  };
  let ack: PatentEditAck;
  try {
    requireCurrent();
    ack = await dependencies.commit(
      await stageKlecksFrameApplication(
        {
          sessionId: target.sessionId,
          viewId: target.viewId,
          sourceAssetId: captured.sourceAssetId,
          expectedEditor: captured.expectedEditor,
        },
        frozen,
        dependencies.assets,
        requireCurrent,
      ),
    );
  } catch (error) {
    discard();
    throw error;
  }
  let editorConfirmed = false;
  if (dependencies.isCurrent()) {
    try {
      editorConfirmed = await dependencies.projects.confirmApplied(target, frozen.ticket);
    } catch {
      /* The durable case must not be rolled back on a lost frame reply. */
    }
  }
  if (!editorConfirmed) discard();
  return { ack, editorConfirmed };
}

/** Prepare immutable assets only; callers choose the single transaction that adopts them. */
export async function stageKlecksFrameApplication(
  input: Pick<KlecksCaseApplication, "viewId" | "sourceAssetId" | "expectedEditor"> & {
    sessionId: string;
  },
  frozen: KlecksFrozenProject,
  assets: Dependencies["assets"],
  requireCurrent: () => void,
): Promise<KlecksCaseApplication> {
  const stage = assets.stageDesignEditorProject;
  if (!stage) throw new Error("当前环境不支持应用分层图片。");
  requireCurrent();
  const request = StageDesignEditorProjectRequestSchema.parse({
    sessionId: input.sessionId,
    project: frozen.project,
    thumbnail: frozen.thumbnail,
  });
  if (!frozen.composite || frozen.composite.byteLength > 50 * 1024 * 1024)
    throw new Error("冻结工程缺少有效的合成图片。");
  validateEditorBinaryHeader(frozen.composite, "png", request.project.metadata.size);
  const staged = await stage.call(assets, request);
  if (!staged.ok) throw staged.error;
  requireCurrent();
  const asset = DesignEditorProjectAssetDescriptorSchema.parse(staged.value.descriptor);
  const images = await assets.importMany({
    sessionId: input.sessionId,
    operationId: crypto.randomUUID(),
    images: [
      {
        originalName: "edited-image.png",
        declaredMediaType: "image/png",
        bytes: Uint8Array.from(frozen.composite),
      },
    ],
  });
  if (!images.ok) throw images.error;
  requireCurrent();
  if (images.value.length !== 1) throw new Error("暂存的应用图片数量不正确。");
  const image = AssetDescriptorSchema.parse(images.value[0]!.descriptor);
  const size = request.project.metadata.size;
  if (
    image.kind !== "image" ||
    image.mediaType !== "image/png" ||
    asset.widthPx !== size.width ||
    asset.heightPx !== size.height ||
    image.widthPx !== size.width ||
    image.heightPx !== size.height
  )
    throw new Error("暂存图片、工程与冻结尺寸不一致。");
  const analyzed = await assets.processDesignImage({
    sessionId: input.sessionId,
    assetId: image.assetId,
    operations: [],
  });
  if (!analyzed.ok) throw analyzed.error;
  requireCurrent();
  const analysis = DesignImageProcessResultSchema.parse(analyzed.value);
  if (analysis.widthPx !== size.width || analysis.heightPx !== size.height)
    throw new Error("分析结果与应用图片尺寸不一致。");
  return {
    viewId: input.viewId,
    sourceAssetId: input.sourceAssetId,
    expectedEditor: input.expectedEditor,
    asset,
    image,
    subjectBounds: analysis.subjectBounds,
    checkpoint: {
      revisionId: crypto.randomUUID(),
      projectAssetId: asset.assetId,
      createdAt: new Date().toISOString(),
    },
  };
}
