import {
  DEFAULT_PAGE_SETTINGS,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../../../shared/document/defaults";
import {
  type AssetDescriptor,
  CANONICAL_DOCUMENT_FORMAT_VERSION,
  type ParagraphNode,
  type PatentBookDocument,
} from "../../../../shared/document/model";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../../shared/patent/formatting";
import type { PatentFigure } from "../../../../shared/patent/model";
import {
  appendImportedFigures,
  deleteFigures,
  drawingExplanationProjection,
  existingDrawingExplanationParagraphs,
  fillDrawingExplanationParagraph,
  fillDrawingExplanationParagraphs,
  readDrawingExplanationDrafts,
  reorderFigures,
  updateDrawingExplanationParagraph,
} from "./drawing-sync-controller";

const FIGURE_A = "00000000-0000-4000-8000-000000000701";
const FIGURE_B = "00000000-0000-4000-8000-000000000702";
const ASSET_A = "00000000-0000-4000-8001-000000000701";
const ASSET_B = "00000000-0000-4000-8001-000000000702";

test("copies retained content once while keeping document metadata and input isolated", () => {
  const source = description(paragraph("old", "图1为旧说明。"));
  const retained = paragraph("body", "正文及格式保持不变。", "#FF0000");
  retained.content.push({ type: "text", text: "下划线", marks: [{ type: "underline" }] });
  source.content.push(retained);
  const before = structuredClone(source);
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    const result = fillDrawingExplanationParagraphs({
      document: source,
      changes: [
        {
          target: { figureId: FIGURE_A, figureNumber: 1, paragraphId: null },
          content: [{ type: "text", text: "图1为新说明。", marks: [] }],
        },
      ],
      createId: () => "new",
    });
    expect(source).toEqual(before);
    expect(result.document.content.at(-1)).toEqual(retained);
    expect(result.document.page).toEqual(source.page);
    expect(result.document.page).not.toBe(source.page);
    expect(result.document.content.at(-1)).not.toBe(retained);
    expect(clone.mock.calls.some(([value]) => value === source || value === source.content)).toBe(
      false,
    );
    result.document.page.marginTopMm += 1;
    const tail = result.document.content.at(-1);
    if (tail?.type === "paragraph") tail.content.length = 0;
    expect(source).toEqual(before);
  } finally {
    clone.mockRestore();
  }
});

test("replaces manual and duplicate explanation paragraphs but preserves the legend and other chapters", () => {
  const source = description(
    paragraph("manual", "整体结构如图所示。"),
    paragraph("duplicate1", "图1为旧说明。"),
    paragraph("duplicate2", "图1为另一说明。"),
    paragraph("legend", "其中：1、箱体。"),
  );
  expect(existingDrawingExplanationParagraphs(source).map((item) => item.id)).toEqual([
    "manual",
    "duplicate1",
    "duplicate2",
  ]);
  const result = fillDrawingExplanationParagraphs({
    document: source,
    changes: [
      {
        target: { figureId: FIGURE_A, figureNumber: 1, paragraphId: null },
        content: [{ type: "text", text: "图1为新说明。", marks: [] }],
      },
    ],
    createId: () => "new",
  });
  expect(result.document.content.map((item) => item.id)).toEqual([
    source.content[0]?.id,
    "new",
    "legend",
    source.content.at(-1)?.id,
  ]);
  expect(source.content).toHaveLength(6);
});

test("reads independently saved drafts after JSON round trip and ignores malformed entries", () => {
  const drafts = { [FIGURE_A]: { figureNumber: 1, value: "图1为自定义结构。" } };
  expect(readDrawingExplanationDrafts(JSON.parse(JSON.stringify(drafts)))).toEqual(drafts);
  expect(readDrawingExplanationDrafts({ broken: null, wrong: { value: 1 } })).toEqual({});
});

function asset(assetId: string, name: string): AssetDescriptor {
  return {
    assetId,
    kind: "image",
    originalName: name,
    mediaType: "image/png",
    extension: "png",
    byteLength: 10,
    sha256: "A".repeat(64),
    widthPx: 100,
    heightPx: 80,
    previewByteLength: 5,
    previewSha256: "B".repeat(64),
  };
}

function figure(figureId: string, assetId: string): PatentFigure {
  return { figureId, assetId, widthMm: 80 };
}

function paragraph(id: string, text: string, color?: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [
      {
        type: "text",
        text,
        marks: color ? [{ type: "color", value: color }] : [],
      },
    ],
  };
}

