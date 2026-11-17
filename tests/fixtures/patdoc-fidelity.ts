import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import type { AssetDescriptor, ParagraphNode } from "../../src/shared/document/model.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
export async function createPatdocFidelityPayload(): Promise<PatentPatdocPayload> {
  const patent = createBlankPatent({
    name: "综合往返验收",
    customer: "测试客户",
    patentType: "invention",
  });
  const original = Uint8Array.from(await readFile(resolve("tests/fixtures/images/sample.png")));
  const descriptor: AssetDescriptor = {
    assetId: randomUUID(),
    kind: "image" as const,
    originalName: "附图.png",
    mediaType: "image/png",
    extension: "png",
    byteLength: original.length,
    sha256: hash(original),
    widthPx: 12,
    heightPx: 8,
    previewByteLength: original.length,
    previewSha256: hash(original),
  };
  patent.assets = [descriptor];
  const paragraph: ParagraphNode = {
    id: randomUUID(),
    type: "paragraph",
    attrs: {
      alignment: "justify",
      paragraphIndentMm: 8,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 14,
    },
    content: [
      {
        type: "text",
        text: "带格式正文",
        marks: [
          { type: "bold" },
          { type: "italic" },
          { type: "underline" },
          { type: "color", value: "#FF0000" },
          { type: "background-color", value: "#FFFF00" },
        ],
      },
      { type: "inline-formula", formulaKind: "math", source: String.raw`\frac{x^2}{2}` },
      { type: "inline-formula", formulaKind: "chemistry", source: String.raw`\ce{H2 + O2 -> H2O}` },
    ],
  };
  for (const book of patent.books) {
    book.document.content = [{ ...structuredClone(paragraph), id: randomUUID() }];
    book.editorState = { selection: { from: 1, to: 1 } };
  }
  patent.books[1]!.document.content.push(
    {
      id: randomUUID(),
      type: "block-formula",
      formulaKind: "math",
      source: String.raw`\sum_{i=1}^{n} i`,
      alignment: "right",
    },
    {
      id: randomUUID(),
      type: "chemical-structure",
      ketSource: '{"root":{"nodes":[]}}',
      previewAssetId: descriptor.assetId,
      editorMode: "molecule",
      widthMm: 70,
      alignment: "center",
    },
    {
      id: randomUUID(),
      type: "table",
      columnWidthsMm: [40],
      rows: [
        {
          id: randomUUID(),
          cells: [
            {
              id: randomUUID(),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "center",
              verticalAlignment: "middle",
              borderStyle: "single",
              content: [{ ...structuredClone(paragraph), id: randomUUID() }],
            },
          ],
        },
      ],
    },
  );
  patent.auxiliaryDocuments = [
    {
      auxiliaryDocumentId: randomUUID(),
      title: "其他材料",
      sourceFileName: "其他材料.docx",
      document: {
        ...structuredClone(patent.books[1]!.document),
        documentId: randomUUID(),
        title: "其他材料",
      },
      editorState: { selection: { from: 2, to: 2 } },
      localRevision: 0,
      persistedRevision: 0,
    },
  ];
  patent.docxImportReport = {
    importedAt: patent.createdAt,
    sourceFileNames: ["五书.docx"],
    assignments: [],
    warnings: [],
  };
  const flowcharts = [2, 1].map((index) => ({
    projectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    source: Uint8Array.from(
      Buffer.from(
        `<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram><diagram id="p2"><mxGraphModel><root><mxCell id="0" value="${index}"/></root></mxGraphModel></diagram></mxfile>`,
      ),
    ),
  }));
  patent.flowchartProjects = flowcharts.map((item, index) => ({
    projectId: item.projectId,
    name: `流程图${index}`,
    revision: 3,
    pageCount: 2,
    lastPageId: "p2",
    sourceSha256: hash(item.source),
    createdAt: patent.createdAt,
    modifiedAt: patent.modifiedAt,
  }));
  patent.figures = [
    {
      figureId: randomUUID(),
      assetId: descriptor.assetId,
      widthMm: 90,
      rotationDeg: 90,
      flowchartLink: {
        projectId: flowcharts[0]!.projectId,
        pageId: "p2",
        exportScope: "page",
        selectedCellIds: [],
        borderMm: 2,
        exportedProjectRevision: 3,
        exportedSourceSha256: hash(flowcharts[0]!.source),
        renderProfileVersion: 1,
      },
    },
  ];
  patent.abstractDrawingFigureId = patent.figures[0]!.figureId;
  return { patent, assets: [{ descriptor, original, preview: original }], flowcharts };
}
