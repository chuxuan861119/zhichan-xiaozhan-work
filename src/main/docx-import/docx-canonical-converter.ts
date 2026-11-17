import {
  createBlankBookDocument,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../shared/document/defaults.js";
import type {
  BlockNode,
  InlineNode,
  ParagraphAttributes,
  ParagraphNode,
  PatentBookDocument,
  TableCell,
  TextMark,
} from "../../shared/document/model.js";
import { inferFormulaKind } from "../../shared/document/omml-to-latex.js";
import { randomUuid } from "../../shared/id.js";
import {
  PATENT_BODY_PARAGRAPH_ATTRIBUTES,
  PATENT_HEADING_ATTRIBUTES,
  PATENT_TITLE_ATTRIBUTES,
} from "../../shared/patent/formatting.js";
import type { PatentBookKind } from "../../shared/patent/model.js";
import type {
  ParsedWordDocument,
  WordBlock,
  WordInline,
  WordParagraphBlock,
  WordRunStyle,
  WordTableBlock,
} from "./wordprocessingml-parser.js";

export type DocxConversionMode = "formal-book" | "auxiliary";

export type ResolvedDocxImage = Readonly<{
  assetId: string;
  widthMm?: number;
}>;

export type DocxCanonicalConversion = Readonly<{
  document: PatentBookDocument;
  warnings: ParsedWordDocument["warnings"];
}>;

type FormalParagraphRole = "body" | "heading" | "title";

type ConversionOptions = Readonly<{
  title: string;
  mode: DocxConversionMode;
  bookKind?: PatentBookKind;
  resolveImage?(relationshipId: string, partName: string | null): ResolvedDocxImage | null;
}>;

export function convertParsedWordDocument(
  parsed: ParsedWordDocument,
  options: ConversionOptions,
): DocxCanonicalConversion {
  const blocks =
    options.mode === "formal-book" ? normalizeFormalWordBlocks(parsed.blocks) : parsed.blocks;
  const content: BlockNode[] = [];
  const descriptionTitleIndex = findDescriptionTitleIndex({ ...parsed, blocks }, options);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.type === "table") {
      content.push(convertTable(block, options));
      continue;
    }
    if (block.list) {
      const list = block.list;
      const grouped: [WordParagraphBlock, ...WordParagraphBlock[]][] = [[block]];
      while (index + 1 < blocks.length) {
        const next = blocks[index + 1];
        if (next?.type === "paragraph" && !next.list && next.listContinuation) {
          grouped.at(-1)?.push(next);
          index += 1;
          continue;
        }
        if (
          next?.type !== "paragraph" ||
          next.list?.kind !== list.kind ||
          next.list.level !== list.level ||
          next.list.id !== list.id ||
          (next.list.ordinal !== undefined &&
            next.list.ordinal !== (list.ordinal ?? list.start) + grouped.length) ||
          (next.list.ordinal === undefined && next.list.start !== list.start)
        ) {
          break;
        }
        grouped.push([next]);
        index += 1;
      }
      if (
        options.mode === "formal-book" &&
        options.bookKind === "claims" &&
        list.kind === "ordered"
      ) {
        content.push(
          ...grouped.flatMap(([paragraph, ...continuations], itemIndex) => [
            numberedClaimParagraph(
              paragraph,
              paragraph.list?.ordinal ?? list.start + itemIndex,
              options.resolveImage,
            ),
            ...continuations.map((continuation) =>
              plainParagraphNode(continuation, options.mode, options.resolveImage),
            ),
          ]),
        );
        continue;
      }
      const items = grouped.map((paragraphs) => ({
        id: randomUuid(),
        content: paragraphs.map((paragraph) =>
          plainParagraphNode(paragraph, options.mode, options.resolveImage),
        ),
      }));
      content.push(
        list.kind === "ordered"
          ? {
              id: randomUuid(),
              type: "ordered-list",
              start: Math.min(1_000_000, list.ordinal ?? list.start),
              items,
            }
          : { id: randomUuid(), type: "bullet-list", items },
      );
      continue;
    }
    content.push(
      ...convertParagraphBlocks(
        block,
        options,
        formalParagraphRole(block, index, options, descriptionTitleIndex),
      ),
    );
  }
  const base = createBlankBookDocument(options.title);
  return {
    document: {
      ...base,
      content: options.mode === "formal-book" ? normalizeFormalContent(content) : content,
    },
    warnings: parsed.warnings,
  };
}

