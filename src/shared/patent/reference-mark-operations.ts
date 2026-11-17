import type { BlockNode, InlineNode, PatentBookDocument, TextMark } from "../document/model.js";
import { randomUuid } from "../id.js";
import { descriptionChapterKindFromText } from "./description.js";
import { PATENT_BODY_PARAGRAPH_ATTRIBUTES } from "./formatting.js";
import { type CanonicalPatent, CanonicalPatentSchema, type PatentBookKind } from "./model.js";
import { descriptionReferenceNumberRanges } from "./reference-mark-description-number.js";
import { locateReferenceMarkIssues } from "./reference-mark-issue-locator.js";
import {
  type DrawingExplanationSegment,
  drawingExplanationSegment,
  invalidLegendParagraphsInSegment,
  lastLegendParagraph,
  legendParagraphsInSegment,
  sortReferenceMarks,
} from "./reference-mark-legend.js";
import {
  cancelClaimsKeywordNumber,
  countDetachedKeywordNumber,
  countKeyword,
  documentText,
  inspectKeywordNumbers,
  interruptedClaimsKeywordMatches,
  numberClaimsKeyword,
  numberDescriptionKeyword,
  protectedClaimsKeywordSearches,
  protectedReferenceMarkKeywordSearches,
  recolorClaimsKeywordNumber,
  renameKeyword,
  renumberClaimsKeyword,
  renumberEmbodimentKeyword,
  renumberTextBookKeyword,
  repairInterruptedClaimsKeyword,
  supplementEmbodimentKeyword,
} from "./reference-mark-text.js";
import {
  AUTOMATIC_EDIT_RED,
  deterministicReferenceMarkId,
  formatReferenceMarkText,
  type ParsedReferenceMark,
  parseReferenceLegendText,
} from "./reference-marks.js";

export type ReferenceMarkSyncState =
  | { status: "active"; legendParagraphId: string | null }
  | { status: "paused"; message: string };

export type ReferenceMarkDescriptionState =
  | { status: "empty" | "aligned" | "different"; currentText: string; targetText: string }
  | { status: "invalid"; message: string };

/**
 * 旧版可选同步开关及待核对流程暂时停用，保留字段兼容历史数据。
 * 面板内明确提交的编辑由 planUpdateReferenceMark 独立执行跨文档事务。
 */
export const REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE: boolean = false;

const CROSS_DOCUMENT_EDITING_DISABLED_MESSAGE =
  "跨文档同步修改已暂时停用；仍可在权利要求书中进行附图标记编号。";

const DRAWING_BOOKS_DISABLED_MESSAGE = "说明书附图已删除，无法进行编号或附图标记同步。";
const MISSING_DESCRIPTION_HEADING_MESSAGE =
  "找不到说明书中的“附图说明”部分。请先在说明书中添加“附图说明”标题，然后重试。";

function manualFillProblemMessage(message: string): string {
  if (message.includes("缺少“附图说明”")) return MISSING_DESCRIPTION_HEADING_MESSAGE;
  return message;
}

function drawingBooksDisabledResult(
  patent: CanonicalPatent,
): { ok: false; code: "SYNC_PAUSED"; message: string } | null {
  return patent.drawingBooksEnabled
    ? null
    : { ok: false, code: "SYNC_PAUSED", message: DRAWING_BOOKS_DISABLED_MESSAGE };
}

function disableLegacyCrossDocumentEditing(patent: CanonicalPatent): void {
  patent.referenceMarkSettings.synchronizedEditingEnabled = false;
  delete patent.referenceMarkSettings.pendingReview;
}

function sameReferenceMarkEntries(
  left: readonly ParsedReferenceMark[],
  right: readonly ParsedReferenceMark[],
): boolean {
  const sortedLeft = sortReferenceMarks(left);
  const sortedRight = sortReferenceMarks(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every(
      (entry, index) =>
        entry.number === sortedRight[index]?.number &&
        entry.keyword === sortedRight[index]?.keyword,
    )
  );
}

/** 附图说明章节内的最后一段段落；章节为空时返回 null。 */
function lastParagraphInSegment(
  description: PatentBookDocument,
  segment: DrawingExplanationSegment,
): Extract<BlockNode, { type: "paragraph" }> | null {
  for (let index = segment.end - 1; index >= segment.start; index -= 1) {
    const block = description.content[index];
    if (block?.type === "paragraph") return block;
  }
  return null;
}

export function inspectReferenceMarkDescriptionState(
  patent: CanonicalPatent,
): ReferenceMarkDescriptionState {
  const description = patent.books.find((book) => book.kind === "description")?.document;
  if (!description) return { status: "invalid", message: "说明书不存在，无法同步。" };
  const segment = drawingExplanationSegment(description);
  if (!segment) return { status: "invalid", message: "缺少“附图说明”标题，无法同步。" };
  if (invalidLegendParagraphsInSegment(description).length > 0) {
    return {
      status: "invalid",
      message: "附图说明中有格式错误的附图标记段落，请先检查其中的编号和关键词。",
    };
  }
  const targetText = formatReferenceMarkText(patent.referenceMarks);
  const legends = legendParagraphsInSegment(description);
  if (legends.length > 1) {
    return { status: "invalid", message: "附图说明中存在多个附图标记段落，请先保留一个。" };
  }
  const legend = legends[0] ?? null;
  const currentText = legend ? paragraphInlineText(legend) : "";
  const parsed = legend ? parseReferenceLegendText(currentText) : null;
  const entries = parsed?.ok ? parsed.entries : [];
  if (patent.referenceMarks.length === 0 && entries.length === 0) {
    return { status: "empty", currentText, targetText };
  }
  return sameReferenceMarkEntries(entries, patent.referenceMarks)
    ? { status: "aligned", currentText, targetText }
    : { status: "different", currentText, targetText };
}

export function planFillReferenceMarksIntoDescription(
  patent: CanonicalPatent,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const pending = pendingReferenceMarkReviewResult(patent);
  if (pending) return pending;
  if (patent.referenceMarks.length === 0) {
    return {
      ok: false,
      code: "INVALID_REFERENCE_MARK",
      message: "当前无附图标记，无法填入说明书。",
    };
  }
  const state = inspectReferenceMarkDescriptionState(patent);
  if (state.status === "invalid") {
    return {
      ok: false,
      code: state.message.includes("缺少“附图说明”")
        ? "MISSING_DESCRIPTION_HEADING"
        : "SYNC_PAUSED",
      message: manualFillProblemMessage(state.message),
    };
  }
  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  const description = after.books.find((book) => book.kind === "description");
  if (!description) return { ok: false, code: "INVALID_PATENT", message: "说明书不存在。" };
  const segment = drawingExplanationSegment(description.document);
  if (!segment)
    return {
      ok: false,
      code: "MISSING_DESCRIPTION_HEADING",
      message: MISSING_DESCRIPTION_HEADING_MESSAGE,
    };
  // 图例沿用组件中用户调整后的排列顺序。
  const orderedMarks = after.referenceMarks;
  const previousContent = lastLegendParagraph(description.document)?.content ?? [];
  const legendContent = buildLegendContent(previousContent, orderedMarks);
  // 唯一图例原位更新；没有图例时复用末尾空段，否则追加新段，不覆盖用户文字。
  writeLegendToSegment(description.document, legendContent);
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_PATENT", message: "填入后的专利数据无效。" };
  return success(
    patent,
    parsed.data,
    { claims: 0, description: 1, abstract: 0 },
    "已填入说明书。",
    true,
    "description",
  );
}

