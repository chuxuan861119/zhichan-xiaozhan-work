import type { AssetDescriptor } from "../document/model.js";
import { drawingAssetIds } from "../drawing-markup/cad-state.js";
import { drawingProjectFixture } from "../drawing-markup/test-fixture.js";
import { retainCurrentPatentAssets } from "./asset-references.js";
import { createBlankPatent } from "./defaults.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value");
  return value;
}

function referencePatent() {
  const patent = createBlankPatent({ name: "资源引用", patentType: "invention" });
  const asset: AssetDescriptor = {
    assetId: id(100),
    kind: "image" as const,
    originalName: "image.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: 1,
    sha256: "A".repeat(64),
    previewByteLength: 1,
    previewSha256: "B".repeat(64),
    widthPx: 12,
    heightPx: 8,
  };
  patent.assets = [asset];
  patent.figures = [{ figureId: id(101), assetId: asset.assetId, widthMm: 60 }];
  return patent;
}

test("keeps CAD originals, live/overlay checkpoints, frozen details and region output bodies", () => {
  const patent = referencePatent();
  const project = drawingProjectFixture(id(1));
  project.baseAssetId = id(2);
  project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "a".repeat(40),
    assetId: id(3),
    overlayAssetId: id(4),
    mapping: { originX: 0, originY: 100, scale: 1 },
  };
  required(project.detailViews?.[0]).cadSource = {
    ...project.cad,
    assetId: id(5),
    baseAssetId: id(6),
    overlayAssetId: id(7),
  };
  required(project.regions[0]).bodyAssetId = id(8);
  patent.drawingProjects = [project];
  const original = required(patent.assets[0]);
  patent.assets.push(...Array.from({ length: 9 }, (_, n) => ({ ...original, assetId: id(n + 1) })));
  const retained = retainCurrentPatentAssets(patent);
  expect([...drawingAssetIds(project)]).toEqual(
    expect.arrayContaining(Array.from({ length: 7 }, (_, n) => id(n + 1))),
  );
  expect(retained.assets.map((a) => a.assetId)).toEqual([
    original.assetId,
    ...Array.from({ length: 8 }, (_, n) => id(n + 1)),
  ]);
  expect(patent.assets).toHaveLength(10);
});

test("keeps inline pictures in tables/lists and auxiliary document resources", () => {
  const patent = referencePatent();
  const original = required(patent.assets[0]);
  const inline = { ...original, assetId: id(21) };
  const auxiliary = { ...original, assetId: id(22) };
  const unused = { ...original, assetId: id(23) };
  patent.assets.push(inline, auxiliary, unused);
  const book = required(patent.books[0]);
  const paragraph = structuredClone(required(book.document.content[0]));
  if (paragraph.type !== "paragraph") throw new Error("fixture paragraph");
  paragraph.content = [
    {
      type: "inline-figure",
      id: id(31),
      assetId: inline.assetId,
      widthMm: 20,
      alignment: "center",
    },
  ];
  book.document.content = [
    {
      type: "table",
      id: id(24),
      columnWidthsMm: [40],
      rows: [
        {
          id: id(25),
          cells: [
            {
              id: id(26),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [paragraph],
            },
          ],
        },
      ],
    },
  ];
  required(patent.books[3]).document.content = [
    { type: "bullet-list", id: id(27), items: [{ id: id(28), content: [paragraph] }] },
  ];
  const document = structuredClone(book.document);
  document.content = [
    { type: "figure", id: id(29), assetId: auxiliary.assetId, widthMm: 60, alignment: "center" },
  ];
  patent.auxiliaryDocuments = [
    {
      auxiliaryDocumentId: id(30),
      title: "参考文档",
      document,
      editorState: {},
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: null,
    },
  ];
  expect(retainCurrentPatentAssets(patent).assets.map((a) => a.assetId)).toEqual([
    original.assetId,
    inline.assetId,
    auxiliary.assetId,
  ]);
});
