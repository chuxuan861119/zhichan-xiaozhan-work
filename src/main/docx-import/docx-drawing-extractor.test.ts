import { describe, expect, it } from "vitest";
import { extractDocxDrawings } from "./docx-drawing-extractor.js";
import type { DocxPackage } from "./docx-package-reader.js";
import type { ParsedWordDocument } from "./wordprocessingml-parser.js";

describe("extractDocxDrawings", () => {
  it("extracts only embedded images in document order and ignores labels", () => {
    const parsed: ParsedWordDocument = {
      warnings: [],
      blocks: [
        {
          type: "paragraph",
          headingLevel: null,
          alignment: "center",
          firstLineIndentMm: null,
          lineSpacing: null,
          list: null,
          inlines: [
            { type: "text", text: "附图1", style: {} },
            {
              type: "image",
              relationshipId: "rId1",
              partName: "word/media/image1.png",
              widthEmu: 3_600_000,
              heightEmu: 1_800_000,
            },
          ],
        },
        {
          type: "table",
          columnWidthsTwips: [],
          rows: [
            {
              cells: [
                {
                  colSpan: 1,
                  verticalMerge: null,
                  paragraphs: [
                    {
                      type: "paragraph",
                      headingLevel: null,
                      alignment: "left",
                      firstLineIndentMm: null,
                      lineSpacing: null,
                      list: null,
                      inlines: [
                        { type: "text", text: "图2", style: {} },
                        {
                          type: "image",
                          relationshipId: "rId2",
                          partName: "word/media/photo.jpeg",
                          widthEmu: null,
                          heightEmu: null,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const pkg: DocxPackage = {
      sourceFileName: "附图.docx",
      externalRelationships: [],
      findings: [],
      parts: new Map([
        ["word/media/image1.png", Uint8Array.from([1, 2, 3])],
        ["word/media/photo.jpeg", Uint8Array.from([4, 5])],
      ]),
    };

    expect(extractDocxDrawings(parsed, pkg)).toEqual([
      {
        bytes: Uint8Array.from([1, 2, 3]),
        fileName: "image1.png",
        mediaType: "image/png",
        relationshipId: "rId1",
        widthMm: 100,
        heightMm: 50,
      },
      {
        bytes: Uint8Array.from([4, 5]),
        fileName: "photo.jpeg",
        mediaType: "image/jpeg",
        relationshipId: "rId2",
        widthMm: null,
        heightMm: null,
      },
    ]);
  });

  it("skips external or missing image parts", () => {
    const parsed: ParsedWordDocument = {
      warnings: [],
      blocks: [
        {
          type: "paragraph",
          headingLevel: null,
          alignment: "left",
          firstLineIndentMm: null,
          lineSpacing: null,
          list: null,
          inlines: [
            {
              type: "image",
              relationshipId: "external",
              partName: null,
              widthEmu: null,
              heightEmu: null,
            },
          ],
        },
      ],
    };
    const pkg: DocxPackage = {
      sourceFileName: "external.docx",
      externalRelationships: [],
      findings: [],
      parts: new Map(),
    };

    expect(extractDocxDrawings(parsed, pkg)).toEqual([]);
  });
});
