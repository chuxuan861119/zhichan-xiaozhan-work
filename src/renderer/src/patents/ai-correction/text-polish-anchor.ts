import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Mark, Slice } from "@tiptap/pm/model";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import type { AiCorrectionBookKind } from "../../../../shared/ai-correction/contract";
import { mixedSelection, mixedTextRuns } from "../../../../shared/ai-correction/mixed-content";
import type {
  TextPolishAnchor,
  TextPolishReplacementResult,
  TextPolishSelectionScope,
} from "../../../../shared/ai-correction/text-polish-contract";
import { AUTOMATIC_EDIT_RED } from "../../../../shared/patent/reference-marks";
import { inspectMixedSelection, mixedEditorDocument } from "./mixed-selection";
import { type PolishTextEdit, polishTextEdits } from "./text-polish-diff";

const MAX_TEXT_POLISH_CHARACTERS = 20_000;

export type TextPolishSelectionState =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | {
      status: "ready";
      text: string;
      characterCount: number;
      scope: Omit<TextPolishSelectionScope, "selectedTextHash">;
    };

function inspectPlainTextPolishSelection(
  editor: Editor | null,
  bookKind: AiCorrectionBookKind,
): TextPolishSelectionState {
  if (!editor || editor.isDestroyed || editor.state.selection.empty) return { status: "empty" };
  const { selection } = editor.state;
  const { from, to } = selection;
  if (!(selection instanceof TextSelection) && !(selection instanceof AllSelection)) {
    return { status: "invalid", message: "请选择一次连续的普通文字选区。" };
  }
  const blocks: Array<{
    blockId: string;
    blockType: "paragraph" | "heading";
    startOffset: number;
    endOffset: number;
    text: string;
  }> = [];
  let invalid = false;
  editor.state.doc.nodesBetween(from, to, (node, position, parent) => {
    if (parent !== editor.state.doc) return true;
    if (!node.isTextblock || (node.type.name !== "paragraph" && node.type.name !== "heading")) {
      invalid = true;
      return false;
    }
    const blockId = node.attrs.nodeId;
    if (typeof blockId !== "string") {
      invalid = true;
      return false;
    }
    const contentStart = position + 1;
    const startOffset = Math.max(from, contentStart) - contentStart;
    const endOffset = Math.min(to, contentStart + node.content.size) - contentStart;
    if (endOffset > startOffset)
      node.nodesBetween(startOffset, endOffset, (child) => {
        if (!child.isText) invalid = true;
        return false;
      });
    const crossesEmptyBlock = node.content.size === 0 && from < contentStart && to > contentStart;
    if (endOffset > startOffset || crossesEmptyBlock) {
      blocks.push({
        blockId,
        blockType: node.type.name,
        startOffset,
        endOffset,
        text: node.textBetween(startOffset, endOffset, "", "\uFFFC"),
      });
    }
    return false;
  });
  if (invalid || blocks.length === 0) {
    return { status: "invalid", message: "选区不能包含公式、列表、表格、换行或其他对象。" };
  }
  const text = blocks.map((block) => block.text).join("\n");
  if (!text.trim()) return { status: "invalid", message: "选中文字不能只包含空白字符。" };
  if (text.length > MAX_TEXT_POLISH_CHARACTERS) {
    return {
      status: "invalid",
      message: `单次最多润色 ${MAX_TEXT_POLISH_CHARACTERS.toLocaleString("zh-CN")} 个字符。`,
    };
  }
  return {
    status: "ready",
    text,
    characterCount: text.length,
    scope: {
      kind: "selection",
      bookKind,
      blocks: blocks.map(({ blockId, blockType, startOffset, endOffset }) => ({
        blockId,
        blockType,
        startOffset,
        endOffset,
      })),
    },
  };
}

export function inspectTextPolishSelection(
  editor: Editor | null,
  bookKind: AiCorrectionBookKind,
): TextPolishSelectionState {
  const plain = inspectPlainTextPolishSelection(editor, bookKind);
  if (plain.status !== "invalid" || !editor) return plain;
  try {
    const mixed = inspectMixedSelection(editor);
    if (!mixed.spans.length) return plain;
    if (mixed.text.length > MAX_TEXT_POLISH_CHARACTERS)
      return {
        status: "invalid",
        message: "选区内容超过单次处理容量，请分段选择；公式与表格可以直接选取。",
      };
    return {
      status: "ready",
      text: mixed.text,
      characterCount: mixed.text.length,
      scope: { kind: "selection", formatVersion: 2, bookKind, blocks: mixed.spans },
    };
  } catch {
    return { status: "invalid", message: "选区内容暂时无法读取，请重新选择。" };
  }
}

