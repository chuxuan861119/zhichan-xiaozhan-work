import { pasteCadMetadata } from "../../../shared/drawing-markup/cad-clipboard";
import { applyCadMutation } from "../../../shared/drawing-markup/cad-mutation";
import {
  assertCadDetailBounds,
  CadDetailBoundsError,
} from "../../../shared/drawing-markup/cad-unified";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import type { CadScene } from "./cadcraft-client";

export type CadEditContext = {
  project: DrawingProject;
  before: string[];
  inside?: string | undefined;
  clip?: { project: DrawingProject; handles: string[] };
};
type EditKernel = {
  execute(command: string, params: string): string;
  scene(): string;
  paste_dxf(bytes: Uint8Array, params: string): string;
};
export type CadEditResult =
  | {
      scene: CadScene;
      result: Record<string, unknown> | null;
      metadata?: DrawingProject;
      rejected?: never;
    }
  | { rejected: string; result: null; scene?: never; metadata?: never };

/** Native geometry and patent membership are accepted as one transaction, off the UI thread. */
export function editCadTransaction(
  kernel: EditKernel,
  command: string,
  params: object,
  context?: CadEditContext,
  paste?: Uint8Array,
): CadEditResult {
  const run = (command: string, params: object) =>
    JSON.parse(kernel.execute(command, JSON.stringify(params)));
  const guardedModify = ["offset", "break", "stretch"].includes(command);
  const transaction = !!context || guardedModify;
  if (transaction) run("bridge.edit_begin", {});
  let accepted = false;
  try {
    let edited: Extract<CadEditResult, { scene: CadScene }>;
    if (paste) {
      const {scene,...result}=JSON.parse(kernel.paste_dxf(paste,JSON.stringify({...params,compact:true})));
      edited={result,scene};
    } else edited=run("bridge.edit",{command,params});
    if (context) {
      const after = edited.scene.partial
        ? [
            ...new Set([
              ...context.before.filter((h) => !edited.scene.removedHandles?.includes(h)),
              ...edited.scene.entities.map((e) => e.handle),
            ]),
          ]
        : edited.scene.entities.map((e) => e.handle);
      edited.metadata = context.clip
        ? pasteCadMetadata(
            context.project,
            context.clip.project,
            context.clip.handles,
            edited.result!.handles as string[],
            (params as { delta: [number, number] }).delta,
            context.before,
            after,
            () => crypto.randomUUID(),
            context.inside,
          )
        : applyCadMutation(
            context.project,
            {
              command,
              params: params as Record<string, unknown>,
              result: edited.result,
              before: context.before,
              after,
              inside: context.inside,
            },
            () => crypto.randomUUID(),
          );
      assertCadDetailBounds(edited.metadata, edited.scene);
    }
    accepted = true;
    return edited;
  } catch (error) {
    const nativeProblem =
      typeof error === "string" ? error : error instanceof Error ? error.message : "";
    const meshRejection = nativeProblem.startsWith("CAD_GEAR_MESH_REJECTED:")
      ? nativeProblem.slice("CAD_GEAR_MESH_REJECTED:".length)
      : undefined;
    if (error instanceof CadDetailBoundsError || meshRejection !== undefined) {
      // A rejected gesture is not an unsaved checkpoint. The prior accepted journal stays intact.
      return { rejected: meshRejection ?? (error as CadDetailBoundsError).message, result: null };
    }
    if (guardedModify && typeof error === "string") {
      // Invalid geometry is a rejected gesture. The snapshot below rolls it back;
      // it must not poison the independent save queue or create a recovery journal entry.
      const message = error.startsWith("invalid parameters")
        ? command === "offset"
          ? "无法偏移此对象，请检查偏移距离；向内偏移的距离不能超过可用范围。"
          : command === "break"
            ? "无法打断此对象，请选择有效曲线并指定曲线上的断点；闭合圆不能单点打断。"
            : error
        : error;
      return { rejected: message, result: null };
    }
    throw error;
  } finally {
    if (transaction) run("bridge.edit_finish", { accept: accepted });
  }
}
