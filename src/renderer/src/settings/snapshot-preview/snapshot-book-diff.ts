import type { JSONContent } from "@tiptap/core";
import type {
  BlockNode,
  InlineNode,
  PatentBookDocument,
  TextMark,
} from "../../../../shared/document/model";
import { buildDocumentStructureRulerIndex } from "../../../../shared/patent/document-structure-ruler";
import type { PatentBookKind } from "../../../../shared/patent/model";
import { canonicalToTiptap } from "../../editor/model-adapter";
import { diffSequence, segmentGraphemes } from "./snapshot-sequence-diff";

export type SnapshotChangeKind = "insert" | "delete" | "format" | "structure";

export type SnapshotBookChange = Readonly<{
  id: string;
  kind: SnapshotChangeKind;
  bookKind: PatentBookKind;
  blockId: string;
  locationLabel: string;
  summary: string;
  details: readonly string[];
  nodeType: string | null;
}>;

export type SnapshotBookDiff = Readonly<{
  bookKind: PatentBookKind;
  currentDocument: PatentBookDocument;
  previewContent: JSONContent;
  changes: readonly SnapshotBookChange[];
}>;

type Input = Readonly<{
  bookKind: PatentBookKind;
  baseline: PatentBookDocument | null;
  current: PatentBookDocument;
  baselineRevision: number | null;
  currentRevision: number;
}>;

type Context = {
  input: Input;
  changes: SnapshotBookChange[];
  serial: number;
  locations: Map<string, string>;
};

type Identified = Readonly<{ id: string }>;
type TiptapMark = NonNullable<JSONContent["marks"]>[number];

export function buildSnapshotBookDiff(input: Input): SnapshotBookDiff {
  if (input.baseline === null) {
    return {
      bookKind: input.bookKind,
      currentDocument: input.current,
      previewContent: canonicalToTiptap(input.current),
      changes: [],
    };
  }
  const context: Context = {
    input,
    changes: [],
    serial: 0,
    locations: buildLocationMap(input),
  };
  const pageDetails = objectDetails(input.baseline.page, input.current.page, [
    ["widthMm", "页面宽度"],
    ["heightMm", "页面高度"],
    ["marginTopMm", "上页边距"],
    ["marginRightMm", "右页边距"],
    ["marginBottomMm", "下页边距"],
    ["marginLeftMm", "左页边距"],
  ]);
  if (pageDetails.length > 0) {
    context.locations.set(input.current.documentId, "页面设置");
    addChange(context, "structure", input.current.documentId, "page-settings", pageDetails);
  }
  const content = compareBlocks(input.baseline.content, input.current.content, context);
  return {
    bookKind: input.bookKind,
    currentDocument: input.current,
    previewContent: { type: "doc", content },
    changes: context.changes,
  };
}

function compareBlocks(
  before: readonly BlockNode[],
  after: readonly BlockNode[],
  context: Context,
): JSONContent[] {
  return compareIdentified(before, after, context, (oldNode, newNode) =>
    compareBlock(oldNode, newNode, context),
  );
}

function compareIdentified<T extends Identified>(
  before: readonly T[],
  after: readonly T[],
  context: Context,
  compareEqual: (before: T, after: T) => JSONContent[],
  toJson: (node: T, source: "baseline" | "current") => JSONContent = (node) =>
    canonicalNode(node as unknown as BlockNode),
  nodeType: (node: T) => string | null = (node) =>
    typeof record(node).type === "string" ? (record(node).type as string) : null,
): JSONContent[] {
  const output: JSONContent[] = [];
  for (const run of diffSequence(before, after, ({ id }) => id)) {
    if (run.kind === "delete") {
      for (const node of run.before)
        output.push(deletedJson(node.id, toJson(node, "baseline"), nodeType(node), context));
    } else if (run.kind === "insert") {
      for (const node of run.after)
        output.push(insertedJson(node.id, toJson(node, "current"), nodeType(node), context));
    } else {
      for (let index = 0; index < run.before.length; index += 1) {
        output.push(...compareEqual(run.before[index]!, run.after[index]!));
      }
    }
  }
  return output;
}

