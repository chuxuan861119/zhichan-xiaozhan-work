import type { AssetDescriptor } from "../../shared/document/model.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import {
  type AssetHealth,
  type ResourceHealthResult,
  resourceLocations,
} from "../../shared/patent-inspection/resource-health.js";
export async function inspectResourceFiles(
  patent: CanonicalPatent,
  readAsset: (assetId: string) => Promise<{ descriptor: AssetDescriptor }>,
  signal?: AbortSignal,
): Promise<ResourceHealthResult> {
  const assets: AssetHealth[] = [];
  const descriptors = new Map(patent.assets.map((asset) => [asset.assetId, asset]));
  for (const assetId of resourceLocations(patent).keys()) {
    signal?.throwIfAborted();
    let status: AssetHealth["status"] = "ok";
    try {
      const stored = await readAsset(assetId);
      const expected = descriptors.get(assetId);
      if (
        !expected ||
        stored.descriptor.sha256 !== expected.sha256 ||
        stored.descriptor.byteLength !== expected.byteLength
      )
        status = "damaged";
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      status =
        code === "NOT_FOUND" || code === "ENOENT"
          ? "missing"
          : code === "CORRUPT_FILE"
            ? "damaged"
            : "unreadable";
    }
    signal?.throwIfAborted();
    assets.push({ assetId, status });
  }
  return { patentId: patent.patentId, patentRevision: patent.revision, assets };
}