/**
 * 将图例内容写入说明书“附图说明”部分的最后一段：
 * - 最后一段为空 → 直接填入该段；
 * - 已有唯一图例段 → 原位更新；
 * - 最后一段有其他文字 → 在其后另起一段，不覆盖用户内容；
 * - 区域内没有段落 → 在区域末尾新建段落。
 */
function writeLegendToSegment(
  description: PatentBookDocument,
  legendContent: readonly InlineNode[],
): void {
  const segment = drawingExplanationSegment(description);
  if (!segment) return;
  const end = segment.end;
  const legends = legendParagraphsInSegment(description);
  const existingLegend = legends[0];
  if (existingLegend) {
    existingLegend.content = [...structuredClone(legendContent)];
    return;
  }
  const last = lastParagraphInSegment(description, segment);
  if (!last) {
    insertLegendParagraph(description, end, legendContent);
    return;
  }
  const text = paragraphInlineText(last);
  if (text.trim().length === 0) {
    // 空段：直接填入。
    last.content = [...structuredClone(legendContent)];
    return;
  }
  const targetIndex = description.content.indexOf(last);
  insertLegendParagraph(description, targetIndex + 1, legendContent);
}

function insertLegendParagraph(
  description: PatentBookDocument,
  index: number,
  legendContent: readonly InlineNode[],
): void {
  description.content.splice(index, 0, {
    id: randomUuid(),
    type: "paragraph",
    attrs: { ...PATENT_BODY_PARAGRAPH_ATTRIBUTES },
    content: [...structuredClone(legendContent)],
  });
}

function paragraphInlineText(block: { content: readonly InlineNode[] }): string {
  return block.content.map((node) => (node.type === "text" ? node.text : "")).join("");
}

export type ReferenceMarkEntryStatus = {
  referenceMarkId: string;
  missingInClaims: boolean;
  missingInDescription: boolean;
  numberMismatch: boolean;
  unnumberedInClaims: boolean;
  unnumberedClaimsCount: number;
  nonstandardClaimsCount: number;
  orphanClaimsNumberCount: number;
  locatableIssueCount: number;
  locatableIssueCounts: Readonly<
    Record<Extract<PatentBookKind, "claims" | "description" | "abstract">, number>
  >;
};

export function inspectReferenceMarkStatus(
  patent: CanonicalPatent,
  referenceMarkId?: string,
): {
  sync: ReferenceMarkSyncState;
  missingReferenceMarkIds: Set<string>;
  entries: ReferenceMarkEntryStatus[];
} {
  if (!patent.drawingBooksEnabled) {
    return {
      sync: { status: "paused", message: DRAWING_BOOKS_DISABLED_MESSAGE },
      missingReferenceMarkIds: new Set(),
      entries: [],
    };
  }
  const claims = patent.books.find((book) => book.kind === "claims")?.document;
  const description = patent.books.find((book) => book.kind === "description")?.document;
  const entries = patent.referenceMarks
    .filter((entry) => referenceMarkId === undefined || entry.referenceMarkId === referenceMarkId)
    .map((entry) => {
      const claimsInspection = claims
        ? inspectKeywordNumbers(claims, entry.keyword, {
            protectedSearches: protectedClaimsKeywordSearches(
              claims,
              entry.keyword,
              patent.referenceMarks,
            ),
          })
        : null;
      const missingInClaims = !claimsInspection || claimsInspection.keywordCount === 0;
      const descriptionProtectedSearches = description
        ? protectedReferenceMarkKeywordSearches(description, entry.keyword, patent.referenceMarks, {
            includeUnparenthesizedNumbers: true,
          })
        : [];
      const missingInDescription =
        !description ||
        countKeyword(description, entry.keyword, {
          excludeLegend: true,
          protectedSearches: descriptionProtectedSearches,
        }) === 0;
      // 正文编号与结构化序号不一致才视为一致性警告；缺词或正文完全没有该编号不算。
      const bodyNumbers = claimsInspection?.numbers ?? [];
      const numberMismatch =
        !missingInClaims &&
        bodyNumbers.length > 0 &&
        bodyNumbers.some((number) => number !== entry.number);
      const unnumberedClaimsCount = claimsInspection?.unnumberedCount ?? 0;
      const locatedIssues = locateReferenceMarkIssues(patent, entry.referenceMarkId);
      return {
        referenceMarkId: entry.referenceMarkId,
        missingInClaims,
        missingInDescription,
        numberMismatch,
        unnumberedInClaims: unnumberedClaimsCount > 0,
        unnumberedClaimsCount,
        nonstandardClaimsCount: claimsInspection?.nonstandardCount ?? 0,
        orphanClaimsNumberCount: claims
          ? countDetachedKeywordNumber(claims, entry.keyword, entry.number)
          : 0,
        locatableIssueCount: locatedIssues.length,
        locatableIssueCounts: {
          claims: locatedIssues.filter((issue) => issue.bookKind === "claims").length,
          description: locatedIssues.filter((issue) => issue.bookKind === "description").length,
          abstract: locatedIssues.filter((issue) => issue.bookKind === "abstract").length,
        },
      };
    });
  const missingReferenceMarkIds = new Set(
    entries
      .filter((entry) => entry.missingInClaims || entry.missingInDescription)
      .map((entry) => entry.referenceMarkId),
  );
  // 仅把附图说明章节内可解析的“其中：序号、关键词”段识别为图例。
  const segment = description ? drawingExplanationSegment(description) : null;
  let sync: ReferenceMarkSyncState;
  if (!description || !segment) {
    sync = { status: "paused", message: "缺少“附图说明”标题，无法同步。" };
  } else if (invalidLegendParagraphsInSegment(description).length > 0) {
    sync = {
      status: "paused",
      message: "附图说明中有格式错误的附图标记段落，请先检查其中的编号和关键词。",
    };
  } else {
    const legends = legendParagraphsInSegment(description);
    sync =
      legends.length > 1
        ? { status: "paused", message: "附图说明中存在多个附图标记段落，请先保留一个。" }
        : { status: "active", legendParagraphId: legends[0]?.id ?? null };
  }
  return { sync, missingReferenceMarkIds, entries };
}

/** 使用与修改计划相同的保护规则，统计核对面板真正需要定位的位置。 */
export function referenceMarkReviewOccurrenceCount(
  patent: CanonicalPatent,
  kind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  review: NonNullable<CanonicalPatent["referenceMarkSettings"]["pendingReview"]>,
): number {
  const document = patent.books.find((book) => book.kind === kind)?.document;
  if (!document) return 0;
  const otherMarks = patent.referenceMarks.filter(
    (mark) => mark.referenceMarkId !== review.referenceMarkId,
  );
  const protectedSearches =
    kind === "claims"
      ? protectedClaimsKeywordSearches(document, review.keyword, otherMarks)
      : protectedReferenceMarkKeywordSearches(document, review.keyword, otherMarks, {
          includeUnparenthesizedNumbers: true,
        });
  return countKeyword(document, review.keyword, {
    ...(kind === "description" ? { excludeLegend: true } : {}),
    protectedSearches,
  });
}

