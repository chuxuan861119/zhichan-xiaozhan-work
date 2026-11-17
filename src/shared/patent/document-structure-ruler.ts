import type { BlockNode, InlineNode, PatentBookDocument } from "../document/model.js";
import { claimStructureWarnings, parseClaimParagraphs } from "./claim-text-tools.js";
import {
  classifyDescriptionChapterBlock,
  type DescriptionChapterKind,
  descriptionInventionTitle,
} from "./description.js";
import type { CanonicalPatent } from "./model.js";

export type DocumentStructureRulerMarker = Readonly<{
  id: string;
  kind: "claim" | "description-chapter" | "description-paragraph" | "warning" | "drawing-figure";
  label: string;
  displayLabel?: string;
  compactLabel: string;
  targetBlockId: string;
  endBlockId: string;
  warning: boolean;
  error?: boolean;
  virtual?: boolean;
  virtualPlacement?: "before" | "after";
  issueId?: string;
}>;

export type DocumentStructureIssue = Readonly<{
  id: string;
  kind:
    | "duplicate-claim"
    | "missing-claim"
    | "duplicate-description-chapter"
    | "missing-description-chapter";
  bookKind: "claims" | "description";
  summary: string;
  targetBlockIds: readonly string[];
  anchorBlockId: string;
}>;

export type DocumentStructureRulerModel = Readonly<{
  markers: readonly DocumentStructureRulerMarker[];
  issues: readonly DocumentStructureIssue[];
}>;

const DESCRIPTION_CHAPTER_PRESENTATION: Partial<
  Record<DescriptionChapterKind, Readonly<{ label: string; compactLabel: string }>>
> = {
  "technical-field": { label: "技术领域", compactLabel: "技" },
  "background-art": { label: "背景技术", compactLabel: "背" },
  "invention-content": { label: "发明内容", compactLabel: "发" },
  "beneficial-effects": { label: "有益效果", compactLabel: "效" },
  "drawing-explanation": { label: "附图说明", compactLabel: "图" },
  "detailed-embodiments": { label: "具体实施方式", compactLabel: "实" },
};

const DESCRIPTION_CHAPTER_ORDER = [
  "technical-field",
  "background-art",
  "invention-content",
  "beneficial-effects",
  "drawing-explanation",
  "detailed-embodiments",
] as const satisfies readonly DescriptionChapterKind[];

const REQUIRED_DESCRIPTION_CHAPTERS = new Set<DescriptionChapterKind>([
  "technical-field",
  "background-art",
  "invention-content",
  "drawing-explanation",
  "detailed-embodiments",
]);

function shortDescriptionChapterLabel(label: string): string {
  return label === "具体实施方式" ? "实施方式" : label;
}

export function buildDocumentStructureRulerIndex(
  document: PatentBookDocument,
  bookKind: "claims" | "description",
): readonly DocumentStructureRulerMarker[] {
  return buildDocumentStructureRulerModel(document, bookKind).markers;
}

export function buildDrawingFigureRulerMarkers(
  figures: readonly { figureId: string }[],
): readonly DocumentStructureRulerMarker[] {
  return figures.map((figure, index) => ({
    id: `figure:${figure.figureId}`,
    kind: "drawing-figure",
    label: `图${index + 1}`,
    compactLabel: String(index + 1),
    targetBlockId: figure.figureId,
    endBlockId: figure.figureId,
    warning: false,
  }));
}

export function buildDocumentStructureRulerModel(
  document: PatentBookDocument,
  bookKind: "claims" | "description",
): DocumentStructureRulerModel {
  return bookKind === "claims" ? buildClaimModel(document) : buildDescriptionModel(document);
}

export function collectPatentStructureIssues(
  patent: Pick<CanonicalPatent, "books">,
): readonly DocumentStructureIssue[] {
  return patent.books.flatMap((book) =>
    book.kind === "claims"
      ? buildClaimModel(book.document, false).issues
      : book.kind === "description"
        ? buildDescriptionModel(book.document, false).issues
        : [],
  );
}

