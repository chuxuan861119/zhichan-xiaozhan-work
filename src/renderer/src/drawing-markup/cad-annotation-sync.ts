import type { DrawingProject } from "../../../shared/drawing-markup/model";
import { drawingEditEqual } from "../../../shared/drawing-markup/performance";

/** Semantic edits share one native source/frame and can coalesce safely. */
export function cadSemanticEdit(before: DrawingProject | undefined, next: DrawingProject) {
  return (
    !!before?.cad?.unified &&
    before.projectId === next.projectId &&
    before.width === next.width &&
    before.height === next.height &&
    before.baseAssetId === next.baseAssetId &&
    before.sourceAssetId === next.sourceAssetId &&
    before.sourceKind === next.sourceKind &&
    before.pageNumber === next.pageNumber &&
    drawingEditEqual(before.cad, next.cad)
  );
}
export function cadAnnotationEdit(before: DrawingProject | undefined, next: DrawingProject) {
  return (
    cadSemanticEdit(before, next) &&
    drawingEditEqual(before!.detailViews, next.detailViews) &&
    drawingEditEqual(before!.baseFragments, next.baseFragments)
  );
}
export function cadMetadataEdit(before: DrawingProject | undefined, next: DrawingProject) {
  return cadAnnotationEdit(before, next) && drawingEditEqual(before!.annotations, next.annotations);
}

/** Coalesce semantic drafts without blocking input. Only the newest complete
 * result may cross the checkpoint boundary; failed drafts remain retryable. */
export class CadAnnotationSync<Input, Output> {
  latest: Input | null = null;
  private running: Promise<void> | null = null;
  private error: unknown;
  constructor(
    private compute: (input: Input) => Promise<Output>,
    private publish: (input: Input, output: Output) => void,
    private changed: (pending: boolean) => void,
    private failed: (error: unknown) => void,
  ) {}
  get pending() {
    return this.latest !== null;
  }
  enqueue(input: Input) {
    this.latest = input;
    this.error = undefined;
    this.changed(true);
    this.start();
  }
  private start() {
    if (this.running || this.error || !this.pending) return;
    this.running = Promise.resolve()
      .then(async () => {
        while (this.latest !== null) {
          const input = this.latest;
          let result: Output;
          try {
            result = await this.compute(input);
          } catch (error) {
            // A superseded draft must not poison the corrected/latest request.
            if (this.latest !== input) continue;
            throw error;
          }
          if (this.latest !== input) continue;
          this.latest = null;
          try {
            this.publish(input, result);
          } catch (error) {
            this.latest = input;
            throw error;
          }
        }
      })
      .catch((error) => {
        this.error = error;
        this.failed(error);
      })
      .finally(() => {
        this.running = null;
        this.changed(this.pending);
        this.start();
      });
  }
  async flush() {
    this.error = undefined;
    this.start();
    while (this.running) {
      await this.running;
      if (this.error) return false;
      this.start();
    }
    return !this.pending;
  }
}
