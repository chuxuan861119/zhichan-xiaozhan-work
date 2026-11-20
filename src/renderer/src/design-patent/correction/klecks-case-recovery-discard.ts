import type { DesignEditorState } from "../../../../shared/patent/design-editor-state";
import type { PatentSaveCoordinator } from "../../patents/patent-save-coordinator";
import { discardKlecksCaseRecovery } from "./klecks-case-checkpoint";
import type { KlecksCaseDocuments } from "./klecks-case-documents";
import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import { KlecksRecoveryDiscard } from "./klecks-recovery-discard";

export function createKlecksCaseRecoveryDiscard(
  queue: PatentSaveCoordinator,
  controller: Pick<KlecksCaseDocuments, "isCurrent" | "reinitialize" | "reconcile">,
  frame: Pick<KlecksFrameClient, "documents" | "state">,
  input: { identity: KlecksPortIdentity; sourceAssetId: string; expectedEditor: DesignEditorState },
  current: () => boolean,
): KlecksRecoveryDiscard {
  const captured = structuredClone(input);
  let submitted = false,
    resetStarted = false;
  const committedModel = () => {
    const patent = queue.snapshot().patent,
      design = patent.designPatent;
    const view = design?.views.find((item) => item.viewId === captured.identity.viewId);
    const expected = { ...captured.expectedEditor, recovery: null };
    if (
      !current() ||
      !design ||
      !view ||
      view.assetId !== captured.sourceAssetId ||
      JSON.stringify(view.editor) !== JSON.stringify(expected)
    )
      throw new Error("舍弃后的图片引用已改变，未重建旧版本。");
    return { design, assets: patent.assets };
  };
  return new KlecksRecoveryDiscard({
    current,
    state: () => frame.state.snapshot(),
    lock: async (token, locked) => {
      if (!(await frame.documents.interactionLock(captured.identity.sessionId, token, locked)))
        throw new Error("图片编辑器尚未确认输入保护。");
    },
    commit: async () => {
      if (submitted) {
        await queue.retry();
        committedModel();
        return;
      }
      if (queue.snapshot().saveError) await queue.retry();
      if (!current() || !controller.isCurrent(captured.identity))
        throw new Error("舍弃操作所属的图片代次已改变。");
      const before = queue.snapshot().localRevision;
      const pending = discardKlecksCaseRecovery(queue, {
        viewId: captured.identity.viewId,
        sourceAssetId: captured.sourceAssetId,
        expectedEditor: captured.expectedEditor,
      });
      // The save queue updates its optimistic model synchronously before awaiting disk.
      submitted = queue.snapshot().localRevision > before;
      await pending;
      committedModel();
    },
    reload: async (token) => {
      const { design, assets } = committedModel();
      let loaded: boolean;
      if (resetStarted)
        loaded = await controller.reconcile(design.views, assets, captured.identity.viewId, token);
      else {
        resetStarted = true;
        loaded = await controller.reinitialize(captured.identity, design.views, assets, token);
      }
      if (!loaded) throw new Error("舍弃已写入案件，但图片尚未重新载入，请重试。");
    },
  });
}
