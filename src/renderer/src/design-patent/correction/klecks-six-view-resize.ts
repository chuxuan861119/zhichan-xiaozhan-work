import {
  DesignEditorProjectDataSchema,
  DesignEditorSourceSchema,
  type PatentApi,
} from "../../../../shared/ipc/contract";
import type { DesignPatentView } from "../../../../shared/patent/design-patent";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import type { SixViewResizeItem } from "../design-six-view-resize";
import { withKlecksCaseApplication } from "./klecks-case-application";
import { stageKlecksFrameApplication } from "./klecks-frame-application";
import type { KlecksFrameClient } from "./klecks-frame-client";
import { withKlecksScratchFrame } from "./klecks-shared-frame";

export function assertNoResizeDraft(view: DesignPatentView, frame?: KlecksFrameClient) {
  const editor = view.editor;
  const state = frame?.state.forDocument?.(view.viewId);
  if (
    editor?.recovery ||
    (editor?.saved && editor.saved.projectAssetId !== editor.applied?.projectAssetId) ||
    state?.dirty ||
    state?.selectionDirty ||
    state?.unapplied ||
    state?.pending
  ) {
    throw new Error(`「${view.label}」有未应用的编辑，请先到第 2 步处理该草稿。本次未修改图片。`);
  }
}

/** Build the replacement case in memory; never commit a partial image batch. */
export async function prepareSixViewResize(
  base: CanonicalPatent,
  items: readonly SixViewResizeItem[],
  prepare: (
    view: DesignPatentView,
    item: SixViewResizeItem,
  ) => ReturnType<typeof stageKlecksFrameApplication>,
) {
  let next = base;
  for (const item of items) {
    const view = base.designPatent?.views.find(
      (candidate) => candidate.viewId === item.viewId && candidate.kind === item.kind,
    );
    if (!view) throw new Error("视图分配已改变，请重新预览。");
    const output = await prepare(view, item);
    if (output.image.widthPx !== item.after.width || output.image.heightPx !== item.after.height)
      throw new Error(`「${view.label}」处理后的尺寸不正确，未应用本批调整。`);
    next = withKlecksCaseApplication(next, output);
  }
  if (!next.designPatent) throw new Error("外观设计案件已关闭。");
  return { design: next.designPatent, assets: next.assets };
}

export function stageSixViewResize(
  base: CanonicalPatent,
  items: readonly SixViewResizeItem[],
  assets: PatentApi["assets"],
  sessionId: string,
  requireCurrent: () => void,
) {
  return withKlecksScratchFrame(assets, sessionId, (frame, scratchSessionId, sync) =>
    prepareSixViewResize(base, items, async (view, item) => {
      requireCurrent();
      const target = {
        sessionId: scratchSessionId,
        viewId: `batch-${crypto.randomUUID()}`,
        generation: 1,
      };
      if (!(await sync([{ viewId: target.viewId, generation: target.generation }])))
        throw new Error("无法准备临时编辑文档。");
      let opened: boolean;
      if (view.editor?.applied) {
        const read = assets.readDesignEditorProject;
        if (!read) throw new Error("当前平台不支持读取分层工程。");
        const result = await read.call(assets, {
          sessionId,
          assetId: view.editor.applied.projectAssetId,
        });
        if (!result.ok) throw result.error;
        requireCurrent();
        opened = await frame.documents.openProject(
          target,
          DesignEditorProjectDataSchema.parse(result.value),
          true,
          { isSaved: true },
        );
      } else {
        const prepare = assets.prepareDesignEditorSource;
        if (!prepare) throw new Error("当前平台不支持准备编辑原图。");
        const result = await prepare.call(assets, {
          sessionId,
          assetId: view.assetId,
          operations: view.operations,
        });
        if (!result.ok) throw result.error;
        requireCurrent();
        opened = await frame.documents.openRaster(
          target,
          view.label.slice(0, 200),
          DesignEditorSourceSchema.parse(result.value),
        );
      }
      const actual = frame.state.snapshot();
      if (
        !opened ||
        actual?.identity?.viewId !== target.viewId ||
        actual.size?.width !== item.before.width ||
        actual.size?.height !== item.before.height
      )
        throw new Error(`「${view.label}」的尺寸已变化，请重新预览。`);
      await frame.tools.send(target, {
        action: "resizeImage",
        ...item.after,
        interpolation: "smooth",
        allowDistortion: true,
      });
      const frozen = await frame.projects.freeze(target);
      try {
        return await stageKlecksFrameApplication(
          {
            sessionId,
            viewId: view.viewId,
            sourceAssetId: view.assetId,
            expectedEditor: view.editor,
          },
          frozen,
          assets,
          requireCurrent,
        );
      } finally {
        await frame.projects.discard(target, frozen.ticket);
      }
    }),
  );
}
