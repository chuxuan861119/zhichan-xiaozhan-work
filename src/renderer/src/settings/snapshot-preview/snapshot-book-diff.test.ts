import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createBlankDocument } from "../../../../shared/document/defaults";
import type { BlockNode, PatentBookDocument, TextMark } from "../../../../shared/document/model";
import { buildSnapshotBookDiff } from "./snapshot-book-diff";

const ids = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
);
const attrs = {
  alignment: "left" as const,
  paragraphIndentMm: 0,
  lineSpacing: 1.5,
  defaultFontFamily: "宋体",
  defaultFontSizePt: 12,
};

function paragraph(id: string, text: string, marks: TextMark[] = []): BlockNode {
  return { id, type: "paragraph", attrs, content: [{ type: "text", text, marks }] };
}

function document(content: BlockNode[]): PatentBookDocument {
  const base = createBlankDocument("测试");
  const { assets: _assets, ...book } = base;
  return { ...book, content };
}

function compare(
  baseline: BlockNode[],
  current: BlockNode[],
  bookKind: "abstract" | "claims" = "abstract",
) {
  return buildSnapshotBookDiff({
    bookKind,
    baseline: document(baseline),
    current: document(current),
    baselineRevision: 4,
    currentRevision: 7,
  });
}

function nodes(root: JSONContent): JSONContent[] {
  return [root, ...(root.content ?? []).flatMap(nodes)];
}

function markedText(root: JSONContent, type: string): string {
  return nodes(root)
    .filter((node) => node.type === "text" && node.marks?.some((mark) => mark.type === type))
    .map((node) => node.text ?? "")
    .join("");
}

function nodeById(root: JSONContent, id: string): JSONContent | undefined {
  return nodes(root).find((node) => node.attrs?.nodeId === id);
}

