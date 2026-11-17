import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importImage } from "../../../src/main/assets/image-importer.js";
import { FileService } from "../../../src/main/documents/file-service.js";
import type {
  PatdocPayload,
  PatentPatdocPayload,
} from "../../../src/main/documents/patdoc-format.js";
import { createBlankDocument } from "../../../src/shared/document/defaults.js";
import type {
  BlockNode,
  ParagraphNode,
  TableCell,
  TableNode,
} from "../../../src/shared/document/model.js";
import { createBlankPatent } from "../../../src/shared/patent/defaults.js";
import { createChemicalContentPayload } from "../../fixtures/chemical-content.js";

export function stableUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function baseParagraph(index: number, text = ""): ParagraphNode {
  const blank = createBlankDocument("fixture").content[0];
  if (blank?.type !== "paragraph") throw new Error("空白文档缺少默认段落。");
  return {
    ...blank,
    id: stableUuid(index),
    content: text ? [{ type: "text", text, marks: [] }] : [],
  };
}

function tableCell(index: number, text: string): TableCell {
  return {
    id: stableUuid(index),
    rowSpan: 1,
    colSpan: 1,
    horizontalAlignment: "left",
    verticalAlignment: "top",
    borderStyle: "single",
    content: [baseParagraph(index + 1000, text)],
  };
}

export function createTable(index: number, rows: number, columns: number): TableNode {
  return {
    id: stableUuid(index),
    type: "table",
    columnWidthsMm: Array.from({ length: columns }, () => 150 / columns),
    rows: Array.from({ length: rows }, (_, row) => ({
      id: stableUuid(index + row + 1),
      cells: Array.from({ length: columns }, (_, column) =>
        tableCell(index + 100 + row * columns + column, `${row + 1}-${column + 1}`),
      ),
    })),
  };
}

export async function createImageAsset(
  assetId = stableUuid(900),
): Promise<PatdocPayload["assets"][number]> {
  const bytes = await readFile(join(process.cwd(), "tests", "fixtures", "images", "sample.png"));
  const imported = await importImage({ originalName: "sample.png", bytes });
  return {
    ...imported,
    descriptor: { ...imported.descriptor, assetId },
  };
}

export async function createReferencePayload(title = "端到端往复式夹具"): Promise<PatdocPayload> {
  const asset = await createImageAsset();
  const blank = createBlankDocument(title);
  const paragraph = baseParagraph(1);
  const content: BlockNode[] = [
    {
      ...paragraph,
      content: [
        {
          type: "text",
          text: "中文 Latin 样式",
          marks: [
            { type: "bold" },
            { type: "italic" },
            { type: "underline" },
            { type: "subscript" },
            { type: "superscript" },
            { type: "font-family", value: "Microsoft YaHei" },
            { type: "font-size", valuePt: 14 },
            { type: "color", value: "#123456" },
          ],
        },
        { type: "inline-formula", source: "E=mc^2", formulaKind: "math" },
      ],
    },
    {
      id: stableUuid(2),
      type: "figure",
      assetId: asset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    },
    createTable(10, 3, 3),
    {
      id: stableUuid(3),
      type: "block-formula",
      source: String.raw`\frac{a}{b}`,
      formulaKind: "math",
    },
    { id: stableUuid(4), type: "page-break" },
    baseParagraph(5, "分页后的说明文字"),
  ];
  return {
    document: {
      ...blank,
      documentId: stableUuid(500),
      createdAt: "2026-07-31T00:00:00.000Z",
      modifiedAt: "2026-07-31T00:00:00.000Z",
      content,
      assets: [asset.descriptor],
    },
    settings: {},
    editorState: {},
    assets: [asset],
  };
}

export async function createPerformancePayload(title: string): Promise<PatentPatdocPayload> {
  const original = await createImageAsset();
  const assets = Array.from({ length: 30 }, (_, index) => ({
    ...original,
    descriptor: { ...original.descriptor, assetId: stableUuid(10_000 + index) },
  }));
  const content: BlockNode[] = [baseParagraph(20_000, "专".repeat(50_000))];
  content.push(baseParagraph(55_000, "性能输入位置"));
  for (let index = 0; index < 20; index += 1) {
    content.push(createTable(100_000 + index * 10_000, 2, 2));
  }
  for (let index = 0; index < 30; index += 1) {
    content.push({
      id: stableUuid(50_000 + index),
      type: "block-formula",
      source: String.raw`x_${index + 1}=\frac{a+b}{c}`,
      formulaKind: "math",
    });
  }
  const chemistry = await createChemicalContentPayload(`${title} 化学负载`, {
    equations: 20,
    structures: 10,
  });
  content.push(...chemistry.document.content);
  let nextId = 60_000 + Number(title.at(-1) ?? 0) * 100;
  const patent = createBlankPatent(
    { patentType: "invention", name: title },
    {
      now: () => new Date("2026-07-31T00:00:00.000Z"),
      createId: () => stableUuid(nextId++),
    },
  );
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("性能专利缺少说明书。");
  description.document = { ...description.document, content };
  patent.figures = assets.map((asset, index) => ({
    figureId: stableUuid(90_000 + index),
    assetId: asset.descriptor.assetId,
    widthMm: 20,
    rotationDeg: 0,
  }));
  patent.abstractDrawingFigureId = patent.figures[0]?.figureId ?? null;
  patent.assets = [...assets.map((asset) => asset.descriptor), ...chemistry.document.assets];
  return { patent, assets: [...assets, ...chemistry.assets] };
}

export async function writePatdoc(
  path: string,
  payload: PatdocPayload | PatentPatdocPayload,
): Promise<void> {
  const service = new FileService();
  const result =
    "patent" in payload
      ? await service.savePatent(path, payload)
      : await service.saveDocument(path, payload);
  if (!result.ok)
    throw new Error(`无法写入 E2E 夹具：${result.error.code} ${result.error.message}`);
}
