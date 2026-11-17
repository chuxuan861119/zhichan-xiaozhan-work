import type { Editor } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { StepMap } from "@tiptap/pm/transform";
import type { AiCorrectionIssue } from "../../../../shared/ai-correction/contract";
import { replacementSafetyReason } from "../../../../shared/ai-correction/replacement-policy";
import { AUTOMATIC_EDIT_RED } from "../../../../shared/patent/reference-marks";
import { inspectionSelectionKey } from "../../editor/extensions/inspection-selection";
import { polishTextEdits } from "./text-polish-diff";

export type ResolvedCorrectionAnchor =
  | { status: "ready"; from: number; to: number }
  | { status: "stale" };

// Persistent paths let document checkpoints share maps instead of copying an ever-growing array.
type AnchorMapHistory = {
  previous: AnchorMapHistory | null;
  map: StepMap;
  length: number;
};

const anchorTracking = new WeakMap<
  Editor,
  {
    originalDoc: ProseMirrorNode;
    history: AnchorMapHistory | null;
    invalidated: boolean;
    stop: () => void;
  }
>();

/** Start immediately before capturing the request document; keep alive while its results are shown. */
export function startCorrectionAnchorTracking(
  editor: Editor,
  onAppliedChange?: (issues: readonly AiCorrectionIssue[], applied: boolean) => void,
  onDocumentChange?: (changed: boolean) => void,
): () => void {
  anchorTracking.get(editor)?.stop();
  const tracking = {
    originalDoc: editor.state.doc,
    history: null as AnchorMapHistory | null,
    invalidated: false,
    stop: () => {},
  };
  const accepted: Array<{
    before: ProseMirrorNode;
    after: ProseMirrorNode;
    beforeMaps: AnchorMapHistory | null;
    afterMaps: AnchorMapHistory | null;
    issues: AiCorrectionIssue[];
    applied: boolean;
  }> = [];
  const checkpoints: Array<{ doc: ProseMirrorNode; history: AnchorMapHistory | null }> = [];
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged || tracking.invalidated) return;
    onDocumentChange?.(!transaction.doc.eq(tracking.originalDoc));
    const beforeMaps = tracking.history;
    checkpoints.push({ doc: transaction.before, history: beforeMaps });
    // Retain more than the editor's undo depth without keeping unlimited document snapshots.
    if (checkpoints.length > 1000) checkpoints.shift();
    if (isHistoryTransaction(transaction)) {
      const record = [...accepted]
        .reverse()
        .find((item) =>
          item.applied
            ? transaction.before.eq(item.after) && transaction.doc.eq(item.before)
            : transaction.before.eq(item.before) && transaction.doc.eq(item.after),
        );
      if (record) {
        record.applied = !record.applied;
        tracking.history = record.applied ? record.afterMaps : record.beforeMaps;
        onAppliedChange?.(record.issues, record.applied);
        return;
      }
      // Undo may restore only the target edit, leaving earlier unrelated edits intact.
      // Restore a verified whole-document checkpoint, never search for a similar quotation.
      for (let index = checkpoints.length - 1; index >= 0; index--) {
        const checkpoint = checkpoints[index];
        if (checkpoint && transaction.doc.eq(checkpoint.doc)) {
          tracking.history = checkpoint.history;
          return;
        }
      }
    }
    // A full snapshot match restores the original occurrence, including after manual undo.
    // Drop obsolete maps so subsequent edits are tracked from that verified document again.
    if (transaction.doc.eq(tracking.originalDoc)) {
      tracking.history = null;
      return;
    }
    if ((tracking.history?.length ?? 0) + transaction.mapping.maps.length > 10_000) {
      tracking.invalidated = true;
      tracking.history = null;
      checkpoints.length = 0;
      accepted.length = 0;
      return;
    }
    for (const map of transaction.mapping.maps) {
      tracking.history = {
        previous: tracking.history,
        map,
        length: (tracking.history?.length ?? 0) + 1,
      };
    }
    const appliedIssues = transaction.getMeta("aiCorrectionApplied") as
      | AiCorrectionIssue[]
      | undefined;
    if (appliedIssues?.length) {
      accepted.push({
        before: transaction.before,
        after: transaction.doc,
        beforeMaps,
        afterMaps: tracking.history,
        issues: appliedIssues,
        applied: true,
      });
      onAppliedChange?.(appliedIssues, true);
    }
  };
  const stop = () => {
    editor.off("transaction", onTransaction);
    editor.off("destroy", stop);
    if (anchorTracking.get(editor)?.stop === stop) anchorTracking.delete(editor);
  };
  tracking.stop = stop;
  anchorTracking.set(editor, tracking);
  editor.on("transaction", onTransaction);
  editor.on("destroy", stop);
  return stop;
}

