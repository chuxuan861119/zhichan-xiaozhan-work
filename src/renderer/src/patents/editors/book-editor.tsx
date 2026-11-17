import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AssetDescriptor,
  InlineNode,
  PatentBookDocument,
} from "../../../../shared/document/model";
import { randomUuid } from "../../../../shared/id";
import type { JsonObject } from "../../../../shared/ipc/primitives";
import { planRegisterReferenceMark } from "../../../../shared/patent/reference-mark-registration";
import {
  type ClaimsDescriptionTarget,
  prepareClaimsForDescription,
} from "../../../../shared/patent/claims-to-description";
import type { PatentDocumentTarget } from "../../../../shared/patent/document-target";
import {
  type CanonicalPatent,
  PATENT_BOOK_LABELS,
  type PatentBookKind,
  type PatentFigure,
} from "../../../../shared/patent/model";
import {
  locateReferenceMarkIssues,
  type ReferenceMarkIssueLocation,
} from "../../../../shared/patent/reference-mark-issue-locator";
import { lastLegendParagraph } from "../../../../shared/patent/reference-mark-legend";
import {
  inspectReferenceMarkDescriptionState,
  planAssignReferenceNumber,
  planAssignDescriptionReferenceNumber,
  planCancelReferenceMark,
  planCompleteReferenceMarkReview,
  planFillReferenceMarksIntoDescription,
  planRemoveReferenceMarkRegistration,
  planReorderReferenceMarks,
  planSetReferenceMarkSync,
  planSupplementClaimsReferenceNumbers,
  planSupplementDescriptionReferenceNumbers,
  planUpdateReferenceMark,
  REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE,
  type ReferenceMarkMutationPlan,
  referenceMarkReviewOccurrenceCount,
} from "../../../../shared/patent/reference-mark-operations";
import {
  protectedClaimsKeywordSearches,
  protectedReferenceMarkKeywordSearches,
} from "../../../../shared/patent/reference-mark-text";
import { PATENT_PAGE_MARGIN_CSS_VARS } from "../../../../shared/settings/page-margins";
import type { EditorCommandBus, EditorSelectionBookmark } from "../../app/command-bus";
import { MotionPresence } from "../../app/motion-presence";
import { setReferenceMarkIssueHighlights } from "../../editor/extensions/reference-mark-issue-highlights";
import { setReferenceMarkReviewHighlights } from "../../editor/extensions/reference-mark-review-highlights";
import type { FormulaDrawingRequest } from "../../editor/formula-drawing-request";
import { rotateImagePreservingSize } from "../../editor/image/image-transform";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../../editor/model-adapter";
import type { TextCounts } from "../../editor/rich-text-editor-core";
import { TableRailPanel } from "../../editor/table/table-rail-panel";
import { ChemicalStructureRailPanel } from "../../editor/ui/chemical-structure-rail-panel";
import { FigureRailPanel } from "../../editor/ui/figure-rail-panel";
import { FindReplacePanel } from "../../editor/ui/find-replace-panel";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import type { OperationFeedback } from "../../shared/operation-feedback";
import { TransientFunctionRailSlot } from "../../shared/transient-function-rail-slot";
import { reportGuidanceProgress } from "../../writing-guidance/progress";
import { DocumentStructureRuler } from "../document-structure-ruler";
import { PatentBookTools } from "../patent-book-tools";
import { PatentGlobalFunctionRail } from "../patent-global-function-rail";
import type { PatentSession } from "../patent-reducer";
import { capabilitiesForPatentBook } from "../patent-toolbar-capabilities";
import type { WorkspacePane } from "../patent-workspace-layout";
import { BodyNumberConflictDialog } from "../reference-marks/body-number-conflict-dialog";
import {
  type InterruptedKeywordDecision,
  InterruptedKeywordDialog,
} from "../reference-marks/interrupted-keyword-dialog";
import {
  firstSupplementNumberLocation,
  scrollToSupplementNumber,
} from "../reference-marks/supplement-number-location";
import { useReferenceMarkStatus } from "../reference-marks/use-reference-mark-status";
import { AbstractDrawingEditor } from "./abstract-drawing-editor";
import {
  deleteFigures,
  drawingSyncSnapshot,
  existingDrawingExplanationParagraphs,
  fillDrawingExplanationParagraphs,
  readDrawingExplanationDrafts,
  reorderFigures,
} from "./drawing-sync-controller";
import { DrawingWorkbench } from "./drawing-workbench";
import type { DrawingImageImport } from "./drawings-editor";
import { PatentBookRichTextEditor, patentBookEditorId } from "./patent-book-rich-text-editor";

export type FindRailSession = Readonly<{
  mode: "find" | "replace";
  scope: "single" | WorkspacePane;
  target: PatentDocumentTarget;
  editorId: string;
  bookmark: EditorSelectionBookmark | null;
}>;

export type ReferenceMarkIssueNavigation = Readonly<{
  referenceMarkId: string;
  activeIndex: number;
}>;

type BookEditorProps = {
  session: PatentSession;
  commandBus: EditorCommandBus;
  onBookDocumentChange(
    bookKind: PatentBookKind,
    document: PatentBookDocument,
    editorState?: JsonObject,
    assets?: AssetDescriptor[],
  ): void;
  onTextCounts?(bookKind: PatentBookKind, counts: TextCounts): void;
  onPatentFiguresChange?(
    figures: PatentFigure[],
    abstractDrawingFigureId: string | null,
    assets: AssetDescriptor[],
    history?: {
      ownerBookKind: "description-drawings";
      label: string;
    },
  ): void;
  onImportDrawingImages?(): void;
  onOpenDrawingMarkup?(): void;
  onOpenDrawingFormula?(kind: "mathematical" | "physics"): void;
  onOpenDrawingChemistry?(kind: "equation" | "structure"): void;
  onEditChemicalFigure?(figureId: string, assetId: string): void;
  onOpenFlowchartEditor?(projectId?: string, replaceFigureId?: string): void;
  onPasteDrawingImages?(images: DrawingImageImport[]): void;
  findSession?: FindRailSession | null;
  findQuery?: string;
  findReplacement?: string;
  findOptions?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    searchMode?: "literal" | "wildcard" | "regex";
    useRegex?: boolean;
  };
  onFindOptionsChange?(options: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    searchMode?: "literal" | "wildcard" | "regex";
    useRegex?: boolean;
  }): void;
  onOpenFindRail?(mode: "find" | "replace", selectedText?: string): void;
  onFindModeChange?(mode: "find" | "replace" | null): void;
  onFindQueryChange?(value: string): void;
  onFindReplacementChange?(value: string): void;
  zoomPercent?: number;
  onApplyReferenceMarkPlan?(plan: ReferenceMarkMutationPlan): boolean;
  getReferenceMarkPatentSnapshot?(): CanonicalPatent | null;
  canUndoReferenceMarkPlan?(
    ownerBookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  ): boolean;
  onUndoReferenceMarkPlan?(
    ownerBookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
  ): boolean;
  referenceMarkIntroDismissed?: boolean;
  onDismissReferenceMarkIntro?(): undefined | Promise<unknown>;
  onRequestReferenceMarkRepair?(): void;
  onRetrySave?(): void | Promise<void>;
  onInsertFormulaDrawing?(request: FormulaDrawingRequest): void | Promise<void>;
  onCheckProblems?(): void;
  onAiCorrection?(): void;
  onTextPolish?(): void;

  inactiveSelectionVisible?: boolean;
  onActivateBook?(bookKind: PatentBookKind): void;
  onOperationFeedback?(feedback: OperationFeedback): void;
  referenceMarkLocatorEnabled?: boolean;
  inventionContentPrefix?: string;
  onOpenInventionContentSettings?(): void;
  activeReferenceMarkId?: string | null;
  recentReferenceMarkId?: string | null;
  onReferenceMarkActivate?(referenceMarkId: string | null): void;
  onCancelReferenceMarkLocator?(): void;
  onReferenceMarkLocatorEnabledChange?(enabled: boolean): void;
  onRecentReferenceMarkChange?(referenceMarkId: string | null): void;
  referenceMarkIssueNavigation?: ReferenceMarkIssueNavigation | null;
  onReferenceMarkIssueNavigationChange?(navigation: ReferenceMarkIssueNavigation | null): void;
};