export function reconcileReferenceMarksFromDescription(
  patent: CanonicalPatent,
  nextDescription: PatentBookDocument,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const pending = pendingReferenceMarkReviewResult(patent);
  if (pending) return pending;
  const segment = drawingExplanationSegment(nextDescription);
  if (!segment)
    return { ok: false, code: "SYNC_PAUSED", message: MISSING_DESCRIPTION_HEADING_MESSAGE };
  if (invalidLegendParagraphsInSegment(nextDescription).length > 0)
    return {
      ok: false,
      code: "SYNC_PAUSED",
      message: "附图说明中有格式错误的附图标记段落，请先检查其中的编号和关键词。",
    };
  const legends = legendParagraphsInSegment(nextDescription);
  if (legends.length === 0)
    return {
      ok: false,
      code: "SYNC_PAUSED",
      message: "附图说明部分没有附图标记段落，已暂停同步。",
    };
  if (legends.length > 1) {
    return {
      ok: false,
      code: "SYNC_PAUSED",
      message: "附图说明中存在多个附图标记段落，请先保留一个。",
    };
  }
  const legend = legends[0] as (typeof legends)[number];
  const parsed = parseReferenceLegendText(paragraphInlineText(legend));
  if (!parsed.ok) return { ok: false, code: "SYNC_PAUSED", message: parsed.message };
  for (const entry of parsed.entries) {
    const invalidKeyword = validateReferenceMarkSelection(entry.keyword);
    if (invalidKeyword) {
      return {
        ok: false,
        code: "INVALID_REFERENCE_MARK",
        message: invalidKeyword.message.replace("请只选择", "请只输入"),
      };
    }
  }
  const after = structuredClone(patent);
  const description = after.books.find((book) => book.kind === "description");
  if (!description) return { ok: false, code: "INVALID_PATENT", message: "说明书不存在。" };
  description.document = structuredClone(nextDescription);
  after.referenceMarks = sortReferenceMarks(parsed.entries).map((entry) => ({
    referenceMarkId: retainedReferenceMarkId(patent.referenceMarks, legend.id, entry),
    ...entry,
  }));
  return success(
    patent,
    CanonicalPatentSchema.parse(after),
    { claims: 0, description: 0, abstract: 0 },
    "附图标记已从说明书更新。",
  );
}

function retainedReferenceMarkId(
  previous: CanonicalPatent["referenceMarks"],
  legendId: string,
  entry: ParsedReferenceMark,
): string {
  const exact = previous.find(
    (current) => current.number === entry.number && current.keyword === entry.keyword,
  );
  if (exact) return exact.referenceMarkId;
  // 仅单维度匹配时，若序号命中的候选与关键词命中的候选不是同一个（存在二义），
  // 不猜测而是生成新 ID，避免“同号不同词 + 同词不同号”并存时串 ID。
  const byNumber = previous.filter((current) => current.number === entry.number);
  const byKeyword = previous.filter((current) => current.keyword === entry.keyword);
  const candidates = new Set([...byNumber, ...byKeyword].map((current) => current.referenceMarkId));
  if (candidates.size === 1) return [...candidates][0] as string;
  return deterministicReferenceMarkId(legendId, entry.number, entry.keyword);
}

export type ReferenceMarkFailureCode =
  | "INVALID_SELECTION"
  | "SYNC_PAUSED"
  | "DUPLICATE_NUMBER"
  | "DUPLICATE_KEYWORD"
  | "AMBIGUOUS_EXISTING_NUMBER"
  | "INVALID_REFERENCE_MARK"
  | "MISSING_DESCRIPTION_HEADING"
  | "DUPLICATE_REFERENCE_MARK"
  | "PENDING_REFERENCE_MARK_REVIEW"
  | "REFERENCE_MARK_REPLACEMENT_MISMATCH"
  | "INTERRUPTED_KEYWORD_MATCHES"
  | "BODY_NUMBER_CONFLICT"
  | "TARGET_KEYWORD_ALREADY_EXISTS"
  | "INVALID_PATENT";

export type ReferenceMarkMutationPlan = {
  before: CanonicalPatent;
  after: CanonicalPatent;
  affectedBookKinds: PatentBookKind[];
  counts: Record<"claims" | "description" | "abstract", number>;
  message: string;
  recordHistory: boolean;
  historyBookKind?: "claims" | "description" | "abstract";
};

export function planSupplementClaimsReferenceNumbers(
  patent: CanonicalPatent,
  referenceMarkId?: string,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const claims = patent.books.find((book) => book.kind === "claims");
  if (!claims) return { ok: false, code: "INVALID_PATENT", message: "权利要求书不存在。" };
  const marks = patent.referenceMarks.filter(
    (mark) => referenceMarkId === undefined || mark.referenceMarkId === referenceMarkId,
  );
  if (referenceMarkId !== undefined && marks.length !== 1)
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "该附图标记已不存在。" };
  let document = claims.document;
  let count = 0;
  for (const mark of [...marks].sort((a, b) => b.keyword.length - a.keyword.length)) {
    const options = {
      protectedSearches: protectedClaimsKeywordSearches(
        document,
        mark.keyword,
        patent.referenceMarks,
      ),
    };
    const inspected = inspectKeywordNumbers(document, mark.keyword, options);
    if (
      inspected.nonstandardCount > 0 ||
      inspected.numbers.some((number) => number !== mark.number) ||
      patent.referenceMarks.some(
        (other) =>
          other.referenceMarkId !== mark.referenceMarkId &&
          (other.number === mark.number || other.keyword === mark.keyword),
      )
    )
      return {
        ok: false,
        code: "AMBIGUOUS_EXISTING_NUMBER",
        message: `“${mark.keyword}”的已有编号与登记不一致或格式不规范，请先核对。本次未修改文档。`,
      };
    const mutation = numberClaimsKeyword(document, mark.keyword, mark.number, options);
    document = mutation.document;
    count += mutation.replacementCount;
  }
  if (!count)
    return success(
      patent,
      patent,
      { claims: 0, description: 0, abstract: 0 },
      "无需增补编号。",
      false,
      "claims",
    );
  const after = structuredClone(patent);
  after.books.find((book) => book.kind === "claims")!.document = document;
  return success(
    patent,
    CanonicalPatentSchema.parse(after),
    { claims: count, description: 0, abstract: 0 },
    `增补成功，共补充 ${count} 处编号。`,
    true,
    "claims",
  );
}

export function planSupplementDescriptionReferenceNumbers(
  patent: CanonicalPatent,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) return { ok: false, code: "INVALID_PATENT", message: "说明书不存在。" };
  const chapterKind = (block: BlockNode) =>
    block.type === "paragraph" || block.type === "heading"
      ? descriptionChapterKindFromText(
          block.content
            .map((node) => (node.type === "text" ? node.text : "\uFFFC"))
            .join("")
            .trim(),
        )
      : null;
  const headings = description.document.content.flatMap((block, index) =>
    chapterKind(block) === "detailed-embodiments" ? [index] : [],
  );
  if (headings.length !== 1)
    return {
      ok: false,
      code: "MISSING_DESCRIPTION_HEADING",
      message: headings.length
        ? "存在多个“具体实施方式”标题，请先保留一个。"
        : "未找到独立的“具体实施方式”标题，无法增补编号。",
    };
  const start = (headings[0] as number) + 1;
  const next = description.document.content.findIndex(
    (block, index) => index >= start && chapterKind(block) !== null,
  );
  const range = { start, end: next < 0 ? description.document.content.length : next };
  let document = description.document;
  let count = 0;
  for (const mark of [...patent.referenceMarks].sort(
    (a, b) => b.keyword.length - a.keyword.length,
  )) {
    const mutation = supplementEmbodimentKeyword(
      document,
      mark.keyword,
      mark.number,
      range,
      protectedReferenceMarkKeywordSearches(document, mark.keyword, patent.referenceMarks, {
        includeUnparenthesizedNumbers: true,
      }),
    );
    document = mutation.document;
    count += mutation.replacementCount;
  }
  if (!count)
    return success(
      patent,
      patent,
      { claims: 0, description: 0, abstract: 0 },
      "无需增补编号。",
      false,
      "description",
    );
  const after = structuredClone(patent);
  const target = after.books.find((book) => book.kind === "description");
  if (!target) return { ok: false, code: "INVALID_PATENT", message: "说明书不存在。" };
  target.document = document;
  return success(
    patent,
    CanonicalPatentSchema.parse(after),
    { claims: 0, description: count, abstract: 0 },
    `增补成功，共补充 ${count} 处编号。`,
    true,
    "description",
  );
}
export type ReferenceMarkPlanResult =
  | { ok: true; plan: ReferenceMarkMutationPlan }
  | {
      ok: false;
      code: Exclude<
        ReferenceMarkFailureCode,
        "INTERRUPTED_KEYWORD_MATCHES" | "BODY_NUMBER_CONFLICT"
      >;
      message: string;
    }
  | {
      ok: false;
      code: "INTERRUPTED_KEYWORD_MATCHES";
      message: string;
      interruptedKeywordRepair: {
        keyword: string;
        number: number;
        matchCount: number;
        examples: string[];
        contexts: string[];
      };
    }
  | {
      ok: false;
      code: "BODY_NUMBER_CONFLICT";
      message: string;
      bodyNumberConflict: {
        keyword: string;
        number: number;
        matchCount: number;
        contexts: string[];
      };
    };

