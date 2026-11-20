import type { DesignPatentView } from "./design-patent.js";

/** Applied composites already include the old raster recipe. Keep the original asset for re-editing. */
export function resolveDesignViewImage(view: DesignPatentView) {
  const applied = view.editor?.applied;
  return applied
    ? {
        assetId: applied.imageAssetId,
        operations: [],
        widthPx: applied.widthPx,
        heightPx: applied.heightPx,
      }
    : {
        assetId: view.assetId,
        operations: view.operations,
        widthPx: undefined,
        heightPx: undefined,
      };
}
