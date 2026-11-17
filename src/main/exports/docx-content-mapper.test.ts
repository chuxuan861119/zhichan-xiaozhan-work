import { Document, Packer, PageOrientation } from "docx";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ParagraphNode, TableNode } from "../../shared/document/model.js";
import type { ExportIssue } from "../../shared/exports/report.js";
import type { AssetStore } from "../assets/asset-store.js";
import {
  type MappingContext,
  mapBlockNode,
  orderedNumbering,
  prepareFormulaExports,
  validateTable,
} from "./docx-content-mapper.js";
import { millimetresToTwips } from "./docx-exporter.js";

function paragraph(text: string, bold = false): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks: bold ? [{ type: "bold" }] : [] }],
  };
}

function table(): TableNode {
  return {
    id: crypto.randomUUID(),
    type: "table",
    columnWidthsMm: [35],
    rows: [
      {
        id: crypto.randomUUID(),
        cells: [
          {
            id: crypto.randomUUID(),
            colSpan: 1,
            rowSpan: 1,
            verticalAlignment: "top",
            horizontalAlignment: "center",
            borderStyle: "single",
            content: [paragraph("单元格")],
          },
        ],
      },
    ],
  };
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("DOCX ZIP could not be opened"));
      else resolveZip(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolveEntry, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("DOCX ZIP entry could not be read"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await openZip(buffer);
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName !== "word/document.xml") {
        zip.readEntry();
        return;
      }
      void readEntry(zip, entry)
        .then((bytes) => resolve(bytes.toString("utf8")))
        .catch(reject);
    });
    zip.on("end", () => reject(new Error("missing document.xml")));
    zip.readEntry();
  });
}

test.each(["left", "center", "right", "justify"] as const)(
  "maps canonical rich text and table paragraph alignment %s through the shared DOCX content mapper",
  async (alignment) => {
    const tableNode = table();
    tableNode.headerRowCount = 1;
    const cell = tableNode.rows[0]?.cells[0];
    if (!cell) throw new Error("测试表格缺少单元格");
    // Paragraph alignment is explicit and takes precedence over the cell default.
    const cellParagraph = cell.content[0];
    if (!cellParagraph) throw new Error("测试单元格缺少段落");
    cellParagraph.attrs.alignment = alignment;
    cell.borderEdges = {
      top: "double",
      right: "none",
      bottom: "single",
      left: "double",
    };
    const content = [paragraph("加粗文字", true), tableNode];
    const issues: ExportIssue[] = [];
    for (const node of content) {
      if (node.type === "table") issues.push(...validateTable(node));
    }
    const formulaExports = await prepareFormulaExports({ content }, issues);
    const numbering = orderedNumbering({ content });
    const context: MappingContext = {
      sessionId: "mapper-test",
      assetStore: { get: () => null } as unknown as AssetStore,
      assetCache: new Map(),
      preparedAssetMediaCache: new Map(),
      preparedFormulaMediaCache: new WeakMap(),
      formulaExports,
      chemicalStructureAssets: new Map(),
      nextDrawingId: 1,
      contentWidthMm: 180,
      contentHeightMm: 260,
      issues,
      embeddedMediaTypes: new Set(),
      orderedListReferences: numbering.references,
    };

    const docx = new Document({
      numbering: { config: numbering.config },
      sections: [
        {
          properties: {
            page: {
              size: {
                width: millimetresToTwips(210),
                height: millimetresToTwips(297),
                orientation: PageOrientation.PORTRAIT,
              },
            },
          },
          children: content.flatMap((node) => mapBlockNode(node, context)),
        },
      ],
    });
    const xml = await documentXml(await Packer.toBuffer(docx));

    expect(issues).toEqual([]);
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:tblHeader/>");
    const cellXml = xml.slice(xml.indexOf("<w:tc>"), xml.indexOf("</w:tc>"));
    expect(cellXml).toContain(`<w:jc w:val="${alignment === "justify" ? "both" : alignment}"/>`);
    expect(xml).toMatch(/<w:top\b(?=[^>]*w:val="double")[^>]*\/>/u);
    expect(xml).toMatch(/<w:right\b(?=[^>]*w:val="none")[^>]*\/>/u);
    expect(xml).toMatch(/<w:bottom\b(?=[^>]*w:val="single")[^>]*\/>/u);
    expect(xml).toMatch(/<w:left\b(?=[^>]*w:val="double")[^>]*\/>/u);
  },
);