function nextSequentialReferenceMarkNumber(
  referenceMarks: CanonicalPatent["referenceMarks"],
): number {
  const usedNumbers = new Set(referenceMarks.map((entry) => entry.number));
  let candidate = (referenceMarks.at(-1)?.number ?? 0) + 1;
  while (usedNumbers.has(candidate)) candidate += 1;
  return candidate;
}

export function planAssignReferenceNumber(
  patent: CanonicalPatent,
  keyword: string,
  dependencies: { now(): Date; createId(): string },
  requestedNumber?: number,
  options: {
    interruptedKeywordDecision?: "keep" | "repair";
    bodyNumberConflictDecision?: "use-anyway";
  } = {},
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const pending = pendingReferenceMarkReviewResult(patent);
  if (pending) return pending;
  const normalized = keyword.trim();
  if (!normalized) return { ok: false, code: "INVALID_SELECTION", message: "请先选择关键词。" };
  const invalidSelection = validateReferenceMarkSelection(normalized);
  if (invalidSelection) return invalidSelection;
  if (
    requestedNumber !== undefined &&
    (!Number.isSafeInteger(requestedNumber) || requestedNumber <= 0)
  ) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "序号必须是正整数。" };
  }
  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  const claims = after.books.find((book) => book.kind === "claims");
  if (!claims) return { ok: false, code: "INVALID_PATENT", message: "权利要求书不存在。" };

  const existing = after.referenceMarks.find((entry) => entry.keyword === normalized);
  const requestedNumberOwner = after.referenceMarks.find(
    (entry) => entry.number === requestedNumber && entry.keyword !== normalized,
  );
  if (requestedNumberOwner) {
    return {
      ok: false,
      code: "DUPLICATE_REFERENCE_MARK",
      message: `序号 ${requestedNumber} 已被“${requestedNumberOwner.keyword}”使用。`,
    };
  }
  const bodyInspection = inspectKeywordNumbers(claims.document, normalized, {
    protectedSearches: protectedClaimsKeywordSearches(
      claims.document,
      normalized,
      after.referenceMarks,
    ),
  });
  if (bodyInspection.nonstandardCount > 0) {
    return {
      ok: false,
      code: "AMBIGUOUS_EXISTING_NUMBER",
      message: `“${normalized}”后的编号格式不规范，请先改为“${normalized}(序号)”后再编号。`,
    };
  }
  const bodyNumbers = [...bodyInspection.numbers];
  const distinctBodyNumbers = [...new Set(bodyNumbers)].sort((left, right) => left - right);
  const conflictingBodyNumberOwner = after.referenceMarks.find(
    (entry) => entry.keyword !== normalized && distinctBodyNumbers.includes(entry.number),
  );
  if (conflictingBodyNumberOwner) {
    return {
      ok: false,
      code: "DUPLICATE_REFERENCE_MARK",
      message: `序号 ${conflictingBodyNumberOwner.number} 已被“${conflictingBodyNumberOwner.keyword}”使用。`,
    };
  }

  let number: number;
  let reusedFromBody = false;
  if (existing) {
    if (requestedNumber !== undefined && requestedNumber !== existing.number) {
      return {
        ok: false,
        code: "AMBIGUOUS_EXISTING_NUMBER",
        message: `“${normalized}”已登记为 ${existing.number}，不能改用 ${requestedNumber}。`,
      };
    }
    // 已登记条目与权利要求书已有编号冲突时停止，避免把“箱体（3）”误写成“箱体（5）（3）”。
    const conflicting = distinctBodyNumbers.filter((value) => value !== existing.number);
    if (conflicting.length > 0) {
      return {
        ok: false,
        code: "AMBIGUOUS_EXISTING_NUMBER",
        message: `“${normalized}”已登记为 ${existing.number}，但权利要求书中还有编号 ${conflicting.join("、")}，请先统一后再编号。`,
      };
    }
    number = existing.number;
  } else if (distinctBodyNumbers.length > 1) {
    // 同一关键词关联多个不同序号时不猜测，返回冲突并不做部分修改。
    return {
      ok: false,
      code: "AMBIGUOUS_EXISTING_NUMBER",
      message: `“${normalized}”在权利要求书中存在多个编号（${distinctBodyNumbers.join("、")}），请先统一后再编号。`,
    };
  } else if (distinctBodyNumbers.length === 1) {
    if (requestedNumber !== undefined && requestedNumber !== distinctBodyNumbers[0]) {
      return {
        ok: false,
        code: "AMBIGUOUS_EXISTING_NUMBER",
        message: `“${normalized}”在权利要求书中已有编号 ${distinctBodyNumbers[0]}，不能改用 ${requestedNumber}。`,
      };
    }
    // 未登记但正文只手写了一个旧编号：沿用该编号并补登记。
    number = distinctBodyNumbers[0] as number;
    reusedFromBody = true;
  } else {
    number = requestedNumber ?? nextSequentialReferenceMarkNumber(after.referenceMarks);
  }

  const bodyNumberConflict = otherBodyNumberOccurrences(claims.document, normalized, number);
  if (bodyNumberConflict.matchCount > 0 && options.bodyNumberConflictDecision !== "use-anyway") {
    return {
      ok: false,
      code: "BODY_NUMBER_CONFLICT",
      message: `序号 ${number} 已在权利要求书其他位置出现，请核对后确认是否仍使用该序号。`,
      bodyNumberConflict: {
        keyword: normalized,
        number,
        matchCount: bodyNumberConflict.matchCount,
        contexts: bodyNumberConflict.contexts,
      },
    };
  }

  const protectedSearches = protectedClaimsKeywordSearches(
    claims.document,
    normalized,
    after.referenceMarks,
  );
  const changed = numberClaimsKeyword(claims.document, normalized, number, {
    protectedSearches,
  });
  if (changed.replacementCount === 0 && !existing && !reusedFromBody) {
    return { ok: false, code: "INVALID_SELECTION", message: "未找到可编号的关键词。" };
  }
  const interrupted = interruptedClaimsKeywordMatches(
    claims.document,
    normalized,
    after.referenceMarks,
  );
  if (interrupted.matchCount > 0 && options.interruptedKeywordDecision === undefined) {
    return {
      ok: false,
      code: "INTERRUPTED_KEYWORD_MATCHES",
      message: `另有 ${interrupted.matchCount} 处“${normalized}”被已有编号打断，请选择是否一并修复。`,
      interruptedKeywordRepair: {
        keyword: normalized,
        number,
        matchCount: interrupted.matchCount,
        examples: interrupted.forms.slice(0, 3),
        contexts: [...interrupted.contexts],
      },
    };
  }
  const repaired =
    options.interruptedKeywordDecision === "repair"
      ? repairInterruptedClaimsKeyword(
          changed.document,
          normalized,
          number,
          interrupted.forms,
          protectedSearches,
        )
      : undefined;
  // 沿用已登记编号或正文旧编号时，把已是“关键词（编号）”的出现位置统一重涂为编号专属颜色。
  const recolored =
    existing !== undefined || reusedFromBody
      ? recolorClaimsKeywordNumber(repaired?.document ?? changed.document, normalized, number)
      : undefined;
  claims.document = recolored?.document ?? repaired?.document ?? changed.document;
  if (!existing)
    after.referenceMarks.push({
      referenceMarkId: dependencies.createId(),
      number,
      keyword: normalized,
    });
  after.modifiedAt = dependencies.now().toISOString();
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_PATENT", message: "编号后的专利数据无效。" };
  return success(
    patent,
    parsed.data,
    {
      claims:
        changed.replacementCount +
        (repaired?.replacementCount ?? 0) +
        (recolored?.replacementCount ?? 0),
      description: 0,
      abstract: 0,
    },
    repaired && repaired.replacementCount > 0
      ? `编号完成，并修复了 ${repaired.replacementCount} 处被旧编号打断的关键词。`
      : reusedFromBody
        ? `检测到正文已有编号 ${number}，已沿用并加入附图标记。`
        : "编号完成。",
  );
}

