import {
  type CadKernel,
  cadSynchronizationSourceIds,
  synchronizeCad,
} from "../../../shared/drawing-markup/cad-unified";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { CadJournal } from "./cad-journal";
import { mergeCadScene } from "./cad-scene-delta";
import type { CadCheckpoint, CadScene } from "./cadcraft-client";

type Kernel = CadKernel & { paste_dxf(bytes: Uint8Array, params: string): string };
export type CadDraftData = Uint8Array | CadCheckpoint;

/** Worker-local model. Semantic edits produce a command snapshot, not another DXF. */
export class CadIncrementalComposition {
  private journal: CadJournal;
  private scene: CadScene | undefined;
  private blank: Uint8Array;
  constructor(private kernel: Kernel) {
    this.journal = new CadJournal(kernel);
    this.blank = kernel.export_dxf();
  }
  synchronize(
    project: DrawingProject,
    sources: ReadonlyMap<string, CadDraftData>,
    previous?: DrawingProject,
    nativeEdit = false,
  ) {
    const load = (data: CadDraftData, id?: string) => {
      if (
        this.journal.load(
          data instanceof Uint8Array
            ? { source: data, ...(id ? { sourceId: id } : {}), edits: [] }
            : data,
        )
      )
        this.scene = undefined;
    };
    try {
      const source = sources.get(project.cad!.assetId);
      if (!source) throw new Error("CAD 工作稿未加载。");
      const ids = cadSynchronizationSourceIds(project);
      const bytes = new Map<string, Uint8Array>();
      // Extra frozen sources are needed only for genuinely new/rebuilt detail bodies.
      for (const id of ids.filter((id) => id !== project.cad!.assetId)) {
        const data = sources.get(id);
        if (!data) throw new Error("局部放大来源未加载。");
        load(data, id);
        bytes.set(id, data instanceof Uint8Array ? data : this.kernel.export_dxf());
      }
      // A native edit may supply new bytes under the previous asset identity.
      load(source, nativeEdit ? undefined : project.cad!.assetId);
      bytes.set(
        project.cad!.assetId,
        ids.length === 1 ? new Uint8Array() : this.kernel.export_dxf(),
      );
      const adapter: CadKernel = {
        load_dxf: (bytes) => load(bytes),
        export_dxf: () => {
          throw new Error("交互同步不能导出整图。");
        },
        scene: () => {
          this.scene ??= JSON.parse(this.kernel.scene()) as CadScene;
          return JSON.stringify(this.scene);
        },
        execute: (command, encoded) => {
          const params = JSON.parse(encoded);
          if (command === "bridge.object_index") return this.kernel.execute(command, encoded);
          if (command === "bridge.drawing_defaults") {
            const result = this.kernel.execute(command, encoded);
            if (params.restore) this.journal.append(command, params);
            return result;
          }
          this.scene ??= JSON.parse(this.kernel.scene()) as CadScene;
          const result = JSON.parse(
            this.kernel.execute("bridge.edit", JSON.stringify({ command, params })),
          );
          this.journal.append(command, params);
          this.scene =
            command === "draworder"
              ? JSON.parse(this.kernel.scene())
              : mergeCadScene(this.scene, result.scene);
          return JSON.stringify(result.result);
        },
      };
      const result = synchronizeCad(adapter, this.blank, project, bytes, previous, {
        loaded: ids.length === 1,
        nativeEdit,
        deferExport: true,
      });
      return {
        checkpoint: this.journal.snapshot(),
        objects: result.objects,
        scene: result.scene as CadScene,
        warnings: result.warnings,
      };
    } catch (error) {
      this.journal.invalidate();
      this.scene = undefined;
      throw error;
    }
  }
}
