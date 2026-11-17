import { referencedDocumentAssetIds } from "../../shared/document/asset-references.js";
import { drawingFiguresForBook } from "../../shared/patent/drawing-content.js";
import type { CanonicalPatent, PatentBookKind } from "../../shared/patent/model.js";
import type { AssetStore, StoredAsset } from "../assets/asset-store.js";

/** Export consumes rendered figures, never the CAD editor's source/history blobs. */
export async function loadPatentExportAssets(
  store: AssetStore,
  sessionId: string,
  patent: CanonicalPatent,
  selection: { mode: "combined" | "single"; bookKind?: PatentBookKind },
): Promise<StoredAsset[]> {
  const ids = new Set<string>();
  for (const book of patent.books) {
    if (selection.mode === "single" && book.kind !== selection.bookKind) continue;
    for (const id of referencedDocumentAssetIds(book.document)) ids.add(id);
    for (const figure of drawingFiguresForBook(patent, book.kind)) ids.add(figure.assetId);
  }
  const assets: StoredAsset[] = [];
  for (const id of ids) {
    const asset = await store.getOrLoad(sessionId, id);
    // The exporter reports missing references with the relevant document/node.
    if (asset) assets.push(asset);
  }
  return assets;
}