function buildClaimModel(
  document: PatentBookDocument,
  includeMarkers = true,
): DocumentStructureRulerModel {
  const paragraphs = document.content.flatMap((block) =>
    block.type === "paragraph" ? [{ block, text: blockText(block) }] : [],
  );
  const structure = parseClaimParagraphs(paragraphs.map((entry) => entry.text));
  const warnings = includeMarkers ? claimStructureWarnings(structure) : [];
  const warningClaimNumbers = new Set(
    warnings.flatMap((warning) => (warning.claimNumber === null ? [] : [warning.claimNumber])),
  );
  const markers: DocumentStructureRulerMarker[] = warnings.flatMap((warning) => {
    if (warning.kind !== "unnumbered-preface") return [];
    const block = paragraphs[warning.paragraphIndex]?.block;
    return block
      ? [
          {
            id: `warning:${block.id}`,
            kind: "warning" as const,
            label: "未识别段落",
            compactLabel: "!",
            targetBlockId: block.id,
            endBlockId: block.id,
            warning: true,
          },
        ]
      : [];
  });

  const claimsByNumber = new Map<number, typeof structure.claims>();
  for (const claim of structure.claims) {
    claimsByNumber.set(claim.number, [...(claimsByNumber.get(claim.number) ?? []), claim]);
  }
  const duplicateNumbers = new Set(
    [...claimsByNumber.entries()].flatMap(([number, claims]) =>
      claims.length > 1 ? [number] : [],
    ),
  );
  const issues: DocumentStructureIssue[] = [];

  for (const claim of structure.claims) {
    if (!includeMarkers) break;
    const start = paragraphs[claim.startParagraphIndex]?.block;
    const end = paragraphs[claim.lastNonEmptyParagraphIndex]?.block ?? start;
    if (!start || !end) continue;
    const duplicate = duplicateNumbers.has(claim.number);
    markers.push({
      id: `claim:${claim.number}:${start.id}`,
      kind: "claim",
      label: duplicate ? `权利要求 ${claim.number} · 重复` : `权利要求 ${claim.number}`,
      compactLabel: `权${claim.number}`,
      targetBlockId: start.id,
      endBlockId: end.id,
      warning: warningClaimNumbers.has(claim.number),
      ...(duplicate
        ? {
            displayLabel: `权${claim.number} 重复`,
            error: true,
            issueId: `duplicate-claim:${claim.number}`,
          }
        : {}),
    });
  }

  for (const number of [...duplicateNumbers].sort((left, right) => left - right)) {
    const claims = claimsByNumber.get(number) ?? [];
    const targetBlockIds = claims.flatMap((claim) => {
      const block = paragraphs[claim.startParagraphIndex]?.block;
      return block ? [block.id] : [];
    });
    const anchorBlockId = targetBlockIds[0];
    if (!anchorBlockId) continue;
    issues.push({
      id: `duplicate-claim:${number}`,
      kind: "duplicate-claim",
      bookKind: "claims",
      summary: `权利要求 ${number} 重复（${targetBlockIds.length} 处）`,
      targetBlockIds,
      anchorBlockId,
    });
  }

  const addMissingRange = (
    start: number,
    end: number,
    anchorBlock: BlockNode | undefined,
    virtualPlacement: "before" | "after" = "before",
  ) => {
    const numberLabel = start === end ? String(start) : `${start}–${end}`;
    const issueId = `missing-claim:${start === end ? start : `${start}-${end}`}`;
    issues.push({
      id: issueId,
      kind: "missing-claim",
      bookKind: "claims",
      summary: `缺少权利要求 ${numberLabel}`,
      targetBlockIds: [],
      anchorBlockId: anchorBlock?.id ?? "",
    });
    if (!includeMarkers || !anchorBlock) return;
    markers.push({
      id: `virtual:${issueId}`,
      kind: "warning",
      label: `缺少权利要求 ${numberLabel}`,
      displayLabel: `缺权${numberLabel}`,
      compactLabel: "!",
      targetBlockId: anchorBlock.id,
      endBlockId: anchorBlock.id,
      warning: false,
      error: true,
      virtual: true,
      virtualPlacement,
      issueId,
    });
  };
  // Work is bounded by actual claims, never by a pasted numeric value.
  // Preserve individual ordinary gaps; large gaps retain their complete range.
  let previous = 0;
  for (const number of [...claimsByNumber.keys()]
    .filter((value) => value > 0)
    .sort((a, b) => a - b)) {
    const claim = claimsByNumber.get(number)?.[0];
    const anchor = claim ? paragraphs[claim.startParagraphIndex]?.block : undefined;
    const start = previous + 1;
    if (number - start > 20) addMissingRange(start, number - 1, anchor);
    else
      for (let missing = start; missing < number; missing += 1)
        addMissingRange(missing, missing, anchor);
    previous = number;
  }
  if (previous === 0) addMissingRange(1, 1, paragraphs[0]?.block, "after");

  return { markers: includeMarkers ? sortMarkers(document, markers) : [], issues };
}

