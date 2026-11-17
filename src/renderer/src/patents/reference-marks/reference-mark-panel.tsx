import { ListOrdered, PencilLine, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanonicalPatent } from "../../../../shared/patent/model";
import {
  REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE,
  type ReferenceMarkDescriptionState,
  type ReferenceMarkSyncState,
} from "../../../../shared/patent/reference-mark-operations";
import { formatReferenceMarkText } from "../../../../shared/patent/reference-marks";
import { platformShortcut } from "../../../../shared/platform";
import { MotionPresence } from "../../app/motion-presence";
import { useConfiguredShortcut, useShortcutAction } from "../../app/shortcut-dispatcher";
import { prefersReducedMotion as isMotionReduced } from "../../shared/motion-preference";
import type { OperationFeedback } from "../../shared/operation-feedback";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import { StandardDialog } from "../../shared/standard-dialog";
import { useOptionalPatentFunctionRail } from "../function-rail/function-rail-context";
import "./reference-mark-remove-dialog.css";
import "./reference-mark-order.css";
import { useReferenceMarkOrder } from "./use-reference-mark-order";
import { AddReferenceMark, type AddReferenceMarkAction } from "./add-reference-mark";

type ActionResult = { ok: boolean; message: string; pending?: boolean };
type ReferenceMarkPanelProps = {
  shortcutsEnabled?: boolean;
  patent: CanonicalPatent;
  sync?: ReferenceMarkSyncState;
  missingReferenceMarkIds: ReadonlySet<string>;
  missingReferenceMarkBooks?: ReadonlyMap<string, readonly ("claims" | "description")[]>;
  mismatchReferenceMarkIds?: ReadonlySet<string>;
  warningMessages?: ReadonlyMap<string, readonly string[]>;
  locatableIssueCounts?: ReadonlyMap<string, number>;
  locatedIssueState?: Readonly<{
    referenceMarkId: string;
    count: number;
    activeIndex: number;
  }> | null;
  introDismissed?: boolean;
  onDismissIntro?(): undefined | Promise<unknown>;
  onSetSynchronizedEditing(enabled: boolean): ActionResult;
  referenceMarkDescription?: ReferenceMarkDescriptionState;
  onFillReferenceMarks?(): ActionResult;
  onAddReferenceMark?: AddReferenceMarkAction;
  onEdit(entry: { referenceMarkId: string; number: number; keyword: string }): ActionResult;
  onCancel(referenceMarkId: string): ActionResult;
  onReorder?(ids: string[]): ActionResult;
  onRemoveRegistration?(referenceMarkId: string): ActionResult;
  onCompleteReview?(
    referenceMarkId: string,
    options?: { acceptCurrentDocument?: boolean },
  ): ActionResult;
  onNavigateReview?(direction: "previous" | "next"): void;
  canUndoReview?: boolean;
  onUndoReview?(): ActionResult;
  onAssignReferenceNumber?(number?: number): ActionResult | undefined;
  numberingBookKind?: "claims" | "description";
  onCustomNumberOpenChange?(open: boolean): void;
  onRepairSync?(): void;
  onLocateIssue?(referenceMarkId: string): void;
  onSupplementNumbers?(referenceMarkId: string): void;
  unnumberedClaimsReferenceMarkIds?: ReadonlySet<string> | undefined;
  onNavigateLocatedIssue?(direction: "previous" | "next"): void;
  onCancelLocatedIssues?(): void;
  keywordHighlightEnabled?: boolean;
  activeReferenceMarkId?: string | null;
  onActivateKeyword?(referenceMarkId: string): void;
  onOperationFeedback?(feedback: OperationFeedback): void;
  collapsed?: boolean;
  actionsInHeader?: boolean;
  onToggleCollapsed?(): void;
};

type RowDraft = { number: string; keyword: string };
type RowErrors = Record<string, string>;

