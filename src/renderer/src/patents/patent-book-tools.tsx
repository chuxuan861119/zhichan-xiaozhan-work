import {
  CirclePlus,
  DraftingCompass,
  Eraser,
  ImagePlus,
  ListChecks,
  ListPlus,
  SpellCheck,
} from "lucide-react";
import type {
  ClaimsDescriptionResult,
  ClaimsDescriptionTarget,
} from "../../../shared/patent/claims-to-description";
import type { PatentBookKind } from "../../../shared/patent/model";
import type {
  ReferenceMarkDescriptionState,
  ReferenceMarkSyncState,
} from "../../../shared/patent/reference-mark-operations";
import { shortcutTooltip } from "../../../shared/settings/shortcuts";
import { useConfiguredShortcut, useShortcutAction } from "../app/shortcut-dispatcher";
import { AiExperimentalEntry } from "../shared/ai-experimental-notice";
import type { OperationFeedback } from "../shared/operation-feedback";
import { ClaimsToDescriptionPanel } from "./claims-to-description-panel";
import type { PatentSession } from "./patent-reducer";
import { ReferenceMarkLocatorPanel } from "./reference-marks/reference-mark-locator-panel";
import { ReferenceMarkPanel } from "./reference-marks/reference-mark-panel";
import type { AddReferenceMarkAction } from "./reference-marks/add-reference-mark";

type PatentBookToolsProps = {
  session: PatentSession;
  editorId: string | null;
  abstractCharacterCount: number;
  onCheckProblems?(): void;
  onAiCorrection?(): void;
  onTextPolish?(): void;
  onInsertDependentClaim(): void;
  onPrepareClaimsDescription?(target: ClaimsDescriptionTarget): ClaimsDescriptionResult;
  onOpenInventionContentSettings?(): void;
  onClaimsDescriptionCopied?(target: ClaimsDescriptionTarget, nodeId: string | null): void;
  onClearExtraFormatting?(): void;
  onSupplementReferenceNumbers?(referenceMarkId?: string): void;
  unnumberedClaimsReferenceMarkIds?: ReadonlySet<string>;
  supplementShortcutEnabled?: boolean;
  shortcutsEnabled?: boolean;
  onSelectAbstractDrawing(figureId: string | null): void;
  onImportDrawingImages?(): void;
  onOpenDrawingMarkup?(): void;
  onOpenFormulaDrawing?(kind: "mathematical" | "physics"): void;
  onOpenChemistryDrawing?(kind: "equation" | "structure"): void;
  onAssignReferenceNumber?(
    number?: number,
  ): { ok: boolean; message: string; pending?: boolean } | undefined;
  onCustomReferenceNumberOpenChange?(open: boolean): void;
  onSetReferenceMarkSync?(enabled: boolean): { ok: boolean; message: string };
  onEditReferenceMark?(entry: { referenceMarkId: string; number: number; keyword: string }): {
    ok: boolean;
    message: string;
  };
  onCancelReferenceMark?(referenceMarkId: string): {
    ok: boolean;
    message: string;
  };
  onReorderReferenceMarks?(ids: string[]): { ok: boolean; message: string };
  onRemoveReferenceMarkRegistration?(referenceMarkId: string): {
    ok: boolean;
    message: string;
  };
  onCompleteReferenceMarkReview?(
    referenceMarkId: string,
    options?: { acceptCurrentDocument?: boolean },
  ): { ok: boolean; message: string };
  onNavigateReferenceMarkReview?(direction: "previous" | "next"): void;
  canUndoReferenceMarkReview?: boolean;
  onUndoReferenceMarkReview?(): { ok: boolean; message: string };
  onRepairReferenceMarkSync?(): void;
  missingReferenceMarkIds?: ReadonlySet<string>;
  missingReferenceMarkBooks?: ReadonlyMap<string, readonly ("claims" | "description")[]>;
  referenceMarkMismatchIds?: ReadonlySet<string>;
  referenceMarkWarningMessages?: ReadonlyMap<string, readonly string[]>;
  locatableIssueCounts?: ReadonlyMap<string, number>;
  locatedIssueState?: Readonly<{
    referenceMarkId: string;
    count: number;
    activeIndex: number;
  }> | null;
  referenceMarkSync?: ReferenceMarkSyncState;
  referenceMarkDescription?: ReferenceMarkDescriptionState;
  onFillReferenceMarks?(): { ok: boolean; message: string };
  onAddReferenceMark?: AddReferenceMarkAction;
  referenceMarkIntroDismissed?: boolean;
  onDismissReferenceMarkIntro?(): undefined | Promise<unknown>;
  referenceMarkCollapsed?: boolean;
  onToggleReferenceMarkCollapse?(): void;
  onOperationFeedback?(feedback: OperationFeedback): void;
  referenceMarkLocatorEnabled?: boolean;
  activeReferenceMarkKeyword?: string | null;
  activeReferenceMarkId?: string | null;
  onReferenceMarkLocatorEnabledChange?(enabled: boolean): void;
  onCancelReferenceMarkLocator?(): void;
  onLocateIssue?(referenceMarkId: string): void;
  onNavigateLocatedIssue?(direction: "previous" | "next"): void;
  onCancelLocatedIssues?(): void;
  onActivateReferenceMarkKeyword?(referenceMarkId: string): void;
};