function compareBlock(before: BlockNode, after: BlockNode, context: Context): JSONContent[] {
  if (before.type !== after.type)
    return [deletedNode(before, context), insertedNode(after, context)];
  switch (after.type) {
    case "paragraph":
    case "heading":
      return [compareTextBlock(before as typeof after, after, context)];
    case "bullet-list":
    case "ordered-list":
      return [compareList(before as typeof after, after, context)];
    case "table":
      return [compareTable(before as typeof after, after, context)];
    case "figure":
    case "block-formula":
    case "chemical-structure":
      return compareAtomic(before as typeof after, after, context);
    default:
      return [canonicalNode(after)];
  }
}

function compareTextBlock(
  before: Extract<BlockNode, { type: "paragraph" | "heading" }>,
  after: Extract<BlockNode, { type: "paragraph" | "heading" }>,
  context: Context,
): JSONContent {
  const base = canonicalNode(after);
  const details = paragraphDetails(before, after);
  const change =
    details.length > 0 ? addChange(context, "structure", after.id, after.type, details) : null;
  const content = compareInline(before.content, after.content, after.id, context);
  return change
    ? { ...annotateSelf(base, change, context.input.currentRevision), content }
    : { ...base, content };
}

function compareList(
  before: Extract<BlockNode, { type: "bullet-list" | "ordered-list" }>,
  after: Extract<BlockNode, { type: "bullet-list" | "ordered-list" }>,
  context: Context,
): JSONContent {
  const base = canonicalNode(after);
  const details: string[] = [];
  if (
    before.type === "ordered-list" &&
    after.type === "ordered-list" &&
    before.start !== after.start
  )
    details.push(`列表起始序号：${before.start} → ${after.start}`);
  if (before.semanticRole !== after.semanticRole)
    details.push(`语义角色：${before.semanticRole ?? "无"} → ${after.semanticRole ?? "无"}`);
  const change =
    details.length > 0 ? addChange(context, "structure", after.id, after.type, details) : null;
  const node: JSONContent = {
    ...base,
    content: compareIdentified(
      before.items,
      after.items,
      context,
      (oldItem, newItem) => {
        const node: JSONContent = {
          type: "listItem",
          attrs: { nodeId: newItem.id },
          content: compareIdentified(
            oldItem.content,
            newItem.content,
            context,
            (oldParagraph, newParagraph) => [compareTextBlock(oldParagraph, newParagraph, context)],
          ),
        };
        return [node];
      },
      (item, source) => listItemJson(source === "baseline" ? before : after, item.id),
    ),
  };
  return change ? annotateSelf(node, change, context.input.currentRevision) : node;
}