function buildDescriptionModel(
  document: PatentBookDocument,
  includeMarkers = true,
): DocumentStructureRulerModel {
  const markers: DocumentStructureRulerMarker[] = [];
  const issues: DocumentStructureIssue[] = [];
  const chapterBlocks = new Map<DescriptionChapterKind, BlockNode[]>();
  let insideDescriptionBody = false;
  let paragraphNumber = 0;

  const titleBlock = document.content[0];
  if (includeMarkers && titleBlock && descriptionInventionTitle(document)) {
    markers.push({
      id: `title:${titleBlock.id}`,
      kind: "description-chapter",
      label: "专利题目",
      compactLabel: "题",
      targetBlockId: titleBlock.id,
      endBlockId: titleBlock.id,
      warning: false,
    });
  }

  for (const block of document.content) {
    const chapter = classifyDescriptionChapterBlock(block);
    if (chapter) {
      insideDescriptionBody = true;
      const presentation = DESCRIPTION_CHAPTER_PRESENTATION[chapter];
      if (presentation) {
        chapterBlocks.set(chapter, [...(chapterBlocks.get(chapter) ?? []), block]);
        if (!includeMarkers) continue;
        const visibleLabel = blockText(block).trim() || presentation.label;
        markers.push({
          id: `chapter:${chapter}:${block.id}`,
          kind: "description-chapter",
          label: visibleLabel,
          compactLabel: presentation.compactLabel,
          targetBlockId: block.id,
          endBlockId: block.id,
          warning: false,
        });
      }
      continue;
    }
    if (
      !includeMarkers ||
      !insideDescriptionBody ||
      block.type !== "paragraph" ||
      blockText(block).trim().length === 0
    ) {
      continue;
    }
    paragraphNumber += 1;
    markers.push({
      id: `paragraph:${paragraphNumber}:${block.id}`,
      kind: "description-paragraph",
      label: `[${String(paragraphNumber).padStart(4, "0")}]`,
      compactLabel: String(paragraphNumber),
      targetBlockId: block.id,
      endBlockId: block.id,
      warning: false,
    });
  }

  for (const chapter of DESCRIPTION_CHAPTER_ORDER) {
    const presentation = DESCRIPTION_CHAPTER_PRESENTATION[chapter];
    if (!presentation) continue;
    const blocks = chapterBlocks.get(chapter) ?? [];
    if (blocks.length > 1) {
      const issueId = `duplicate-description-chapter:${chapter}`;
      const duplicateIds = new Set(blocks.map((block) => block.id));
      for (let index = 0; index < markers.length; index += 1) {
        const marker = markers[index];
        if (marker?.kind !== "description-chapter" || !duplicateIds.has(marker.targetBlockId))
          continue;
        markers[index] = {
          ...marker,
          label: `${presentation.label} · 重复`,
          displayLabel: `${shortDescriptionChapterLabel(presentation.label)}重复`,
          error: true,
          issueId,
        };
      }
      issues.push({
        id: issueId,
        kind: "duplicate-description-chapter",
        bookKind: "description",
        summary: `${presentation.label}重复（${blocks.length} 处）`,
        targetBlockIds: blocks.map((block) => block.id),
        anchorBlockId: blocks[0]?.id ?? document.content[0]?.id ?? "",
      });
      continue;
    }
    if (!REQUIRED_DESCRIPTION_CHAPTERS.has(chapter) || blocks.length > 0) continue;
    const chapterIndex = DESCRIPTION_CHAPTER_ORDER.indexOf(chapter);
    const nextBlock = DESCRIPTION_CHAPTER_ORDER.slice(chapterIndex + 1)
      .flatMap((candidate) => chapterBlocks.get(candidate) ?? [])
      .at(0);
    const previousBlock = DESCRIPTION_CHAPTER_ORDER.slice(0, chapterIndex)
      .reverse()
      .flatMap((candidate) => chapterBlocks.get(candidate) ?? [])
      .at(0);
    const anchorBlock = nextBlock ?? previousBlock ?? document.content[0];
    const issueId = `missing-description-chapter:${chapter}`;
    const virtualPlacement = nextBlock ? "before" : "after";
    issues.push({
      id: issueId,
      kind: "missing-description-chapter",
      bookKind: "description",
      summary: `缺少${presentation.label}`,
      targetBlockIds: [],
      anchorBlockId: anchorBlock?.id ?? "",
    });
    if (!includeMarkers || !anchorBlock) continue;
    markers.push({
      id: `virtual:${issueId}`,
      kind: "warning",
      label: `缺少${presentation.label}`,
      displayLabel: `缺${shortDescriptionChapterLabel(presentation.label)}`,
      compactLabel: "!",
      targetBlockId: anchorBlock.id,
      endBlockId: anchorBlock.id,
      warning: false,
      error: true,
      virtual: true,
      virtualPlacement,
      issueId,
    });
  }

  return { markers: includeMarkers ? sortMarkers(document, markers) : [], issues };
}

function sortMarkers(
  document: PatentBookDocument,
  markers: readonly DocumentStructureRulerMarker[],
): DocumentStructureRulerMarker[] {
  const blockIndices = new Map<string, number>();
  document.content.forEach((block, index) => {
    if (!blockIndices.has(block.id)) blockIndices.set(block.id, index);
  });
  return [...markers].sort((left, right) => {
    const blockDifference =
      (blockIndices.get(left.targetBlockId) ?? -1) - (blockIndices.get(right.targetBlockId) ?? -1);
    if (blockDifference !== 0) return blockDifference;
    const placementOrder = (marker: DocumentStructureRulerMarker) =>
      marker.virtualPlacement === "before" ? -1 : marker.virtualPlacement === "after" ? 1 : 0;
    return placementOrder(left) - placementOrder(right);
  });
}

function blockText(block: BlockNode): string {
  if (block.type !== "paragraph" && block.type !== "heading") return "";
  return inlineText(block.content);
}

function inlineText(content: readonly InlineNode[]): string {
  return content
    .map((inline) => {
      if (inline.type === "text") return inline.text;
      if (inline.type === "inline-formula") return inline.source;
      return "";
    })
    .join("");
}