function activeBookKind(session: PatentSession): PatentBookKind {
  return session.activeBookKind;
}

function abstractCharacterLimitWarning(session: PatentSession): string {
  const provision =
    session.patent.patentType === "invention"
      ? "《专利审查指南》第一部分第一章第 4.5.1 节"
      : "《专利审查指南》第二部分第二章第 2.4 节第（4）项";
  return `摘要超过 300 字，不符合${provision}规定的摘要文字部分（包括标点符号）不得超过 300 个字的要求。`;
}

export function PatentBookTools({
  shortcutsEnabled = true,
  session,
  editorId,
  abstractCharacterCount,
  onCheckProblems = () => undefined,
  onAiCorrection = () => undefined,
  onTextPolish = () => undefined,
  onInsertDependentClaim,
  onPrepareClaimsDescription,
  onOpenInventionContentSettings,
  onClaimsDescriptionCopied,
  onClearExtraFormatting = () => undefined,
  onSupplementReferenceNumbers,
  unnumberedClaimsReferenceMarkIds,
  supplementShortcutEnabled = true,
  onSelectAbstractDrawing,
  onImportDrawingImages = () => undefined,
  onOpenDrawingMarkup,
  onAssignReferenceNumber = () => undefined,
  onCustomReferenceNumberOpenChange = () => undefined,
  onSetReferenceMarkSync = () => ({ ok: true, message: "" }),
  onEditReferenceMark = () => ({ ok: true, message: "" }),
  onReorderReferenceMarks,
  onCancelReferenceMark = () => ({ ok: true, message: "" }),
  onRemoveReferenceMarkRegistration = () => ({
    ok: false,
    message: "当前无法移除附图标记登记。",
  }),
  onCompleteReferenceMarkReview,
  onNavigateReferenceMarkReview,
  canUndoReferenceMarkReview = false,
  onUndoReferenceMarkReview,
  onRepairReferenceMarkSync,
  missingReferenceMarkIds = new Set(),
  missingReferenceMarkBooks = new Map(),
  referenceMarkMismatchIds = new Set<string>(),
  referenceMarkWarningMessages = new Map(),
  locatableIssueCounts = new Map(),
  locatedIssueState = null,
  referenceMarkSync = {
    status: "active",
    legendParagraphId: null,
  } as ReferenceMarkSyncState,
  referenceMarkDescription = {
    status: "aligned",
    currentText: "",
    targetText: "",
  },
  onFillReferenceMarks,
  onAddReferenceMark,
  referenceMarkIntroDismissed = true,
  onDismissReferenceMarkIntro = () => undefined,
  referenceMarkCollapsed = false,
  onToggleReferenceMarkCollapse,
  onOperationFeedback,
  referenceMarkLocatorEnabled = true,
  activeReferenceMarkKeyword = null,
  activeReferenceMarkId = null,
  onReferenceMarkLocatorEnabledChange = () => undefined,
  onCancelReferenceMarkLocator = () => undefined,
  onLocateIssue = () => undefined,
  onNavigateLocatedIssue = () => undefined,
  onCancelLocatedIssues = () => undefined,
  onActivateReferenceMarkKeyword = () => undefined,
}: PatentBookToolsProps) {
  const bookKind = activeBookKind(session);
  const isTextBook = bookKind === "claims" || bookKind === "description" || bookKind === "abstract";
  const clearExtraFormattingShortcut = useConfiguredShortcut("clear-extra-formatting");
  const checkProblemsShortcut = useConfiguredShortcut("check-problems");
  const aiCorrectionShortcut = useConfiguredShortcut("ai-correction");
  const insertDependentClaimShortcut = useConfiguredShortcut("insert-dependent-claim");
  const supplementShortcut = useConfiguredShortcut("supplement-reference-numbers");
  const importDrawingImagesShortcut = useConfiguredShortcut("import-drawing-images");
  const customShortcutTitle = (label: string, shortcut: string | null) =>
    shortcutTooltip({
      label,
      shortcuts: shortcut ? [shortcut] : [],
      binding: "custom",
      visibleLabel: true,
    });
  useShortcutAction("clear-extra-formatting", isTextBook && shortcutsEnabled, () => {
    onClearExtraFormatting();
    return true;
  });
  useShortcutAction("check-problems", isTextBook && shortcutsEnabled, () => {
    onCheckProblems();
    return true;
  });
  useShortcutAction("ai-correction", isTextBook && shortcutsEnabled, () => {
    onAiCorrection();
    return true;
  });
  useShortcutAction("insert-dependent-claim", bookKind === "claims" && shortcutsEnabled, () => {
    onInsertDependentClaim();
    return true;
  });
  useShortcutAction(
    "supplement-reference-numbers",
    (bookKind === "description" || bookKind === "claims") &&
      session.patent.drawingBooksEnabled &&
      supplementShortcutEnabled &&
      shortcutsEnabled &&
      !!onSupplementReferenceNumbers,
    () => {
      onSupplementReferenceNumbers?.();
      return true;
    },
  );
  useShortcutAction(
    "import-drawing-images",
    bookKind === "description-drawings" && shortcutsEnabled,
    () => {
      onImportDrawingImages();
      return true;
    },
  );
  const problemCheck = (
    <div className="patent-book-tools__problem-check">
      <button
        type="button"
        className="patent-book-tools__problem-check-button"
        aria-keyshortcuts={checkProblemsShortcut || undefined}
        onClick={onCheckProblems}
      >
        <ListChecks aria-hidden="true" />
        本地检查
      </button>
    </div>
  );
  const intelligentAssistance = (
    <div className="patent-book-tools__problem-check">
      <span className="compact-tool-actions__label compact-tool-actions__label--separated">
        智能辅助
      </span>
      <AiExperimentalEntry label="AI 纠错" iconOnly>
        <button
          type="button"
          className="patent-book-tools__ai-correction-button"
          aria-keyshortcuts={aiCorrectionShortcut || undefined}
          onClick={onAiCorrection}
        >
          <SpellCheck aria-hidden="true" />
          AI 纠错
        </button>
      </AiExperimentalEntry>
      <AiExperimentalEntry label="小栈AI助手" iconOnly>
        <button
          type="button"
          className="patent-book-tools__text-polish-button"
          onClick={onTextPolish}
        >
          <span aria-hidden="true" className="xiaozhan-ai-tool-icon">
            AI
          </span>
          小栈AI助手
        </button>
      </AiExperimentalEntry>
    </div>
  );
  const referencePanel = session.patent.drawingBooksEnabled ? (
    <ReferenceMarkPanel
      shortcutsEnabled={shortcutsEnabled}
      patent={session.patent}
      actionsInHeader={bookKind === "claims" || bookKind === "description"}
      sync={referenceMarkSync}
      missingReferenceMarkIds={missingReferenceMarkIds}
      missingReferenceMarkBooks={missingReferenceMarkBooks}
      mismatchReferenceMarkIds={referenceMarkMismatchIds}
      warningMessages={referenceMarkWarningMessages}
      locatableIssueCounts={locatableIssueCounts}
      locatedIssueState={locatedIssueState}
      referenceMarkDescription={referenceMarkDescription}
      introDismissed={referenceMarkIntroDismissed}
      onDismissIntro={onDismissReferenceMarkIntro}
      onSetSynchronizedEditing={onSetReferenceMarkSync}
      {...(onFillReferenceMarks ? { onFillReferenceMarks } : {})}
      {...(onAddReferenceMark ? { onAddReferenceMark } : {})}
      onEdit={onEditReferenceMark}
      {...(onReorderReferenceMarks ? { onReorder: onReorderReferenceMarks } : {})}
      onCancel={onCancelReferenceMark}
      onRemoveRegistration={onRemoveReferenceMarkRegistration}
      onLocateIssue={onLocateIssue}
      {...(bookKind === "claims" && onSupplementReferenceNumbers
        ? {
            onSupplementNumbers: onSupplementReferenceNumbers,
            unnumberedClaimsReferenceMarkIds,
          }
        : {})}
      onNavigateLocatedIssue={onNavigateLocatedIssue}
      onCancelLocatedIssues={onCancelLocatedIssues}
      keywordHighlightEnabled={referenceMarkLocatorEnabled}
      activeReferenceMarkId={activeReferenceMarkId}
      onActivateKeyword={onActivateReferenceMarkKeyword}
      {...(onCompleteReferenceMarkReview
        ? { onCompleteReview: onCompleteReferenceMarkReview }
        : {})}
      {...(onNavigateReferenceMarkReview
        ? { onNavigateReview: onNavigateReferenceMarkReview }
        : {})}
      canUndoReview={canUndoReferenceMarkReview}
      {...(onUndoReferenceMarkReview ? { onUndoReview: onUndoReferenceMarkReview } : {})}
      {...(onOperationFeedback ? { onOperationFeedback } : {})}
      {...(bookKind === "claims" || bookKind === "description"
        ? { onAssignReferenceNumber, numberingBookKind: bookKind }
        : {})}
      {...(bookKind === "claims" || bookKind === "description"
        ? { onCustomNumberOpenChange: onCustomReferenceNumberOpenChange }
        : {})}
      {...(bookKind === "claims" && onRepairReferenceMarkSync
        ? { onRepairSync: onRepairReferenceMarkSync }
        : {})}
      {...(bookKind === "description-drawings" && onToggleReferenceMarkCollapse
        ? {
            collapsed: referenceMarkCollapsed,
            onToggleCollapsed: onToggleReferenceMarkCollapse,
          }
        : {})}
    />
  ) : null;
  const referencePanelHost = referencePanel ? (
    <div className="patent-book-tools">{referencePanel}</div>
  ) : null;
  const referenceMarkLocator = isTextBook ? (
    <div className="patent-book-tools">
      <ReferenceMarkLocatorPanel
        enabled={referenceMarkLocatorEnabled}
        activeKeyword={activeReferenceMarkKeyword}
        onEnabledChange={onReferenceMarkLocatorEnabledChange}
        onCancel={onCancelReferenceMarkLocator}
      />
    </div>
  ) : null;
  if (!editorId && bookKind !== "abstract-drawing" && bookKind !== "description-drawings") {
    return null;
  }

  if (bookKind === "claims") {
    return (
      <>
        <fieldset className="patent-book-tools compact-tool-actions" aria-label="权利要求书工具">
          <span className="compact-tool-actions__label">文档工具</span>
          <button
            type="button"
            className="patent-book-tools__clear-extra-formatting"
            title={customShortcutTitle("清除多余格式", clearExtraFormattingShortcut)}
            onClick={onClearExtraFormatting}
          >
            <Eraser aria-hidden="true" />
            清除多余格式
          </button>
          {problemCheck}
          <button
            type="button"
            title={customShortcutTitle("插入从权", insertDependentClaimShortcut)}
            className="patent-book-tools__insert-dependent-claim"
            onClick={onInsertDependentClaim}
          >
            <ListPlus aria-hidden="true" />
            插入从权
          </button>
          <button
            type="button"
            className="patent-book-tools__supplement-claims-numbers"
            disabled={!session.patent.drawingBooksEnabled || !onSupplementReferenceNumbers}
            onClick={() => onSupplementReferenceNumbers?.()}
            aria-keyshortcuts={supplementShortcut || undefined}
          >
            <CirclePlus strokeWidth={1.5} aria-hidden="true" />
            增补编号
          </button>
          {onPrepareClaimsDescription && onClaimsDescriptionCopied && onOperationFeedback ? (
            <ClaimsToDescriptionPanel
              key={session.sessionId}
              onPrepare={onPrepareClaimsDescription}
              {...(onOpenInventionContentSettings
                ? { onOpenSettings: onOpenInventionContentSettings }
                : {})}
              onCopied={onClaimsDescriptionCopied}
              onFeedback={onOperationFeedback}
            />
          ) : null}
          {intelligentAssistance}
        </fieldset>
        {referencePanelHost}
        {referenceMarkLocator}
      </>
    );
  }

  if (bookKind === "description") {
    return (
      <>
        <fieldset className="patent-book-tools compact-tool-actions" aria-label="说明书工具">
          <span className="compact-tool-actions__label">文档工具</span>
          <button
            type="button"
            className="patent-book-tools__clear-extra-formatting"
            title={customShortcutTitle("清除多余格式", clearExtraFormattingShortcut)}
            onClick={onClearExtraFormatting}
          >
            <Eraser aria-hidden="true" />
            清除多余格式
          </button>
          <button
            type="button"
            className="patent-book-tools__supplement-reference-numbers"
            disabled={!session.patent.drawingBooksEnabled || !onSupplementReferenceNumbers}
            onClick={() => onSupplementReferenceNumbers?.()}
            aria-keyshortcuts={supplementShortcut || undefined}
          >
            <CirclePlus strokeWidth={1.5} aria-hidden="true" />
            增补编号
          </button>
          {problemCheck}
          {intelligentAssistance}
        </fieldset>
        {referencePanelHost}
        {referenceMarkLocator}
      </>
    );
  }

  if (bookKind === "abstract") {
    return (
      <>
        <fieldset className="patent-book-tools compact-tool-actions" aria-label="说明书摘要工具">
          <span className="compact-tool-actions__label">文档工具</span>
          <button
            type="button"
            className="patent-book-tools__clear-extra-formatting"
            title={customShortcutTitle("清除多余格式", clearExtraFormattingShortcut)}
            onClick={onClearExtraFormatting}
          >
            <Eraser aria-hidden="true" />
            清除多余格式
          </button>
          {problemCheck}
          {intelligentAssistance}
          <span>摘要字数：{abstractCharacterCount}</span>
          {abstractCharacterCount > 300 ? (
            <output className="patent-book-tools__warning" role="alert">
              {abstractCharacterLimitWarning(session)}
            </output>
          ) : null}
        </fieldset>
        {referenceMarkLocator}
      </>
    );
  }

  if (bookKind === "abstract-drawing") {
    return (
      <fieldset className="patent-book-tools" aria-label="摘要附图工具">
        <label>
          摘要附图
          <select
            className="patent-book-tools__abstract-drawing-select"
            value={session.patent.abstractDrawingFigureId ?? ""}
            disabled={session.patent.figures.length === 0}
            onChange={(event) => onSelectAbstractDrawing(event.target.value || null)}
          >
            <option value="">不选择</option>
            {session.patent.figures.map((figure, index) => (
              <option key={figure.figureId} value={figure.figureId}>
                图{index + 1}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
    );
  }

  if (bookKind === "description-drawings") {
    return (
      <fieldset className="patent-book-tools compact-drawing-import" aria-label="说明书附图工具">
        <button
          type="button"
          title={customShortcutTitle("导入图片", importDrawingImagesShortcut)}
          onClick={onImportDrawingImages}
        >
          <ImagePlus aria-hidden="true" />
          导入图片
        </button>
        <button
          type="button"
          className="cad-markup-entry"
          disabled={!onOpenDrawingMarkup}
          onClick={onOpenDrawingMarkup}
        >
          <DraftingCompass aria-hidden="true" />
          CAD标号
        </button>
        {referencePanel}
      </fieldset>
    );
  }

  return null;
}