function compareTable(
  before: Extract<BlockNode, { type: "table" }>,
  after: Extract<BlockNode, { type: "table" }>,
  context: Context,
): JSONContent {
  const base = canonicalNode(after);
  const tableDetails = objectDetails(before, after, [
    ["columnWidthsMm", "列宽"],
    ["headerRowCount", "标题行数"],
    ["layoutMode", "表格布局"],
    ["tableAlignment", "表格对齐", "left"],
    ["tableNameEnabled", "显示表名", false],
    ["tableName", "表名", ""],
    ["tableNoteEnabled", "显示补充说明", false],
    ["tableNote", "补充说明", ""],
  ]);
  if (before.semanticRole !== after.semanticRole)
    tableDetails.push(`语义角色：${before.semanticRole ?? "无"} → ${after.semanticRole ?? "无"}`);
  const tableChange =
    tableDetails.length > 0
      ? addChange(context, "structure", after.id, after.type, tableDetails)
      : null;
  const tableNode: JSONContent = {
    ...base,
    content: compareIdentified(
      before.rows,
      after.rows,
      context,
      (oldRow, newRow) => {
        const rowDetails = objectDetails(oldRow, newRow, [
          ["rowHeightMm", "行高"],
          ["rowHeightRule", "行高规则"],
        ]);
        const rowChange =
          rowDetails.length > 0
            ? addChange(context, "structure", after.id, "table-row", rowDetails)
            : null;
        const rowNode: JSONContent = {
          type: "tableRow",
          attrs: {
            nodeId: newRow.id,
            ...(newRow.rowHeightMm === undefined
              ? {}
              : { rowHeightMm: newRow.rowHeightMm, rowHeightRule: newRow.rowHeightRule }),
          },
          content: compareIdentified(
            oldRow.cells,
            newRow.cells,
            context,
            (oldCell, newCell) => {
              const cellDetails = objectDetails(oldCell, newCell, [
                ["rowSpan", "纵向合并"],
                ["colSpan", "横向合并"],
                ["horizontalAlignment", "单元格水平对齐"],
                ["verticalAlignment", "单元格垂直对齐"],
                ["borderStyle", "边框"],
                ["borderEdges", "边框边缘"],
                ["paddingMm", "单元格留白", { top: 2, right: 2, bottom: 2, left: 2 }],
              ]);
              const cellChange =
                cellDetails.length > 0
                  ? addChange(context, "structure", after.id, "table-cell", cellDetails)
                  : null;
              const source = findJsonById(base, newCell.id);
              const cellNode: JSONContent = {
                type: source?.type ?? "tableCell",
                attrs: source?.attrs,
                content: compareIdentified(
                  oldCell.content,
                  newCell.content,
                  context,
                  (oldParagraph, newParagraph) => [
                    compareTextBlock(oldParagraph, newParagraph, context),
                  ],
                ),
              };
              return [
                cellChange
                  ? annotateSelf(cellNode, cellChange, context.input.currentRevision)
                  : cellNode,
              ];
            },
            (cell, source) =>
              findJsonById(canonicalNode(source === "baseline" ? before : after), cell.id)!,
          ),
        };
        return [
          rowChange ? annotateSelf(rowNode, rowChange, context.input.currentRevision) : rowNode,
        ];
      },
      (row, source) => findJsonById(canonicalNode(source === "baseline" ? before : after), row.id)!,
    ),
  };
  return tableChange
    ? annotateSelf(tableNode, tableChange, context.input.currentRevision)
    : tableNode;
}

function compareAtomic(
  before: Extract<BlockNode, { type: "figure" | "block-formula" | "chemical-structure" }>,
  after: Extract<BlockNode, { type: "figure" | "block-formula" | "chemical-structure" }>,
  context: Context,
): JSONContent[] {
  const semanticKeys =
    after.type === "figure"
      ? ["assetId"]
      : after.type === "block-formula"
        ? ["source", "formulaKind"]
        : ["ketSource", "editorMode", "previewAssetId"];
  if (semanticKeys.some((key) => !sameValue(record(before)[key], record(after)[key]))) {
    return [deletedNode(before, context), insertedNode(after, context)];
  }
  const displayKeys =
    after.type === "block-formula" ? ["alignment"] : ["widthMm", "alignment", "rotationDeg"];
  const details = displayKeys.flatMap((key) =>
    valueDetail(
      key,
      record(before)[key] ?? (key === "alignment" ? "center" : undefined),
      record(after)[key] ?? (key === "alignment" ? "center" : undefined),
    ),
  );
  const node = canonicalNode(after);
  if (details.length === 0) return [node];
  const change = addChange(context, "structure", after.id, after.type, details);
  return [annotateNode(node, change, context.input.currentRevision, false)];
}

type InlineToken = Readonly<{
  key: string;
  text: string | null;
  marks: readonly TextMark[];
  source: InlineNode;
}>;