function convertParagraphBlocks(
  paragraph: WordParagraphBlock,
  options: ConversionOptions,
  formalRole: FormalParagraphRole,
): BlockNode[] {
  const blocks: BlockNode[] = [];
  let inlines: InlineNode[] = [];
  const flush = () => {
    if (inlines.length === 0 && blocks.length > 0) return;
    const base = paragraphNode({ ...paragraph, inlines: [] }, options.mode, true, formalRole);
    blocks.push({ ...base, content: inlines });
    inlines = [];
  };
  for (const inline of paragraph.inlines) {
    if (inline.type === "image") {
      flush();
      const resolved = options.resolveImage?.(inline.relationshipId, inline.partName) ?? null;
      if (resolved) {
        const measured = inline.widthEmu ? inline.widthEmu / 36000 : (resolved.widthMm ?? 80);
        blocks.push({
          id: randomUuid(),
          type: "figure",
          assetId: resolved.assetId,
          widthMm: Math.max(10, Math.min(165, measured)),
          alignment:
            paragraph.alignment === "right"
              ? "right"
              : paragraph.alignment === "center"
                ? "center"
                : "left",
        });
      } else {
        blocks.push(placeholderParagraph("[未导入：图片]", options.mode));
      }
    } else if (inline.type === "page-break") {
      flush();
      if (options.mode === "auxiliary") {
        blocks.push({ id: randomUuid(), type: "page-break" });
      }
    } else {
      inlines.push(...convertInline(inline, options.mode));
    }
  }
  if (inlines.length > 0 || blocks.length === 0) flush();
  return blocks;
}

function paragraphNode(
  paragraph: WordParagraphBlock,
  mode: DocxConversionMode,
  preserveHeading: boolean,
  formalRole: FormalParagraphRole = "body",
): ParagraphNode | Extract<BlockNode, { type: "heading" }> {
  const content = paragraph.inlines.flatMap((inline) => convertInline(inline, mode));
  const heading =
    preserveHeading && formalRole !== "title"
      ? formalRole === "heading"
        ? (paragraph.headingLevel ?? 1)
        : paragraph.headingLevel
      : null;
  if (heading) {
    return {
      id: randomUuid(),
      type: "heading",
      level: heading,
      attrs: paragraphAttributes(paragraph, mode, true),
      content,
    };
  }
  return {
    id: randomUuid(),
    type: "paragraph",
    ...(formalRole === "title" ? { semanticRole: "invention-title" as const } : {}),
    attrs:
      mode === "formal-book" && formalRole === "title"
        ? { ...PATENT_TITLE_ATTRIBUTES }
        : paragraphAttributes(paragraph, mode, false),
    content,
  };
}

function findDescriptionTitleIndex(
  parsed: ParsedWordDocument,
  options: ConversionOptions,
): number | null {
  if (options.mode !== "formal-book" || options.bookKind !== "description") return null;
  const paragraphs = parsed.blocks
    .map((block, index) => ({ block, index }))
    .filter(
      (entry): entry is { block: WordParagraphBlock; index: number } =>
        entry.block.type === "paragraph" && paragraphText(entry.block).length > 0,
    );
  const candidate = paragraphs[0];
  if (!candidate || isDescriptionChapterHeading(candidate.block)) return null;
  const following = paragraphs[1]?.block;
  return candidate.block.alignment === "center" ||
    (following && isDescriptionChapterHeading(following))
    ? candidate.index
    : null;
}