export type ResolvedTextPolishAnchor =
  | { status: "ready"; from: number; to: number }
  | { status: "stale" };

export function resolveTextPolishAnchor(
  editor: Editor,
  anchor: TextPolishAnchor,
): ResolvedTextPolishAnchor {
  if (anchor.formatVersion === 2) {
    try {
      const { blocks, positions } = mixedEditorDocument(editor);
      const mixed = mixedSelection(blocks, anchor.blocks);
      if (mixed.text !== anchor.originalText) return { status: "stale" };
      const first = anchor.blocks[0]!,
        last = anchor.blocks.at(-1)!;
      const a = positions.get(first.blockId)!,
        b = positions.get(last.blockId)!;
      return {
        status: "ready",
        from: a.position + (first.blockType === "object" ? 0 : 1 + first.startOffset),
        to: b.position + (last.blockType === "object" ? b.node.nodeSize : 1 + last.endOffset),
      };
    } catch {
      return { status: "stale" };
    }
  }
  const topLevelBlocks: Array<{
    blockId: string;
    blockType: string;
    position: number;
    size: number;
  }> = [];
  editor.state.doc.forEach((node, position) => {
    topLevelBlocks.push({
      blockId: String(node.attrs.nodeId ?? ""),
      blockType: node.type.name,
      position,
      size: node.content.size,
    });
  });
  let previousIndex = -1;
  const resolved = anchor.blocks.map((span) => {
    const index = topLevelBlocks.findIndex((block) => block.blockId === span.blockId);
    const block = topLevelBlocks[index];
    if (
      !block ||
      block.blockType !== span.blockType ||
      (previousIndex >= 0 && index !== previousIndex + 1) ||
      span.endOffset > block.size
    ) {
      return null;
    }
    previousIndex = index;
    return {
      from: block.position + 1 + span.startOffset,
      to: block.position + 1 + span.endOffset,
    };
  });
  if (resolved.some((span) => span === null)) return { status: "stale" };
  const first = resolved[0];
  const last = resolved.at(-1);
  if (!first || !last) return { status: "stale" };
  const from = first.from;
  const to = last.to;
  if (from < 1 || to > editor.state.doc.content.size || to <= from) return { status: "stale" };
  const text = editor.state.doc.textBetween(from, to, "\n", "\uFFFC");
  return text === anchor.originalText ? { status: "ready", from, to } : { status: "stale" };
}

function polishMarks(marks: readonly Mark[]): Mark[] {
  return marks.flatMap((mark) => {
    if (
      mark.type.name !== "textStyle" ||
      String(mark.attrs.color).toUpperCase() !== AUTOMATIC_EDIT_RED.toUpperCase()
    ) {
      return [mark];
    }
    const attrs = { ...mark.attrs, color: null };
    return Object.values(attrs).some((value) => value !== null && value !== undefined)
      ? [mark.type.create(attrs)]
      : [];
  });
}