/** Description numbering is an independent transaction: never write claims or other chapters. */
export function planAssignDescriptionReferenceNumber(
  patent: CanonicalPatent,
  keyword: string,
  sourceBlockIndex: number,
  dependencies: { now(): Date; createId(): string },
  requestedNumber?: number,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const pending = pendingReferenceMarkReviewResult(patent);
  if (pending) return pending;
  const normalized = keyword.trim();
  if (!normalized) return { ok: false, code: "INVALID_SELECTION", message: "请先选择关键词。" };
  const invalid = validateReferenceMarkSelection(normalized);
  if (invalid) return invalid;
  if (
    requestedNumber !== undefined &&
    (!Number.isSafeInteger(requestedNumber) || requestedNumber <= 0)
  )
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "序号必须是正整数。" };
  const description = patent.books.find((book) => book.kind === "description");
  if (!description) return { ok: false, code: "INVALID_PATENT", message: "说明书不存在。" };
  const chapter = (block: BlockNode) =>
    block.type === "paragraph" || block.type === "heading"
      ? descriptionChapterKindFromText(
          block.content
            .map((node) => (node.type === "text" ? node.text : "\uFFFC"))
            .join("")
            .trim(),
        )
      : null;
  const headings = description.document.content.flatMap((block, index) =>
    chapter(block) === "detailed-embodiments" ? [index] : [],
  );
  if (headings.length !== 1)
    return {
      ok: false,
      code: "MISSING_DESCRIPTION_HEADING",
      message: headings.length
        ? "存在多个“具体实施方式”标题，请先保留一个。"
        : "未找到独立的“具体实施方式”标题，无法编号。",
    };
  const start = headings[0]! + 1;
  const next = description.document.content.findIndex(
    (block, index) => index >= start && chapter(block) !== null,
  );
  const range = { start, end: next < 0 ? description.document.content.length : next };
  if (
    !Number.isInteger(sourceBlockIndex) ||
    sourceBlockIndex < range.start ||
    sourceBlockIndex >= range.end
  )
    return {
      ok: false,
      code: "INVALID_SELECTION",
      message: "请在说明书“具体实施方式”正文中选中不含编号的关键词。",
    };
  if (patent.referenceMarks.some((entry) => normalized === `${entry.keyword}${entry.number}`))
    return { ok: false, code: "INVALID_SELECTION", message: "请只选择不含编号的关键词。" };
  const scoped = {
    ...description.document,
    content: description.document.content.slice(range.start, range.end),
  };
  if (
    interruptedClaimsKeywordMatches(scoped, normalized, patent.referenceMarks, {
      includeUnparenthesizedNumbers: true,
    }).matchCount > 0
  )
    return {
      ok: false,
      code: "AMBIGUOUS_EXISTING_NUMBER",
      message: `“${normalized}”存在被已有编号打断的写法，请先核对统一后再编号。`,
    };
  const protectedSearches = protectedReferenceMarkKeywordSearches(
    scoped,
    normalized,
    patent.referenceMarks,
    { includeUnparenthesizedNumbers: true },
  );
  const body = inspectKeywordNumbers(scoped, normalized, {
    protectedSearches,
    includeUnparenthesizedNumbers: true,
  });
  const claims = patent.books.find((book) => book.kind === "claims");
  const claimsInspection = claims
    ? inspectKeywordNumbers(claims.document, normalized, {
        protectedSearches: protectedClaimsKeywordSearches(
          claims.document,
          normalized,
          patent.referenceMarks,
        ),
      })
    : null;
  const existing = patent.referenceMarks.find((entry) => entry.keyword === normalized);
  const numbers = [
    ...new Set([
      ...body.numbers,
      ...(claimsInspection?.numbers ?? []),
      ...(existing ? [existing.number] : []),
    ]),
  ];
  if (
    body.nonstandardCount ||
    numbers.some((number) => !Number.isSafeInteger(number) || number <= 0) ||
    numbers.length > 1
  )
    return {
      ok: false,
      code: "AMBIGUOUS_EXISTING_NUMBER",
      message: `“${normalized}”的正文编号或登记不一致，请先核对并统一。`,
    };
  if (numbers.length && requestedNumber !== undefined && requestedNumber !== numbers[0])
    return {
      ok: false,
      code: "AMBIGUOUS_EXISTING_NUMBER",
      message: `“${normalized}”已有编号 ${numbers[0]}，不能改用 ${requestedNumber}。`,
    };
  const text = documentText(scoped);
  const otherNumbers = new Set(
    descriptionReferenceNumberRanges(text)
      .filter((entry) => !text.slice(0, entry.from).trimEnd().endsWith(normalized))
      .map((entry) => entry.number),
  );
  const claimsNumbers = claims
    ? [
        ...documentText(claims.document).matchAll(
          /[（(][\t \u3000]*([0-9０-９]+)[\t \u3000]*[)）]/gu,
        ),
      ].map((match) =>
        Number(
          match[1]!.replace(/[０-９]/gu, (digit) =>
            String.fromCharCode(digit.charCodeAt(0) - 65248),
          ),
        ),
      )
    : [];
  let number =
    numbers[0] ?? requestedNumber ?? nextSequentialReferenceMarkNumber(patent.referenceMarks);
  if (!numbers.length && requestedNumber === undefined) {
    const occupied = new Set([
      ...patent.referenceMarks.map((entry) => entry.number),
      ...otherNumbers,
      ...claimsNumbers,
    ]);
    while (occupied.has(number)) number += 1;
  }
  const owner = patent.referenceMarks.find(
    (entry) => entry.number === number && entry.keyword !== normalized,
  );
  const claimsConflict = claims
    ? otherBodyNumberOccurrences(claims.document, normalized, number).matchCount > 0
    : false;
  if (owner || otherNumbers.has(number) || claimsConflict)
    return {
      ok: false,
      code: "DUPLICATE_REFERENCE_MARK",
      message: owner
        ? `序号 ${number} 已被“${owner.keyword}”使用。`
        : `序号 ${number} 已在正文其他位置出现，请核对后选择未占用的编号。`,
    };
  const changed = numberDescriptionKeyword(
    description.document,
    normalized,
    number,
    range,
    protectedSearches,
  );
  if (!changed.replacementCount && !body.numberedCount)
    return {
      ok: false,
      code: "INVALID_SELECTION",
      message: "未找到可编号的关键词；尺寸、数量等普通数字不会作为附图标号处理。",
    };
  const after = structuredClone(patent);
  after.books.find((book) => book.kind === "description")!.document = changed.document;
  if (!existing)
    after.referenceMarks.push({
      referenceMarkId: dependencies.createId(),
      number,
      keyword: normalized,
    });
  const modified = JSON.stringify(after) !== JSON.stringify(patent);
  if (modified) after.modifiedAt = dependencies.now().toISOString();
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_PATENT", message: "编号后的专利数据无效。" };
  return success(
    patent,
    parsed.data,
    { claims: 0, description: changed.replacementCount, abstract: 0 },
    existing
      ? `已沿用“${normalized}”的编号 ${number}，仅处理具体实施方式。`
      : `编号完成：“${normalized}”为 ${number}，已登记到附图标记。`,
    modified,
    "description",
  );
}

