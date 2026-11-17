import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importImage } from "../../src/main/assets/image-importer.js";
import type { PatdocPayload, PatentPatdocPayload } from "../../src/main/documents/patdoc-format.js";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import type {
  BlockNode,
  CanonicalDocument,
  ParagraphNode,
} from "../../src/shared/document/model.js";
import { createBlankPatent } from "../../src/shared/patent/defaults.js";

export const CHEMICAL_EQUATION_SOURCE = String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`;
export const CHEMICAL_STRUCTURE_KET =
  '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"C","location":[0,0,0]},{"label":"O","location":[1,0,0]}],"bonds":[{"type":1,"atoms":[0,1]}]}}';

function fixtureUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function paragraph(id: number, text = ""): ParagraphNode {
  const blank = createBlankDocument("化学内容夹具").content[0];
  if (blank?.type !== "paragraph") throw new Error("默认文档缺少段落。");
  return {
    ...blank,
    id: fixtureUuid(id),
    content: text ? [{ type: "text", text, marks: [] }] : [],
  };
}

async function structurePreview(index: number): Promise<PatdocPayload["assets"][number]> {
  const bytes = await readFile(join(process.cwd(), "tests", "fixtures", "images", "sample.png"));
  const imported = await importImage({ originalName: "chemical-structure.png", bytes });
  return {
    ...imported,
    descriptor: { ...imported.descriptor, assetId: fixtureUuid(700_000 + index) },
  };
}

/**
 * Deterministic persisted chemistry content for E2E reopen/export and benchmark workloads.
 * The PNG is deliberately pre-rendered: opening or exporting it must not initialize Ketcher.
 */
export async function createChemicalContentPayload(
  title: string,
  options: { equations?: number; structures?: number } = {},
): Promise<PatdocPayload> {
  const equations = options.equations ?? 2;
  const structures = options.structures ?? 1;
  const assets = await Promise.all(
    Array.from({ length: structures }, (_, index) => structurePreview(index)),
  );
  const content: BlockNode[] = [
    {
      ...paragraph(600_000, "化学内容："),
      content: [
        { type: "text", text: "化学内容：", marks: [] },
        { type: "inline-formula", source: CHEMICAL_EQUATION_SOURCE, formulaKind: "chemistry" },
      ],
    },
  ];

  for (let index = 1; index < equations; index += 1) {
    content.push({
      id: fixtureUuid(610_000 + index),
      type: "block-formula",
      source: String.raw`\ce{${index + 1}H2 + O2 -> ${index + 1}H2O}`,
      formulaKind: "chemistry",
    });
  }
  for (let index = 0; index < structures; index += 1) {
    const asset = assets[index];
    if (!asset) throw new Error("化学结构预览夹具缺失。");
    content.push({
      id: fixtureUuid(620_000 + index),
      type: "chemical-structure",
      ketSource: CHEMICAL_STRUCTURE_KET,
      previewAssetId: asset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    });
  }
  const blank = createBlankDocument(title);
  const document: CanonicalDocument = {
    ...blank,
    documentId: fixtureUuid(630_000 + equations * 100 + structures),
    createdAt: "2026-08-04T00:00:00.000Z",
    modifiedAt: "2026-08-04T00:00:00.000Z",
    content,
    assets: assets.map((asset) => asset.descriptor),
  };
  return { document, settings: {}, editorState: {}, assets };
}

export async function createChemicalPatentPayload(
  name: string,
  options: { equations?: number; structures?: number } = {},
): Promise<PatentPatdocPayload> {
  const content = await createChemicalContentPayload("说明书", options);
  let nextId = 640_000;
  const patent = createBlankPatent(
    { patentType: "invention", name },
    {
      now: () => new Date("2026-08-04T00:00:00.000Z"),
      createId: () => fixtureUuid(nextId++),
    },
  );
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) throw new Error("化学专利夹具缺少说明书。");
  description.document = { ...description.document, content: content.document.content };
  patent.assets = content.document.assets;
  return { patent, assets: content.assets };
}
