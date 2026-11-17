import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importImage } from "../../../src/main/assets/image-importer.js";
import type { PatentPatdocPayload } from "../../../src/main/documents/patdoc-format.js";
import type { BlockNode, ChemicalStructureNode } from "../../../src/shared/document/model.js";
import { createBlankPatent } from "../../../src/shared/patent/defaults.js";
import type { PatentBookKind } from "../../../src/shared/patent/model.js";

/** Deterministic Ketcher KET sources covering the three macromolecular classes. */
export const SRU_POLYMER_KET =
  '{"root":{"nodes":[{"$ref":"sru1"}]},"sru1":{"type":"monomer","alias":"X","class":"sru","attachmentPoints":[]}}';
export const PROTEIN_KET =
  '{"root":{"nodes":[{"$ref":"aa1"}]},"aa1":{"type":"monomer","alias":"Ala","class":"amino-acid","attachmentPoints":[]}}';
export const NUCLEIC_ACID_KET =
  '{"root":{"nodes":[{"$ref":"nu1"}]},"nu1":{"type":"monomer","alias":"A","class":"nucleotide","attachmentPoints":[]}}';

function fixtureUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

async function structurePreview(index: number): Promise<PatentPatdocPayload["assets"][number]> {
  const bytes = await readFile(join(process.cwd(), "tests", "fixtures", "images", "sample.png"));
  const imported = await importImage({ originalName: "structure.png", bytes });
  return {
    ...imported,
    descriptor: { ...imported.descriptor, assetId: fixtureUuid(900_000 + index) },
  };
}

function structureBlock(
  id: number,
  previewAssetId: string,
  ketSource: string,
): ChemicalStructureNode {
  return {
    id: fixtureUuid(id),
    type: "chemical-structure",
    ketSource,
    editorMode: "macromolecule",
    previewAssetId,
    widthMm: 80,
    alignment: "center",
  };
}

function paragraphBlock(id: number, text: string): BlockNode {
  return {
    id: fixtureUuid(id),
    type: "paragraph",
    attrs: {
      alignment: "left",
      paragraphIndentMm: 0,
      lineSpacing: 1.5,
      defaultFontFamily: "SimSun",
      defaultFontSizePt: 12,
    },
    content: [{ type: "text", text, marks: [] }],
  };
}

/**
 * Deterministic persisted patent carrying one macromolecular structure per core book:
 * claims → SRU polymer, description → peptide, abstract → nucleic acid. Reopening or
 * exporting this payload must never initialize Ketcher (previews are pre-rendered).
 */
export async function createMacromolecularPatentPayload(
  name: string,
): Promise<PatentPatdocPayload> {
  const [sru, protein, nucleic] = await Promise.all([
    structurePreview(0),
    structurePreview(1),
    structurePreview(2),
  ]);
  if (!sru || !protein || !nucleic) throw new Error("大分子结构预览夹具缺失。");
  let nextId = 900_100;
  const patent = createBlankPatent(
    { patentType: "invention", name },
    {
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      createId: () => fixtureUuid(nextId++),
    },
  );
  const byKind = new Map(patent.books.map((book) => [book.kind, book] as const));
  const book = (kind: PatentBookKind) => {
    const found = byKind.get(kind);
    if (!found) throw new Error(`夹具缺少书册 ${kind}`);
    return found;
  };
  const sruNode = structureBlock(910_000, sru.descriptor.assetId, SRU_POLYMER_KET);
  const proteinNode = structureBlock(910_001, protein.descriptor.assetId, PROTEIN_KET);
  const nucleicNode = structureBlock(910_002, nucleic.descriptor.assetId, NUCLEIC_ACID_KET);
  book("claims").document = {
    ...book("claims").document,
    content: [paragraphBlock(910_010, "SRU 聚合物结构："), sruNode],
  };
  book("description").document = {
    ...book("description").document,
    content: [paragraphBlock(910_011, "蛋白多肽结构："), proteinNode],
  };
  book("abstract").document = {
    ...book("abstract").document,
    content: [paragraphBlock(910_012, "核酸结构："), nucleicNode],
  };
  patent.assets = [sru.descriptor, protein.descriptor, nucleic.descriptor];
  return { patent, assets: [sru, protein, nucleic] };
}
