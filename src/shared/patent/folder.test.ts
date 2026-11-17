import { drawingProjectFixture } from "../drawing-markup/test-fixture.js";
import { createBlankPatent } from "./defaults.js";
import { folderExportItems, patentFolderEntries } from "./folder.js";

test("lists available books and auxiliary documents without filename suffixes", () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  patent.drawingBooksEnabled = false;
  patent.auxiliaryDocuments = [
    {
      ...patent.books[0]!,
      auxiliaryDocumentId: crypto.randomUUID(),
      title: "交底书.docx",
      sourceFileName: null,
    },
  ];
  const entries = patentFolderEntries(patent);
  expect(entries.filter((e) => e.kind === "book")).toHaveLength(3);
  expect(entries.at(-1)?.name).toBe("交底书");
  expect(entries.at(-1)?.formats).toEqual(["docx", "pdf"]);
});

test("CAD default differs from raster drawing source and batch keeps native formats", () => {
  const patent = createBlankPatent({ patentType: "utility-model", name: null });
  const drawing = drawingProjectFixture(crypto.randomUUID());
  drawing.cad = { assetId: drawing.sourceAssetId } as typeof drawing.cad;
  patent.drawingProjects = [drawing];
  const entries = patentFolderEntries(patent);
  expect(entries).toHaveLength(6);
  expect(entries.at(-1)?.formats).toEqual(["dwg", "dxf"]);
  expect(
    folderExportItems(
      entries,
      entries.map((e) => e.key),
    ),
  ).toEqual(entries.map((e) => ({ key: e.key, format: e.formats[0] })));
  expect(() => folderExportItems(entries, [entries[0]!.key], "dwg")).toThrow();
  expect(() => folderExportItems(entries, ["missing"])).toThrow();
  expect(() => folderExportItems(entries, [entries[0]!.key, entries[0]!.key])).toThrow();
});
