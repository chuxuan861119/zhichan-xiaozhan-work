import {
  type PatentEditAck,
  StageDesignEditorProjectRequestSchema,
} from "../../../../shared/ipc/contract";
import type { DesignEditorState } from "../../../../shared/patent/design-editor-state";
import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksProjectSaveDependencies, KlecksProjectSaveInput } from "./klecks-project-save";

export type KlecksFrameSaveInput = {
  identity: KlecksPortIdentity;
  sourceAssetId: string;
  expectedEditor: DesignEditorState | undefined;
  kind: "saved" | "recovery";
  selectionOnly?: boolean;
};
export type KlecksFrameSaveDependencies = {
  projects: KlecksFrameClient["projects"];
  persist(
    input: KlecksProjectSaveInput,
    callbacks: Pick<KlecksProjectSaveDependencies, "isCurrent" | "onSaved">,
  ): Promise<PatentEditAck>;
  isCurrent(identity: KlecksPortIdentity): boolean;
};
export async function saveKlecksFrameProject(
  input: KlecksFrameSaveInput,
  dependencies: KlecksFrameSaveDependencies,
): Promise<{ ack: PatentEditAck; editorConfirmed: boolean }> {
  const captured = structuredClone(input);
  const target = captured.identity;
  const isCurrent = () => dependencies.isCurrent(target);
  if (!isCurrent()) throw { code: "CANCELLED", message: "图片编辑会话已改变。" };
  const frozen = await dependencies.projects.freeze(target);
  // Pixel edits may arrive between scheduling a selection save and freezing it.
  const kind = captured.selectionOnly && frozen.pixelDirty !== false ? "recovery" : captured.kind;
  const discard = () => {
    void dependencies.projects.discard(target, frozen.ticket).catch(() => undefined);
  };
  let ack: PatentEditAck;
  let saved = false;
  try {
    if (!isCurrent()) throw { code: "CANCELLED", message: "冻结期间图片编辑会话已改变。" };
    const request = StageDesignEditorProjectRequestSchema.parse({
      sessionId: target.sessionId,
      project: frozen.project,
      thumbnail: frozen.thumbnail,
    });
    ack = await dependencies.persist(
      {
        ...request,
        viewId: target.viewId,
        sourceAssetId: captured.sourceAssetId,
        expectedEditor: captured.expectedEditor,
        kind,
        preserveApplied: frozen.unapplied === false && kind === "saved",
      },
      {
        isCurrent,
        onSaved: () => {
          saved = true;
        },
      },
    );
  } catch (error) {
    discard();
    throw error;
  }
  // The case is durable at this point. A lost editor acknowledgement must not turn it into a failed save.
  let editorConfirmed = false;
  if (kind === "saved" && saved && isCurrent()) {
    try {
      editorConfirmed = await dependencies.projects.confirmSaved(target, frozen.ticket);
    } catch {
      /* Keep the durable case acknowledgement. */
    }
  }
  if (!editorConfirmed) discard();
  return { ack, editorConfirmed };
}