export function ReferenceMarkPanel({
  shortcutsEnabled = true,
  patent,
  sync = { status: "active", legendParagraphId: null },
  missingReferenceMarkIds,
  missingReferenceMarkBooks = new Map(),
  mismatchReferenceMarkIds = new Set<string>(),
  warningMessages = new Map(),
  locatableIssueCounts = new Map(),
  locatedIssueState = null,
  introDismissed = true,
  onDismissIntro = () => undefined,
  onSetSynchronizedEditing,
  referenceMarkDescription = { status: "aligned", currentText: "", targetText: "" },
  onFillReferenceMarks,
  onAddReferenceMark,
  onEdit,
  onCancel,
  onReorder,
  onRemoveRegistration = () => ({ ok: false, message: "当前无法移除附图标记登记。" }),
  onCompleteReview = () => ({ ok: false, message: "待核对任务不存在。" }),
  onNavigateReview = () => undefined,
  canUndoReview = false,
  onUndoReview = () => ({ ok: false, message: "当前无法撤销本次修改。" }),
  onAssignReferenceNumber,
  numberingBookKind = "claims",
  onCustomNumberOpenChange = () => undefined,
  onRepairSync,
  onLocateIssue = () => undefined,
  onSupplementNumbers,
  unnumberedClaimsReferenceMarkIds,
  onNavigateLocatedIssue = () => undefined,
  onCancelLocatedIssues = () => undefined,
  keywordHighlightEnabled = true,
  activeReferenceMarkId = null,
  onActivateKeyword = () => undefined,
  onOperationFeedback = () => undefined,
  collapsed = false,
  actionsInHeader = false,
  onToggleCollapsed,
}: ReferenceMarkPanelProps) {
  const activeRowRef = useRef<HTMLDivElement>(null);
  const railController = useOptionalPatentFunctionRail();
  const requestTool = railController?.requestTool;
  const railExpanded = railController?.presentation.expanded ?? true;
  const activeId = keywordHighlightEnabled ? activeReferenceMarkId : null;
  const lastRevealedId = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || onToggleCollapsed) return;
    return requestTool?.("reference-keyword");
  }, [activeId, requestTool, onToggleCollapsed]);
  useEffect(() => {
    if (lastRevealedId.current === activeId) return;
    lastRevealedId.current = activeId;
    if (activeId && collapsed) onToggleCollapsed?.();
  }, [activeId, collapsed, onToggleCollapsed]);
  useEffect(() => {
    if (!activeId || collapsed || !railExpanded) return;
    const row = activeRowRef.current;
    const rail = row?.closest<HTMLElement>(".patent-global-function-rail");
    if (!row || !rail) return;
    const item = row.getBoundingClientRect();
    const viewport = rail.getBoundingClientRect();
    if (item.top >= viewport.top + 8 && item.bottom <= viewport.bottom - 8) return;
    // Scroll only the tool rail: scrolling all ancestors would also move the document.
    const scale = rail.offsetHeight > 0 ? viewport.height / rail.offsetHeight : 1;
    const top = Math.max(
      0,
      rail.scrollTop +
        (item.top - viewport.top - (viewport.height - item.height) / 2) / (scale || 1),
    );
    const reduceMotion = isMotionReduced() ?? false;
    rail.scrollTo?.({ top, behavior: reduceMotion ? "auto" : "smooth" });
  }, [activeId, collapsed, railExpanded]);
  const collapsible = Boolean(onToggleCollapsed);
  const [pendingFillConfirm, setPendingFillConfirm] = useState<{
    currentText: string;
    targetText: string;
  } | null>(null);
  const cancelFillRef = useRef<HTMLButtonElement>(null);
  const [introOpen, setIntroOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [expandedReferenceMarkId, setExpandedReferenceMarkId] = useState<string | null>(null);
  const [customNumberOpen, setCustomNumberOpen] = useState(false);
  const [customNumber, setCustomNumber] = useState("");
  const [customNumberError, setCustomNumberError] = useState("");
  const [pendingCancel, setPendingCancel] = useState<{
    referenceMarkId: string;
    keyword: string;
  } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    referenceMarkId: string;
    keyword: string;
  } | null>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  const cancelIntroRef = useRef<HTMLButtonElement>(null);
  const customNumberInputRef = useRef<HTMLInputElement>(null);
  const editing =
    REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE &&
    patent.referenceMarkSettings.synchronizedEditingEnabled;
  const pendingReview = REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE
    ? patent.referenceMarkSettings.pendingReview
    : undefined;
  const reviewPending = pendingReview !== undefined;
  const effectiveCollapsed = collapsed && !reviewPending;
  const paused = REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE && sync.status === "paused";
  // 排列顺序随专利保存，复制和填入时沿用；不自动改正文或编号。
  const visibleText = formatReferenceMarkText(patent.referenceMarks);
  const dragDisabled =
    !onReorder || effectiveCollapsed || reviewPending || paused || expandedReferenceMarkId !== null;
  const reorder = useReferenceMarkOrder(
    patent.referenceMarks.map((entry) => entry.referenceMarkId),
    onReorder,
    !dragDisabled,
  );
  const entriesById = new Map(patent.referenceMarks.map((entry) => [entry.referenceMarkId, entry]));
  const sortedReferenceMarks = reorder.order.flatMap((id) => {
    const entry = entriesById.get(id);
    return entry ? [entry] : [];
  });
  const dragging = reorder.ghost !== null;
  useEffect(() => {
    if (dragging) return requestTool?.("reference-reorder");
  }, [dragging, requestTool]);
  const dirtyDraftIds = sortedReferenceMarks.flatMap((entry) => {
    const draft = drafts[entry.referenceMarkId];
    return draft &&
      (draft.number.trim() !== String(entry.number) || draft.keyword.trim() !== entry.keyword)
      ? [entry.referenceMarkId]
      : [];
  });
  const activeDraftId = dirtyDraftIds[0];
  const hasDrafts = dirtyDraftIds.length > 0;
  const hasMarks = sortedReferenceMarks.length > 0;
  const hasCurrentDescription =
    referenceMarkDescription.status !== "invalid" && Boolean(referenceMarkDescription.currentText);
  const fullDocumentPaused = editing && paused;
  const fillDisabled = !hasMarks || reviewPending || hasDrafts;
  const fillTitle = !hasMarks
    ? "当前无附图标记，无法填入说明书"
    : hasDrafts
      ? "请先保存或取消当前附图标记修改"
      : reviewPending
        ? "请先完成当前附图标记核对"
        : hasCurrentDescription
          ? "替换说明书当前的附图标记"
          : "将附图标记填入说明书";

  useEffect(() => {
    if (!customNumberOpen) return;
    customNumberInputRef.current?.focus();
    customNumberInputRef.current?.select();
  }, [customNumberOpen]);

  const apply = (
    result: ActionResult,
    titles: { success: string; error: string } = { success: "操作成功", error: "操作失败" },
  ) => {
    onOperationFeedback({
      tone: result.ok ? "success" : "error",
      title: result.ok ? titles.success : titles.error,
      ...(result.message ? { message: result.message } : {}),
    });
    return result;
  };
  const applyFill = (result: ActionResult) =>
    apply(result, { success: "填入成功！", error: "无法填入" });
  const isMissingClaimsKeyword = (referenceMarkId: string) => {
    const books = missingReferenceMarkBooks.get(referenceMarkId);
    return books ? books.includes("claims") : missingReferenceMarkIds.has(referenceMarkId);
  };
  const missingMessage = (referenceMarkId: string) => {
    const books = missingReferenceMarkBooks.get(referenceMarkId) ?? [];
    if (books.includes("claims") && books.includes("description")) {
      return "未找到关键词：权利要求书、说明书。";
    }
    return books.includes("description") && !books.includes("claims")
      ? "未找到关键词：说明书。"
      : "未找到关键词：权利要求书。";
  };
  const draftFor = (entry: { referenceMarkId: string; number: number; keyword: string }) =>
    drafts[entry.referenceMarkId] ?? { number: String(entry.number), keyword: entry.keyword };

  const clearDraft = (referenceMarkId: string) => {
    setDrafts((previous) => {
      if (!(referenceMarkId in previous)) return previous;
      const next = { ...previous };
      delete next[referenceMarkId];
      return next;
    });
    setRowErrors((previous) => {
      if (!(referenceMarkId in previous)) return previous;
      const next = { ...previous };
      delete next[referenceMarkId];
      return next;
    });
    setExpandedReferenceMarkId((previous) => (previous === referenceMarkId ? null : previous));
  };

  const updateDraft = (
    entry: { referenceMarkId: string; number: number; keyword: string },
    patch: Partial<RowDraft>,
  ) => {
    setDrafts((previous) => ({
      ...previous,
      [entry.referenceMarkId]: {
        ...(previous[entry.referenceMarkId] ?? {
          number: String(entry.number),
          keyword: entry.keyword,
        }),
        ...patch,
      },
    }));
    setRowErrors((previous) => {
      if (!(entry.referenceMarkId in previous)) return previous;
      const next = { ...previous };
      delete next[entry.referenceMarkId];
      return next;
    });
  };

  const saveRow = (entry: { referenceMarkId: string; number: number; keyword: string }) => {
    if (
      mismatchReferenceMarkIds.has(entry.referenceMarkId) ||
      (warningMessages.get(entry.referenceMarkId)?.length ?? 0) > 0 ||
      fullDocumentPaused ||
      reviewPending ||
      (activeDraftId !== undefined && activeDraftId !== entry.referenceMarkId)
    )
      return;
    const draft = draftFor(entry);
    const numberText = draft.number.trim();
    const keyword = draft.keyword.trim();
    if (!numberText || !keyword) {
      setRowErrors((previous) => ({
        ...previous,
        [entry.referenceMarkId]: "序号和关键词不能为空；如需移除该标记，请使用“取消编号”。",
      }));
      return;
    }
    const number = Number(numberText);
    if (!/^[1-9]\d*$/u.test(numberText) || !Number.isSafeInteger(number)) {
      setRowErrors((previous) => ({
        ...previous,
        [entry.referenceMarkId]: "序号必须是正整数。",
      }));
      return;
    }
    const duplicateNumber = patent.referenceMarks.some(
      (item) => item.referenceMarkId !== entry.referenceMarkId && item.number === number,
    );
    const duplicateKeyword = patent.referenceMarks.some(
      (item) => item.referenceMarkId !== entry.referenceMarkId && item.keyword === keyword,
    );
    if (duplicateNumber || duplicateKeyword) {
      setRowErrors((previous) => ({
        ...previous,
        [entry.referenceMarkId]: "序号和关键词不能重复。",
      }));
      return;
    }
    const result = onEdit({ referenceMarkId: entry.referenceMarkId, number, keyword });
    apply(result, { success: "保存成功", error: "保存失败" });
    if (result.ok) clearDraft(entry.referenceMarkId);
    else setRowErrors((previous) => ({ ...previous, [entry.referenceMarkId]: result.message }));
  };

  const deleteRow = (entry: { referenceMarkId: string; keyword: string }) => {
    if (reviewPending || hasDrafts) return;
    setPendingCancel(entry);
  };

  const toggleEditing = (checked: boolean) => {
    if (reviewPending) {
      onOperationFeedback({
        tone: "error",
        title: "暂不能更改",
        message: "请先完成当前附图标记的全文档核对。",
      });
      return;
    }
    if (!checked && hasDrafts) {
      onOperationFeedback({
        tone: "error",
        title: "无法关闭",
        message: "请先保存或取消当前修改。",
      });
      return;
    }
    if (checked && !introDismissed) {
      setIntroOpen(true);
      return;
    }
    apply(onSetSynchronizedEditing(checked), {
      success: checked ? "跨文档同步修改已开启" : "跨文档同步修改已关闭",
      error: "设置未完成",
    });
  };

  const closeCustomNumber = () => {
    setCustomNumberOpen(false);
    setCustomNumber("");
    setCustomNumberError("");
    onCustomNumberOpenChange(false);
  };

  const openCustomNumber = () => {
    // Native browsers cannot focus the input while its collapsed rail is display:none.
    railController?.setHovered(true);
    setCustomNumberOpen(true);
    setCustomNumberError("");
    onCustomNumberOpenChange(true);
  };

  useShortcutAction(
    "assign-reference-number",
    shortcutsEnabled &&
      Boolean(onAssignReferenceNumber) &&
      !fullDocumentPaused &&
      !reviewPending &&
      !hasDrafts,
    () => {
      onAssignReferenceNumber?.();
      return true;
    },
  );
  useShortcutAction(
    "assign-custom-reference-number",
    shortcutsEnabled &&
      Boolean(onAssignReferenceNumber) &&
      !fullDocumentPaused &&
      !reviewPending &&
      !hasDrafts,
    () => {
      openCustomNumber();
      return true;
    },
  );
  const assignReferenceNumberShortcut = useConfiguredShortcut("assign-reference-number");
  const assignCustomReferenceNumberShortcut = useConfiguredShortcut(
    "assign-custom-reference-number",
  );

  const showCustomNumberError = (error: string) => {
    setCustomNumberError(error);
    customNumberInputRef.current?.focus();
    customNumberInputRef.current?.select();
  };

  const submitCustomNumber = () => {
    const normalized = customNumber.trim();
    const number = Number(normalized);
    if (!/^[1-9]\d*$/u.test(normalized) || !Number.isSafeInteger(number)) {
      showCustomNumberError("请输入不带前导零的十进制正整数。");
      return;
    }
    const owner = patent.referenceMarks.find((entry) => entry.number === number);
    if (owner) {
      showCustomNumberError(`序号 ${number} 已被“${owner.keyword}”使用。`);
      return;
    }
    const result = onAssignReferenceNumber?.(number);
    if (result?.pending) {
      closeCustomNumber();
      return;
    }
    if (result && !result.ok) {
      apply(result, { success: "编号完成", error: "无法编号" });
      showCustomNumberError(result.message);
      return;
    }
    if (result) apply(result, { success: "编号完成", error: "无法编号" });
    closeCustomNumber();
  };

  const reviewPanel = pendingReview ? (
    <div className="reference-mark-panel__review" role="status">
      <strong>请在所有文档中核对“{pendingReview.keyword}”</strong>
      <p>
        修改时命中：权利要求书 {pendingReview.counts.claims} 处 · 说明书{" "}
        {pendingReview.counts.description} 处 · 说明书摘要 {pendingReview.counts.abstract} 处
      </p>
      <div className="reference-mark-panel__review-navigation">
        <button type="button" onClick={() => onNavigateReview("previous")}>
          上一处
        </button>
        <button type="button" onClick={() => onNavigateReview("next")}>
          下一处
        </button>
      </div>
      <div className="reference-mark-panel__review-actions">
        <button
          type="button"
          disabled={!canUndoReview}
          title={
            canUndoReview
              ? "撤销本次全文档修改"
              : "文档已继续编辑或应用已重新打开，无法安全自动撤销"
          }
          onClick={() =>
            apply(onUndoReview(), {
              success: "本次修改已撤销",
              error: "无法撤销",
            })
          }
        >
          撤销本次修改
        </button>
        <button
          type="button"
          className="reference-mark-panel__review-complete"
          onClick={() =>
            apply(onCompleteReview(pendingReview.referenceMarkId), {
              success: "核对已完成",
              error: "无法完成核对",
            })
          }
        >
          核对无问题
        </button>
        <button
          type="button"
          onClick={() =>
            apply(
              onCompleteReview(pendingReview.referenceMarkId, {
                acceptCurrentDocument: true,
              }),
              {
                success: "已保留当前内容",
                error: "无法完成核对",
              },
            )
          }
        >
          保留当前内容并完成
        </button>
      </div>
    </div>
  ) : null;

  const actionButtons = (
    <div className="reference-mark-panel__actions">
      <AddReferenceMark key={patent.patentId} entries={patent.referenceMarks}
        {...(onAddReferenceMark ? { onAdd: onAddReferenceMark } : {})}
        disabled={reviewPending || hasDrafts} />
      <button
        type="button"
        className="reference-mark-panel__fill"
        title={fillTitle}
        disabled={fillDisabled}
        onClick={() => {
          if (!onFillReferenceMarks) return;
          if (referenceMarkDescription.status !== "invalid" && hasCurrentDescription) {
            // 说明书已有内容时先弹出应用内确认，重复填入也必须由用户明确覆盖。
            setPendingFillConfirm({
              currentText: referenceMarkDescription.currentText,
              targetText: referenceMarkDescription.targetText,
            });
            return;
          }
          applyFill(onFillReferenceMarks());
        }}
      >
        填入说明书
      </button>
      <button
        type="button"
        className="reference-mark-panel__copy"
        title={hasMarks ? "复制附图标记" : "当前无附图标记，无法复制"}
        disabled={!visibleText}
        onClick={async () => {
          try {
            const result = await window.patentApi.clipboard.writeText(visibleText);
            if (!result.ok) throw new Error(result.error.message);
            onOperationFeedback({
              tone: "success",
              title: "复制成功",
              message: "附图标记已复制到剪贴板。",
            });
          } catch {
            onOperationFeedback({
              tone: "error",
              title: "复制失败",
              message: "无法写入剪贴板，请重试。",
            });
          }
        }}
      >
        复制
      </button>
    </div>
  );

  return (
    <section
      className="reference-mark-panel"
      aria-label="附图标记"
      data-collapsible={collapsible}
      data-collapsed={collapsible && effectiveCollapsed}
    >
      <header className="reference-mark-panel__header">
        {collapsible ? (
          <button
            type="button"
            className="reference-mark-panel__toggle"
            aria-label={effectiveCollapsed ? "展开附图标记" : "折叠附图标记"}
            aria-expanded={!effectiveCollapsed}
            aria-controls="reference-mark-panel-body"
            disabled={reviewPending}
            onClick={onToggleCollapsed}
          >
            <strong>附图标记</strong>
            <span aria-hidden="true" className="reference-mark-panel__toggle-caret" />
          </button>
        ) : (
          <div className="reference-mark-panel__title">
            <strong>附图标记</strong>
          </div>
        )}
        {actionsInHeader ? actionButtons : null}
      </header>

      <div
        id="reference-mark-panel-body"
        className="reference-mark-panel__body"
        hidden={effectiveCollapsed}
        inert={effectiveCollapsed || undefined}
        aria-hidden={effectiveCollapsed || undefined}
      >
        <div className="reference-mark-panel__sync-row">
          {!actionsInHeader ? actionButtons : null}
          {REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE ? (
            <label className="reference-mark-panel__switch">
              <span className="reference-mark-panel__switch-label">跨文档同步修改</span>
              <input
                type="checkbox"
                checked={editing}
                disabled={reviewPending || hasDrafts || (paused && !editing)}
                onChange={(event) => toggleEditing(event.target.checked)}
              />
              <span className="reference-mark-panel__switch-control" aria-hidden="true" />
            </label>
          ) : null}
        </div>

        {REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE && paused ? (
          <div className="reference-mark-panel__paused" role={editing ? "alert" : "status"}>
            <strong>同步已暂停</strong>
            <p>{sync.message}</p>
            {onRepairSync ? (
              <button type="button" onClick={onRepairSync}>
                前往说明书修复
              </button>
            ) : null}
          </div>
        ) : null}

        {onAssignReferenceNumber ? (
          <div className="reference-mark-panel__numbering">
            <div className="reference-mark-panel__numbering-buttons">
              <button
                type="button"
                disabled={fullDocumentPaused || reviewPending || hasDrafts}
                data-numbering-help="sequential"
                data-numbering-book-kind={numberingBookKind}
                aria-keyshortcuts={assignReferenceNumberShortcut || undefined}
                onClick={() => onAssignReferenceNumber()}
              >
                <ListOrdered size={16} strokeWidth={1.5} aria-hidden="true" />
                顺序编号
              </button>
              <button
                type="button"
                disabled={fullDocumentPaused || reviewPending || hasDrafts}
                aria-expanded={customNumberOpen}
                data-numbering-help="custom"
                data-numbering-book-kind={numberingBookKind}
                aria-keyshortcuts={assignCustomReferenceNumberShortcut || undefined}
                onClick={openCustomNumber}
              >
                <PencilLine size={16} strokeWidth={1.5} aria-hidden="true" />
                自定义编号
              </button>
            </div>
            <SpatialCollapse open={Boolean(customNumberOpen)}>
              {
                <form
                  className="reference-mark-panel__custom-number"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitCustomNumber();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    closeCustomNumber();
                  }}
                >
                  <label className="reference-mark-panel__custom-number-field">
                    <span>指定编号</span>
                    <input
                      ref={customNumberInputRef}
                      type="text"
                      inputMode="numeric"
                      aria-label="自定义编号数字"
                      placeholder="请输入正整数"
                      value={customNumber}
                      onChange={(event) => {
                        setCustomNumber(event.target.value);
                        setCustomNumberError("");
                      }}
                    />
                  </label>
                  <div className="reference-mark-panel__custom-number-row">
                    <button type="button" onClick={closeCustomNumber} aria-label="取消自定义编号">
                      取消
                    </button>
                    <button type="submit" aria-label="确认自定义编号">
                      确认
                    </button>
                  </div>
                  {customNumberError ? (
                    <p className="reference-mark-panel__custom-error" role="alert">
                      {customNumberError}
                    </p>
                  ) : null}
                </form>
              }
            </SpatialCollapse>
          </div>
        ) : null}

        {sortedReferenceMarks.length === 0 && !fullDocumentPaused && !reviewPending ? (
          collapsible ? null : (
            <div className="reference-mark-panel__empty">
              <span>暂无附图标记</span>
              <p>
                {numberingBookKind === "description"
                  ? "在说明书“具体实施方式”正文中选中关键词进行编号，数字不加括号。"
                  : "需要在权利要求书中选择关键词进行编号。"}
              </p>
            </div>
          )
        ) : sortedReferenceMarks.length > 0 ? (
          <div className="reference-mark-panel__editor">
            <div className="reference-mark-panel__columns" aria-hidden="true">
              <span>序号</span>
              <span>关键词</span>
              <span />
            </div>
            <div className="reference-mark-panel__rows" ref={reorder.listRef}>
              {sortedReferenceMarks.map((entry) => {
                const draft = draftFor(entry);
                const error = rowErrors[entry.referenceMarkId];
                const dirty =
                  draft.number.trim() !== String(entry.number) ||
                  draft.keyword.trim() !== entry.keyword;
                const lockedByOtherDraft =
                  activeDraftId !== undefined && activeDraftId !== entry.referenceMarkId;
                const missing = isMissingClaimsKeyword(entry.referenceMarkId);
                const mismatch = mismatchReferenceMarkIds.has(entry.referenceMarkId);
                const warnings = warningMessages.get(entry.referenceMarkId) ?? [];
                // A missing keyword is editable registration data, not a
                // conflicting body number that must be resolved first.
                const sourceIssue = mismatch || warnings.length > 0;
                const located =
                  locatedIssueState?.referenceMarkId === entry.referenceMarkId
                    ? locatedIssueState
                    : null;
                const isExpanded = expandedReferenceMarkId === entry.referenceMarkId;
                return (
                  <div
                    key={entry.referenceMarkId}
                    ref={activeId === entry.referenceMarkId ? activeRowRef : undefined}
                    data-reference-list-id={entry.referenceMarkId}
                    className={[
                      activeId === entry.referenceMarkId ? "is-keyword-active" : "",
                      isExpanded ? "is-editing" : "",
                      reorder.ghost?.id === entry.referenceMarkId ? "is-reordering" : "",
                      missing ? "is-missing" : "",
                      mismatch ? "is-mismatch" : "",
                      missing || mismatch || warnings.length > 0 || error ? "is-issue" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <SpatialCollapse
                      open={isExpanded}
                      className="reference-mark-panel__edit-motion"
                    >
                      <form
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (dirty) saveRow(entry);
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) {
                            if (event.key === "Enter") event.preventDefault();
                            return;
                          }
                          if (event.key !== "Escape" || reviewPending || lockedByOtherDraft) return;
                          event.preventDefault();
                          event.stopPropagation();
                          clearDraft(entry.referenceMarkId);
                        }}
                      >
                        <div className="reference-mark-panel__fields">
                          <input
                            aria-label={`${entry.keyword}序号`}
                            type="text"
                            inputMode="numeric"
                            pattern="[1-9][0-9]*"
                            disabled={
                              sourceIssue ||
                              fullDocumentPaused ||
                              reviewPending ||
                              lockedByOtherDraft
                            }
                            value={draft.number}
                            onChange={(event) => updateDraft(entry, { number: event.target.value })}
                          />
                          <input
                            aria-label={`${entry.keyword}关键词`}
                            disabled={
                              sourceIssue ||
                              fullDocumentPaused ||
                              reviewPending ||
                              lockedByOtherDraft
                            }
                            maxLength={100}
                            value={draft.keyword}
                            onChange={(event) =>
                              updateDraft(entry, { keyword: event.target.value })
                            }
                          />
                        </div>
                        <div className="reference-mark-panel__row-actions">
                          <button
                            type="submit"
                            disabled={
                              sourceIssue ||
                              !dirty ||
                              fullDocumentPaused ||
                              reviewPending ||
                              lockedByOtherDraft
                            }
                            aria-label={`保存${entry.keyword}`}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            disabled={reviewPending || lockedByOtherDraft}
                            aria-label={`取消${entry.keyword}修改`}
                            onClick={() => clearDraft(entry.referenceMarkId)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="reference-mark-panel__delete"
                            disabled={fullDocumentPaused || reviewPending || hasDrafts}
                            aria-label={`取消${entry.keyword}编号`}
                            onClick={() => deleteRow(entry)}
                          >
                            取消编号
                          </button>
                        </div>
                      </form>
                    </SpatialCollapse>
                    <SpatialCollapse
                      open={!isExpanded}
                      animateInitial={false}
                      className="reference-mark-panel__summary-motion"
                    >
                      <div className="reference-mark-panel__row-summary">
                        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: this stays selectable text; the adjacent menu is the keyboard action. */}
                        <div
                          className="reference-mark-panel__row-activation-area"
                          data-selectable-tool-text
                          tabIndex={-1}
                          title={
                            keywordHighlightEnabled
                              ? "单击高亮正文中的关键词；双击编辑关键词"
                              : "双击编辑关键词；开启零部件定位后可单击高亮"
                          }
                          onClick={(event) => {
                            if (event.detail > 1) return;
                            if (keywordHighlightEnabled) onActivateKeyword(entry.referenceMarkId);
                          }}
                          onDoubleClick={() => {
                            if (
                              sourceIssue ||
                              fullDocumentPaused ||
                              reviewPending ||
                              lockedByOtherDraft
                            )
                              return;
                            setExpandedReferenceMarkId(entry.referenceMarkId);
                          }}
                        >
                          <button
                            type="button"
                            className="reference-mark-panel__row-number reference-mark-panel__drag-handle"
                            aria-label={`调整${entry.keyword}位置`}
                            title={platformShortcut("拖动可调整关键词位置；也可按 Alt+↑/↓ 调整")}
                            disabled={dragDisabled || hasDrafts}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) =>
                              reorder.start(
                                event,
                                entry.referenceMarkId,
                                `${entry.number}　${entry.keyword}`,
                              )
                            }
                            onKeyDown={(event) => {
                              if (
                                event.altKey &&
                                (event.key === "ArrowUp" || event.key === "ArrowDown")
                              ) {
                                event.preventDefault();
                                event.stopPropagation();
                                reorder.moveByKeyboard(
                                  entry.referenceMarkId,
                                  event.key === "ArrowUp" ? -1 : 1,
                                );
                              }
                            }}
                          >
                            {entry.number}
                          </button>
                          <span className="reference-mark-panel__row-keyword">{entry.keyword}</span>
                        </div>
                        <button
                          type="button"
                          className="reference-mark-panel__row-menu"
                          disabled={
                            sourceIssue || fullDocumentPaused || reviewPending || lockedByOtherDraft
                          }
                          aria-label={`编辑${entry.keyword}`}
                          title={
                            sourceIssue
                              ? "请先解决关键词或编号错误，再编辑附图标记"
                              : "编辑附图标记"
                          }
                          onClick={() => setExpandedReferenceMarkId(entry.referenceMarkId)}
                        >
                          ⋮
                        </button>
                      </div>
                    </SpatialCollapse>
                    {mismatch ? (
                      <span className="reference-mark-panel__warning">编号不一致</span>
                    ) : null}
                    {warnings.map((warning) => (
                      <span key={warning} className="reference-mark-panel__warning">
                        {warning}
                      </span>
                    ))}
                    {missing ? (
                      <span className="reference-mark-panel__error">
                        {missingMessage(entry.referenceMarkId)}
                      </span>
                    ) : null}
                    {error ? (
                      <span className="reference-mark-panel__error" role="alert">
                        {error}
                      </span>
                    ) : null}
                    {missing || mismatch || warnings.length > 0 ? (
                      <div className="reference-mark-panel__issue-actions">
                        {missing && !sourceIssue && !isExpanded ? (
                          <button type="button" aria-label={`修改标记：${entry.keyword}`}
                            disabled={fullDocumentPaused || reviewPending || lockedByOtherDraft}
                            onClick={() => setExpandedReferenceMarkId(entry.referenceMarkId)}>
                            修改标记
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={fullDocumentPaused || reviewPending || hasDrafts}
                          title="移出附图标记列表，保留正文和编号"
                          aria-label={`移出标记：${entry.keyword}`}
                          onClick={() =>
                            setPendingRemove({
                              referenceMarkId: entry.referenceMarkId,
                              keyword: entry.keyword,
                            })
                          }
                        >
                          移出标记
                        </button>
                        {(locatableIssueCounts.get(entry.referenceMarkId) ?? 0) > 0 ? <button
                          type="button"
                          title="定位正文中的问题"
                          onClick={() => onLocateIssue(entry.referenceMarkId)}
                        >
                          定位问题
                        </button> : null}
                        {onSupplementNumbers &&
                        unnumberedClaimsReferenceMarkIds?.has(entry.referenceMarkId) ? (
                          <button
                            type="button"
                            className="reference-mark-panel__supplement"
                            aria-label={`增补编号：${entry.keyword}`}
                            onClick={() => onSupplementNumbers(entry.referenceMarkId)}
                          >
                            增补编号
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {located && located.count > 0 ? (
                      <fieldset
                        className="reference-mark-panel__issue-locator"
                        aria-label={`定位${entry.keyword}的问题`}
                      >
                        <div className="reference-mark-panel__issue-locator-status">
                          <span>{`共定位 ${located.count} 处`}</span>
                          <button type="button" onClick={onCancelLocatedIssues}>
                            结束定位
                          </button>
                        </div>
                        <div className="reference-mark-panel__issue-locator-actions">
                          <button
                            type="button"
                            disabled={located.count <= 1}
                            onClick={() => onNavigateLocatedIssue("previous")}
                          >
                            上一处
                          </button>
                          <span>{`${located.activeIndex + 1} / ${located.count}`}</span>
                          <button
                            type="button"
                            disabled={located.count <= 1}
                            onClick={() => onNavigateLocatedIssue("next")}
                          >
                            下一处
                          </button>
                        </div>
                      </fieldset>
                    ) : null}
                    {pendingReview?.referenceMarkId === entry.referenceMarkId ? reviewPanel : null}
                  </div>
                );
              })}
              {pendingReview &&
              !sortedReferenceMarks.some(
                (entry) => entry.referenceMarkId === pendingReview.referenceMarkId,
              )
                ? reviewPanel
                : null}
            </div>
          </div>
        ) : null}

        {createPortal(
          <MotionPresence>
            {REFERENCE_MARK_CROSS_DOCUMENT_EDITING_AVAILABLE && introOpen ? (
              <StandardDialog
                open
                title="同步修改说明"
                size="m"
                onCancel={() => setIntroOpen(false)}
                initialFocusRef={cancelIntroRef}
                footer={
                  <>
                    <button ref={cancelIntroRef} type="button" onClick={() => setIntroOpen(false)}>
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIntroOpen(false);
                        apply(onSetSynchronizedEditing(true), {
                          success: "跨文档同步修改已开启",
                          error: "设置未完成",
                        });
                      }}
                    >
                      开启
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        void onDismissIntro();
                        setIntroOpen(false);
                        apply(onSetSynchronizedEditing(true), {
                          success: "跨文档同步修改已开启",
                          error: "设置未完成",
                        });
                      }}
                    >
                      开启且不再提示
                    </button>
                  </>
                }
              >
                <p>
                  开启后，在附图标记组件中修改序号或关键词，会同步更新权利要求书、说明书和说明书摘要中匹配的内容；手工修改正文不会反向更新组件。自动修改的内容将标记为红色。
                </p>
              </StandardDialog>
            ) : null}
          </MotionPresence>,
          document.body,
        )}

        {createPortal(
          <MotionPresence>
            {pendingRemove ? (
              <StandardDialog
                open
                title="移出标记"
                size="s"
                className="reference-mark-remove-dialog"
                dialogRole="alertdialog"
                onCancel={() => setPendingRemove(null)}
                initialFocusRef={cancelRemoveRef}
                footer={
                  <>
                    <button
                      ref={cancelRemoveRef}
                      type="button"
                      onClick={() => setPendingRemove(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="standard-dialog__danger-button"
                      onClick={() => {
                        const current = pendingRemove;
                        setPendingRemove(null);
                        const result = onRemoveRegistration(current.referenceMarkId);
                        apply(result, {
                          success: "已移出标记",
                          error: "无法移出标记",
                        });
                        if (result.ok) clearDraft(current.referenceMarkId);
                      }}
                    >
                      确认移出
                    </button>
                  </>
                }
              >
                <div className="reference-mark-remove-dialog__keyword">
                  <span>关键词</span>
                  <strong>{pendingRemove.keyword}</strong>
                </div>
                <p className="reference-mark-remove-dialog__description">
                  仅移出标记列表，不修改正文和编号。
                </p>
              </StandardDialog>
            ) : null}
          </MotionPresence>,
          document.body,
        )}

        {createPortal(
          <MotionPresence>
            {pendingCancel ? (
              <StandardDialog
                open
                title="取消附图标记编号"
                size="s"
                dialogRole="alertdialog"
                onCancel={() => setPendingCancel(null)}
                footer={
                  <>
                    <button type="button" onClick={() => setPendingCancel(null)}>
                      返回
                    </button>
                    <button
                      type="button"
                      className="standard-dialog__danger-button"
                      onClick={() => {
                        const current = pendingCancel;
                        const result = onCancel(current.referenceMarkId);
                        apply(result, { success: "已取消编号", error: "无法取消编号" });
                        if (result.ok) {
                          clearDraft(current.referenceMarkId);
                          setPendingCancel(null);
                        }
                      }}
                    >
                      确认取消编号
                    </button>
                  </>
                }
              >
                <p>{`仅取消权利要求书中“${pendingCancel.keyword}”的编号，并移出标记列表，保留关键词。说明书、说明书摘要和已填入的图例保持不变。`}</p>
              </StandardDialog>
            ) : null}
          </MotionPresence>,
          document.body,
        )}

        {createPortal(
          <MotionPresence>
            {pendingFillConfirm ? (
              <StandardDialog
                open
                title="填入附图标记"
                subtitle="将替换说明书当前的附图标记"
                size="m"
                onCancel={() => setPendingFillConfirm(null)}
                initialFocusRef={cancelFillRef}
                footer={
                  <>
                    <button
                      ref={cancelFillRef}
                      type="button"
                      onClick={() => setPendingFillConfirm(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="standard-dialog__danger-button"
                      onClick={() => {
                        setPendingFillConfirm(null);
                        if (onFillReferenceMarks) applyFill(onFillReferenceMarks());
                      }}
                    >
                      确认覆盖
                    </button>
                  </>
                }
              >
                <div className="reference-mark-panel__fill-warning">
                  <TriangleAlert size={18} aria-hidden="true" />
                  <span>请确认以下内容后再覆盖。</span>
                </div>
                <div className="reference-mark-panel__fill-diff">
                  <strong>当前内容</strong>
                  <p>{pendingFillConfirm.currentText}</p>
                  <strong>将覆盖为</strong>
                  <p>{pendingFillConfirm.targetText}</p>
                </div>
              </StandardDialog>
            ) : null}
          </MotionPresence>,
          document.body,
        )}
      </div>
      <span className="reference-mark-order-status" role="status">
        {reorder.notice}
      </span>
      {reorder.ghost &&
        createPortal(
          <div
            className="reference-mark-drag-ghost"
            aria-hidden="true"
            style={{
              left: reorder.ghost.x,
              top: reorder.ghost.y,
              width: reorder.ghost.width,
              height: reorder.ghost.height,
            }}
          >
            {reorder.ghost.label}
          </div>,
          document.body,
        )}
    </section>
  );
}
