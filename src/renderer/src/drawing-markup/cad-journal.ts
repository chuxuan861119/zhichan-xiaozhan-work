import { drawingEditEqual } from "../../../shared/drawing-markup/performance";
import type { CadCheckpoint } from "./cadcraft-client";

type Kernel = {
  load_dxf(bytes: Uint8Array): void;
  execute(command: string, params: string): unknown;
  paste_dxf(bytes: Uint8Array, params: string): unknown;
};
export class CadJournal {
  private current: CadCheckpoint | undefined;
  constructor(private kernel: Kernel) {}
  adopt(checkpoint: CadCheckpoint) {
    this.current = checkpoint;
  }
  invalidate() {
    this.current = undefined;
  }
  load(next: CadCheckpoint) {
    const before = this.current;
    const sameSource =
      before &&
      (before.sourceId && next.sourceId
        ? before.sourceId === next.sourceId
        : before.source.length === next.source.length &&
          before.source.every((v, i) => v === next.source[i]));
    const append =
      sameSource &&
      before.edits.length <= next.edits.length &&
      before.edits.every((edit, i) => drawingEditEqual(edit, next.edits[i]));
    try {
      if (!append) this.kernel.load_dxf(next.source);
      for (const edit of next.edits.slice(append ? before.edits.length : 0)) {
        if (edit.paste) this.kernel.paste_dxf(edit.paste, JSON.stringify(edit.params));
        else this.kernel.execute(edit.command, JSON.stringify(edit.params));
      }
      this.current = next;
      return !append || before.edits.length !== next.edits.length;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }
  append(command: string, params: object) {
    if (!this.current) throw new Error("CAD 快照尚未加载。");
    this.current = { ...this.current, edits: [...this.current.edits, { command, params }] };
  }
  snapshot() {
    if (!this.current) throw new Error("CAD 快照尚未加载。");
    return this.current;
  }
}