function description(...explanations: ParagraphNode[]): PatentBookDocument {
  return {
    formatVersion: CANONICAL_DOCUMENT_FORMAT_VERSION,
    documentId: "00000000-0000-4000-8000-000000000700",
    title: "说明书",
    createdAt: "2026-08-30T00:00:00.000Z",
    modifiedAt: "2026-08-30T00:00:00.000Z",
    page: { ...DEFAULT_PAGE_SETTINGS },
    content: [
      {
        id: "00000000-0000-4000-8000-000000000710",
        type: "heading",
        level: 1,
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "附图说明", marks: [] }],
      },
      ...explanations,
      {
        id: "00000000-0000-4000-8000-000000000719",
        type: "heading",
        level: 1,
        attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
        content: [{ type: "text", text: "具体实施方式", marks: [] }],
      },
    ],
  };
}

describe("decoupled drawing operations", () => {
  test("adds, reorders, and deletes figures without accepting a description document", () => {
    const firstAsset = asset(ASSET_A, "图1.png");
    const secondAsset = asset(ASSET_B, "图2.png");
    const firstFigure = figure(FIGURE_A, ASSET_A);
    const secondFigure = figure(FIGURE_B, ASSET_B);

    const appended = appendImportedFigures({
      figures: [firstFigure],
      assets: [firstAsset],
      importedFigures: [secondFigure],
      importedAssets: [secondAsset],
      abstractDrawingFigureId: FIGURE_A,
    });
    expect(appended).toEqual({
      figures: [firstFigure, secondFigure],
      assets: [firstAsset, secondAsset],
      abstractDrawingFigureId: FIGURE_A,
    });
    expect(appended).not.toHaveProperty("descriptionEdit");

    const reordered = reorderFigures({
      orderedFigures: [secondFigure, firstFigure],
      assets: appended.assets,
      abstractDrawingFigureId: FIGURE_A,
    });
    expect(reordered.figures).toEqual([secondFigure, firstFigure]);
    expect(reordered).not.toHaveProperty("descriptionEdit");

    const deleted = deleteFigures({
      figures: reordered.figures,
      assets: reordered.assets,
      abstractDrawingFigureId: FIGURE_A,
      figureIds: [FIGURE_A],
    });
    expect(deleted.figures).toEqual([secondFigure]);
    expect(deleted.abstractDrawingFigureId).toBeNull();
    expect(deleted).not.toHaveProperty("descriptionEdit");
  });

  test("projects each visible explanation independently instead of pausing the whole rail", () => {
    const firstParagraph = paragraph(
      "00000000-0000-4000-8000-000000000711",
      "图1为整体结构示意图。",
    );
    const duplicate = paragraph(
      "00000000-0000-4000-8000-000000000712",
      "图1为另一整体结构示意图。",
    );
    const projection = drawingExplanationProjection({
      figures: [figure(FIGURE_A, ASSET_A), figure(FIGURE_B, ASSET_B)],
      descriptionDocument: description(firstParagraph, duplicate),
    });

    expect(projection).toEqual([
      expect.objectContaining({ figureId: FIGURE_A, figureNumber: 1, status: "duplicate" }),
      expect.objectContaining({ figureId: FIGURE_B, figureNumber: 2, status: "missing" }),
    ]);
  });

  test("edits only the explicitly selected existing paragraph and keeps its color", () => {
    const targetId = "00000000-0000-4000-8000-000000000711";
    const source = description(paragraph(targetId, "图1为原说明。", "#D92D20"));

    const updated = updateDrawingExplanationParagraph({
      document: source,
      paragraphId: targetId,
      content: [{ type: "text", text: "图1为用户修改后的说明。", marks: [] }],
    });

    expect(updated.content.find((block) => block.id === targetId)).toMatchObject({
      content: [
        {
          type: "text",
          text: "图1为用户修改后的说明。",
          marks: [{ type: "color", value: "#D92D20" }],
        },
      ],
    });
  });

  test("inserts a missing explanation only when the user explicitly fills it", () => {
    const source = description(
      paragraph("00000000-0000-4000-8000-000000000711", "图1为整体结构示意图。"),
      paragraph("00000000-0000-4000-8000-000000000718", "其中，1为箱体。"),
    );

    const updated = fillDrawingExplanationParagraph({
      document: source,
      paragraphId: null,
      content: [{ type: "text", text: "图2为局部结构示意图。", marks: [] }],
      createId: () => "00000000-0000-4000-8000-000000000712",
    });

    expect(updated.content.map((block) => block.id)).toEqual([
      "00000000-0000-4000-8000-000000000710",
      "00000000-0000-4000-8000-000000000711",
      "00000000-0000-4000-8000-000000000712",
      "00000000-0000-4000-8000-000000000718",
      "00000000-0000-4000-8000-000000000719",
    ]);
    expect(updated.content[2]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000712",
      type: "paragraph",
      content: [{ type: "text", text: "图2为局部结构示意图。", marks: [] }],
    });
    expect(updated.content[2]).not.toHaveProperty("semanticRole");
    expect(updated.content[2]).not.toHaveProperty("figureId");
    expect(source.content).toHaveLength(4);
  });

  test.each(["legend", "chapter", "blank", "end"] as const)(
    "preserves the following %s and adds no blank paragraphs on repeated fills",
    (following) => {
      const source = description();
      if (following === "end") source.content.pop();
      if (following === "legend" || following === "blank") {
        source.content.splice(
          1,
          0,
          paragraph("existing-paragraph", following === "blank" ? "" : "其中：1、箱体。"),
        );
      }
      const originalTail = structuredClone(source.content.slice(1));
      const changes = [
        {
          target: { figureId: FIGURE_A, figureNumber: 1, paragraphId: null as string | null },
          content: [{ type: "text" as const, text: "图1为整体结构示意图。", marks: [] }],
        },
      ];
      const first = fillDrawingExplanationParagraphs({
        document: source,
        changes,
        createId: () => "new-paragraph",
      });
      expect(first.document.content.slice(2)).toEqual(originalTail);
      expect(first.document.content).toHaveLength(source.content.length + 1);
      for (const change of changes) change.target.paragraphId = first.firstParagraphId;
      const repeated = fillDrawingExplanationParagraphs({
        document: first.document,
        changes,
        createId: () => "unexpected",
      });
      expect(repeated.document).toEqual(first.document);
      expect(source.content.slice(1)).toEqual(originalTail);
    },
  );

  test("fills all explanations without adding a blank separator, keeping red text and two-character indents", () => {
    const firstId = "00000000-0000-4000-8000-000000000711";
    const source = description(
      paragraph(firstId, "图1为原说明。", "#111111"),
      paragraph("00000000-0000-4000-8000-000000000718", "其中，1为箱体。"),
    );
    const createdIds = [
      "00000000-0000-4000-8000-000000000712",
      "00000000-0000-4000-8000-000000000713",
    ];

    const result = fillDrawingExplanationParagraphs({
      document: source,
      changes: [
        {
          target: { figureId: FIGURE_A, figureNumber: 1, paragraphId: firstId },
          content: [{ type: "text", text: "图1为整体结构示意图。", marks: [] }],
        },
        {
          target: { figureId: FIGURE_B, figureNumber: 2, paragraphId: null },
          content: [{ type: "text", text: "图2为局部结构示意图。", marks: [] }],
        },
      ],
      createId: () => createdIds.shift() ?? "unexpected-id",
    });

    expect(result.firstParagraphId).toBe(firstId);
    expect(result.document.content.map((block) => block.id)).toEqual([
      "00000000-0000-4000-8000-000000000710",
      firstId,
      "00000000-0000-4000-8000-000000000712",
      "00000000-0000-4000-8000-000000000718",
      "00000000-0000-4000-8000-000000000719",
    ]);
    expect(result.document.content.slice(1, 3)).toEqual([
      expect.objectContaining({
        id: firstId,
        semanticRole: "description-drawing-explanation",
        figureId: FIGURE_A,
        attrs: expect.objectContaining({ paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM }),
        content: [
          {
            type: "text",
            text: "图1为整体结构示意图。",
            marks: [{ type: "color", value: "#D92D20" }],
          },
        ],
      }),
      expect.objectContaining({
        semanticRole: "description-drawing-explanation",
        figureId: FIGURE_B,
        attrs: expect.objectContaining({ paragraphIndentMm: PATENT_FIRST_LINE_INDENT_MM }),
        content: [
          {
            type: "text",
            text: "图2为局部结构示意图。",
            marks: [{ type: "color", value: "#D92D20" }],
          },
        ],
      }),
    ]);
    expect(result.document.content[3]).toEqual(source.content[2]);
    expect(source.content.map((block) => block.id)).toContain(firstId);
  });
});
