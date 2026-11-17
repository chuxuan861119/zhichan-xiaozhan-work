import { posix } from "node:path";
import type { DocxPackage } from "./docx-package-reader.js";
import type { ParsedWordDocument, WordParagraphBlock } from "./wordprocessingml-parser.js";

export type ExtractedDocxDrawing = Readonly<{
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  relationshipId: string;
  widthMm: number | null;
  heightMm: number | null;
}>;

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".emf": "image/emf",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wmf": "image/wmf",
};

export function extractDocxDrawings(
  parsed: ParsedWordDocument,
  pkg: DocxPackage,
): ExtractedDocxDrawing[] {
  const result: ExtractedDocxDrawing[] = [];
  for (const paragraph of paragraphsInDocumentOrder(parsed)) {
    for (const inline of paragraph.inlines) {
      if (inline.type !== "image" || !inline.partName) continue;
      const bytes = pkg.parts.get(inline.partName);
      if (!bytes) continue;
      const extension = posix.extname(inline.partName).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[extension];
      if (!mediaType) continue;
      result.push({
        bytes,
        fileName: posix.basename(inline.partName),
        mediaType,
        relationshipId: inline.relationshipId,
        widthMm: emuToMm(inline.widthEmu),
        heightMm: emuToMm(inline.heightEmu),
      });
    }
  }
  return result;
}

function* paragraphsInDocumentOrder(parsed: ParsedWordDocument): Generator<WordParagraphBlock> {
  for (const block of parsed.blocks) {
    if (block.type === "paragraph") {
      yield block;
      continue;
    }
    for (const row of block.rows) {
      for (const cell of row.cells) yield* cell.paragraphs;
    }
  }
}

function emuToMm(value: number | null): number | null {
  return value === null ? null : value / 36_000;
}