function compareInline(
  before: readonly InlineNode[],
  after: readonly InlineNode[],
  blockId: string,
  context: Context,
): JSONContent[] {
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const output: JSONContent[] = [];
  for (const run of diffSequence(oldTokens, newTokens, ({ key }) => key)) {
    if (run.kind === "delete") appendTokenChange(output, run.before, "delete", blockId, context);
    else if (run.kind === "insert")
      appendTokenChange(output, run.after, "insert", blockId, context);
    else {
      for (let index = 0; index < run.before.length; ) {
        const oldToken = run.before[index]!;
        const newToken = run.after[index]!;
        const details = markDetails(oldToken.marks, newToken.marks);
        let end = index + 1;
        while (
          end < run.before.length &&
          sameValue(details, markDetails(run.before[end]!.marks, run.after[end]!.marks))
        )
          end += 1;
        if (details.length === 0) {
          for (let tokenIndex = index; tokenIndex < end; tokenIndex += 1)
            appendToken(output, run.after[tokenIndex]!);
        } else {
          const change = addChange(context, "format", blockId, null, details);
          const mark = annotationMark(
            "snapshotFormatChange",
            change,
            context.input.currentRevision,
          );
          for (let tokenIndex = index; tokenIndex < end; tokenIndex += 1)
            appendToken(output, run.after[tokenIndex]!, mark);
        }
        index = end;
      }
    }
  }
  return mergeAdjacentText(output);
}

function tokenize(content: readonly InlineNode[]): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const source of content) {
    if (source.type === "text") {
      for (const text of segmentGraphemes(source.text))
        tokens.push({ key: `text:${text}`, text, marks: source.marks, source });
    } else if (source.type === "hard-break")
      tokens.push({ key: "hard-break", text: null, marks: [], source });
    else if (source.type === "inline-formula")
      tokens.push({
        key: `inline-formula:${source.formulaKind}:${source.source}`,
        text: null,
        marks: [],
        source,
      });
    else
      tokens.push({
        key: `inline-figure:${source.id}:${source.assetId}:${source.widthMm}:${source.rotationDeg ?? 0}:${source.alignment ?? "center"}`,
        text: null,
        marks: [],
        source,
      });
  }
  return tokens;
}

function appendTokenChange(
  output: JSONContent[],
  tokens: readonly InlineToken[],
  kind: "delete" | "insert",
  blockId: string,
  context: Context,
): void {
  if (tokens.length === 0) return;
  for (let start = 0; start < tokens.length; ) {
    let end = start + 1;
    while (
      end < tokens.length &&
      canonicalMarksKey(tokens[end]!.marks) === canonicalMarksKey(tokens[start]!.marks)
    )
      end += 1;
    const group = tokens.slice(start, end);
    const details = group.flatMap((token) =>
      kind === "delete" ? markDetails(token.marks, []) : markDetails([], token.marks),
    );
    const change = addChange(context, kind, blockId, null, [...new Set(details)]);
    const revision =
      kind === "delete" ? context.input.baselineRevision! : context.input.currentRevision;
    const mark = annotationMark(
      kind === "delete" ? "snapshotDeletion" : "snapshotInsertion",
      change,
      revision,
    );
    for (const token of group) appendToken(output, token, mark);
    start = end;
  }
}

function appendToken(output: JSONContent[], token: InlineToken, extraMark?: TiptapMark): void {
  if (token.text !== null) {
    const node = canonicalToTiptap({
      content: [
        {
          id: "00000000-0000-4000-8000-000000000000",
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1,
            defaultFontFamily: "宋体",
            defaultFontSizePt: 12,
          },
          content: [{ type: "text", text: token.text, marks: [...token.marks] }],
        },
      ],
    }).content![0]!.content![0]!;
    output.push({ ...node, marks: [...(node.marks ?? []), ...(extraMark ? [extraMark] : [])] });
    return;
  }
  let node: JSONContent;
  if (token.source.type === "hard-break") node = { type: "hardBreak" };
  else if (token.source.type === "inline-formula")
    node = {
      type: "inlineMath",
      attrs: { latex: token.source.source, formulaKind: token.source.formulaKind },
    };
  else if (token.source.type === "inline-figure")
    node = {
      type: "inlineFigure",
      attrs: {
        nodeId:
          extraMark?.type === "snapshotDeletion"
            ? `${token.source.id}--snapshot-${String(extraMark.attrs?.snapshotChangeId)}`
            : token.source.id,
        assetId: token.source.assetId,
        widthMm: token.source.widthMm,
        alignment: token.source.alignment,
        rotationDeg: token.source.rotationDeg ?? 0,
      },
    };
  else throw new Error("Text token must carry visible text");
  output.push(
    extraMark ? { ...node, attrs: { ...(node.attrs ?? {}), ...(extraMark.attrs ?? {}) } } : node,
  );
}

