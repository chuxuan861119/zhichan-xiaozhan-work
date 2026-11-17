import { isCanonicalDocumentBlank } from "./content-state.js";
import { createBlankDocument } from "./defaults.js";
import type { BlockNode, CanonicalDocument } from "./model.js";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function withFirstBlock(block: BlockNode): CanonicalDocument {
  const document = createBlankDocument("内容状态");
  document.content = [block];
  return document;
}

describe("canonical document content state", () => {
  test("treats default and whitespace-only text structures as blank", () => {
    const document = createBlankDocument("空白");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    paragraph.content = [{ type: "text", text: "  \n\t　", marks: [] }];

    expect(isCanonicalDocumentBlank(createBlankDocument("默认空白"))).toBe(true);
    expect(isCanonicalDocumentBlank(document)).toBe(true);
    expect(
      isCanonicalDocumentBlank(
        withFirstBlock({
          id: testUuid(1),
          type: "bullet-list",
          items: [
            {
              id: testUuid(2),
              content: [
                {
                  id: testUuid(3),
                  type: "paragraph",
                  attrs: paragraph.attrs,
                  content: [],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("treats visible inline content as nonblank", () => {
    const document = createBlankDocument("正文");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;

    paragraph.content = [{ type: "text", text: "正文", marks: [] }];
    expect(isCanonicalDocumentBlank(document)).toBe(false);

    paragraph.content = [{ type: "hard-break" }];
    expect(isCanonicalDocumentBlank(document)).toBe(false);

    paragraph.content = [{ type: "inline-formula", source: "x+1", formulaKind: "math" }];
    expect(isCanonicalDocumentBlank(document)).toBe(false);
  });

  test.each<BlockNode>([
    { id: testUuid(10), type: "page-break" },
    { id: testUuid(11), type: "block-formula", source: "x+1", formulaKind: "math" },
    {
      id: testUuid(111),
      type: "chemical-structure",
      ketSource: "(ket) (atom C)",
      previewAssetId: testUuid(112),
      widthMm: 80,
      alignment: "center",
    },
    {
      id: testUuid(12),
      type: "figure",
      assetId: testUuid(13),
      widthMm: 80,
      alignment: "center",
    },
    {
      id: testUuid(14),
      type: "table",
      columnWidthsMm: [40],
      rows: [
        {
          id: testUuid(15),
          cells: [
            {
              id: testUuid(16),
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [
                {
                  id: testUuid(17),
                  type: "paragraph",
                  attrs: {
                    alignment: "left",
                    paragraphIndentMm: 0,
                    lineSpacing: 1.5,
                    defaultFontFamily: "SimSun",
                    defaultFontSizePt: 12,
                  },
                  content: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ])("treats structural block $type as nonblank", (block) => {
    expect(isCanonicalDocumentBlank(withFirstBlock(block))).toBe(false);
  });

  test("ignores an unreferenced asset descriptor when visible content is empty", () => {
    const document = createBlankDocument("残留资源");
    document.assets = [
      {
        assetId: testUuid(20),
        kind: "image",
        originalName: "unused.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: 1,
        sha256: "A".repeat(64),
        widthPx: 1,
        heightPx: 1,
        previewByteLength: 1,
        previewSha256: "B".repeat(64),
      },
    ];

    expect(isCanonicalDocumentBlank(document)).toBe(true);
  });
});