function activeBook(session: PatentSession) {
  return session.patent.books.find((book) => book.kind === session.activeBookKind) ?? null;
}

function descriptionBook(session: PatentSession) {
  return session.patent.books.find((candidate) => candidate.kind === "description") ?? null;
}

function documentText(document: PatentBookDocument): string {
  return document.content
    .map((block) => {
      if (block.type === "paragraph" || block.type === "heading") return inlineText(block.content);
      if (block.type === "block-formula") return block.source;
      if (block.type === "table") {
        return block.rows
          .map((row) =>
            row.cells
              .map((cell) =>
                cell.content.map((paragraph) => inlineText(paragraph.content)).join(""),
              )
              .join(""),
          )
          .join("");
      }
      return "";
    })
    .join("");
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

function createBookEditorId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function BookEditor({
  session,
  commandBus,
  onBookDocumentChange,
  onTextCounts = () => undefined,
  onPatentFiguresChange = () => undefined,
  onImportDrawingImages = () => undefined,
  onOpenDrawingMarkup,
  onOpenFlowchartEditor = () => undefined,
  onPasteDrawingImages = () => undefined,
  findSession,
  findQuery,
  findReplacement,
  findOptions,
  onFindOptionsChange,
  onOpenFindRail,
  onFindModeChange,
  onFindQueryChange,
  onFindReplacementChange,
  zoomPercent = 100,
  onApplyReferenceMarkPlan = () => false,
  getReferenceMarkPatentSnapshot,
  canUndoReferenceMarkPlan = () => false,
  onUndoReferenceMarkPlan = () => false,
  referenceMarkIntroDismissed = true,
  onDismissReferenceMarkIntro = () => undefined,
  onRequestReferenceMarkRepair = () => undefined,
  onRetrySave = () => undefined,
  onInsertFormulaDrawing,
  onOpenDrawingFormula,
  onOpenDrawingChemistry,
  onEditChemicalFigure,
  onCheckProblems = () => undefined,
  onAiCorrection = () => undefined,
  onTextPolish = () => undefined,

  inactiveSelectionVisible = false,
  onActivateBook = () => undefined,
  onOperationFeedback = () => undefined,
  referenceMarkLocatorEnabled = true,
  inventionContentPrefix,
  onOpenInventionContentSettings,
  activeReferenceMarkId = null,
  recentReferenceMarkId = null,
  onReferenceMarkActivate = () => undefined,
  onCancelReferenceMarkLocator = () => undefined,
  onReferenceMarkLocatorEnabledChange = () => undefined,
  onRecentReferenceMarkChange = () => undefined,
  referenceMarkIssueNavigation: controlledReferenceMarkIssueNavigation,
  onReferenceMarkIssueNavigationChange,
}: BookEditorProps) {
  const { status: referenceMarkStatus, error: referenceMarkCheckError } = useReferenceMarkStatus(
    session.patent,
  );
  const [customReferenceNumberOpen, setCustomReferenceNumberOpen] = useState(false);
  const [pendingInterruptedNumbering, setPendingInterruptedNumbering] = useState<{
    keyword: string;
    requestedNumber: number | undefined;
    number: number;
    matchCount: number;
    examples: string[];
    contexts: string[];
    bodyNumberConflictDecision?: "use-anyway";
  } | null>(null);
  const [pendingBodyNumberConflict, setPendingBodyNumberConflict] = useState<{
    requestedNumber: number | undefined;
    number: number;
    contexts: string[];
  } | null>(null);
  const [referenceMarkReviewCursor, setReferenceMarkReviewCursor] = useState<{
    reviewKey: string;
    bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">;
    index: number;
  } | null>(null);
  const [localReferenceMarkIssueNavigation, setLocalReferenceMarkIssueNavigation] =
    useState<ReferenceMarkIssueNavigation | null>(null);
  const referenceMarkIssueNavigation =
    controlledReferenceMarkIssueNavigation ?? localReferenceMarkIssueNavigation;
  const setReferenceMarkIssueNavigation = useCallback(
    (navigation: ReferenceMarkIssueNavigation | null) => {
      if (onReferenceMarkIssueNavigationChange) {
        onReferenceMarkIssueNavigationChange(navigation);
        return;
      }
      setLocalReferenceMarkIssueNavigation(navigation);
    },
    [onReferenceMarkIssueNavigationChange],
  );
  const locatedReferenceMarkIssues = useMemo(
    () =>
      referenceMarkIssueNavigation
        ? locateReferenceMarkIssues(session.patent, referenceMarkIssueNavigation.referenceMarkId)
        : [],
    [referenceMarkIssueNavigation, session.patent],
  );
  const activeLocatedReferenceMarkIssue = referenceMarkIssueNavigation
    ? (locatedReferenceMarkIssues[referenceMarkIssueNavigation.activeIndex] ?? null)
    : null;
  useEffect(() => {
    if (referenceMarkCheckError)
      onOperationFeedback({ tone: "error", title: "检查未完成", message: referenceMarkCheckError });
  }, [referenceMarkCheckError, onOperationFeedback]);
  useEffect(() => {
    if (!referenceMarkIssueNavigation) return;
    if (locatedReferenceMarkIssues.length === 0) {
      setReferenceMarkIssueNavigation(null);
      return;
    }
    if (referenceMarkIssueNavigation.activeIndex >= locatedReferenceMarkIssues.length) {
      setReferenceMarkIssueNavigation({
        referenceMarkId: referenceMarkIssueNavigation.referenceMarkId,
        activeIndex: locatedReferenceMarkIssues.length - 1,
      });
    }
  }, [
    locatedReferenceMarkIssues.length,
    referenceMarkIssueNavigation,
    setReferenceMarkIssueNavigation,
  ]);
  const book = activeBook(session);
  if (!book) return <main aria-label="书册编辑器">未找到当前书册。</main>;
  const activeReferenceMarkKeyword =
    session.patent.referenceMarks.find((mark) => mark.referenceMarkId === activeReferenceMarkId)
      ?.keyword ?? null;

  const pendingReferenceMarkReview = REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE
    ? session.patent.referenceMarkSettings.pendingReview
    : undefined;
  const pendingReferenceMarkReviewKey = pendingReferenceMarkReview
    ? `${pendingReferenceMarkReview.referenceMarkId}:${pendingReferenceMarkReview.createdAt}`
    : null;
  const referenceHistoryOwner =
    book.kind === "claims" || book.kind === "description" || book.kind === "abstract"
      ? book.kind
      : "claims";

  const applyReferenceResult = (result: ReturnType<typeof planSetReferenceMarkSync>) => {
    if (!result.ok) return { ok: false, message: result.message };
    return onApplyReferenceMarkPlan(result.plan)
      ? { ok: true, message: result.plan.message }
      : { ok: false, message: "当前专利状态已变化，请重试。" };
  };
  const reportOperationResult = (
    result: { ok: boolean; message: string },
    titles: { success: string; error: string },
  ) => {
    onOperationFeedback({
      tone: result.ok ? "success" : "error",
      title: result.ok ? titles.success : titles.error,
      message: result.message,
    });
    return result;
  };
  // 填入附图标记后，等说明书编辑器渲染出图例段节点后平滑滚动到该位置。
  const scrollToFilledLegend = (editorId: string, legendId: string) => {
    let attempts = 20;
    const poll = () => {
      const editor = commandBus.getEditor(editorId);
      const target =
        editor?.view.dom.querySelector<HTMLElement>(`[data-nodeid="${legendId}"]`) ?? null;
      if (
        target &&
        !target.closest('[hidden], [inert], [aria-hidden="true"]') &&
        (typeof target.checkVisibility !== "function" || target.checkVisibility()) &&
        typeof target.scrollIntoView === "function"
      ) {
        const reducedMotion = isMotionReduced();
        target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        return;
      }
      if (attempts <= 0) return;
      attempts -= 1;
      setTimeout(poll, 50);
    };
    poll();
  };
  const replaceDocumentWithHistoryWhenReady = async (
    editorId: string,
    document: PatentBookDocument,
  ) => {
    const content = canonicalToTiptap(document);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (commandBus.replaceDocumentWithHistory(editorId, content)) return true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    return false;
  };
  const referenceMarkHighlightOptions = (
    kind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
    keyword: string,
    referenceMarkId: string,
  ) => {
    const document = session.patent.books.find((candidate) => candidate.kind === kind)?.document;
    if (!document) return {};
    const otherMarks = session.patent.referenceMarks.filter(
      (mark) => mark.referenceMarkId !== referenceMarkId,
    );
    const protectedSearches =
      kind === "claims"
        ? protectedClaimsKeywordSearches(document, keyword, otherMarks)
        : protectedReferenceMarkKeywordSearches(document, keyword, otherMarks, {
            includeUnparenthesizedNumbers: true,
          });
    const legend = kind === "description" ? lastLegendParagraph(document) : null;
    return {
      protectedSearches,
      ...(legend ? { excludedNodeIds: [legend.id] } : {}),
    };
  };
  const scrollToReferenceMarkReview = (
    bookKind: Extract<PatentBookKind, "claims" | "description" | "abstract">,
    index: number,
  ) => {
    let attempts = 20;
    const editorId = patentBookEditorId(session.sessionId, bookKind);
    const poll = () => {
      const editor = commandBus.getEditor(editorId);
      const keyword = session.patent.referenceMarkSettings.pendingReview?.keyword ?? null;
      if (editor && keyword) {
        const review = session.patent.referenceMarkSettings.pendingReview;
        setReferenceMarkReviewHighlights(
          editor,
          keyword,
          index,
          review ? referenceMarkHighlightOptions(bookKind, keyword, review.referenceMarkId) : {},
        );
        const target = editor.view.dom.querySelector<HTMLElement>(
          "[data-reference-mark-review-active='true']",
        );
        if (target && typeof target.scrollIntoView === "function") {
          const reducedMotion = isMotionReduced();
          target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        }
        return;
      }
      if (attempts <= 0) return;
      attempts -= 1;
      setTimeout(poll, 50);
    };
    poll();
  };
  const navigateReferenceMarkReview = (direction: "previous" | "next") => {
    const review = session.patent.referenceMarkSettings.pendingReview;
    if (!review) return;
    const reviewKey = `${review.referenceMarkId}:${review.createdAt}`;
    const currentCounts = Object.fromEntries(
      (["claims", "description", "abstract"] as const).map((kind) => {
        return [kind, referenceMarkReviewOccurrenceCount(session.patent, kind, review)];
      }),
    ) as Record<Extract<PatentBookKind, "claims" | "description" | "abstract">, number>;
    const orderedBooks = (["claims", "description", "abstract"] as const).filter(
      (kind) => currentCounts[kind] > 0,
    );
    if (orderedBooks.length === 0) {
      onOperationFeedback({
        tone: "error",
        title: "没有可定位内容",
        message: "当前文档中已找不到该关键词，请手动完成核对。",
      });
      return;
    }
    const current =
      referenceMarkReviewCursor?.reviewKey === reviewKey ? referenceMarkReviewCursor : null;
    let bookKind =
      current?.bookKind ??
      (orderedBooks.includes(referenceHistoryOwner)
        ? referenceHistoryOwner
        : (orderedBooks[0] as (typeof orderedBooks)[number]));
    let index = current?.index ?? (direction === "next" ? -1 : currentCounts[bookKind]);
    index += direction === "next" ? 1 : -1;
    if (index >= currentCounts[bookKind] || index < 0) {
      const currentBookIndex = orderedBooks.indexOf(bookKind);
      const offset = direction === "next" ? 1 : -1;
      bookKind =
        orderedBooks[(currentBookIndex + offset + orderedBooks.length) % orderedBooks.length] ??
        bookKind;
      index = direction === "next" ? 0 : Math.max(currentCounts[bookKind] - 1, 0);
    }
    setReferenceMarkReviewCursor({ reviewKey, bookKind, index });
    onActivateBook(bookKind);
    scrollToReferenceMarkReview(bookKind, index);
  };
  const scrollToReferenceMarkIssue = (
    location: ReferenceMarkIssueLocation,
    issues: readonly ReferenceMarkIssueLocation[],
  ) => {
    onActivateBook(location.bookKind);
    let attempts = 20;
    const poll = () => {
      const editor = commandBus.getEditor(patentBookEditorId(session.sessionId, location.bookKind));
      if (editor) {
        setReferenceMarkIssueHighlights(
          editor,
          issues.filter((issue) => issue.bookKind === location.bookKind),
          location.locationId,
        );
        const target = editor.view.dom.querySelector<HTMLElement>(
          "[data-reference-mark-issue-active='true']",
        );
        if (target && typeof target.scrollIntoView === "function") {
          const reducedMotion = isMotionReduced();
          target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        }
        return;
      }
      if (attempts <= 0) return;
      attempts -= 1;
      setTimeout(poll, 50);
    };
    poll();
  };
  const locateReferenceMarkIssue = (referenceMarkId: string) => {
    const issues = locateReferenceMarkIssues(session.patent, referenceMarkId);
    if (issues.length === 0) {
      onOperationFeedback({
        tone: "error",
        title: "没有可定位位置",
        message: "问题关键词或编号已完全缺失，请根据组件提示自行排查。",
      });
      return;
    }
    setReferenceMarkIssueNavigation({ referenceMarkId, activeIndex: 0 });
    const first = issues[0];
    if (first) scrollToReferenceMarkIssue(first, issues);
  };
  const navigateLocatedReferenceMarkIssue = (direction: "previous" | "next") => {
    if (!referenceMarkIssueNavigation || locatedReferenceMarkIssues.length === 0) return;
    const offset = direction === "next" ? 1 : -1;
    const activeIndex =
      (referenceMarkIssueNavigation.activeIndex + offset + locatedReferenceMarkIssues.length) %
      locatedReferenceMarkIssues.length;
    setReferenceMarkIssueNavigation({
      referenceMarkId: referenceMarkIssueNavigation.referenceMarkId,
      activeIndex,
    });
    const location = locatedReferenceMarkIssues[activeIndex];
    if (location) scrollToReferenceMarkIssue(location, locatedReferenceMarkIssues);
  };
  const referenceMarkProps = {
    shortcutsEnabled: !inactiveSelectionVisible,
    supplementShortcutEnabled: !inactiveSelectionVisible,
    onSupplementReferenceNumbers: (referenceMarkId?: string) => {
      const currentPatent = getReferenceMarkPatentSnapshot?.() ?? session.patent;
      const targetKind = book.kind === "claims" || referenceMarkId ? "claims" : "description";
      const result =
        targetKind === "claims"
          ? planSupplementClaimsReferenceNumbers(currentPatent, referenceMarkId)
          : planSupplementDescriptionReferenceNumbers(currentPatent);
      const count = result.ok ? result.plan.counts[targetKind] : 0;
      const applied =
        result.ok && count === 0
          ? { ok: true, message: result.plan.message }
          : applyReferenceResult(result);
      onOperationFeedback({
        tone: applied.ok ? "success" : "error",
        title: applied.ok ? applied.message : "无法增补编号",
        ...(!applied.ok ? { message: applied.message } : {}),
      });
      if (!applied.ok || !result.ok || !count) return;
      const before = result.plan.before.books.find((book) => book.kind === targetKind)?.document;
      const after = result.plan.after.books.find((book) => book.kind === targetKind)?.document;
      if (!before || !after) return;
      const location = firstSupplementNumberLocation(
        before,
        after,
        session.patent.referenceMarks.map((mark) => mark.keyword),
      );
      if (!location) return;
      let attempts = 20;
      const locate = () => {
        const editor = commandBus.getEditor(patentBookEditorId(session.sessionId, targetKind));
        if (editor && !editor.isDestroyed && scrollToSupplementNumber(editor, location)) return;
        if (--attempts > 0) window.setTimeout(locate, 50);
      };
      window.setTimeout(locate, 0);
    },
    unnumberedClaimsReferenceMarkIds: new Set(
      referenceMarkStatus.entries
        .filter((entry) => entry.unnumberedClaimsCount > 0)
        .map((entry) => entry.referenceMarkId),
    ),
    activeReferenceMarkId,
    onActivateReferenceMarkKeyword: (referenceMarkId: string) => {
      if (!referenceMarkLocatorEnabled) return;
      onReferenceMarkActivate(activeReferenceMarkId === referenceMarkId ? null : referenceMarkId);
    },
    missingReferenceMarkIds: referenceMarkStatus.missingReferenceMarkIds,
    missingReferenceMarkBooks: new Map(
      referenceMarkStatus.entries
        .filter((entry) => entry.missingInClaims || entry.missingInDescription)
        .map((entry) => [
          entry.referenceMarkId,
          [
            ...(entry.missingInClaims ? (["claims"] as const) : []),
            ...(entry.missingInDescription ? (["description"] as const) : []),
          ],
        ]),
    ),
    referenceMarkMismatchIds: new Set(
      referenceMarkStatus.entries
        .filter((entry) => entry.numberMismatch)
        .map((entry) => entry.referenceMarkId),
    ),
    referenceMarkWarningMessages: new Map(
      referenceMarkStatus.entries.flatMap((entry) => {
        const mark = session.patent.referenceMarks.find(
          (candidate) => candidate.referenceMarkId === entry.referenceMarkId,
        );
        const messages = [
          ...(entry.unnumberedClaimsCount > 0
            ? [
                `权利要求书中有 ${entry.unnumberedClaimsCount} 处“${mark?.keyword ?? "该关键词"}”未编号`,
              ]
            : []),
          ...(entry.nonstandardClaimsCount > 0
            ? [`有 ${entry.nonstandardClaimsCount} 处编号格式不规范`]
            : []),
          ...(entry.orphanClaimsNumberCount > 0
            ? [
                `权利要求书：编号 ${mark?.number ?? ""} 与关键词不匹配，共 ${entry.orphanClaimsNumberCount} 处。`,
              ]
            : []),
          ...(entry.locatableIssueCounts.description + entry.locatableIssueCounts.abstract > 0
            ? [
                `说明书或说明书摘要中有 ${
                  entry.locatableIssueCounts.description + entry.locatableIssueCounts.abstract
                } 处附图标记编号不一致`,
              ]
            : []),
        ];
        return messages.length > 0 ? [[entry.referenceMarkId, messages] as const] : [];
      }),
    ),
    locatableIssueCounts: new Map(
      referenceMarkStatus.entries.map((entry) => [
        entry.referenceMarkId,
        entry.locatableIssueCount,
      ]),
    ),
    locatedIssueState:
      referenceMarkIssueNavigation && locatedReferenceMarkIssues.length > 0
        ? {
            referenceMarkId: referenceMarkIssueNavigation.referenceMarkId,
            count: locatedReferenceMarkIssues.length,
            activeIndex: referenceMarkIssueNavigation.activeIndex,
          }
        : null,
    referenceMarkSync: referenceMarkStatus.sync,
    referenceMarkDescription: inspectReferenceMarkDescriptionState(session.patent),
    referenceMarkIntroDismissed,
    onDismissReferenceMarkIntro,
    onSetReferenceMarkSync: (enabled: boolean) =>
      applyReferenceResult(planSetReferenceMarkSync(session.patent, enabled)),
    onFillReferenceMarks: () => {
      const result = planFillReferenceMarksIntoDescription(session.patent);
      if (!result.ok) return applyReferenceResult(result);
      const legendId = filledLegendId(result.plan.after);
      const applied = applyReferenceResult(result);
      // 填入成功后平滑滚动说明书到图例段所在位置。
      if (applied.ok && legendId) {
        onActivateBook("description");
        scrollToFilledLegend(patentBookEditorId(session.sessionId, "description"), legendId);
      }
      return applied;
    },
    onAddReferenceMark: (entry: { number: number; keyword: string }) =>
      applyReferenceResult(planRegisterReferenceMark(getReferenceMarkPatentSnapshot?.() ?? session.patent, entry)),
    onLocateIssue: locateReferenceMarkIssue,
    onNavigateLocatedIssue: navigateLocatedReferenceMarkIssue,
    onCancelLocatedIssues: () => setReferenceMarkIssueNavigation(null),
    onEditReferenceMark: (entry: { referenceMarkId: string; number: number; keyword: string }) =>
      applyReferenceResult(
        planUpdateReferenceMark(session.patent, entry, {
          now: () => new Date(),
          ownerBookKind: referenceHistoryOwner,
        }),
      ),
    onReorderReferenceMarks: (ids: string[]) =>
      applyReferenceResult(planReorderReferenceMarks(session.patent, ids)),
    onCancelReferenceMark: (referenceMarkId: string) =>
      applyReferenceResult(planCancelReferenceMark(session.patent, referenceMarkId)),
    onRemoveReferenceMarkRegistration: (referenceMarkId: string) =>
      applyReferenceResult(planRemoveReferenceMarkRegistration(session.patent, referenceMarkId)),
    onCompleteReferenceMarkReview: (
      referenceMarkId: string,
      options?: { acceptCurrentDocument?: boolean },
    ) =>
      applyReferenceResult(
        planCompleteReferenceMarkReview(session.patent, referenceMarkId, options),
      ),
    onNavigateReferenceMarkReview: navigateReferenceMarkReview,
    canUndoReferenceMarkReview: pendingReferenceMarkReview
      ? canUndoReferenceMarkPlan(pendingReferenceMarkReview.ownerBookKind)
      : false,
    onUndoReferenceMarkReview: () =>
      pendingReferenceMarkReview &&
      onUndoReferenceMarkPlan(pendingReferenceMarkReview.ownerBookKind)
        ? { ok: true, message: "本次修改已撤销。" }
        : { ok: false, message: "文档已继续编辑，当前无法安全自动撤销。" },
    onOperationFeedback,
  };

  if (book.kind === "claims" || book.kind === "description" || book.kind === "abstract") {
    const editorId = patentBookEditorId(session.sessionId, book.kind);
    const structureRulerBookKind =
      book.kind === "claims" || book.kind === "description" ? book.kind : null;
    const completeReferenceNumbering = (referenceMarkId: string | null) => {
      onRecentReferenceMarkChange(referenceMarkId);
      commandBus.focus(editorId, { collapseSelection: true });
    };
    const assignReferenceNumber = (
      requestedNumber?: number,
      decisions: {
        interruptedKeywordDecision?: "keep" | "repair";
        bodyNumberConflictDecision?: "use-anyway";
      } = {},
    ) => {
      const selection = commandBus.getPlainTextSelection(editorId);
      if (!selection.ok) {
        if (requestedNumber === undefined) {
          reportOperationResult(selection, { success: "编号完成", error: "无法编号" });
        }
        return { ok: false, message: selection.message };
      }
      const existingEntry = session.patent.referenceMarks.find(
        (entry) => entry.keyword === selection.text.trim(),
      );
      let numberingPatent = session.patent;
      const editor = commandBus.getEditor(editorId);
      if (book.kind === "description") {
        const fail = (message: string) => {
          const result = { ok: false as const, message };
          if (requestedNumber === undefined)
            reportOperationResult(result, { success: "编号完成", error: "无法编号" });
          return result;
        };
        if (!editor || editor.view.composing) return fail("请先完成当前输入，再进行编号。");
        const snapshot = getReferenceMarkPatentSnapshot
          ? getReferenceMarkPatentSnapshot()
          : session.patent;
        if (!snapshot) return fail("当前专利状态尚未同步，请稍后重试。");
        const source = snapshot.books.find((candidate) => candidate.kind === "description");
        if (!source) return fail("说明书不存在。");
        const expected = editor.schema.nodeFromJSON(
          canonicalToTiptap({ ...source.document, assets: snapshot.assets }),
        );
        if (!editor.state.doc.eq(expected)) return fail("说明书正在同步最新内容，请稍后重试。");
        numberingPatent = snapshot;
      }
      const result =
        book.kind === "description"
          ? planAssignDescriptionReferenceNumber(
              numberingPatent,
              selection.text,
              editor!.state.selection.$from.index(0),
              { now: () => new Date(), createId: createBookEditorId },
              requestedNumber,
            )
          : planAssignReferenceNumber(
              session.patent,
              selection.text,
              {
                now: () => new Date(),
                createId: createBookEditorId,
              },
              requestedNumber,
              decisions,
            );
      if (!result.ok && result.code === "BODY_NUMBER_CONFLICT") {
        setPendingBodyNumberConflict({
          requestedNumber,
          number: result.bodyNumberConflict.number,
          contexts: result.bodyNumberConflict.contexts,
        });
        return { ok: false, pending: true, message: result.message };
      }
      if (!result.ok && result.code === "INTERRUPTED_KEYWORD_MATCHES") {
        setPendingInterruptedNumbering({
          keyword: result.interruptedKeywordRepair.keyword,
          requestedNumber,
          number: result.interruptedKeywordRepair.number,
          matchCount: result.interruptedKeywordRepair.matchCount,
          examples: result.interruptedKeywordRepair.examples,
          contexts: result.interruptedKeywordRepair.contexts,
          ...(decisions.bodyNumberConflictDecision
            ? { bodyNumberConflictDecision: decisions.bodyNumberConflictDecision }
            : {}),
        });
        return { ok: false, pending: true, message: result.message };
      }
      const applied = applyReferenceResult(result);
      if (applied.ok && result.ok) {
        const assigned = result.plan.after.referenceMarks.find(
          (entry) => entry.keyword === selection.text.trim(),
        );
        if (assigned)
          reportGuidanceProgress(
            commandBus.getEditor(editorId)?.view.dom ?? null,
            "numbered",
            `${assigned.keyword}—${assigned.number}`,
          );
        completeReferenceNumbering(assigned?.referenceMarkId ?? null);
      }
      if (requestedNumber === undefined) {
        reportOperationResult(
          applied.ok && existingEntry
            ? {
                ok: true,
                message: `“${existingEntry.keyword}”已编号为 ${existingEntry.number}，本次已沿用原序号。`,
              }
            : applied,
          {
            success: existingEntry
              ? `“${existingEntry.keyword}”已编号为 ${existingEntry.number}，沿用原序号`
              : "编号完成",
            error: "无法编号",
          },
        );
      }
      return applied;
    };
    const resolveInterruptedNumbering = (decision: InterruptedKeywordDecision) => {
      const pending = pendingInterruptedNumbering;
      setPendingInterruptedNumbering(null);
      if (!pending || decision === "cancel") return;
      const result = planAssignReferenceNumber(
        session.patent,
        pending.keyword,
        {
          now: () => new Date(),
          createId: createBookEditorId,
        },
        pending.requestedNumber,
        {
          interruptedKeywordDecision: decision,
          ...(pending.bodyNumberConflictDecision
            ? { bodyNumberConflictDecision: pending.bodyNumberConflictDecision }
            : {}),
        },
      );
      const applied = applyReferenceResult(result);
      if (applied.ok && result.ok) {
        const assigned = result.plan.after.referenceMarks.find(
          (entry) => entry.keyword === pending.keyword,
        );
        if (assigned)
          reportGuidanceProgress(
            commandBus.getEditor(editorId)?.view.dom ?? null,
            "numbered",
            `${assigned.keyword}—${assigned.number}`,
          );
        completeReferenceNumbering(assigned?.referenceMarkId ?? null);
      }
      reportOperationResult(applied, {
        success: "编号完成",
        error: "无法编号",
      });
    };
    const insertDependentClaim = () => {
      if (book.kind !== "claims") return;
      reportOperationResult(commandBus.insertDependentClaim(editorId), {
        success: "插入成功",
        error: "无法插入",
      });
    };
    const clearCurrentBookFormatting = () => {
      reportOperationResult(commandBus.clearExtraFormatting(editorId), {
        success: "格式清理完成",
        error: "无法清理格式",
      });
    };
    const findReplacePanel =
      findSession?.target.patentId === session.patentId &&
      findSession.target.kind === "book" &&
      findSession.target.bookKind === book.kind &&
      findSession.editorId === editorId ? (
        <div data-function-rail-owner={findSession.scope}>
          <FindReplacePanel
            editor={commandBus.getEditor(editorId)}
            mode={findSession.mode}
            query={findQuery ?? ""}
            replacement={findReplacement ?? ""}
            options={findOptions ?? {}}
            {...(onFindOptionsChange ? { onOptionsChange: onFindOptionsChange } : {})}
            {...(onFindModeChange ? { onModeChange: onFindModeChange } : {})}
            onShortcut={(mode) => onFindModeChange?.(findSession.mode === mode ? null : mode)}
            onQueryChange={onFindQueryChange ?? (() => undefined)}
            onReplacementChange={onFindReplacementChange ?? (() => undefined)}
            onClose={() => onFindModeChange?.(null)}
          />
        </div>
      ) : null;
    return (
      <div className="patent-book-editor-layout" data-patent-text-projection={editorId}>
        <div
          className="patent-page-with-rail"
          data-structure-ruler={structureRulerBookKind ? "true" : undefined}
          data-structure-ruler-offset={structureRulerBookKind ? undefined : "true"}
          style={
            {
              "--patent-page-zoom": zoomPercent / 100,
              "--patent-book-page-width": `${book.document.page.widthMm}mm`,
              "--patent-book-page-min-height": `${book.document.page.heightMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.top]: `${book.document.page.marginTopMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.right]: `${book.document.page.marginRightMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.bottom]: `${book.document.page.marginBottomMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.left]: `${book.document.page.marginLeftMm}mm`,
            } as CSSProperties
          }
        >
          {structureRulerBookKind ? (
            <DocumentStructureRuler
              document={book.document}
              bookKind={structureRulerBookKind}
              editorId={editorId}
              commandBus={commandBus}
              measurementKey={zoomPercent}
            />
          ) : null}
          <div className="patent-page-zoom-frame">
            <PatentBookRichTextEditor
              key={book.bookId}
              editorId={editorId}
              bookKind={book.kind}
              document={book.document}
              availableAssetIds={new Set(session.patent.assets.map((asset) => asset.assetId))}
              sessionId={session.sessionId}
              assets={session.patent.assets}
              commandBus={commandBus}
              capabilities={capabilitiesForPatentBook(book.kind)}
              {...(book.kind === "claims"
                ? {
                    onInsertDependentClaim: insertDependentClaim,
                  }
                : {})}
              {...((book.kind === "claims" || book.kind === "description") &&
              session.patent.drawingBooksEnabled
                ? {
                    onNumberSelection: () => {
                      assignReferenceNumber();
                    },
                  }
                : {})}
              activeSelectionVisible={
                (book.kind === "claims" || book.kind === "description") && customReferenceNumberOpen
              }
              inactiveSelectionVisible={inactiveSelectionVisible}
              referenceMarkReviewKeyword={pendingReferenceMarkReview?.keyword ?? null}
              referenceMarkReviewActiveIndex={
                referenceMarkReviewCursor?.reviewKey === pendingReferenceMarkReviewKey &&
                referenceMarkReviewCursor?.bookKind === book.kind
                  ? (referenceMarkReviewCursor?.index ?? null)
                  : null
              }
              referenceMarkIssueLocations={locatedReferenceMarkIssues.filter(
                (issue) => issue.bookKind === book.kind,
              )}
              referenceMarkIssueActiveLocationId={
                activeLocatedReferenceMarkIssue?.bookKind === book.kind
                  ? activeLocatedReferenceMarkIssue.locationId
                  : null
              }
              referenceMarkLocatorEnabled={referenceMarkLocatorEnabled}
              referenceMarks={session.patent.referenceMarks}
              activeReferenceMarkId={activeReferenceMarkId}
              recentReferenceMarkId={recentReferenceMarkId}
              onReferenceMarkActivate={onReferenceMarkActivate}
              onDocumentChange={(document, assets) =>
                onBookDocumentChange(book.kind, document, undefined, assets)
              }
              onTextCounts={(counts) => onTextCounts(book.kind, counts)}
              onFindModeChange={(mode, selectedText) => {
                if (mode) onOpenFindRail?.(mode, selectedText);
                else onFindModeChange?.(null);
              }}
              saveState={session.aggregateSaveState}
              onRetrySave={onRetrySave}
              {...(onInsertFormulaDrawing ? { onInsertFormulaDrawing } : {})}
            />
          </div>
          <PatentGlobalFunctionRail
            bookKind={book.kind}
            title={PATENT_BOOK_LABELS[book.kind]}
            measurementKey={zoomPercent}
            onCollapse={() => {
              if (findReplacePanel) onFindModeChange?.(null);
              onCancelReferenceMarkLocator();
            }}
          >
            <TransientFunctionRailSlot open={findReplacePanel !== null}>
              {findReplacePanel}
            </TransientFunctionRailSlot>
            <ChemicalStructureRailPanel
              commandBus={commandBus}
              editorId={editorId}
              contentWidthMm={
                book.document.page.widthMm -
                book.document.page.marginLeftMm -
                book.document.page.marginRightMm
              }
            />
            {book.kind === "claims" || book.kind === "description" ? (
              <FigureRailPanel
                commandBus={commandBus}
                editorId={editorId}
                sessionId={session.sessionId}
                onOperationFeedback={onOperationFeedback}
              />
            ) : null}
            {book.kind === "description" ? (
              <TableRailPanel commandBus={commandBus} editorId={editorId} />
            ) : null}
            <PatentBookTools
              session={session}
              editorId={editorId}
              onCheckProblems={onCheckProblems}
              onAiCorrection={onAiCorrection}
              onTextPolish={onTextPolish}
              abstractCharacterCount={
                book.kind === "abstract" ? documentText(book.document).length : 0
              }
              onInsertDependentClaim={insertDependentClaim}
              onPrepareClaimsDescription={(target) => {
                const availableAssets = new Set(
                  session.patent.assets.map((asset) => asset.assetId),
                );
                const books = session.patent.books.map((candidate) => {
                  if (candidate.kind !== "claims" && candidate.kind !== "description")
                    return candidate;
                  const editor = commandBus.getEditor(
                    patentBookEditorId(session.sessionId, candidate.kind),
                  );
                  if (!editor) return candidate;
                  if (editor.view.composing) throw new Error("请先完成当前输入，再进行转换。");
                  const current = tiptapToPatentBookDocument(
                    editor.getJSON(),
                    candidate.document,
                    availableAssets,
                    session.patent.assets,
                  );
                  if (!current.ok) throw new Error(current.error.message);
                  return { ...candidate, document: current.value };
                });
                return prepareClaimsForDescription(
                  { ...session.patent, books },
                  target,
                  inventionContentPrefix,
                );
              }}
              {...(onOpenInventionContentSettings ? { onOpenInventionContentSettings } : {})}
              onClaimsDescriptionCopied={(
                _target: ClaimsDescriptionTarget,
                nodeId: string | null,
              ) => {
                // No single matching heading means there is nowhere to jump: keep the copy free of
                // side effects and let the user paste it manually.
                if (!nodeId) return;
                onActivateBook("description");
                scrollToFilledLegend(patentBookEditorId(session.sessionId, "description"), nodeId);
              }}
              onClearExtraFormatting={clearCurrentBookFormatting}
              onSelectAbstractDrawing={(figureId) =>
                onPatentFiguresChange(session.patent.figures, figureId, session.patent.assets, {
                  ownerBookKind: "description-drawings",
                  label: "选择摘要附图",
                })
              }
              onImportDrawingImages={onImportDrawingImages}
              onAssignReferenceNumber={assignReferenceNumber}
              onCustomReferenceNumberOpenChange={setCustomReferenceNumberOpen}
              onRepairReferenceMarkSync={onRequestReferenceMarkRepair}
              referenceMarkLocatorEnabled={referenceMarkLocatorEnabled}
              activeReferenceMarkKeyword={activeReferenceMarkKeyword}
              onReferenceMarkLocatorEnabledChange={onReferenceMarkLocatorEnabledChange}
              onCancelReferenceMarkLocator={onCancelReferenceMarkLocator}
              {...referenceMarkProps}
            />
          </PatentGlobalFunctionRail>
        </div>
        <MotionPresence>
          {pendingInterruptedNumbering ? (
            <InterruptedKeywordDialog
              keyword={pendingInterruptedNumbering.keyword}
              number={pendingInterruptedNumbering.number}
              matchCount={pendingInterruptedNumbering.matchCount}
              examples={pendingInterruptedNumbering.examples}
              contexts={pendingInterruptedNumbering.contexts}
              onDecision={resolveInterruptedNumbering}
            />
          ) : null}
        </MotionPresence>
        <MotionPresence>
          {pendingBodyNumberConflict ? (
            <BodyNumberConflictDialog
              number={pendingBodyNumberConflict.number}
              contexts={pendingBodyNumberConflict.contexts}
              onCancel={() => setPendingBodyNumberConflict(null)}
              onConfirm={() => {
                const pending = pendingBodyNumberConflict;
                setPendingBodyNumberConflict(null);
                const result = assignReferenceNumber(pending.requestedNumber, {
                  bodyNumberConflictDecision: "use-anyway",
                });
                const stillPending = "pending" in result && result.pending;
                if (pending.requestedNumber !== undefined && !stillPending) {
                  reportOperationResult(result, {
                    success: "编号完成",
                    error: "无法编号",
                  });
                }
              }}
            />
          ) : null}
        </MotionPresence>
      </div>
    );
  }

  if (book.kind === "abstract-drawing") {
    return (
      <div className="drawing-editor-layout">
        <div
          className="patent-page-with-rail"
          data-structure-ruler-offset="true"
          style={
            {
              "--patent-page-zoom": zoomPercent / 100,
              "--patent-book-page-width": `${book.document.page.widthMm}mm`,
              "--patent-book-page-min-height": `${book.document.page.heightMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.top]: `${book.document.page.marginTopMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.right]: `${book.document.page.marginRightMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.bottom]: `${book.document.page.marginBottomMm}mm`,
              [PATENT_PAGE_MARGIN_CSS_VARS.left]: `${book.document.page.marginLeftMm}mm`,
            } as CSSProperties
          }
        >
          <AbstractDrawingEditor
            sessionId={session.sessionId}
            figures={session.patent.figures}
            selectedFigureId={session.patent.abstractDrawingFigureId}
          />
          <PatentGlobalFunctionRail bookKind={book.kind} title={PATENT_BOOK_LABELS[book.kind]}>
            <PatentBookTools
              session={session}
              editorId={null}
              onCheckProblems={onCheckProblems}
              onAiCorrection={onAiCorrection}
              onTextPolish={onTextPolish}
              abstractCharacterCount={0}
              onInsertDependentClaim={() => undefined}
              onClearExtraFormatting={() => undefined}
              onSelectAbstractDrawing={(figureId) =>
                onPatentFiguresChange(session.patent.figures, figureId, session.patent.assets, {
                  ownerBookKind: "description-drawings",
                  label: "选择摘要附图",
                })
              }
              onImportDrawingImages={onImportDrawingImages}
              {...referenceMarkProps}
            />
          </PatentGlobalFunctionRail>
        </div>
      </div>
    );
  }

  const description = descriptionBook(session);
  if (!description) return <main aria-label="附图编辑器">未找到说明书，无法显示附图说明。</main>;
  const sync = drawingSyncSnapshot({
    figures: session.patent.figures,
    descriptionDocument: description.document,
    descriptionEditorState: description.editorState,
  });
  const baseDrawingInput = {
    figures: session.patent.figures,
    assets: session.patent.assets,
    abstractDrawingFigureId: session.patent.abstractDrawingFigureId,
  };
  const emitFigureEdit = (
    edit: {
      figures: PatentFigure[];
      abstractDrawingFigureId: string | null;
      assets: AssetDescriptor[];
    },
    label: string,
  ) => {
    onPatentFiguresChange(edit.figures, edit.abstractDrawingFigureId, edit.assets, {
      ownerBookKind: "description-drawings",
      label,
    });
  };

  return (
    <div className="drawing-editor-layout">
      <DrawingWorkbench
        shortcutsEnabled={!inactiveSelectionVisible}
        sessionId={session.sessionId}
        patentType={session.patent.patentType}
        zoomPercent={zoomPercent}
        page={book.document.page}
        figures={session.patent.figures}
        assets={session.patent.assets}
        sync={sync.sync}
        unlinked={sync.unlinked}
        explanations={sync.entries}
        savedDrafts={readDrawingExplanationDrafts(book.editorState.drawingExplanationDrafts)}
        onDraftsChange={(drafts) =>
          onBookDocumentChange(book.kind, book.document, {
            ...book.editorState,
            drawingExplanationDrafts: drafts,
          })
        }
        existingExplanationText={existingDrawingExplanationParagraphs(description.document)
          .map((paragraph) =>
            paragraph.content
              .map((node) =>
                node.type === "text"
                  ? node.text
                  : node.type === "hard-break"
                    ? "\n"
                    : node.type === "inline-formula"
                      ? node.source
                      : "",
              )
              .join(""),
          )
          .join("\n")}
        flowchartProjects={session.patent.flowchartProjects}
        onOpenLinkedFlowchart={(projectId, figureId) => onOpenFlowchartEditor(projectId, figureId)}
        {...(onEditChemicalFigure ? { onEditChemicalStructure: onEditChemicalFigure } : {})}
        toolbar={({ referenceMarksCollapsed, onToggleReferenceMarksCollapse }) => (
          <PatentBookTools
            session={session}
            editorId={null}
            onCheckProblems={onCheckProblems}
            onAiCorrection={onAiCorrection}
            onTextPolish={onTextPolish}
            abstractCharacterCount={0}
            onInsertDependentClaim={() => undefined}
            onClearExtraFormatting={() => undefined}
            onSelectAbstractDrawing={(figureId) =>
              onPatentFiguresChange(session.patent.figures, figureId, session.patent.assets, {
                ownerBookKind: "description-drawings",
                label: "选择摘要附图",
              })
            }
            onImportDrawingImages={onImportDrawingImages}
            {...(onOpenDrawingMarkup ? { onOpenDrawingMarkup } : {})}
            {...(onOpenDrawingFormula ? { onOpenFormulaDrawing: onOpenDrawingFormula } : {})}
            {...(onOpenDrawingChemistry ? { onOpenChemistryDrawing: onOpenDrawingChemistry } : {})}
            {...referenceMarkProps}
            referenceMarkCollapsed={referenceMarksCollapsed}
            onToggleReferenceMarkCollapse={onToggleReferenceMarksCollapse}
          />
        )}
        onPasteImages={onPasteDrawingImages}
        onReorderFigures={(orderedFigures) =>
          emitFigureEdit(
            reorderFigures({
              orderedFigures,
              assets: baseDrawingInput.assets,
              abstractDrawingFigureId: baseDrawingInput.abstractDrawingFigureId,
            }),
            "调整附图顺序",
          )
        }
        onResizeFigure={(figureId, widthMm) =>
          onPatentFiguresChange(
            session.patent.figures.map((figure) =>
              figure.figureId === figureId ? { ...figure, widthMm } : figure,
            ),
            session.patent.abstractDrawingFigureId,
            session.patent.assets,
            { ownerBookKind: "description-drawings", label: "调整附图尺寸" },
          )
        }
        onRotateFigures={(figureIds, direction) => {
          const selectedIds = new Set(figureIds);
          const rotatedFigures = session.patent.figures.map((figure) => {
            if (!selectedIds.has(figure.figureId)) return figure;
            const asset = session.patent.assets.find((asset) => asset.assetId === figure.assetId);
            const geometry = rotateImagePreservingSize(
              figure,
              asset ? asset.widthPx / asset.heightPx : 1,
              direction,
            );
            return geometry ? { ...figure, ...geometry } : null;
          });
          if (rotatedFigures.some((figure) => figure === null)) {
            onOperationFeedback({
              tone: "error",
              title: "图片尺寸超出范围",
              message: "旋转后的宽度超出页面允许范围，请先调整图片大小。",
            });
            return;
          }
          onPatentFiguresChange(
            rotatedFigures.filter((figure) => figure !== null),
            session.patent.abstractDrawingFigureId,
            session.patent.assets,
            {
              ownerBookKind: "description-drawings",
              label: figureIds.length > 1 ? "批量旋转附图" : "旋转附图",
            },
          );
        }}
        onChange={async (changes) => {
          try {
            const result = fillDrawingExplanationParagraphs({
              document: description.document,
              changes,
              createId: randomUuid,
            });
            const descriptionEditorId = patentBookEditorId(session.sessionId, "description");
            onActivateBook("description");
            if (
              !(await replaceDocumentWithHistoryWhenReady(descriptionEditorId, result.document))
            ) {
              return {
                ok: false,
                message: "说明书编辑器尚未就绪，请稍后重试。",
              };
            }
            scrollToFilledLegend(descriptionEditorId, result.firstParagraphId);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : "附图说明未能写入，请重试。",
            };
          }
        }}
        onOperationFeedback={onOperationFeedback}
        onDeleteFigure={(figureId) =>
          emitFigureEdit(
            deleteFigures({
              ...baseDrawingInput,
              figureIds: [figureId],
            }),
            "删除附图",
          )
        }
        onDeleteFigures={(figureIds) =>
          emitFigureEdit(
            deleteFigures({
              ...baseDrawingInput,
              figureIds,
            }),
            figureIds.length > 1 ? "批量删除附图" : "删除附图",
          )
        }
      />
    </div>
  );
}

/** 填入计划目标说明书文档中的图例段 id（用于填入后滚动定位）。 */
function filledLegendId(patent: CanonicalPatent): string | null {
  const description = patent.books.find((book) => book.kind === "description");
  const legend = description ? lastLegendParagraph(description.document) : null;
  return legend ? legend.id : null;
}
