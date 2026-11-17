import type { PersistentAssetStore } from "../assets/asset-store.js";
import type { SnapshotService } from "../library/snapshot-service.js";
import { PatdocError, type PatdocSnapshot } from "./patdoc-format.js";

export async function collectPatdocHistory(
  patentId: string,
  snapshots: Pick<SnapshotService, "list" | "open" | "readFlowchartArchive">,
  assets: PersistentAssetStore,
): Promise<PatdocSnapshot[]> {
  const history: PatdocSnapshot[] = [];
  const cache = new Map<string, Awaited<ReturnType<PersistentAssetStore["readAsset"]>>>();
  for (const item of await snapshots.list(patentId)) {
    if (item.status !== "healthy")
      throw new PatdocError(
        "PATDOC_HISTORY_INCOMPLETE",
        "存在损坏或缺少资源的快照，已取消完整导出，请先在快照版本中处理。",
      );
    const opened = await snapshots.open(patentId, item.revision);
    const stored = [];
    for (const descriptor of opened.patent.assets) {
      let asset = cache.get(descriptor.assetId);
      if (!asset) {
        asset = await assets.readAsset(descriptor.assetId);
        cache.set(descriptor.assetId, asset);
      }
      stored.push(asset);
    }
    history.push({
      patent: opened.patent,
      createdAt: item.createdAt,
      source: item.source,
      assets: stored,
      flowcharts: await snapshots.readFlowchartArchive(patentId, item.revision),
    });
  }
  return history;
}