describe("buildSnapshotBookDiff", () => {
  test("does not report explicit zero paragraph spacing or centered formulas as changes", () => {
    const before = paragraph(ids[0]!, "原有内容");
    if (before.type !== "paragraph") throw new Error("fixture");
    const formula = {
      id: ids[1]!,
      type: "block-formula" as const,
      source: "x",
      formulaKind: "math" as const,
    };
    expect(
      compare(
        [before, formula],
        [
          { ...before, attrs: { ...before.attrs, spaceBeforePt: 0, spaceAfterPt: 0 } },
          { ...formula, alignment: "center" },
        ],
      ).changes,
    ).toHaveLength(0);
  });
  test.each(["spaceBeforePt", "spaceAfterPt"] as const)("reports %s changes", (field) => {
    const before = paragraph(ids[0]!, "原有内容");
    if (before.type !== "paragraph") throw new Error("fixture");
    const after = { ...before, attrs: { ...before.attrs, [field]: 6 } };
    expect(compare([before], [after]).changes).toContainEqual(
      expect.objectContaining({ kind: "structure", blockId: before.id }),
    );
  });

  test.each([
    { tableNameEnabled: true, tableName: "实验结果" },
    { tableNoteEnabled: true, tableNote: "单位：毫米" },
    { tableAlignment: "right" as const },
  ])("reports table annotation and alignment changes: %j", (patch) => {
    const before: Extract<BlockNode, { type: "table" }> = {
      id: ids[0]!,
      type: "table",
      columnWidthsMm: [100],
      rows: [
        {
          id: ids[1]!,
          cells: [
            {
              id: ids[2]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [{ id: ids[3]!, type: "paragraph", attrs, content: [] }],
            },
          ],
        },
      ],
    };
    expect(compare([before], [{ ...before, ...patch }]).changes).toContainEqual(
      expect.objectContaining({ kind: "structure", blockId: before.id }),
    );
  });

  test("reports cell padding changes without changing the snapshot document", () => {
    const before: Extract<BlockNode, { type: "table" }> = {
      id: ids[0]!,
      type: "table",
      columnWidthsMm: [100],
      rows: [
        {
          id: ids[1]!,
          cells: [
            {
              id: ids[2]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [{ id: ids[3]!, type: "paragraph", attrs, content: [] }],
            },
          ],
        },
      ],
    };
    const after = structuredClone(before);
    after.rows[0]!.cells[0]!.paddingMm = { top: 2, bottom: 2, left: 3, right: 3 };
    const result = compare([before], [after]);
    expect(result.changes).toContainEqual(expect.objectContaining({ nodeType: "table-cell" }));
    expect(result.currentDocument.content).toEqual([after]);
  });

  test("reports formula alignment changes", () => {
    const formula = {
      id: ids[0]!,
      type: "block-formula" as const,
      source: "x+1",
      formulaKind: "math" as const,
    };
    expect(compare([formula], [{ ...formula, alignment: "right" }]).changes).toContainEqual(
      expect.objectContaining({ kind: "structure", nodeType: "block-formula" }),
    );
  });

  test("reports page margin changes and keeps current page settings", () => {
    const baseline = document([paragraph(ids[0]!, "原有内容")]);
    const current = {
      ...baseline,
      page: { ...baseline.page, marginLeftMm: baseline.page.marginLeftMm + 2 },
    };
    const result = buildSnapshotBookDiff({
      bookKind: "claims",
      baseline,
      current,
      baselineRevision: 4,
      currentRevision: 7,
    });
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: "structure", locationLabel: "页面设置" }),
    );
    expect(result.currentDocument.page).toEqual(current.page);
  });

  test("describes a paragraph added since the baseline without exposing its internal type", () => {
    const result = compare([], [paragraph(ids[0]!, "新段落")]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.kind).toBe("insert");
    expect(result.changes[0]?.summary).toBe("新增段落");
    expect(
      compare([paragraph(ids[0]!, "新段落")], [paragraph(ids[0]!, "新段落")]).changes,
    ).toHaveLength(0);
  });
  test("keeps deleted replacement text before inserted text", () => {
    const result = compare(
      [paragraph(ids[0]!, "连接件由金属制成。")],
      [paragraph(ids[0]!, "连接件由绝缘材料制成。")],
    );
    expect(result.changes.map(({ kind }) => kind)).toEqual(["delete", "insert"]);
    expect(markedText(result.previewContent, "snapshotDeletion")).toBe("金属");
    expect(markedText(result.previewContent, "snapshotInsertion")).toBe("绝缘材料");
    expect(
      nodes(result.previewContent)
        .filter((node) => node.type === "text")
        .map((node) => node.text)
        .join(""),
    ).toContain("金属绝缘材料");
  });

  test("reports color and highlight changes without text changes", () => {
    const result = compare(
      [paragraph(ids[0]!, "连接件", [{ type: "color", value: "#000000" }])],
      [
        paragraph(ids[0]!, "连接件", [
          { type: "color", value: "#C00000" },
          { type: "background-color", value: "#FFFF00" },
        ]),
      ],
    );
    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "format",
        details: ["字体颜色：#000000 → #C00000", "突出显示：无 → #FFFF00"],
      }),
    ]);
    expect(markedText(result.previewContent, "snapshotFormatChange")).toBe("连接件");
  });

  test("reports superscript and paragraph alignment", () => {
    const before = paragraph(ids[0]!, "2");
    const after = {
      ...paragraph(ids[0]!, "2", [{ type: "superscript" }]),
      attrs: { ...attrs, alignment: "center" as const },
    };
    expect(compare([before], [after]).changes.map(({ kind }) => kind)).toEqual([
      "structure",
      "format",
    ]);
  });

  test("renders moved stable blocks as deletion plus insertion with unique preview ids", () => {
    const first = paragraph(ids[0]!, "甲");
    const second = paragraph(ids[1]!, "乙");
    const result = compare([first, second], [second, first]);
    expect(result.changes.map(({ kind }) => kind)).toEqual(["delete", "insert"]);
    const previewIds = nodes(result.previewContent)
      .map((node) => node.attrs?.nodeId)
      .filter(Boolean);
    expect(new Set(previewIds).size).toBe(previewIds.length);
  });

  test.each(["figure", "block-formula", "chemical-structure"] as const)(
    "keeps deleted %s visible and annotated",
    (type) => {
      const atomic: BlockNode =
        type === "figure"
          ? {
              id: ids[0]!,
              type,
              assetId: ids[10]!,
              widthMm: 100,
              alignment: "center",
            }
          : type === "block-formula"
            ? { id: ids[0]!, type, source: "x", formulaKind: "math" }
            : {
                id: ids[0]!,
                type,
                ketSource: "{}",
                previewAssetId: ids[10]!,
                widthMm: 100,
                alignment: "center",
              };
      const result = compare([atomic], []);
      expect(result.changes).toContainEqual(
        expect.objectContaining({ kind: "delete", nodeType: type }),
      );
      expect(
        nodes(result.previewContent).find((node) => node.attrs?.snapshotChangeKind === "delete")
          ?.attrs,
      ).toMatchObject({ snapshotSourceRevision: 4 });
    },
  );

  test("compares nested list item text", () => {
    const list = (text: string): BlockNode => ({
      id: ids[0]!,
      type: "bullet-list",
      items: [
        {
          id: ids[1]!,
          content: [paragraph(ids[2]!, text) as Extract<BlockNode, { type: "paragraph" }>],
        },
      ],
    });
    expect(compare([list("旧")], [list("新")]).changes.map(({ kind }) => kind)).toEqual([
      "delete",
      "insert",
    ]);
  });

  test("keeps an inserted inline image visible and annotated", () => {
    const paragraphId = "00000000-0000-4000-8000-000000000020";
    const inlineFigureId = "00000000-0000-4000-8000-000000000021";
    const assetId = "00000000-0000-4000-8000-000000000022";
    const before = paragraph(paragraphId, "前后") as Extract<BlockNode, { type: "paragraph" }>;
    const after: Extract<BlockNode, { type: "paragraph" }> = {
      ...before,
      content: [
        { type: "text", text: "前", marks: [] },
        {
          id: inlineFigureId,
          type: "inline-figure",
          assetId,
          widthMm: 30,
          alignment: "center",
          rotationDeg: 90,
        },
        { type: "text", text: "后", marks: [] },
      ],
    };

    const result = compare([before], [after]);
    expect(
      nodes(result.previewContent).find((node) => node.type === "inlineFigure")?.attrs,
    ).toMatchObject({
      assetId,
      rotationDeg: 90,
      snapshotChangeKind: "insert",
      snapshotSourceRevision: 7,
    });
  });

  test("compares table cell text and row/cell attributes", () => {
    const table = (
      text: string,
      rowHeightMm: number,
      horizontalAlignment: "left" | "center",
    ): BlockNode => ({
      id: ids[0]!,
      type: "table",
      columnWidthsMm: [80],
      rows: [
        {
          id: ids[1]!,
          rowHeightMm,
          rowHeightRule: "exact",
          cells: [
            {
              id: ids[2]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment,
              verticalAlignment: "top",
              borderStyle: "single",
              content: [paragraph(ids[3]!, text) as Extract<BlockNode, { type: "paragraph" }>],
            },
          ],
        },
      ],
    });
    const result = compare([table("旧", 10, "left")], [table("新", 12, "center")]);
    expect(result.changes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["structure", "delete", "insert"]),
    );
    expect(result.changes.flatMap(({ details }) => details)).toEqual(
      expect.arrayContaining(["行高：10 → 12", "单元格水平对齐：左对齐 → 居中"]),
    );
  });

  test("returns unannotated current content when baseline is null", () => {
    const current = document([paragraph(ids[0]!, "正文")]);
    const result = buildSnapshotBookDiff({
      bookKind: "abstract",
      baseline: null,
      current,
      baselineRevision: null,
      currentRevision: 7,
    });
    expect(result.changes).toEqual([]);
    expect(JSON.stringify(result.previewContent)).not.toContain("snapshotChange");
  });

  test("attaches ids, kinds, and source revisions to every annotation", () => {
    const result = compare([paragraph(ids[0]!, "旧")], [paragraph(ids[0]!, "新")]);
    for (const node of nodes(result.previewContent).filter((entry) =>
      JSON.stringify(entry).includes("snapshotChangeKind"),
    )) {
      const annotation = node.attrs?.snapshotChangeKind
        ? node.attrs
        : node.marks?.find((mark) => mark.type.startsWith("snapshot"))?.attrs;
      if (annotation)
        expect(annotation).toMatchObject({
          snapshotChangeId: expect.any(String),
          snapshotChangeKind: expect.any(String),
          snapshotSourceRevision: expect.any(Number),
        });
    }
  });

  test("creates deterministic change ids that remain unique across books", () => {
    const baseline = document([paragraph(ids[0]!, "旧")]);
    const current = document([paragraph(ids[0]!, "新")]);
    const build = (bookKind: "abstract" | "claims") =>
      buildSnapshotBookDiff({
        bookKind,
        baseline,
        current,
        baselineRevision: 4,
        currentRevision: 7,
      });
    const abstractIds = build("abstract").changes.map(({ id }) => id);
    const claimIds = build("claims").changes.map(({ id }) => id);
    expect(abstractIds[0]).not.toBe(claimIds[0]);
    expect(build("abstract").changes.map(({ id }) => id)).toEqual(abstractIds);
    expect(new Set(abstractIds).size).toBe(abstractIds.length);
  });

  test("uses delete/insert for semantic replacement but structure for display-only changes", () => {
    const formula = (source: string): BlockNode => ({
      id: ids[0]!,
      type: "block-formula",
      source,
      formulaKind: "math",
    });
    expect(compare([formula("x")], [formula("y")]).changes.map(({ kind }) => kind)).toEqual([
      "delete",
      "insert",
    ]);
    const figure = (widthMm: number): BlockNode => ({
      id: ids[0]!,
      type: "figure",
      assetId: ids[10]!,
      widthMm,
      alignment: "center",
    });
    expect(compare([figure(80)], [figure(100)]).changes.map(({ kind }) => kind)).toEqual([
      "structure",
    ]);
  });

  test("reuses claim ruler labels and falls back to 24 graphemes", () => {
    const claim = compare(
      [paragraph(ids[0]!, "1. 一种装置。")],
      [paragraph(ids[0]!, "1. 一种新装置。")],
      "claims",
    );
    expect(claim.changes.every(({ locationLabel }) => locationLabel === "权利要求 1")).toBe(true);
    const fallback = compare(
      [paragraph(ids[0]!, "这是一个超过二十四个字的段落用于验证摘要位置标签会被正确截断处理")],
      [paragraph(ids[0]!, "这是一个超过二十四个字的新段落用于验证摘要位置标签会被正确截断处理")],
    );
    expect(fallback.changes[0]?.locationLabel.length).toBeLessThanOrEqual(24);
  });

  test("annotates only each structurally changed paragraph, list, table, row, and cell node", () => {
    const nested = paragraph(ids[5]!, "内容") as Extract<BlockNode, { type: "paragraph" }>;
    const list = (start: number): BlockNode => ({
      id: ids[0]!,
      type: "ordered-list",
      start,
      items: [{ id: ids[1]!, content: [nested] }],
    });
    const listResult = compare([list(1)], [list(2)]);
    expect(nodeById(listResult.previewContent, ids[0]!)?.attrs).toMatchObject({
      snapshotChangeKind: "structure",
      snapshotSourceRevision: 7,
    });
    expect(nodeById(listResult.previewContent, ids[1]!)?.attrs?.snapshotChangeKind).toBeUndefined();

    const table = (
      rowHeightMm: number,
      horizontalAlignment: "left" | "center",
      widths = [80],
    ): BlockNode => ({
      id: ids[6]!,
      type: "table",
      columnWidthsMm: widths,
      rows: [
        {
          id: ids[7]!,
          rowHeightMm,
          rowHeightRule: "exact",
          cells: [
            {
              id: ids[8]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment,
              verticalAlignment: "top",
              borderStyle: "single",
              content: [paragraph(ids[9]!, "表格") as Extract<BlockNode, { type: "paragraph" }>],
            },
          ],
        },
      ],
    });
    const tableResult = compare([table(10, "left")], [table(12, "center", [90])]);
    for (const id of [ids[6]!, ids[7]!, ids[8]!])
      expect(nodeById(tableResult.previewContent, id)?.attrs).toMatchObject({
        snapshotChangeKind: "structure",
        snapshotSourceRevision: 7,
      });
    expect(
      nodeById(tableResult.previewContent, ids[9]!)?.attrs?.snapshotChangeKind,
    ).toBeUndefined();

    const changedParagraph = {
      ...paragraph(ids[10]!, "段落"),
      figureId: undefined,
      attrs: { ...attrs, alignment: "right" as const },
    } as BlockNode;
    const paragraphResult = compare([paragraph(ids[10]!, "段落")], [changedParagraph]);
    expect(nodeById(paragraphResult.previewContent, ids[10]!)?.attrs).toMatchObject({
      snapshotChangeKind: "structure",
    });
  });

  test("propagates ruler labels to nested descendants and recursively falls back to nested text", () => {
    const claimHeading = paragraph(ids[10]!, "1. 一种装置，包括：") as Extract<
      BlockNode,
      { type: "paragraph" }
    >;
    const claimList: BlockNode = {
      id: ids[0]!,
      type: "bullet-list",
      items: [
        {
          id: ids[1]!,
          content: [paragraph(ids[2]!, "连接件。") as Extract<BlockNode, { type: "paragraph" }>],
        },
      ],
    };
    const changedClaimList: BlockNode = {
      ...claimList,
      items: [
        {
          id: ids[1]!,
          content: [paragraph(ids[2]!, "新连接件。") as Extract<BlockNode, { type: "paragraph" }>],
        },
      ],
    };
    const claim = compare([claimHeading, claimList], [claimHeading, changedClaimList], "claims");
    expect(claim.changes.every(({ locationLabel }) => locationLabel === "权利要求 1")).toBe(true);

    const nestedList = (text: string): BlockNode => ({
      id: ids[3]!,
      type: "bullet-list",
      items: [
        {
          id: ids[4]!,
          content: [paragraph(ids[5]!, text) as Extract<BlockNode, { type: "paragraph" }>],
        },
      ],
    });
    const fallback = compare(
      [nestedList("嵌套列表中的旧文字作为位置")],
      [nestedList("嵌套列表中的新文字作为位置")],
    );
    expect(
      fallback.changes.every(({ locationLabel }) => locationLabel.includes("嵌套列表中的新文字")),
    ).toBe(true);

    const chapter = {
      ...paragraph(ids[11]!, "技术领域"),
      semanticRole: "description-technical-field" as const,
    } as Extract<BlockNode, { type: "paragraph" }>;
    const table = (text: string): BlockNode => ({
      id: ids[12]!,
      type: "table",
      columnWidthsMm: [80],
      rows: [
        {
          id: ids[13]!,
          cells: [
            {
              id: ids[14]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [paragraph(ids[15]!, text) as Extract<BlockNode, { type: "paragraph" }>],
            },
          ],
        },
      ],
    });
    const description = buildSnapshotBookDiff({
      bookKind: "description",
      baseline: document([chapter, table("旧内容")]),
      current: document([chapter, table("新内容")]),
      baselineRevision: 4,
      currentRevision: 7,
    });
    expect(description.changes.every(({ locationLabel }) => locationLabel === "技术领域")).toBe(
      true,
    );
  });

  test("splits adjacent inserted and deleted text when canonical mark sets differ", () => {
    const content = (first: string, second: string): Extract<BlockNode, { type: "paragraph" }> => ({
      id: ids[0]!,
      type: "paragraph",
      attrs,
      content: [
        { type: "text", text: first, marks: [] },
        { type: "text", text: second, marks: [{ type: "bold" }] },
      ],
    });
    const inserted = compare([paragraph(ids[0]!, "")], [content("甲", "乙")]);
    expect(inserted.changes.map(({ kind }) => kind)).toEqual(["insert", "insert"]);
    expect(new Set(inserted.changes.map(({ id }) => id)).size).toBe(2);
    const deleted = compare([content("甲", "乙")], [paragraph(ids[0]!, "")]);
    expect(deleted.changes.map(({ kind }) => kind)).toEqual(["delete", "delete"]);
  });

  test("compares figureId, list and table semantic attributes, and matched type changes", () => {
    const drawing = (figureId?: string): BlockNode => ({
      id: ids[0]!,
      type: "paragraph",
      semanticRole: "description-drawing-explanation",
      ...(figureId ? { figureId } : {}),
      attrs,
      content: [{ type: "text", text: "图1", marks: [] }],
    });
    const figureResult = compare([drawing(ids[10]!)], [drawing(ids[11]!)]);
    expect(figureResult.changes[0]?.details).toContain(`附图关联：${ids[10]} → ${ids[11]}`);
    const list = (role: "claim" | undefined): BlockNode => ({
      id: ids[1]!,
      type: "ordered-list",
      start: 1,
      ...(role ? { semanticRole: role } : {}),
      items: [
        {
          id: ids[2]!,
          content: [paragraph(ids[3]!, "项") as Extract<BlockNode, { type: "paragraph" }>],
        },
      ],
    });
    expect(compare([list(undefined)], [list("claim")]).changes[0]?.details).toContain(
      "语义角色：无 → claim",
    );
    const table = (role: "claim" | undefined): BlockNode => ({
      id: ids[4]!,
      type: "table",
      ...(role ? { semanticRole: role } : {}),
      columnWidthsMm: [80],
      rows: [
        {
          id: ids[5]!,
          cells: [
            {
              id: ids[6]!,
              rowSpan: 1,
              colSpan: 1,
              horizontalAlignment: "left",
              verticalAlignment: "top",
              borderStyle: "single",
              content: [paragraph(ids[7]!, "格") as Extract<BlockNode, { type: "paragraph" }>],
            },
          ],
        },
      ],
    });
    expect(compare([table(undefined)], [table("claim")]).changes[0]?.details).toContain(
      "语义角色：无 → claim",
    );
    expect(
      compare(
        [paragraph(ids[8]!, "同ID")],
        [{ id: ids[8]!, type: "block-formula", source: "x", formulaKind: "math" }],
      ).changes.map(({ kind }) => kind),
    ).toEqual(["delete", "insert"]);
  });

  test("represents hard breaks, inline formulas, and every text mark change", () => {
    const paragraphWith = (
      content: Extract<BlockNode, { type: "paragraph" }>["content"],
    ): BlockNode => ({ id: ids[0]!, type: "paragraph", attrs, content });
    const atomic = compare(
      [paragraphWith([{ type: "text", text: "甲", marks: [] }])],
      [
        paragraphWith([
          { type: "text", text: "甲", marks: [] },
          { type: "hard-break" },
          { type: "inline-formula", source: "x", formulaKind: "math" },
        ]),
      ],
    );
    expect(atomic.changes.map(({ kind }) => kind)).toEqual(["insert"]);
    expect(
      nodes(atomic.previewContent)
        .filter((node) => node.attrs?.snapshotChangeKind === "insert")
        .map(({ type }) => type),
    ).toEqual(expect.arrayContaining(["hardBreak", "inlineMath"]));
    const atomicDeletion = compare(
      [
        paragraphWith([
          { type: "text", text: "甲", marks: [] },
          { type: "hard-break" },
          { type: "inline-formula", source: "x", formulaKind: "math" },
        ]),
      ],
      [paragraphWith([{ type: "text", text: "甲", marks: [] }])],
    );
    expect(
      nodes(atomicDeletion.previewContent)
        .filter((node) => node.attrs?.snapshotChangeKind === "delete")
        .map(({ type }) => type),
    ).toEqual(expect.arrayContaining(["hardBreak", "inlineMath"]));

    const allMarks: TextMark[] = [
      { type: "bold" },
      { type: "italic" },
      { type: "underline" },
      { type: "claim-reference-review" },
      { type: "superscript" },
      { type: "subscript" },
      { type: "font-family", value: "黑体" },
      { type: "font-size", valuePt: 14 },
      { type: "color", value: "#C00000" },
      { type: "background-color", value: "#FFFF00" },
    ];
    const formats = compare(
      [paragraph(ids[0]!, "字")],
      [paragraph(ids[0]!, "字", allMarks)],
    ).changes.flatMap(({ details }) => details);
    expect(formats).toHaveLength(10);
    expect(formats).toEqual(
      expect.arrayContaining([
        "加粗：无 → 有",
        "字体：无 → 黑体",
        "字号：无 → 14",
        "字体颜色：无 → #C00000",
        "突出显示：无 → #FFFF00",
      ]),
    );
  });
});