function formalParagraphRole(
  paragraph: WordParagraphBlock,
  blockIndex: number,
  options: ConversionOptions,
  descriptionTitleIndex: number | null,
): FormalParagraphRole {
  if (options.mode !== "formal-book") return "body";
  if (blockIndex === descriptionTitleIndex) return "title";
  if (
    options.bookKind === "description" &&
    (paragraph.headingLevel !== null || isDescriptionChapterHeading(paragraph))
  ) {
    return "heading";
  }
  return "body";
}

function isDescriptionChapterHeading(paragraph: WordParagraphBlock): boolean {
  return new Set([
    "技术领域",
    "背景技术",
    "发明内容",
    "实用新型内容",
    "有益效果",
    "附图说明",
    "具体实施方式",
  ]).has(paragraphText(paragraph).replace(/[\s　]/gu, ""));
}

function paragraphText(paragraph: WordParagraphBlock): string {
  return paragraph.inlines
    .filter((inline) => inline.type === "text")
    .map((inline) => inline.text)
    .join("")
    .trim();
}

function plainParagraphNode(
  paragraph: WordParagraphBlock,
  mode: DocxConversionMode,
  resolveImage?: ConversionOptions["resolveImage"],
): ParagraphNode {
  return {
    id: randomUuid(),
    type: "paragraph",
    attrs: paragraphAttributes(paragraph, mode, false),
    content: paragraph.inlines.flatMap((inline) => convertInline(inline, mode, resolveImage)),
  };
}

function numberedClaimParagraph(
  paragraph: WordParagraphBlock,
  number: number,
  resolveImage?: ConversionOptions["resolveImage"],
): ParagraphNode {
  const node = plainParagraphNode(paragraph, "formal-book", resolveImage);
  const text = node.content
    .filter((inline): inline is Extract<InlineNode, { type: "text" }> => inline.type === "text")
    .map((inline) => inline.text)
    .join("");
  if (/^\s*\d+[.．、]\s*/u.test(text)) return node;
  const firstTextIndex = node.content.findIndex((inline) => inline.type === "text");
  const prefix = `${number}. `;
  if (firstTextIndex < 0) {
    return { ...node, content: [{ type: "text", text: prefix, marks: [] }, ...node.content] };
  }
  return {
    ...node,
    content: node.content.map((inline, index) =>
      index === firstTextIndex && inline.type === "text"
        ? { ...inline, text: `${prefix}${inline.text}` }
        : inline,
    ),
  };
}

function normalizeFormalWordBlocks(blocks: readonly WordBlock[]): WordBlock[] {
  return blocks.map((block) =>
    block.type === "paragraph" ? normalizeFormalParagraph(block) : block,
  );
}

function normalizeFormalParagraph(paragraph: WordParagraphBlock): WordParagraphBlock {
  const inlines = paragraph.inlines.map((inline) =>
    inline.type === "text"
      ? { ...inline, text: inline.text.replace(/\u00A0/gu, " ").replace(/\t+/gu, " ") }
      : inline,
  );
  let beforeVisibleContent = true;
  const withoutLeadingLayoutWhitespace = inlines.map((inline) => {
    if (inline.type === "page-break") {
      beforeVisibleContent = true;
      return inline;
    }
    if (!beforeVisibleContent) return inline;
    if (inline.type === "text") {
      const text = inline.text.replace(/^[ \u3000]+/gu, "");
      if (text.length > 0) beforeVisibleContent = false;
      return { ...inline, text };
    }
    beforeVisibleContent = false;
    return inline;
  });
  let afterVisibleContent = true;
  const normalized = [...withoutLeadingLayoutWhitespace]
    .reverse()
    .map((inline) => {
      if (inline.type === "page-break") {
        afterVisibleContent = true;
        return inline;
      }
      if (!afterVisibleContent) return inline;
      if (inline.type === "text") {
        const text = inline.text.replace(/[ \u3000]+$/gu, "");
        if (text.length > 0) afterVisibleContent = false;
        return { ...inline, text };
      }
      afterVisibleContent = false;
      return inline;
    })
    .reverse()
    .filter((inline) => inline.type !== "text" || inline.text.length > 0);
  return { ...paragraph, inlines: normalized };
}