function resolveInDocument(
  doc: ProseMirrorNode,
  issue: AiCorrectionIssue,
  verifiedSnapshot = false,
): ResolvedCorrectionAnchor {
  let objectRange: { from: number; to: number } | null = null;
  doc.descendants((node, position) => {
    if (
      node.attrs.nodeId === issue.anchor.blockId &&
      node.isAtom &&
      !node.isText &&
      !node.isInline &&
      issue.applicability === "analysis-only" &&
      issue.anchor.originalText === "\uFFFC"
    )
      objectRange = { from: position, to: position + node.nodeSize };
  });
  if (objectRange) return { status: "ready", ...(objectRange as { from: number; to: number }) };
  let blockPosition: number | null = null;
  let blockText = "";
  doc.descendants((node, position) => {
    if (node.attrs.nodeId !== issue.anchor.blockId || !node.isTextblock) return true;
    blockPosition = position;
    node.forEach((child) => {
      blockText += child.isText
        ? child.text
        : child.type.name === "hardBreak"
          ? "\n"
          : "\uFFFC".repeat(child.nodeSize);
    });
    return false;
  });
  const { originalText, contextBefore = "", contextAfter = "" } = issue.anchor;
  if (blockPosition === null || !originalText) return { status: "stale" };
  if (verifiedSnapshot) {
    const { startOffset, endOffset } = issue.anchor;
    if (
      blockText.slice(startOffset, endOffset) === originalText &&
      blockText.slice(Math.max(0, startOffset - contextBefore.length), startOffset) ===
        contextBefore &&
      blockText.slice(endOffset, endOffset + contextAfter.length) === contextAfter
    ) {
      return {
        status: "ready",
        from: blockPosition + 1 + startOffset,
        to: blockPosition + 1 + endOffset,
      };
    }
    return { status: "stale" };
  }
  const matches: number[] = [];
  for (
    let offset = blockText.indexOf(originalText);
    offset >= 0;
    offset = blockText.indexOf(originalText, offset + 1)
  ) {
    const end = offset + originalText.length;
    if (
      blockText.slice(Math.max(0, offset - contextBefore.length), offset) === contextBefore &&
      blockText.slice(end, end + contextAfter.length) === contextAfter
    )
      matches.push(offset);
  }
  const firstMatch = matches[0];
  if (matches.length !== 1 || firstMatch === undefined) return { status: "stale" };
  return {
    status: "ready",
    from: blockPosition + 1 + firstMatch,
    to: blockPosition + 1 + firstMatch + issue.anchor.originalText.length,
  };
}