function deletedNode(node: Identified, context: Context): JSONContent {
  const block = node as BlockNode;
  return deletedJson(block.id, canonicalNode(block), "type" in block ? block.type : null, context);
}

function insertedNode(node: Identified, context: Context): JSONContent {
  const block = node as BlockNode;
  return insertedJson(block.id, canonicalNode(block), "type" in block ? block.type : null, context);
}

function deletedJson(
  id: string,
  node: JSONContent,
  nodeType: string | null,
  context: Context,
): JSONContent {
  const change = addChange(context, "delete", id, nodeType ?? node.type ?? null, []);
  return annotateNode(node, change, context.input.baselineRevision!, true);
}

function insertedJson(
  id: string,
  node: JSONContent,
  nodeType: string | null,
  context: Context,
): JSONContent {
  const change = addChange(context, "insert", id, nodeType ?? node.type ?? null, []);
  return annotateNode(node, change, context.input.currentRevision, false);
}

function canonicalNode(block: BlockNode): JSONContent {
  return canonicalToTiptap({ content: [block] }).content![0]!;
}

function annotateNode(
  node: JSONContent,
  change: SnapshotBookChange,
  revision: number,
  cloneIds: boolean,
): JSONContent {
  const visit = (current: JSONContent): JSONContent => ({
    ...current,
    attrs: {
      ...(current.attrs ?? {}),
      ...(cloneIds && current.attrs?.nodeId
        ? { nodeId: `${current.attrs.nodeId}--snapshot-${change.id}` }
        : {}),
      snapshotChangeId: change.id,
      snapshotChangeKind: change.kind,
      snapshotSourceRevision: revision,
    },
    ...(current.content ? { content: current.content.map(visit) } : {}),
  });
  return visit(node);
}

function annotateSelf(
  node: JSONContent,
  change: SnapshotBookChange,
  revision: number,
): JSONContent {
  return {
    ...node,
    attrs: {
      ...(node.attrs ?? {}),
      snapshotChangeId: change.id,
      snapshotChangeKind: change.kind,
      snapshotSourceRevision: revision,
    },
  };
}

function annotationMark(type: string, change: SnapshotBookChange, revision: number): TiptapMark {
  return {
    type,
    attrs: {
      snapshotChangeId: change.id,
      snapshotChangeKind: change.kind,
      snapshotSourceRevision: revision,
    },
  };
}

function addChange(
  context: Context,
  kind: SnapshotChangeKind,
  blockId: string,
  nodeType: string | null,
  details: readonly string[],
): SnapshotBookChange {
  const id = `snapshot-change-${context.input.bookKind}-${++context.serial}`;
  const change: SnapshotBookChange = {
    id,
    kind,
    bookKind: context.input.bookKind,
    blockId,
    locationLabel:
      context.locations.get(blockId) ??
      fallbackLocation(context.input.current, blockId) ??
      fallbackLocation(context.input.baseline!, blockId) ??
      "文档内容",
    summary: summary(kind, nodeType),
    details,
    nodeType,
  };
  context.changes.push(change);
  return change;
}

function buildLocationMap(input: Input): Map<string, string> {
  const result = new Map<string, string>();
  if (input.bookKind !== "claims" && input.bookKind !== "description") return result;
  for (const document of [input.current, input.baseline].filter(
    (value): value is PatentBookDocument => value !== null,
  )) {
    const markers = buildDocumentStructureRulerIndex(document, input.bookKind);
    for (const marker of markers) {
      const start = document.content.findIndex(({ id }) => id === marker.targetBlockId);
      const end = document.content.findIndex(({ id }) => id === marker.endBlockId);
      for (let index = start; index <= Math.max(start, end); index += 1) {
        const id = document.content[index]?.id;
        if (id && !result.has(id))
          addLocationForDescendants(document.content[index]!, marker.label, result);
      }
    }
    let nearestLabel: string | null = null;
    for (const block of document.content) {
      nearestLabel = result.get(block.id) ?? nearestLabel;
      if (nearestLabel) addLocationForDescendants(block, nearestLabel, result);
    }
  }
  return result;
}