function normalizeFormalContent(content: readonly BlockNode[]): BlockNode[] {
  const normalized: BlockNode[] = [];
  for (const block of content) {
    if (emptyParagraph(block) && (normalized.length === 0 || emptyParagraph(normalized.at(-1)))) {
      continue;
    }
    normalized.push(block);
  }
  while (normalized.length > 0 && emptyParagraph(normalized.at(-1))) normalized.pop();
  return normalized;
}

function emptyParagraph(block: BlockNode | undefined): boolean {
  return (
    block?.type === "paragraph" &&
    block.content.every(
      (inline) =>
        inline.type === "hard-break" || (inline.type === "text" && inline.text.trim() === ""),
    )
  );
}

function paragraphAttributes(
  paragraph: WordParagraphBlock,
  mode: DocxConversionMode,
  heading: boolean,
): ParagraphAttributes {
  if (mode === "formal-book") {
    return { ...(heading ? PATENT_HEADING_ATTRIBUTES : PATENT_BODY_PARAGRAPH_ATTRIBUTES) };
  }
  return {
    ...DEFAULT_PARAGRAPH_ATTRIBUTES,
    alignment: paragraph.alignment,
    paragraphIndentMm: Math.max(0, Math.min(80, paragraph.firstLineIndentMm ?? 0)),
    lineSpacing: paragraph.lineSpacing ?? DEFAULT_PARAGRAPH_ATTRIBUTES.lineSpacing,
    ...(paragraph.spaceBeforePt !== undefined ? { spaceBeforePt: paragraph.spaceBeforePt } : {}),
    ...(paragraph.spaceAfterPt !== undefined ? { spaceAfterPt: paragraph.spaceAfterPt } : {}),
  };
}

function convertInline(
  inline: WordInline,
  mode: DocxConversionMode,
  resolveImage?: ConversionOptions["resolveImage"],
): InlineNode[] {
  if (inline.type === "text") {
    return [{ type: "text", text: inline.text, marks: marksForStyle(inline.style, mode) }];
  }
  if (inline.type === "break") return [{ type: "hard-break" }];
  if (inline.type === "formula") {
    return [
      {
        type: "inline-formula",
        source: inline.latex,
        formulaKind: inferFormulaKind(inline.latex),
      },
    ];
  }
  if (inline.type === "unsupported") {
    return [{ type: "text", text: `[未导入：${inline.label}]`, marks: [] }];
  }
  if (inline.type === "image") {
    const resolved = resolveImage?.(inline.relationshipId, inline.partName);
    if (resolved) {
      const measured = inline.widthEmu ? inline.widthEmu / 36000 : (resolved.widthMm ?? 80);
      return [
        {
          id: randomUuid(),
          type: "inline-figure",
          assetId: resolved.assetId,
          widthMm: Math.max(10, Math.min(165, measured)),
          alignment: "left",
          rotationDeg: 0,
        },
      ];
    }
    return [{ type: "text", text: "[未导入：图片]", marks: [] }];
  }
  return [];
}

function marksForStyle(style: WordRunStyle, mode: DocxConversionMode): TextMark[] {
  const marks: TextMark[] = [];
  if (style.bold) marks.push({ type: "bold" });
  if (style.italic) marks.push({ type: "italic" });
  if (style.underline) marks.push({ type: "underline" });
  if (style.verticalAlign === "superscript") marks.push({ type: "superscript" });
  if (style.verticalAlign === "subscript") marks.push({ type: "subscript" });
  if (mode === "auxiliary") {
    if (style.fontFamily) marks.push({ type: "font-family", value: style.fontFamily });
    if (style.fontSizePt) marks.push({ type: "font-size", valuePt: style.fontSizePt });
    if (style.color) marks.push({ type: "color", value: style.color });
    if (style.backgroundColor) {
      marks.push({ type: "background-color", value: style.backgroundColor });
    }
  }
  return marks;
}