export function locateCorrectionAnchor(
  editor: Editor,
  issue: AiCorrectionIssue,
): ResolvedCorrectionAnchor {
  const tracking = anchorTracking.get(editor);
  if (!tracking) return resolveInDocument(editor.state.doc, issue);
  if (tracking.invalidated) return { status: "stale" };
  const original = resolveInDocument(tracking.originalDoc, issue, true);
  if (original.status !== "ready") return original;
  let { from, to } = original;
  const maps: StepMap[] = [];
  for (let history = tracking.history; history; history = history.previous) maps.push(history.map);
  for (const map of maps.reverse()) {
    let touched = false;
    map.forEach((oldStart, oldEnd) => {
      if (oldStart < to && oldEnd > from) touched = true;
    });
    if (touched) return { status: "stale" };
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  const doc = editor.state.doc;
  const selectedObject = doc.nodeAt(from);
  if (
    issue.applicability === "analysis-only" &&
    issue.anchor.originalText === "\uFFFC" &&
    selectedObject?.isAtom &&
    selectedObject.attrs.nodeId === issue.anchor.blockId &&
    selectedObject.eq(tracking.originalDoc.nodeAt(original.from)!)
  )
    return { status: "ready", from, to };
  const $from = doc.resolve(from),
    $to = doc.resolve(to);
  if (
    to <= from ||
    !$from.sameParent($to) ||
    $from.parent.attrs.nodeId !== issue.anchor.blockId ||
    doc.textBetween(from, to, "\n", (node) =>
      node.type.name === "hardBreak" ? "\n" : "\uFFFC".repeat(node.nodeSize),
    ) !== issue.anchor.originalText
  )
    return { status: "stale" };
  return { status: "ready", from, to };
}

export function selectCorrectionAnchor(editor: Editor, issue: AiCorrectionIssue): boolean {
  const resolved = locateCorrectionAnchor(editor, issue);
  if (resolved.status !== "ready") return false;
  return editor
    .chain()
    .setMeta(inspectionSelectionKey, true)
    .focus()
    .setTextSelection({ from: resolved.from, to: resolved.to })
    .scrollIntoView()
    .run();
}

export function applyCorrectionIssues(
  editor: Editor,
  issues: readonly AiCorrectionIssue[],
): { appliedIssueIds: string[]; skippedIssueIds: string[]; skippedReasons: string[] } {
  const skippedIssueIds: string[] = [];
  const skippedReasons: string[] = [];
  const resolved = issues
    .map((issue) => {
      if (
        issue.risk === "high" ||
        issue.applicability !== "replace" ||
        issue.replacement === null ||
        replacementSafetyReason(issue.anchor.originalText, issue.replacement) !== null
      ) {
        skippedIssueIds.push(issue.issueId);
        skippedReasons.push(
          issue.replacement === null
            ? "此建议仅供人工核对，不可直接替换。"
            : (replacementSafetyReason(issue.anchor.originalText, issue.replacement) ??
                "此建议仅供人工核对，不可直接替换。"),
        );
        return null;
      }
      const anchor = locateCorrectionAnchor(editor, issue);
      if (anchor.status !== "ready") {
        skippedIssueIds.push(issue.issueId);
        skippedReasons.push("对应原文已变化或无法唯一定位，未应用修改；请重新检查该段。");
        return null;
      }
      let crossesObject = false;
      const $from = editor.state.doc.resolve(anchor.from);
      $from.parent.nodesBetween(
        $from.parentOffset,
        $from.parentOffset + anchor.to - anchor.from,
        (node) => {
          if (!node.isText) crossesObject = true;
          return false;
        },
      );
      const edits = polishTextEdits(issue.anchor.originalText, issue.replacement);
      if (crossesObject || !edits) {
        skippedIssueIds.push(issue.issueId);
        skippedReasons.push("涉及对象或复杂格式，无法安全替换，请人工修改。");
        return null;
      }
      return { issue, ...anchor, edits };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => left.from - right.from);
  const nonOverlapping: typeof resolved = [];
  for (const candidate of resolved) {
    const previous = nonOverlapping.at(-1);
    if (previous && previous.to > candidate.from) {
      skippedIssueIds.push(candidate.issue.issueId);
      skippedReasons.push("建议的替换范围相互重叠，已跳过冲突项。");
      continue;
    }
    nonOverlapping.push(candidate);
  }
  const transaction = closeHistory(editor.state.tr);
  const textStyle = editor.state.schema.marks.textStyle;
  if (!textStyle) throw new Error("AI 纠错编辑器缺少文字颜色扩展。");
  for (const candidate of [...nonOverlapping].reverse()) {
    for (const edit of [...candidate.edits].reverse()) {
      const from = candidate.from + edit.from;
      const to = candidate.from + edit.to;
      const $from = transaction.doc.resolve(from);
      const $to = transaction.doc.resolve(to);
      const inherited = $from.marksAcross($to) ?? $from.marks();
      const originalStyle = inherited.find((mark) => mark.type === textStyle);
      const marks = textStyle
        .create({ ...originalStyle?.attrs, color: AUTOMATIC_EDIT_RED })
        .addToSet(inherited);
      transaction.replaceWith(
        from,
        to,
        edit.text ? editor.state.schema.text(edit.text, marks) : Fragment.empty,
      );
    }
  }
  if (transaction.docChanged) {
    transaction.setMeta(
      "aiCorrectionApplied",
      nonOverlapping.map(({ issue }) => issue),
    );
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.dispatch(closeHistory(editor.state.tr));
  }
  return {
    appliedIssueIds: nonOverlapping.map(({ issue }) => issue.issueId),
    skippedIssueIds,
    skippedReasons: [...new Set(skippedReasons)],
  };
}
