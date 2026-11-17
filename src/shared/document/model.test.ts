import { SaveDocumentRequestSchema } from "../ipc/contract.js";
import { createBlankDocument, DEFAULT_PARAGRAPH_ATTRIBUTES } from "./defaults.js";
import {
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  CanonicalDocumentSchema,
  FigureNodeSchema,
  MAX_KET_SOURCE_BYTES,
  type ParagraphNode,
  ParagraphNodeSchema,
  VectorImageAssetDescriptorSchema,
} from "./model.js";
import { validateCanonicalDocument } from "./validation.js";

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function paragraphFixture(): ParagraphNode {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text: "图1为整体结构示意图。", marks: [] }],
  };
}

describe("canonical patent document", () => {
  test("accepts a sanitized SVG vector image with a PNG fallback descriptor", () => {
    const descriptor = {
      assetId: testUuid(991),
      kind: "vector-image" as const,
      originalName: "实验图.svg",
      mediaType: "image/svg+xml" as const,
      extension: "svg" as const,
      byteLength: 120,
      sha256: "A".repeat(64),
      widthPx: 1600,
      heightPx: 1200,
      previewByteLength: 240,
      previewSha256: "B".repeat(64),
    };
    expect(VectorImageAssetDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });
  test("creates a schema-valid A4 blank document", () => {
    const document = createBlankDocument("文档 1");

    expect(document.formatVersion).toBe(CANONICAL_DOCUMENT_FORMAT_VERSION);
    expect(document.page).toEqual({
      widthMm: 210,
      heightMm: 297,
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
    expect(document.content).toHaveLength(1);
    expect(document.content[0]).toMatchObject({
      type: "paragraph",
      attrs: { defaultFontFamily: "SimSun", defaultFontSizePt: 14 },
    });
    expect(CanonicalDocumentSchema.parse(document)).toEqual(document);
  });

  test("is required at the persistence IPC boundary", () => {
    const request = {
      sessionId: "session-1",
      document: { title: "不是完整模型" },
      editorState: {},
    };

    expect(SaveDocumentRequestSchema.safeParse(request).success).toBe(false);
    expect(
      SaveDocumentRequestSchema.safeParse({
        ...request,
        document: createBlankDocument("完整模型"),
      }).success,
    ).toBe(true);
  });

  test("rejects duplicate node identifiers", () => {
    const document = createBlankDocument("重复节点");
    const paragraph = document.content[0];
    expect(paragraph).toBeDefined();

    const result = validateCanonicalDocument({
      ...document,
      content: [paragraph, structuredClone(paragraph)],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("节点编号重复");
  });

  test("rejects figures that reference missing assets", () => {
    const document = createBlankDocument("缺失图片");
    const result = validateCanonicalDocument({
      ...document,
      content: [
        {
          id: testUuid(2),
          type: "figure",
          assetId: testUuid(3),
          widthMm: 120,
          alignment: "center",
          rotationDeg: 0,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("图片资源不存在");
  });

  test("models block and inline images without built-in captions", () => {
    const blockFigure = {
      id: testUuid(20),
      type: "figure" as const,
      assetId: testUuid(21),
      widthMm: 80,
      alignment: "center" as const,
      rotationDeg: 90,
    };
    const inlineFigure = {
      ...blockFigure,
      id: testUuid(22),
      type: "inline-figure" as const,
    };

    expect(FigureNodeSchema.safeParse(blockFigure).success).toBe(true);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("嵌入型图片"),
        content: [
          {
            id: testUuid(23),
            type: "paragraph",
            attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
            content: [
              { type: "text", text: "图片前", marks: [] },
              inlineFigure,
              { type: "text", text: "图片后", marks: [] },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(FigureNodeSchema.safeParse({ ...blockFigure, rotationDeg: 45 }).success).toBe(false);
    expect(FigureNodeSchema.safeParse({ ...blockFigure, caption: "图1" }).success).toBe(false);
    expect(FigureNodeSchema.parse(blockFigure)).not.toHaveProperty("caption");
  });

  test("accepts chemistry formula nodes and defaults legacy formula kinds to math", () => {
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("化学公式"),
        content: [
          {
            id: testUuid(30),
            type: "paragraph",
            attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
            content: [
              { type: "inline-formula", source: "H2O", formulaKind: "chemistry" },
              { type: "inline-formula", source: "x+1" },
            ],
          },
          {
            id: testUuid(31),
            type: "block-formula",
            source: "CH3COOH",
            formulaKind: "chemistry",
          },
        ],
      }).data?.content,
    ).toMatchObject([
      { content: [{ formulaKind: "chemistry" }, { formulaKind: "math" }] },
      { formulaKind: "chemistry" },
    ]);
  });

  test("accepts bounded chemical structures and rejects invalid KET presentation data", () => {
    const base = {
      id: testUuid(32),
      type: "chemical-structure",
      ketSource: "(ket)\n  (atom C)",
      previewAssetId: testUuid(33),
      widthMm: 80,
      alignment: "center",
    };

    expect(
      CanonicalDocumentSchema.safeParse({ ...createBlankDocument("结构式"), content: [base] })
        .success,
    ).toBe(true);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("空结构式"),
        content: [{ ...base, ketSource: " " }],
      }).success,
    ).toBe(false);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("超长结构式"),
        content: [{ ...base, ketSource: "a".repeat(5 * 1024 * 1024 + 1) }],
      }).success,
    ).toBe(false);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("过窄结构式"),
        content: [{ ...base, widthMm: 9 }],
      }).success,
    ).toBe(false);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("错误对齐"),
        content: [{ ...base, alignment: "justify" }],
      }).success,
    ).toBe(false);
  });

  test("limits multibyte KET source by UTF-8 bytes rather than JavaScript length", () => {
    const multibytePrefix = "化".repeat(Math.floor(MAX_KET_SOURCE_BYTES / 3));
    const base = {
      id: testUuid(34),
      type: "chemical-structure",
      previewAssetId: testUuid(35),
      widthMm: 80,
      alignment: "center",
    };

    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("多字节边界"),
        content: [{ ...base, ketSource: `${multibytePrefix}ab` }],
      }).success,
    ).toBe(true);
    expect(
      CanonicalDocumentSchema.safeParse({
        ...createBlankDocument("多字节超限"),
        content: [{ ...base, ketSource: `${multibytePrefix}abc` }],
      }).success,
    ).toBe(false);
  });

  test.each([
    ["unsupported node type", { id: testUuid(4), type: "iframe", url: "https://example.com" }],
    ["empty formula source", { id: testUuid(5), type: "block-formula", source: "   " }],
    [
      "illegal semantic role",
      {
        id: testUuid(6),
        type: "paragraph",
        semanticRole: "invented-role",
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
  ])("rejects %s", (_label, block) => {
    const document = createBlankDocument("非法内容");
    expect(validateCanonicalDocument({ ...document, content: [block] }).ok).toBe(false);
  });

  test("rejects lowercase asset hashes", () => {
    const document = createBlankDocument("资源校验");
    const invalidAsset = {
      assetId: testUuid(10),
      kind: "image",
      originalName: "drawing.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 10,
      sha256: "a".repeat(64),
      widthPx: 100,
      heightPx: 80,
      previewByteLength: 10,
      previewSha256: "B".repeat(64),
    };

    expect(validateCanonicalDocument({ ...document, assets: [invalidAsset] }).ok).toBe(false);
  });

  test("rejects duplicate asset identifiers", () => {
    const document = createBlankDocument("重复资源");
    const validAsset = {
      assetId: testUuid(10),
      kind: "image",
      originalName: "drawing.png",
      mediaType: "image/png",
      extension: "png",
      byteLength: 10,
      sha256: "A".repeat(64),
      widthPx: 100,
      heightPx: 80,
      previewByteLength: 10,
      previewSha256: "B".repeat(64),
    };
    const duplicateResult = validateCanonicalDocument({
      ...document,
      assets: [validAsset, structuredClone(validAsset)],
    });
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.error.message).toContain("资源编号重复");
  });

  test("rejects text nodes over one million UTF-16 code units", () => {
    const document = createBlankDocument("超长文本");
    const paragraph = document.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;

    expect(
      validateCanonicalDocument({
        ...document,
        content: [
          {
            ...paragraph,
            content: [{ type: "text", text: "字".repeat(1_000_001), marks: [] }],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("allows linked drawing explanation paragraphs and rejects stray figure identifiers", () => {
    const figureId = crypto.randomUUID();

    expect(
      ParagraphNodeSchema.safeParse({
        ...paragraphFixture(),
        semanticRole: "description-drawing-explanation",
        figureId,
      }).success,
    ).toBe(true);

    expect(
      ParagraphNodeSchema.safeParse({
        ...paragraphFixture(),
        semanticRole: "description-drawing-explanation",
      }).success,
    ).toBe(false);

    expect(ParagraphNodeSchema.safeParse({ ...paragraphFixture(), figureId }).success).toBe(false);
  });

  test("rejects documents over the 200,000-node limit", () => {
    const document = createBlankDocument("超大文档");
    const paragraph = document.content[0];
    expect(paragraph).toBeDefined();
    if (!paragraph) return;

    const content = Array.from({ length: 200_001 }, (_, index) => ({
      ...paragraph,
      id: testUuid(index + 100),
    }));
    const result = validateCanonicalDocument({ ...document, content });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("200000");
  });
});
