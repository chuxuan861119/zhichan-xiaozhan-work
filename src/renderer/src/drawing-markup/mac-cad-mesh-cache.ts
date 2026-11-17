import type { PreviewMesh } from "./cad-preview-gpu";
import type { CadScene } from "./cadcraft-client";

/** At most one GPU mesh, owned weakly by its immutable scene. */
export class MacCadMeshCache {
  private scenes = new WeakMap<CadScene, { key: string; mesh: PreviewMesh }>();
  private previous: WeakRef<CadScene> | undefined;
  constructor(private maxBytes = 32 * 1024 * 1024) {}

  get(scene: CadScene, key: string, build: () => PreviewMesh) {
    const cached = this.scenes.get(scene);
    if (cached?.key === key) return cached.mesh;
    const previous = this.previous?.deref();
    if (previous) this.scenes.delete(previous);
    this.previous = undefined;
    const mesh = build();
    if (mesh.vertices.byteLength <= this.maxBytes) {
      this.scenes.set(scene, { key, mesh });
      this.previous = new WeakRef(scene);
    }
    return mesh;
  }
}

export const macCadMeshCache = new MacCadMeshCache();
