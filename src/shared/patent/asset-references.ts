import { referencedDocumentAssetIds } from "../document/asset-references.js";
import { drawingAssetIds } from "../drawing-markup/cad-state.js";
import type { CanonicalPatent } from "./model.js";

/** Current content only. Undo leases and snapshot indexes own historical resources separately. */
export function retainCurrentPatentAssets<T extends CanonicalPatent>(patent: T): T {
  const used = new Set(patent.figures.map((figure) => figure.assetId));
  for (const book of [...patent.books, ...patent.auxiliaryDocuments]) {
    for (const assetId of referencedDocumentAssetIds(book.document)) used.add(assetId);
  }
  for (const project of patent.drawingProjects) {
    for (const assetId of drawingAssetIds(project)) used.add(assetId);
    // A published region may retain an output-body link independently of its live CAD checkpoint.
    // Preserve a stored body without making stale optional links a new validation requirement.
    for (const region of project.regions) if (region.bodyAssetId) used.add(region.bodyAssetId);
  }
  return { ...patent, assets: patent.assets.filter((asset) => used.has(asset.assetId)) };
}