export function planSetReferenceMarkSync(
  patent: CanonicalPatent,
  enabled: boolean,
): ReferenceMarkPlanResult {
  if (enabled && !REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE) {
    return { ok: false, code: "SYNC_PAUSED", message: CROSS_DOCUMENT_EDITING_DISABLED_MESSAGE };
  }
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  return success(
    patent,
    after,
    { claims: 0, description: 0, abstract: 0 },
    "跨文档同步修改已关闭。",
  );
}

export function planUpdateReferenceMark(
  patent: CanonicalPatent,
  edit: { referenceMarkId: string; number: number; keyword: string },
  dependencies: {
    now(): Date;
    ownerBookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">;
  } = { now: () => new Date(), ownerBookKind: "claims" },
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  const entry = after.referenceMarks.find((item) => item.referenceMarkId === edit.referenceMarkId);
  if (!entry) return { ok: false, code: "INVALID_REFERENCE_MARK", message: "附图标记不存在。" };
  const currentStatus = inspectReferenceMarkStatus(patent, edit.referenceMarkId).entries.find(
    (status) => status.referenceMarkId === edit.referenceMarkId,
  );
  if (currentStatus && hasUnsafeClaimsState(currentStatus)) return replacementMismatchResult();
  if (!Number.isSafeInteger(edit.number) || edit.number <= 0) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "序号必须是正整数。" };
  }
  const keyword = edit.keyword.trim();
  if (!keyword) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "关键词不能为空。" };
  }
  const invalidKeyword = validateReferenceMarkSelection(keyword);
  if (invalidKeyword) {
    return {
      ...invalidKeyword,
      code: "INVALID_REFERENCE_MARK",
      message: invalidKeyword.message.replace("请只选择", "请只输入"),
    };
  }
  if (edit.number === entry.number && keyword === entry.keyword) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "序号和关键词没有变化。" };
  }
  if (
    after.referenceMarks.some(
      (item) => item !== entry && (item.number === edit.number || item.keyword === keyword),
    )
  )
    return { ok: false, code: "DUPLICATE_REFERENCE_MARK", message: "序号和关键词不能重复。" };
  let claimsCount = 0;
  if (edit.number !== entry.number) {
    for (const book of after.books) {
      if (!["claims", "description", "abstract"].includes(book.kind)) continue;
      const text = documentText(book.document);
      const conflict =
        book.kind === "claims"
          ? otherBodyNumberOccurrences(book.document, entry.keyword, edit.number).matchCount
          : descriptionReferenceNumberRanges(text).filter(
              (range) =>
                range.number === edit.number &&
                !text.slice(0, range.from).trimEnd().endsWith(entry.keyword),
            ).length;
      if (conflict) {
        const label =
          book.kind === "claims"
            ? "权利要求书"
            : book.kind === "description"
              ? "说明书"
              : "说明书摘要";
        return {
          ok: false,
          code: "BODY_NUMBER_CONFLICT",
          message: `${label}其他位置已使用编号 ${edit.number}，请先定位核对或选择其他编号。`,
          bodyNumberConflict: {
            keyword: entry.keyword,
            number: edit.number,
            matchCount: conflict,
            contexts: [],
          },
        };
      }
    }
  }
  const counts = { claims: 0, description: 0, abstract: 0 };
  const keywordChanged = keyword !== entry.keyword;
  if (keywordChanged && !currentStatus?.missingInClaims) {
    const claims = after.books.find((book) => book.kind === "claims");
    const existingTargetCount = claims
      ? countKeyword(claims.document, keyword, {
          protectedSearches: protectedClaimsKeywordSearches(
            claims.document,
            keyword,
            after.referenceMarks,
          ),
        })
      : 0;
    if (existingTargetCount > 0) {
      return {
        ok: false,
        code: "TARGET_KEYWORD_ALREADY_EXISTS",
        message: `权利要求书中已经存在 ${existingTargetCount} 处“${keyword}”。为避免出现部分未编号，请先取消当前编号，再选择“${keyword}”统一编号。`,
      };
    }
  }
  for (const book of after.books) {
    if (book.kind === "claims") {
      // Manually/CAD-registered terms can legitimately be absent from claims.
      // Correct their registration without inventing text or adding numbers;
      // the explicit supplement operation handles an existing corrected term.
      if (currentStatus?.missingInClaims) continue;
      const protectedSearches = protectedClaimsKeywordSearches(
        book.document,
        entry.keyword,
        after.referenceMarks,
      );
      const expectedRenumberCount = renumberClaimsKeyword(
        book.document,
        entry.keyword,
        entry.number,
        entry.number,
        { protectedSearches },
      ).replacementCount;
      if (expectedRenumberCount === 0) return replacementMismatchResult();
      const expectedRenameCount = keywordChanged
        ? renameKeyword(book.document, entry.keyword, entry.keyword, { protectedSearches })
            .replacementCount
        : 0;
      const renumbered = renumberClaimsKeyword(
        book.document,
        entry.keyword,
        entry.number,
        edit.number,
        { protectedSearches },
      );
      const renamed = keywordChanged
        ? renameKeyword(renumbered.document, entry.keyword, keyword, { protectedSearches })
        : { document: renumbered.document, replacementCount: 0 };
      if (
        renumbered.replacementCount !== expectedRenumberCount ||
        renamed.replacementCount !== expectedRenameCount
      )
        return replacementMismatchResult();
      claimsCount = renumbered.replacementCount + renamed.replacementCount;
      book.document = renamed.document;
    } else if (book.kind === "description" || book.kind === "abstract") {
      const protectedSearches = protectedReferenceMarkKeywordSearches(
        book.document,
        entry.keyword,
        after.referenceMarks,
        { includeUnparenthesizedNumbers: true },
      );
      const updatedLegendIds: string[] = [];
      // Update only an existing exact legend entry; never fill or replace unrelated registrations.
      if (book.kind === "description") {
        for (const legend of legendParagraphsInSegment(book.document)) {
          const parsedLegend = parseReferenceLegendText(paragraphInlineText(legend));
          if (!parsedLegend.ok) continue;
          const target = parsedLegend.entries.find(
            (item) => item.keyword === entry.keyword && item.number === entry.number,
          );
          if (!target) continue;
          legend.content = buildLegendContent(
            legend.content,
            parsedLegend.entries.map((item) =>
              item === target ? { number: edit.number, keyword } : item,
            ),
          );
          updatedLegendIds.push(legend.id);
          counts.description += 1;
        }
      }
      const renumbered = renumberTextBookKeyword(
        book.document,
        entry.keyword,
        entry.number,
        edit.number,
        { protectedSearches, excludedBlockIds: updatedLegendIds },
      );
      const renamed = keywordChanged
        ? renameKeyword(renumbered.document, entry.keyword, keyword, {
            protectedSearches,
            excludedBlockIds: updatedLegendIds,
          })
        : { document: renumbered.document, replacementCount: 0 };
      book.document = renamed.document;
      counts[book.kind] += renumbered.replacementCount + renamed.replacementCount;
    }
  }
  entry.number = edit.number;
  entry.keyword = keyword;
  after.modifiedAt = dependencies.now().toISOString();
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "附图标记数据无效。" };
  return success(
    patent,
    parsed.data,
    { ...counts, claims: claimsCount },
    "附图标记已更新，并同步至权利要求书、说明书和说明书摘要。",
  );
}

