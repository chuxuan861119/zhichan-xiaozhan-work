type Revision = { dirty: boolean; revision: number; layers: number; raster?: number; psd?: number };
/** Memory-only export watermarks, intentionally not the engine's patent-save watermark. */
export class TemporaryImageRevisions {
  private entries = new Map<string, Revision>();
  observe(
    id: string,
    state: { dirty: boolean; checkpointRevision: number; layers: unknown[] },
  ): boolean {
    const previous = this.entries.get(id);
    if (
      previous?.dirty === state.dirty &&
      previous.revision === state.checkpointRevision &&
      previous.layers === state.layers.length
    )
      return false;
    this.entries.set(id, {
      ...this.entries.get(id),
      dirty: state.dirty,
      revision: state.checkpointRevision,
      layers: state.layers.length,
    });
    return true;
  }
  revision(id: string): number {
    return this.entries.get(id)?.revision ?? 0;
  }
  isLayered(id: string): boolean {
    return (this.entries.get(id)?.layers ?? 0) > 1;
  }
  needsExport(id: string): boolean {
    const entry = this.entries.get(id);
    return (
      !!entry?.dirty &&
      (entry.layers > 1
        ? entry.psd !== entry.revision
        : entry.psd !== entry.revision && entry.raster !== entry.revision)
    );
  }
  exported(id: string, revision: number, kind: "raster" | "psd"): void {
    const entry = this.entries.get(id);
    if (entry) entry[kind] = revision;
  }
  remove(id: string): void {
    this.entries.delete(id);
  }
}
