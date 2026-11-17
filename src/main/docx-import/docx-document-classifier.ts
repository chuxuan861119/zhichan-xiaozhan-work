import { basename, extname } from "node:path";
import { randomUuid } from "../../shared/id.js";
import type { PatentBookKind } from "../../shared/patent/model.js";
import type {
  ParsedWordDocument,
  WordBlock,
  WordParagraphBlock,
} from "./wordprocessingml-parser.js";

export type DocxClassificationTarget =
  | Readonly<{ kind: "official-book"; bookKind: PatentBookKind }>
  | Readonly<{ kind: "unrecognized" }>;

export type ClassifiedDocxUnit = Readonly<{
  unitId: string;
  sourceFileName: string;
  title: string;
  blocks: readonly WordBlock[];
  suggestedTarget: DocxClassificationTarget;
  recognizedBookKind?: PatentBookKind;
  confidence: "high" | "medium" | "low";
  evidence: readonly string[];
}>;

export type DocxClassificationConflict = Readonly<{
  bookKind: PatentBookKind;
  unitIds: readonly string[];
}>;

export type DocxClassificationResult = Readonly<{
  units: readonly ClassifiedDocxUnit[];
  conflicts: readonly DocxClassificationConflict[];
}>;

type SourceDocument = Readonly<{
  sourceFileName: string;
  document: ParsedWordDocument;
}>;

const HEADING_TARGETS: Readonly<Record<string, PatentBookKind>> = {
  权利要求: "claims",
  权利要求书: "claims",
  说明书: "description",
  说明书附图: "description-drawings",
  附图: "description-drawings",
  摘要: "abstract",
  说明书摘要: "abstract",
  摘要附图: "abstract-drawing",
};

export function classifyDocxDocuments(
  sources: readonly SourceDocument[],
): DocxClassificationResult {
  const units = sources.flatMap((source) => classifySource(source));
  const byBook = new Map<PatentBookKind, string[]>();
  for (const unit of units) {
    if (unit.suggestedTarget.kind !== "official-book") continue;
    const ids = byBook.get(unit.suggestedTarget.bookKind) ?? [];
    ids.push(unit.unitId);
    byBook.set(unit.suggestedTarget.bookKind, ids);
  }
  const conflicts = [...byBook.entries()]
    .filter(([, unitIds]) => unitIds.length > 1)
    .map(([bookKind, unitIds]) => ({ bookKind, unitIds }));
  return { units, conflicts };
}

function classifySource(source: SourceDocument): ClassifiedDocxUnit[] {
  const sectionUnits = classifySections(source);
  if (sectionUnits.length > 0) return sectionUnits;
  const boundaries = headingBoundaries(source.document.blocks);
  if (boundaries.length >= 2) {
    const leading = trimEmptyBlocks(source.document.blocks.slice(0, boundaries[0]?.index));
    return [
      ...(leading.length
        ? [unrecognizedUnit(source.sourceFileName, leading, "五书标题前存在无法识别的内容")]
        : []),
      ...boundaries.map((boundary, index) => {
        const next = boundaries[index + 1];
        const blocks = source.document.blocks.slice(boundary.index + 1, next?.index);
        return createUnit(source.sourceFileName, blocks, boundary.kind, "high", [
          `检测到独立标题“${headingLabel(boundary.kind)}”`,
        ]);
      }),
    ];
  }
  return [classifySingle(source.sourceFileName, source.document.blocks, boundaries)];
}

