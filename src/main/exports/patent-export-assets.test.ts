import { createChemicalContentPayload } from "../../../tests/fixtures/chemical-content.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { AssetStore } from "../assets/asset-store.js";
import { loadPatentExportAssets } from "./patent-export-assets.js";
import { createPatentPrintPackage } from "./patent-print-template.js";

test("exports rendered resources on demand without reading CAD history or other books", async () => {
  const payload = await createChemicalContentPayload("按需导出");
  const patent = createBlankPatent({ patentType: "invention", name: "按需导出" });
  const book = patent.books.find((book) => book.kind === "description")!;
  book.document = payload.document;
  patent.assets = payload.assets.map((asset) => asset.descriptor);
  const unrelated = crypto.randomUUID();
  patent.assets.push({ ...patent.assets[0]!, assetId: unrelated });
  const readAsset = vi.fn(async (id: string) => {
    const asset = payload.assets.find((asset) => asset.descriptor.assetId === id);
    if (!asset) throw new Error("must not read unused history");
    return asset;
  });
  const store = new AssetStore({ persistent: { readAsset, install: vi.fn() } });
  store.createSession("export");
  expect(
    await loadPatentExportAssets(store, "export", patent, { mode: "single", bookKind: "claims" }),
  ).toEqual([]);
  expect(readAsset).not.toHaveBeenCalled();
  const selection = { mode: "single", bookKind: "description" } as const;
  const assets = await loadPatentExportAssets(store, "export", patent, selection);
  expect(assets).toEqual(payload.assets);
  expect(readAsset).toHaveBeenCalledTimes(payload.assets.length);
  const printed = await createPatentPrintPackage({ patent, assets, ...selection });
  expect(printed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(printed.html).toContain("data:image/");
  expect(readAsset).not.toHaveBeenCalledWith(unrelated);
});
