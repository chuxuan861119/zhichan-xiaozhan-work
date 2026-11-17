import type { AssetDescriptor } from "../../../shared/document/model";
import { reframeCadProject } from "../../../shared/drawing-markup/cad-frame";
import { cadSemanticKey, cadSemanticKeyMatches } from "../../../shared/drawing-markup/cad-semantic-key";
import type { CadCheckpoint } from "../../../shared/drawing-markup/cad-state";
import type { DrawingProject } from "../../../shared/drawing-markup/model";
import type { CadScene, CadCheckpoint as CadCommandCheckpoint } from "./cadcraft-client";

type Prepared = { cad: CadCheckpoint; assets: AssetDescriptor[]; previewId: string };
type Draft = {
  project: DrawingProject;
  bytes?: Uint8Array | undefined;
  checkpoint?: CadCommandCheckpoint | undefined;
  readonly scene: CadScene | undefined;
  prepared?: Prepared;
  preparing?: Promise<Prepared> | undefined;
  releaseCheckpoint?(): void;
};

/** Session-local checkpoints never enter the patent document. Only resolve()
 * may cross the persistence boundary, after all referenced assets exist. */
export class CadDraftCheckpoints {
  private drafts = new Map<string, Draft>();
  private recentScenes = new Map<string, CadScene>();
  private recentCheckpoints = new Map<string, CadCommandCheckpoint>();
  private sources = new Map<string, WeakRef<Uint8Array>>();
  constructor(private prepare: (project: DrawingProject, bytes: Uint8Array) => Promise<Prepared>,
    private materialize?: (checkpoint: CadCommandCheckpoint) => Promise<Uint8Array>) {}
  get(id: string) {
    return this.drafts.get(id);
  }
  stage(
    project: DrawingProject,
    data: Uint8Array | CadCommandCheckpoint,
    scene: CadScene,
    objects: NonNullable<CadCheckpoint["objects"]>,
    preserveFrame = false,
  ) {
    const mapping = { ...project.cad!.mapping };
    const natural = scene.svgFrame;
    const right = Math.max(
      mapping.originX + project.width / mapping.scale,
      natural.origin[0] + natural.width,
    );
    const bottom = Math.min(
      mapping.originY - project.height / mapping.scale,
      natural.origin[1] - natural.height,
    );
    // A stable camera must not bypass the editing extent limit previously
    // enforced when the background serializer expanded the SVG frame.
    if (scene.entityCount && (
      (right - Math.min(mapping.originX, natural.origin[0])) * mapping.scale > 100_000 ||
      (Math.max(mapping.originY, natural.origin[1]) - bottom) * mapping.scale > 100_000
    )) throw new Error("图形超出当前图纸的可编辑范围，请缩小操作距离或倍率后重试。");
    if (scene.entityCount && !preserveFrame) {
      mapping.originX = Math.min(mapping.originX, natural.origin[0]);
      mapping.originY = Math.max(mapping.originY, natural.origin[1]);
    }
    const width = scene.entityCount && !preserveFrame ? (right - mapping.originX) * mapping.scale : project.width;
    const height = scene.entityCount && !preserveFrame ? (mapping.originY - bottom) * mapping.scale : project.height;
    if (width > 100_000 || height > 100_000)
      throw new Error("图形超出当前图纸的可编辑范围，请缩小操作距离或倍率后重试。");
    const next = reframeCadProject(
      project,
      { ...project.cad!, assetId: crypto.randomUUID(), mapping, objects, unified: 1 },
      width,
      height,
    );
    next.revision++;
    if (!next.cad!.overlayAssetId) next.baseFragments = undefined;
    next.cad = { ...next.cad!, semanticKey: cadSemanticKey(next) };
    // History keeps checkpoint identity, not hundreds of full tessellated DWGs.
    // A collected older scene is reconstructed by the editor from durable bytes.
    const sceneRef = new WeakRef(scene);
    this.recentScenes.set(next.cad.assetId, scene);
    while (this.recentScenes.size > 8)
      this.recentScenes.delete(this.recentScenes.keys().next().value!);
    let retained: CadCommandCheckpoint | undefined;
    if (!(data instanceof Uint8Array)) {
      // Structured-cloned worker replies share one immutable source, not one DXF
      // allocation per stroke in the history list.
      const id = data.sourceId;
      const source = id ? this.sources.get(id)?.deref() : undefined;
      retained = source ? {...data, source} : data;
      if (id && !source) {
        for (const [key, value] of this.sources) if (!value.deref()) this.sources.delete(key);
        this.sources.set(id, new WeakRef(data.source));
      }
      this.recentCheckpoints.set(next.cad.assetId, retained);
      while (this.recentCheckpoints.size > 8) this.recentCheckpoints.delete(this.recentCheckpoints.keys().next().value!);
    }
    const checkpointRef = retained ? new WeakRef(retained) : undefined;
    this.drafts.set(next.cad.assetId, {
      project: next,
      ...(data instanceof Uint8Array ? {bytes: data} : {}),
      // Once materialized, the immutable asset is authoritative. An old command
      // log can allocate different handles in a replacement worker/solver.
      get checkpoint() { return this.prepared ? undefined : retained ?? checkpointRef?.deref(); },
      releaseCheckpoint() { retained = undefined; },
      get scene() {
        return sceneRef.deref();
      },
    });
    return next;
  }
  async readBytes(id: string) {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    if (draft.bytes) return draft.bytes;
    if (draft.checkpoint && !draft.prepared) {
      if (!this.materialize) throw new Error("CAD 快照保存器未配置。");
      return this.materialize(draft.checkpoint);
    }
    return undefined;
  }
  async resolve(
    project: DrawingProject,
  ): Promise<{ project: DrawingProject; assets: AssetDescriptor[] }> {
    const assets: AssetDescriptor[] = [];
    const resolve = async (id: string) => {
      const draft = this.drafts.get(id);
      if (!draft) return undefined;
      if (!draft.prepared) {
        draft.preparing ??= (draft.bytes ? this.prepare(draft.project, draft.bytes) : this.readBytes(id).then(bytes => {
          if (!bytes) throw new Error("CAD 快照内容不可用，未发布文件。");
          return this.prepare(draft.project, bytes);
        })).finally(() => {
          draft.preparing = undefined;
        });
        draft.prepared = await draft.preparing;
      }
      assets.push(...draft.prepared.assets);
      // History may reference this checkpoint later; retain its identity/scene,
      // but read durable bytes on demand instead of keeping every DXF in memory.
      draft.bytes = undefined;
      draft.releaseCheckpoint?.();
      this.recentCheckpoints.delete(id);
      return draft.prepared;
    };
    const prepared = project.cad ? await resolve(project.cad.assetId) : undefined;
    const next = { ...project };
    if (prepared && project.cad) {
      next.cad = {
        ...project.cad,
        assetId: prepared.cad.assetId,
        ...(project.cad.overlayAssetId ? { overlayAssetId: prepared.previewId } : {}),
      };
      if (!project.cad.overlayAssetId) {
        next.baseAssetId = prepared.previewId;
        next.baseFragments = undefined;
      }
    }
    if (project.detailViews)
      next.detailViews = await Promise.all(
        project.detailViews.map(async (detail) => {
          if (!detail.cadSource) return detail;
          const source = await resolve(detail.cadSource.assetId);
          if (!source) return detail;
          return {
            ...detail,
            cadSource: {
              ...detail.cadSource,
              assetId: source.cad.assetId,
              ...(detail.cadSource.overlayAssetId
                ? { overlayAssetId: source.previewId }
                : { baseAssetId: source.previewId }),
            },
          };
        }),
      );
    // Resolving asset IDs is not a native rebuild. Never certify an old or
    // semantically stale checkpoint merely because the document was saved.
    if (next.cad && cadSemanticKeyMatches(project))
      next.cad = { ...next.cad, semanticKey: cadSemanticKey(next) };
    return { project: next, assets };
  }
}