function classifySingle(
  sourceFileName: string,
  blocks: readonly WordBlock[],
  boundaries: readonly Readonly<{ index: number; kind: PatentBookKind }>[],
): ClassifiedDocxUnit {
  const distinctHeadings = new Set(boundaries.map((boundary) => boundary.kind));
  if (distinctHeadings.size === 1) {
    const boundary = boundaries[0];
    if (boundary) {
      if (trimEmptyBlocks(blocks.slice(0, boundary.index)).length > 0) {
        return unrecognizedUnit(sourceFileName, blocks, "五书标题前存在无法识别的内容");
      }
      return createUnit(sourceFileName, blocks.slice(boundary.index + 1), boundary.kind, "high", [
        `检测到文档标题“${headingLabel(boundary.kind)}”`,
      ]);
    }
  }
  if (distinctHeadings.size > 1) {
    return unrecognizedUnit(sourceFileName, blocks, "检测到多个相互冲突的文档标题");
  }

  const text = normalizedDocumentText(blocks);
  const imageCount = countImages(blocks);
  const normalizedFileName = normalizeHeading(basename(sourceFileName, extname(sourceFileName)));
  if (imageCount > 0 && normalizedFileName.includes("摘要附图")) {
    return createUnit(sourceFileName, blocks, "abstract-drawing", "high", [
      "文件名指向摘要附图且正文包含图片",
    ]);
  }
  if (imageCount > 0 && normalizedFileName.includes("说明书附图")) {
    return createUnit(sourceFileName, blocks, "description-drawings", "high", [
      "文件名指向说明书附图且正文包含图片",
    ]);
  }
  if (imageCount > 0 && drawingLabelOnlyText(blocks)) {
    return createUnit(sourceFileName, blocks, "description-drawings", "medium", [
      "正文主要由图片和附图编号组成",
    ]);
  }
  if (/^(?:1[.、．]|一、).{0,80}(?:一种|一项|一种方法|一种装置)/u.test(text)) {
    return createUnit(sourceFileName, blocks, "claims", "medium", [
      "正文以权利要求编号和保护主题开头",
    ]);
  }
  const descriptionSignals = [
    "技术领域",
    "背景技术",
    "发明内容",
    "实用新型内容",
    "具体实施方式",
  ].filter((signal) => text.includes(signal));
  if (descriptionSignals.length >= 2) {
    return createUnit(sourceFileName, blocks, "description", "medium", [
      `检测到说明书章节：${descriptionSignals.join("、")}`,
    ]);
  }
  if (
    normalizedFileName.includes("摘要") &&
    text.length <= 2_000 &&
    /(?:本发明|本实用新型).{0,80}(?:公开|涉及|提供)/u.test(text)
  ) {
    return createUnit(sourceFileName, blocks, "abstract", "medium", [
      "检测到摘要常用表述且篇幅较短",
    ]);
  }
  return unrecognizedUnit(sourceFileName, blocks, "未检测到足以确定五书类型的内容特征");
}

function classifySections(source: SourceDocument): ClassifiedDocxUnit[] {
  const sections = source.document.sections ?? [];
  if (!sections.some((section) => sectionKind(section.headerText) !== null)) return [];
  const grouped: Array<{
    kind: PatentBookKind | null;
    headerText: string | null;
    blocks: WordBlock[];
  }> = [];
  for (const section of sections) {
    const blocks = trimEmptyBlocks(
      source.document.blocks.slice(section.startBlockIndex, section.endBlockIndex),
    );
    if (blocks.length === 0) continue;
    const kind = sectionKind(section.headerText);
    const previous = grouped.at(-1);
    if (previous && previous.kind === kind && previous.headerText === section.headerText) {
      previous.blocks.push(...blocks);
    } else {
      grouped.push({ kind, headerText: section.headerText, blocks: [...blocks] });
    }
  }
  return grouped.flatMap((section) => {
    // A shared page header is not a book boundary when the body names multiple books.
    const bodyKinds = new Set(headingBoundaries(section.blocks).map((boundary) => boundary.kind));
    if (bodyKinds.size > 1) {
      return classifySource({
        sourceFileName: source.sourceFileName,
        document: { blocks: section.blocks, warnings: [] },
      });
    }
    return [
      section.kind
        ? createUnit(source.sourceFileName, section.blocks, section.kind, "high", [
            `根据 Word 分节页眉识别为“${headingLabel(section.kind)}”`,
          ])
        : unrecognizedUnit(
            source.sourceFileName,
            section.blocks,
            section.headerText
              ? `Word 分节页眉“${section.headerText}”无法对应到五书`
              : "Word 分节未提供可识别的五书页眉",
          ),
    ];
  });
}

function sectionKind(headerText: string | null): PatentBookKind | null {
  if (!headerText) return null;
  return HEADING_TARGETS[normalizeHeading(headerText)] ?? null;
}

