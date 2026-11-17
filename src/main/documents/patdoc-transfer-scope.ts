import { retainCurrentPatentAssets } from "../../shared/patent/asset-references.js";
import type { PatentPatdocPayload } from "./patdoc-format.js";

// Portable patent files contain current content, not local history or import diagnostics.
export function portablePatdocPayload(input: PatentPatdocPayload): PatentPatdocPayload {
  const { snapshots: _snapshots, ...current } = input;
  const patent = retainCurrentPatentAssets({ ...input.patent, docxImportReport: null });
  const ids = new Set(patent.assets.map((asset) => asset.assetId));
  return {
    ...current,
    patent,
    assets: input.assets.filter((asset) => ids.has(asset.descriptor.assetId)),
  };
}