function convertTable(
  table: WordTableBlock,
  options: ConversionOptions,
): Extract<BlockNode, { type: "table" }> {
  const mode = options.mode;
  const columns = Math.max(
    1,
    table.columnWidthsTwips.length,
    ...table.rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.colSpan, 0)),
  );
  const sourceWidths =
    table.columnWidthsTwips.length > 0 ? table.columnWidthsTwips : Array(columns).fill(2400);
  const totalWidth = sourceWidths.reduce((sum, width) => sum + width, 0) || columns;
  const scale = table.widthTwips ? table.widthTwips / totalWidth : 1;
  const columnWidthsMm = sourceWidths.map((width) =>
    Math.min(500, Math.max(0.1, (width * scale * 25.4) / 1440)),
  );
  const activeVerticalMerges = new Map<number, TableCell>();
  const rows = table.rows.map((row) => {
    let column = 0;
    let coveredColumns = 0;
    const cells: TableCell[] = [];
    for (const sourceCell of row.cells) {
      if (sourceCell.verticalMerge === "continue") {
        const active = activeVerticalMerges.get(column);
        if (active) {
          active.rowSpan += 1;
          coveredColumns += sourceCell.colSpan;
        }
        column += sourceCell.colSpan;
        continue;
      }
      const cell: TableCell = {
        id: randomUuid(),
        rowSpan: 1,
        colSpan: sourceCell.colSpan,
        horizontalAlignment:
          sourceCell.paragraphs[0]?.alignment === "center"
            ? "center"
            : sourceCell.paragraphs[0]?.alignment === "right"
              ? "right"
              : "left",
        verticalAlignment: sourceCell.verticalAlignment ?? "top",
        ...(sourceCell.paddingMm ? { paddingMm: sourceCell.paddingMm } : {}),
        borderStyle: sourceCell.borderEdges?.top ?? "single",
        ...(sourceCell.borderEdges ? { borderEdges: sourceCell.borderEdges } : {}),
        content: sourceCell.paragraphs.map((paragraph) => {
          const node = plainParagraphNode(paragraph, mode, options.resolveImage);
          // Table paragraphs are not body paragraphs: keep supported source geometry.
          node.attrs = {
            ...node.attrs,
            alignment: paragraph.alignment,
            paragraphIndentMm: Math.max(0, Math.min(80, paragraph.firstLineIndentMm ?? 0)),
            lineSpacing: paragraph.lineSpacing ?? 1,
            spaceBeforePt: paragraph.spaceBeforePt ?? 0,
            spaceAfterPt: paragraph.spaceAfterPt ?? 0,
          };
          return node;
        }),
      };
      cells.push(cell);
      if (sourceCell.verticalMerge === "restart") activeVerticalMerges.set(column, cell);
      else activeVerticalMerges.delete(column);
      column += sourceCell.colSpan;
    }
    if (cells.length === 0 && coveredColumns !== columns) {
      cells.push({
        id: randomUuid(),
        rowSpan: 1,
        colSpan: columns,
        horizontalAlignment: "left",
        verticalAlignment: "top",
        borderStyle: "single",
        content: [placeholderParagraph("", mode)],
      });
    }
    return {
      id: randomUuid(),
      cells,
      ...(row.rowHeightMm !== undefined && row.rowHeightRule
        ? { rowHeightMm: row.rowHeightMm, rowHeightRule: row.rowHeightRule }
        : {}),
    };
  });
  return {
    id: randomUuid(),
    type: "table",
    columnWidthsMm,
    layoutMode: table.layoutMode ?? "fit-page",
    headerRowCount: table.rows[0]?.header ? 1 : 0,
    rows,
  };
}

function placeholderParagraph(text: string, mode: DocxConversionMode): ParagraphNode {
  return {
    id: randomUuid(),
    type: "paragraph",
    attrs:
      mode === "formal-book"
        ? { ...PATENT_BODY_PARAGRAPH_ATTRIBUTES }
        : { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: text ? [{ type: "text", text, marks: [] }] : [],
  };
}