function fallbackLocation(document: PatentBookDocument, id: string): string | null {
  const text =
    document.content
      .map((block) => descendantLocationText(block, id))
      .find((value) => value !== null) ?? "";
  return text ? segmentGraphemes(text.trim()).slice(0, 24).join("") : null;
}

function addLocationForDescendants(
  value: unknown,
  label: string,
  locations: Map<string, string>,
): void {
  if (!value || typeof value !== "object") return;
  const item = record(value as object);
  if (typeof item.id === "string" && !locations.has(item.id)) locations.set(item.id, label);
  for (const child of Object.values(item)) {
    if (Array.isArray(child))
      for (const entry of child) addLocationForDescendants(entry, label, locations);
  }
}

function descendantLocationText(block: BlockNode, id: string): string | null {
  if (block.id === id) return blockVisibleText(block) || firstDescendantParagraphText(block);
  if (block.type === "bullet-list" || block.type === "ordered-list") {
    for (const item of block.items) {
      if (item.id === id) return firstParagraphText(item.content);
      for (const paragraph of item.content)
        if (paragraph.id === id) return blockVisibleText(paragraph);
    }
  }
  if (block.type === "table") {
    for (const row of block.rows) {
      if (row.id === id)
        return row.cells.map((cell) => firstParagraphText(cell.content)).find(Boolean) ?? "";
      for (const cell of row.cells) {
        if (cell.id === id) return firstParagraphText(cell.content);
        for (const paragraph of cell.content)
          if (paragraph.id === id) return blockVisibleText(paragraph);
      }
    }
  }
  return null;
}

function firstDescendantParagraphText(block: BlockNode): string {
  if (block.type === "bullet-list" || block.type === "ordered-list")
    return block.items.map((item) => firstParagraphText(item.content)).find(Boolean) ?? "";
  if (block.type === "table")
    return (
      block.rows
        .flatMap((row) => row.cells)
        .map((cell) => firstParagraphText(cell.content))
        .find(Boolean) ?? ""
    );
  return "";
}

function firstParagraphText(
  paragraphs: readonly Extract<BlockNode, { type: "paragraph" }>[],
): string {
  return paragraphs.map(blockVisibleText).find(Boolean) ?? "";
}

function blockVisibleText(block: BlockNode | undefined): string {
  if (!block) return "";
  if (block.type === "paragraph" || block.type === "heading")
    return block.content
      .map((node) =>
        node.type === "text" ? node.text : node.type === "inline-formula" ? node.source : "\n",
      )
      .join("");
  return "";
}

function paragraphDetails(
  before: Extract<BlockNode, { type: "paragraph" | "heading" }>,
  after: Extract<BlockNode, { type: "paragraph" | "heading" }>,
): string[] {
  const details = objectDetails(before.attrs, after.attrs, [
    ["alignment", "段落对齐"],
    ["paragraphIndentMm", "段落缩进"],
    ["lineSpacing", "行距"],
    ["spaceBeforePt", "段前间距", 0],
    ["spaceAfterPt", "段后间距", 0],
    ["defaultFontFamily", "默认字体"],
    ["defaultFontSizePt", "默认字号"],
  ]);
  if (before.type === "heading" && after.type === "heading" && before.level !== after.level)
    details.push(`标题级别：${before.level} → ${after.level}`);
  if (before.semanticRole !== after.semanticRole)
    details.push(`语义角色：${before.semanticRole ?? "无"} → ${after.semanticRole ?? "无"}`);
  if (
    before.type === "paragraph" &&
    after.type === "paragraph" &&
    before.figureId !== after.figureId
  )
    details.push(`附图关联：${before.figureId ?? "无"} → ${after.figureId ?? "无"}`);
  return details;
}