export function planCompleteReferenceMarkReview(
  patent: CanonicalPatent,
  referenceMarkId: string,
  options: { acceptCurrentDocument?: boolean } = {},
): ReferenceMarkPlanResult {
  const review = patent.referenceMarkSettings.pendingReview;
  if (!review || review.referenceMarkId !== referenceMarkId) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "待核对的附图标记不存在。" };
  }
  const current = inspectReferenceMarkStatus(patent).entries.find(
    (entry) => entry.referenceMarkId === referenceMarkId,
  );
  const hasReviewIssues =
    !current ||
    current.missingInClaims ||
    hasUnsafeClaimsState(current) ||
    inspectReferenceMarkDescriptionState(patent).status !== "aligned" ||
    !reviewedBooksStillContainExpectedKeyword(patent, review);
  if (!options.acceptCurrentDocument && hasReviewIssues) {
    return replacementMismatchResult();
  }
  const after = structuredClone(patent);
  delete after.referenceMarkSettings.pendingReview;
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_PATENT", message: "完成核对后的专利数据无效。" };
  return success(
    patent,
    parsed.data,
    { claims: 0, description: 0, abstract: 0 },
    options.acceptCurrentDocument ? "已保留当前正文并完成核对。" : "核对已完成。",
    false,
  );
}

export function planCancelReferenceMark(
  patent: CanonicalPatent,
  referenceMarkId: string,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;
  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  const entry = after.referenceMarks.find((item) => item.referenceMarkId === referenceMarkId);
  if (!entry) return { ok: false, code: "INVALID_REFERENCE_MARK", message: "附图标记不存在。" };
  const currentStatus = inspectReferenceMarkStatus(patent, referenceMarkId).entries.find(
    (status) => status.referenceMarkId === referenceMarkId,
  );
  if (currentStatus && hasUnsafeClaimsState(currentStatus, { allowUnnumbered: true })) {
    return replacementMismatchResult();
  }
  const claims = after.books.find((book) => book.kind === "claims");
  const protectedSearches = claims
    ? protectedClaimsKeywordSearches(claims.document, entry.keyword, after.referenceMarks)
    : [];
  const claimsMutation = claims
    ? cancelClaimsKeywordNumber(claims.document, entry.keyword, entry.number, {
        protectedSearches,
      })
    : undefined;
  if (
    claims &&
    claimsMutation?.replacementCount === 0 &&
    countKeyword(claims.document, entry.keyword, { protectedSearches }) > 0
  ) {
    return replacementMismatchResult();
  }
  if (claims && claimsMutation) claims.document = claimsMutation.document;
  const remainingMarks = after.referenceMarks.filter(
    (item) => item.referenceMarkId !== referenceMarkId,
  );
  after.referenceMarks = remainingMarks;
  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success)
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "已取消编号后的专利数据无效。" };
  return success(
    patent,
    parsed.data,
    {
      claims: claimsMutation?.replacementCount ?? 0,
      description: 0,
      abstract: 0,
    },
    "已取消权利要求书编号。",
  );
}

/** Reorder registrations without changing their numbers or any document text. */
export function planReorderReferenceMarks(
  patent: CanonicalPatent,
  ids: readonly string[],
): ReferenceMarkPlanResult {
  const entries = new Map(patent.referenceMarks.map((entry) => [entry.referenceMarkId, entry]));
  if (
    ids.length !== entries.size ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !entries.has(id))
  ) {
    return {
      ok: false,
      code: "INVALID_REFERENCE_MARK",
      message: "附图标记列表已变化，请重新拖动。",
    };
  }
  if (patent.referenceMarkSettings.pendingReview) {
    return { ok: false, code: "PENDING_REFERENCE_MARK_REVIEW", message: "请先完成当前核对。" };
  }
  const after = structuredClone(patent);
  const cloned = new Map(after.referenceMarks.map((entry) => [entry.referenceMarkId, entry]));
  after.referenceMarks = ids.flatMap((id) => {
    const entry = cloned.get(id);
    return entry ? [entry] : [];
  });
  return success(
    patent,
    after,
    { claims: 0, description: 0, abstract: 0 },
    "已调整附图标记顺序，正文与编号未改变。",
  );
}

/**
 * Remove a stale reference-mark registration without attempting to rewrite body text.
 * This is the safe recovery path when the user has already edited the numbered text
 * manually and the original keyword can no longer be matched reliably.
 */
export function planRemoveReferenceMarkRegistration(
  patent: CanonicalPatent,
  referenceMarkId: string,
): ReferenceMarkPlanResult {
  const disabled = drawingBooksDisabledResult(patent);
  if (disabled) return disabled;

  const after = structuredClone(patent);
  disableLegacyCrossDocumentEditing(after);
  if (!after.referenceMarks.some((item) => item.referenceMarkId === referenceMarkId)) {
    return { ok: false, code: "INVALID_REFERENCE_MARK", message: "附图标记不存在。" };
  }

  after.referenceMarks = after.referenceMarks.filter(
    (item) => item.referenceMarkId !== referenceMarkId,
  );

  const parsed = CanonicalPatentSchema.safeParse(after);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_REFERENCE_MARK",
      message: "移除附图标记登记后的专利数据无效。",
    };
  }
  return success(
    patent,
    parsed.data,
    { claims: 0, description: 0, abstract: 0 },
    "已移除附图标记登记，正文保持不变。",
  );
}

function hasUnsafeClaimsState(
  status: ReferenceMarkEntryStatus,
  options: { allowUnnumbered?: boolean } = {},
): boolean {
  return (
    status.numberMismatch ||
    (!options.allowUnnumbered && status.unnumberedInClaims) ||
    status.nonstandardClaimsCount > 0 ||
    status.orphanClaimsNumberCount > 0
  );
}

function reviewedBooksStillContainExpectedKeyword(
  patent: CanonicalPatent,
  review: NonNullable<CanonicalPatent["referenceMarkSettings"]["pendingReview"]>,
): boolean {
  const otherMarks = patent.referenceMarks.filter(
    (mark) => mark.referenceMarkId !== review.referenceMarkId,
  );
  const claims = patent.books.find((book) => book.kind === "claims")?.document;
  if (review.counts.claims > 0) {
    if (!claims) return false;
    const inspected = inspectKeywordNumbers(claims, review.keyword, {
      protectedSearches: protectedClaimsKeywordSearches(claims, review.keyword, otherMarks),
    });
    if (
      inspected.numbers.filter((number) => number === review.number).length < review.counts.claims
    ) {
      return false;
    }
  }
  for (const kind of ["description", "abstract"] as const) {
    const expected = review.counts[kind];
    if (expected === 0) continue;
    const document = patent.books.find((book) => book.kind === kind)?.document;
    if (!document) return false;
    const protectedSearches = protectedReferenceMarkKeywordSearches(
      document,
      review.keyword,
      patent.referenceMarks,
      { includeUnparenthesizedNumbers: true },
    );
    const actual = countKeyword(document, review.keyword, {
      ...(kind === "description" ? { excludeLegend: true } : {}),
      protectedSearches,
    });
    if (actual < expected) return false;
  }
  const descriptionNumberedCount =
    review.descriptionNumberedCount ??
    (review.previousNumber !== review.number && review.counts.description > 0 ? 1 : 0);
  if (descriptionNumberedCount > 0) {
    const description = patent.books.find((book) => book.kind === "description")?.document;
    const protectedSearches = description
      ? protectedReferenceMarkKeywordSearches(description, review.keyword, patent.referenceMarks, {
          includeUnparenthesizedNumbers: true,
        })
      : [];
    if (
      !description ||
      renumberEmbodimentKeyword(description, review.keyword, review.number, review.number, {
        protectedSearches,
      }).replacementCount < descriptionNumberedCount
    ) {
      return false;
    }
  }
  return true;
}