export function applyTextPolish(
  editor: Editor,
  result: TextPolishReplacementResult,
  allowFormattingReset = false,
): { ok: true } | { ok: false; message: string; requiresConfirmation?: true } {
  const anchor = resolveTextPolishAnchor(editor, result.anchor);
  if (anchor.status === "stale") {
    return { ok: false, message: "替换失败：原文已修改，请重新选择并润色。" };
  }
  if (result.anchor.formatVersion === 2) return applyMixedTextPolish(editor, result);
  const lines = result.polishedText.split(/\r?\n/u);
  if (lines.length === result.anchor.blocks.length) {
    const edits: PolishTextEdit[] = [];
    let failed = false;
    result.anchor.blocks.forEach((span, index) => {
      editor.state.doc.forEach((node, position) => {
        if (node.attrs.nodeId !== span.blockId) return;
        const original = node.textBetween(span.startOffset, span.endOffset, "", "\uFFFC");
        const revised = lines[index] ?? "";
        let changes = polishTextEdits(original, revised);
        if (!changes) {
          const formats = new Set<string>();
          node.nodesBetween(span.startOffset, span.endOffset, (child) => {
            if (child.isText) formats.add(JSON.stringify(polishMarks(child.marks)));
          });
          if (formats.size > 1 && !allowFormattingReset) {
            failed = true;
            return;
          }
          changes = [{ from: 0, to: original.length, text: revised }];
        }
        edits.push(
          ...changes.map((change) => ({
            ...change,
            from: change.from + position + 1 + span.startOffset,
            to: change.to + position + 1 + span.startOffset,
          })),
        );
      });
    });
    if (failed)
      return {
        ok: false,
        requiresConfirmation: true,
        message:
          "润色改动较大，无法可靠保留全部局部格式。继续替换会统一相关文字格式，是否继续？也可取消并复制润色稿。",
      };
    const transaction = closeHistory(editor.state.tr);
    editor.state.doc.nodesBetween(anchor.from, anchor.to, (node, position) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name !== "textStyle" ||
          String(mark.attrs.color).toUpperCase() !== AUTOMATIC_EDIT_RED.toUpperCase()
        )
          continue;
        const from = Math.max(position, anchor.from),
          to = Math.min(position + node.nodeSize, anchor.to);
        transaction.removeMark(from, to, mark);
        for (const replacement of polishMarks([mark])) transaction.addMark(from, to, replacement);
      }
    });
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      const $from = transaction.doc.resolve(edit.from),
        $to = transaction.doc.resolve(edit.to);
      const marks = polishMarks($from.marksAcross($to) ?? $from.marks());
      transaction.replaceWith(
        edit.from,
        edit.to,
        edit.text ? editor.state.schema.text(edit.text, marks) : Fragment.empty,
      );
    }
    if (transaction.docChanged) {
      editor.view.dispatch(transaction.scrollIntoView());
      editor.view.dispatch(closeHistory(editor.state.tr));
    }
    return { ok: true };
  }
  if (!allowFormattingReset)
    return {
      ok: false,
      requiresConfirmation: true,
      message:
        "润色结果改变了段落数量，继续替换会重新划分段落，并可能重置选区内标题及文字格式。是否继续？也可取消并复制润色稿。",
    };
  const $from = editor.state.doc.resolve(anchor.from),
    $to = editor.state.doc.resolve(anchor.to);
  const marks = polishMarks($from.marksAcross($to) ?? $from.marks());
  const paragraph = editor.state.schema.nodes.paragraph;
  if (!paragraph) return { ok: false, message: "替换失败：当前文档不支持段落文字。" };
  const replacement = new Slice(
    Fragment.fromArray(
      lines.map((line) =>
        paragraph.create(null, line ? editor.state.schema.text(line, marks) : null),
      ),
    ),
    1,
    1,
  );
  const transaction = closeHistory(editor.state.tr).replaceRange(
    anchor.from,
    anchor.to,
    replacement,
  );
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr));
  return { ok: true };
}

function applyMixedTextPolish(
  editor: Editor,
  result: TextPolishReplacementResult,
): { ok: true } | { ok: false; message: string } {
  const failure = {
    ok: false as const,
    message:
      "此稿改变了公式、对象标记或段落结构，不能直接替换。可复制结果，或要求 AI 保留结构重新修改。",
  };
  try {
    const { blocks, positions } = mixedEditorDocument(editor);
    const mixed = mixedSelection(blocks, result.anchor.blocks);
    const lines = result.polishedText.split(/\r?\n/u);
    if (lines.length !== mixed.lines.length) return failure;
    const edits: PolishTextEdit[] = [];
    for (const [index, line] of mixed.lines.entries()) {
      const runs = mixedTextRuns(line, lines[index]!);
      if (!runs) return failure;
      const location = positions.get(line.span.blockId)!;
      for (const run of runs) {
        if (line.span.blockType === "object") {
          if (run.text) return failure;
          continue;
        }
        const original = location.node.textBetween(run.start, run.end, "", "\uFFFC");
        const changes = polishTextEdits(original, run.text);
        if (!changes) return failure;
        edits.push(
          ...changes.map((change) => ({
            ...change,
            from: location.position + 1 + run.start + change.from,
            to: location.position + 1 + run.start + change.to,
          })),
        );
      }
    }
    const transaction = closeHistory(editor.state.tr);
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      const marks = polishMarks(transaction.doc.resolve(edit.from).marks());
      transaction.replaceWith(
        edit.from,
        edit.to,
        edit.text ? editor.state.schema.text(edit.text, marks) : Fragment.empty,
      );
    }
    if (transaction.docChanged) {
      editor.view.dispatch(transaction);
      editor.view.dispatch(closeHistory(editor.state.tr));
    }
    return { ok: true };
  } catch {
    return failure;
  }
}