function markDetails(before: readonly TextMark[], after: readonly TextMark[]): string[] {
  const oldMarks = new Map<string, TextMark>(before.map((mark) => [mark.type, mark]));
  const newMarks = new Map<string, TextMark>(after.map((mark) => [mark.type, mark]));
  const order = [
    "bold",
    "italic",
    "underline",
    "claim-reference-review",
    "superscript",
    "subscript",
    "font-family",
    "font-size",
    "color",
    "background-color",
  ];
  return order.flatMap((type) => {
    const oldMark = oldMarks.get(type);
    const newMark = newMarks.get(type);
    if (sameValue(oldMark, newMark)) return [];
    const label: Record<string, string> = {
      bold: "加粗",
      italic: "斜体",
      underline: "下划线",
      "claim-reference-review": "引用审查标记",
      superscript: "上标",
      subscript: "下标",
      "font-family": "字体",
      "font-size": "字号",
      color: "字体颜色",
      "background-color": "突出显示",
    };
    return [`${label[type]}：${markValue(oldMark)} → ${markValue(newMark)}`];
  });
}

function markValue(mark: TextMark | undefined): string {
  if (!mark) return "无";
  if ("value" in mark) return mark.value;
  if ("valuePt" in mark) return String(mark.valuePt);
  return "有";
}

function objectDetails(
  before: object,
  after: object,
  fields: readonly (readonly [string, string, unknown?])[],
): string[] {
  const oldRecord = record(before),
    newRecord = record(after);
  return fields.flatMap(([key, label, defaultValue]) =>
    sameValue(oldRecord[key] ?? defaultValue, newRecord[key] ?? defaultValue)
      ? []
      : [
          `${label}：${displayValue(key, oldRecord[key] ?? defaultValue)} → ${displayValue(key, newRecord[key] ?? defaultValue)}`,
        ],
  );
}

function valueDetail(key: string, before: unknown, after: unknown): string[] {
  return sameValue(before, after)
    ? []
    : [
        `${key === "widthMm" ? "宽度" : "对齐"}：${displayValue(key, before)} → ${displayValue(key, after)}`,
      ];
}

function displayValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "无";
  const alignments: Record<string, string> = {
    left: "左对齐",
    center: "居中",
    right: "右对齐",
    justify: "两端对齐",
    top: "顶部",
    middle: "居中",
    bottom: "底部",
  };
  if ((key.toLowerCase().includes("alignment") || key === "alignment") && typeof value === "string")
    return alignments[value] ?? value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function canonicalMarksKey(marks: readonly TextMark[]): string {
  return JSON.stringify([...marks].sort((left, right) => left.type.localeCompare(right.type)));
}
function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function summary(kind: SnapshotChangeKind, nodeType: string | null): string {
  const labels: Record<string, string> = {
    paragraph: "段落",
    heading: "标题",
    text: "文字",
    figure: "图片",
    table: "表格",
    "bullet-list": "列表",
    "ordered-list": "列表",
    "list-item": "列表项",
    "table-row": "表格行",
    "table-cell": "单元格",
    "block-formula": "公式",
    "chemical-structure": "化学结构式",
    "page-settings": "页面设置",
  };
  const action =
    kind === "insert"
      ? "新增"
      : kind === "delete"
        ? "删除"
        : kind === "format"
          ? "格式变化"
          : "结构变化";
  const target = nodeType ? (labels[nodeType] ?? "内容") : "";
  return kind === "insert" || kind === "delete" ? `${action}${target}` : `${target}${action}`;
}

function findJsonById(root: JSONContent, id: string): JSONContent | undefined {
  if (root.attrs?.nodeId === id) return root;
  return root.content?.map((child) => findJsonById(child, id)).find(Boolean);
}

function listItemJson(
  list: Extract<BlockNode, { type: "bullet-list" | "ordered-list" }>,
  id: string,
): JSONContent {
  const item = canonicalNode(list).content?.find((node) => node.attrs?.nodeId === id);
  if (!item) throw new Error(`Snapshot list item missing: ${id}`);
  return item;
}

function mergeAdjacentText(nodes: readonly JSONContent[]): JSONContent[] {
  const result: JSONContent[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (node.type === "text" && previous?.type === "text" && sameValue(node.marks, previous.marks))
      previous.text = `${previous.text ?? ""}${node.text ?? ""}`;
    else result.push(node);
  }
  return result;
}