function validateReferenceMarkSelection(
  keyword: string,
): { ok: false; code: "INVALID_SELECTION"; message: string } | null {
  if (keyword.length > 100) {
    return { ok: false, code: "INVALID_SELECTION", message: "关键词不能超过 100 个字符。" };
  }
  if (/\r|\n/u.test(keyword)) {
    return { ok: false, code: "INVALID_SELECTION", message: "关键词不能跨越多个段落。" };
  }
  if (/[。！？；，、,.!?;:：]/u.test(keyword)) {
    return { ok: false, code: "INVALID_SELECTION", message: "关键词不能包含句读标点。" };
  }
  if (/[（(][\t \u3000]*[0-9０-９]+[\t \u3000]*[)）]/u.test(keyword)) {
    return {
      ok: false,
      code: "INVALID_SELECTION",
      message: "请只选择不含编号的关键词。",
    };
  }
  return null;
}

function otherBodyNumberOccurrences(
  document: PatentBookDocument,
  keyword: string,
  number: number,
): { matchCount: number; contexts: string[] } {
  const text = documentText(document);
  const matches: Array<{ index: number; text: string }> = [];
  for (const match of text.matchAll(/[（(][\t \u3000]*([0-9０-９]+)[\t \u3000]*[)）]/gu)) {
    const index = match.index;
    const matchedText = match[0] ?? "";
    const normalizedNumber = Number(
      (match[1] ?? "").replace(/[０-９]/gu, (digit) =>
        String.fromCharCode("0".charCodeAt(0) + digit.charCodeAt(0) - "０".charCodeAt(0)),
      ),
    );
    if (index === undefined || normalizedNumber !== number) continue;
    const lineStart = text.lastIndexOf("\n", Math.max(index - 1, 0)) + 1;
    const prefix = text.slice(lineStart, index).replace(/[\t \u3000]+$/u, "");
    if (prefix.endsWith(keyword)) continue;
    matches.push({ index, text: matchedText });
  }
  return {
    matchCount: matches.length,
    contexts: [
      ...new Set(
        matches.map((match) => {
          const start = Math.max(0, match.index - 18);
          const end = Math.min(text.length, match.index + match.text.length + 18);
          return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\n/gu, " ")}${
            end < text.length ? "…" : ""
          }`;
        }),
      ),
    ].slice(0, 3),
  };
}

function pendingReferenceMarkReviewResult(
  patent: CanonicalPatent,
): { ok: false; code: "PENDING_REFERENCE_MARK_REVIEW"; message: string } | null {
  if (!REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE) return null;
  return patent.referenceMarkSettings.pendingReview
    ? {
        ok: false,
        code: "PENDING_REFERENCE_MARK_REVIEW",
        message: "请先完成当前附图标记的全文档核对。",
      }
    : null;
}

function replacementMismatchResult(): {
  ok: false;
  code: "REFERENCE_MARK_REPLACEMENT_MISMATCH";
  message: string;
} {
  return {
    ok: false,
    code: "REFERENCE_MARK_REPLACEMENT_MISMATCH",
    message: "权利要求书中的关键词或编号已被手动修改，无法安全更新编号；请先核对并统一权利要求书。",
  };
}

function claimsDocument(patent: CanonicalPatent): PatentBookDocument | undefined {
  return patent.books.find((book) => book.kind === "claims")?.document;
}

const AUTOMATIC_RED_MARKS: TextMark[] = [{ type: "color", value: AUTOMATIC_EDIT_RED }];

function legendMarksAt(content: readonly InlineNode[], offset: number): TextMark[] {
  let cursor = 0;
  for (const node of content) {
    if (node.type !== "text") continue;
    if (offset >= cursor && offset < cursor + node.text.length) return node.marks;
    cursor += node.text.length;
  }
  return [];
}

function sameMarks(left: readonly TextMark[], right: readonly TextMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendTextNode(nodes: InlineNode[], text: string, marks: TextMark[]): void {
  if (!text) return;
  const previous = nodes.at(-1);
  if (previous && previous.type === "text" && sameMarks(previous.marks, marks)) {
    (previous as Extract<InlineNode, { type: "text" }>).text += text;
  } else {
    nodes.push({ type: "text", text, marks: structuredClone(marks) });
  }
}

/**
 * 生成附图标记段落内容：只有本次自动新增或改变的文字片段使用自动修改红色，
 * 未改变的“其中：”前缀与未变条目保留原有格式。
 */
function buildLegendContent(
  previousContent: readonly InlineNode[],
  entries: readonly ParsedReferenceMark[],
): InlineNode[] {
  const previousText = previousContent
    .map((node) => (node.type === "text" ? node.text : ""))
    .join("");
  const previousParsed = parseReferenceLegendText(previousText);
  const previousPrefix = previousText.match(/^其中[：,:，]/u)?.[0] ?? "";
  const prefixMarks =
    previousParsed.ok && previousPrefix === "其中："
      ? legendMarksAt(previousContent, 0)
      : AUTOMATIC_RED_MARKS;

  const oldOffsets = new Map<string, number>();
  if (previousParsed.ok) {
    let searchFrom = previousPrefix.length;
    for (const entry of previousParsed.entries) {
      const fragment = `${entry.number}、${entry.keyword}`;
      const index = previousText.indexOf(fragment, searchFrom);
      if (index >= 0) {
        oldOffsets.set(`${entry.number}:${entry.keyword}`, index);
        searchFrom = index + fragment.length;
      }
    }
  }
  const entryMarks = (entry: ParsedReferenceMark): TextMark[] => {
    const offset = oldOffsets.get(`${entry.number}:${entry.keyword}`);
    return offset === undefined ? AUTOMATIC_RED_MARKS : legendMarksAt(previousContent, offset);
  };

  const nodes: InlineNode[] = [];
  appendTextNode(nodes, "其中：", prefixMarks);
  entries.forEach((entry, index) => {
    if (index > 0) appendTextNode(nodes, "；", entryMarks(entry));
    appendTextNode(nodes, `${entry.number}、${entry.keyword}`, entryMarks(entry));
  });
  const lastEntry = entries.at(-1);
  appendTextNode(nodes, "。", lastEntry ? entryMarks(lastEntry) : AUTOMATIC_RED_MARKS);
  return nodes;
}

function success(
  before: CanonicalPatent,
  after: CanonicalPatent,
  counts: Record<"claims" | "description" | "abstract", number>,
  message: string,
  recordHistory = true,
  historyBookKind?: "claims" | "description" | "abstract",
): ReferenceMarkPlanResult {
  return {
    ok: true,
    plan: {
      before,
      after,
      affectedBookKinds: after.books
        .filter(
          (book, index) =>
            JSON.stringify(book.document) !== JSON.stringify(before.books[index]?.document),
        )
        .map((book) => book.kind),
      counts,
      message,
      recordHistory,
      ...(historyBookKind ? { historyBookKind } : {}),
    },
  };
}