function trimEmptyBlocks(blocks: readonly WordBlock[]): WordBlock[] {
  let start = 0;
  let end = blocks.length;
  while (start < end && blockIsEmpty(blocks[start])) start += 1;
  while (end > start && blockIsEmpty(blocks[end - 1])) end -= 1;
  return blocks.slice(start, end);
}

function blockIsEmpty(block: WordBlock | undefined): boolean {
  return (
    block?.type === "paragraph" &&
    block.inlines.every(
      (inline) =>
        inline.type === "break" ||
        inline.type === "page-break" ||
        (inline.type === "text" && inline.text.trim().length === 0),
    )
  );
}

function countImages(blocks: readonly WordBlock[]): number {
  return blocks.reduce((total, block) => {
    const paragraphs =
      block.type === "paragraph"
        ? [block]
        : block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs));
    return (
      total +
      paragraphs.reduce(
        (paragraphTotal, paragraph) =>
          paragraphTotal + paragraph.inlines.filter((inline) => inline.type === "image").length,
        0,
      )
    );
  }, 0);
}

function drawingLabelOnlyText(blocks: readonly WordBlock[]): boolean {
  const lines = normalizedDocumentText(blocks)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) =>
      /^(?:附图)?图\s*[一二三四五六七八九十百千\d]+(?:\s*[：:].*)?$/u.test(line),
    )
  );
}

function createUnit(
  sourceFileName: string,
  blocks: readonly WordBlock[],
  kind: PatentBookKind,
  confidence: "high" | "medium",
  evidence: readonly string[],
): ClassifiedDocxUnit {
  if (kind === "abstract-drawing") {
    return {
      unitId: randomUuid(),
      sourceFileName,
      title: "摘要附图（待选择）",
      blocks,
      suggestedTarget: { kind: "official-book", bookKind: "abstract-drawing" },
      recognizedBookKind: "abstract-drawing",
      confidence,
      evidence: [...evidence, "用于匹配说明书附图，无法匹配时请在软件内选择"],
    };
  }
  return {
    unitId: randomUuid(),
    sourceFileName,
    title: headingLabel(kind),
    blocks,
    suggestedTarget: { kind: "official-book", bookKind: kind },
    confidence,
    evidence,
  };
}

function unrecognizedUnit(
  sourceFileName: string,
  blocks: readonly WordBlock[],
  reason: string,
): ClassifiedDocxUnit {
  const extension = extname(sourceFileName);
  const title = basename(sourceFileName, extension).trim() || "无法识别的文档";
  return {
    unitId: randomUuid(),
    sourceFileName,
    title,
    blocks,
    suggestedTarget: { kind: "unrecognized" },
    confidence: "low",
    evidence: [reason],
  };
}

function headingBoundaries(
  blocks: readonly WordBlock[],
): ReadonlyArray<Readonly<{ index: number; kind: PatentBookKind }>> {
  const boundaries: Array<Readonly<{ index: number; kind: PatentBookKind }>> = [];
  blocks.forEach((block, index) => {
    if (block.type !== "paragraph") return;
    const text = normalizeHeading(paragraphText(block));
    const kind = HEADING_TARGETS[text];
    if (kind) boundaries.push({ index, kind });
  });
  return boundaries;
}

function normalizedDocumentText(blocks: readonly WordBlock[]): string {
  return blocks
    .flatMap((block) =>
      block.type === "paragraph"
        ? [paragraphText(block)]
        : block.rows.flatMap((row) =>
            row.cells.flatMap((cell) => cell.paragraphs.map(paragraphText)),
          ),
    )
    .join("\n")
    .trim();
}

function paragraphText(paragraph: WordParagraphBlock): string {
  return paragraph.inlines
    .filter((inline) => inline.type === "text")
    .map((inline) => inline.text)
    .join("")
    .trim();
}

function normalizeHeading(value: string): string {
  return value.replace(/[\s　:：·•—_-]/gu, "").replace(/[（）()]/gu, "");
}

function headingLabel(kind: PatentBookKind): string {
  if (kind === "claims") return "权利要求书";
  if (kind === "description") return "说明书";
  if (kind === "description-drawings") return "说明书附图";
  if (kind === "abstract") return "说明书摘要";
  return "摘要附图";
}
