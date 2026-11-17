import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { randomUuid } from "../../../../shared/id";
import { PATENT_FIRST_LINE_INDENT_MM } from "../../../../shared/patent/formatting";
import { type ClaimInsertionPlan, planDependentClaimInsertion } from "./caret-aware-claim-plan";
import { CLAIM_REFERENCE_MARKER_SOURCE } from "./claim-reference-expression";

export type ClaimEditorOperationResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 插入从属权利要求时，被插入/被改变的字符统一标记：红字（claimReferenceReview）+ 黄色高亮背景。 */
const CHANGE_HIGHLIGHT_COLOR = "#FDE047" as const;

type EditorParagraph = {
  paragraphIndex: number;
  rootIndex: number;
  position: number;
  node: ProseMirrorNode;
  text: string;
};

type PlannedReplacement = {
  from: number;
  to: number;
  text: string;
  kind: "number" | "reference";
  source: EditorParagraph;
};

type TextCleanup = {
  from: number;
  to: number;
  text: string;
  marks: readonly Mark[];
  removedFormats: number;
  normalizedSpaces: number;
  removedUnderlines: number;
};

function isPatentPunctuation(character: string): boolean {
  return /[，。；：、（）【】《》！？,.!?;:()[\]{}]/u.test(character);
}

function normalizePatentSpaces(
  text: string,
  beforeNode = "",
  afterNode = "",
): { text: string; changes: number } {
  let changes = 0;
  const normalized = text.replaceAll("　", " ").replace(/\s+/gu, (spaces, offset, source) => {
    const prefix = beforeNode + source.slice(0, offset);
    const suffix = source.slice(offset + spaces.length) + afterNode;
    const before = prefix.trimEnd().at(-1) ?? "";
    const after = suffix.trimStart().slice(0, 1);
    const remove =
      before.length === 0 ||
      after.length === 0 ||
      /\p{Script=Han}/u.test(before) ||
      /\p{Script=Han}/u.test(after) ||
      isPatentPunctuation(before) ||
      isPatentPunctuation(after) ||
      // A whitespace run can cross marks; retain its separator only in its first node.
      /\s$/u.test(prefix);
    const replacement = remove ? "" : " ";
    if (replacement !== spaces) changes += 1;
    return replacement;
  });
  return { text: normalized, changes };
}

function emptyUnderlineRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let pending: { from: number; to: number; count: number } | null = null;
  const flush = () => {
    if (pending && pending.count >= 2) ranges.push({ from: pending.from, to: pending.to });
    pending = null;
  };
  for (const match of text.matchAll(/[_\uFF3F]+/gu)) {
    const from = match.index;
    const to = from + match[0].length;
    const before = text.slice(0, from);
    const after = text.slice(to);
    // Chinese template blanks may touch prose, but identifier underscores are content.
    const identifierBefore = /[\p{L}\p{N}]$/u.test(before) && !/\p{Script=Han}$/u.test(before);
    const identifierAfter = /^[\p{L}\p{N}]/u.test(after) && !/^\p{Script=Han}/u.test(after);
    if (identifierBefore || identifierAfter) {
      flush();
      continue;
    }
    if (pending && /^[ \t\u00A0\u3000]*$/u.test(text.slice(pending.to, from))) {
      pending.to = to;
      pending.count += match[0].length;
    } else {
      flush();
      pending = { from, to, count: match[0].length };
    }
  }
  flush();
  return ranges;
}

type CleanedTextRun = { text: string; before: string; after: string; removedUnderlines: number };

function cleanedTextRuns(parent: ProseMirrorNode): Map<ProseMirrorNode, CleanedTextRun> {
  const cleaned = new Map<ProseMirrorNode, CleanedTextRun>();
  let nodes: Array<{ node: ProseMirrorNode; text: string }> = [];
  let beforeBoundary = "";
  const flush = (afterBoundary: string) => {
    const ranges = emptyUnderlineRanges(nodes.map(({ text }) => text).join(""));
    let offset = 0;
    const parts = nodes.map(({ node, text }) => {
      const from = offset;
      const to = from + text.length;
      offset = to;
      let cursor = 0;
      let result = "";
      for (const range of ranges) {
        if (range.to <= from || range.from >= to) continue;
        const start = Math.max(0, range.from - from);
        result += text.slice(cursor, start);
        cursor = Math.min(text.length, range.to - from);
      }
      return {
        node,
        text: result + text.slice(cursor),
        removedUnderlines: ranges.filter((range) => range.from >= from && range.from < to).length,
      };
    });
    const text = parts.map((part) => part.text).join("");
    offset = 0;
    for (const part of parts) {
      cleaned.set(part.node, {
        text: part.text,
        before: beforeBoundary + text.slice(0, offset),
        after: text.slice(offset + part.text.length) + afterBoundary,
        removedUnderlines: part.removedUnderlines,
      });
      offset += part.text.length;
    }
    nodes = [];
  };
  parent.forEach((node) => {
    if (node.isText && node.text !== undefined) nodes.push({ node, text: node.text });
    else {
      const boundary = node.type.name === "hardBreak" ? "" : "\uFFFC";
      flush(boundary);
      beforeBoundary = boundary;
    }
  });
  flush("");
  return cleaned;
}

function cleanedMarks(
  marks: readonly Mark[],
  colorsOnly = false,
): { marks: readonly Mark[]; removed: number } {
  let removed = 0;
  const cleaned = marks.flatMap((mark) => {
    if (
      (!colorsOnly && (mark.type.name === "underline" || mark.type.name === "italic")) ||
      mark.type.name === "claimReferenceReview"
    ) {
      removed += 1;
      return [];
    }
    if (mark.type.name !== "textStyle") return [mark];

    const hasColor = typeof mark.attrs.color === "string";
    const hasBackground = typeof mark.attrs.backgroundColor === "string";
    if (!hasColor && !hasBackground) return [mark];

    removed += 1;
    const attributes = Object.fromEntries(
      Object.entries(mark.attrs).filter(
        ([name, value]) => name !== "color" && name !== "backgroundColor" && value != null,
      ),
    );
    return Object.keys(attributes).length > 0 ? [mark.type.create(attributes)] : [];
  });
  return { marks: cleaned, removed };
}

function topLevelParagraphs(editor: Editor): EditorParagraph[] {
  const paragraphs: EditorParagraph[] = [];
  editor.state.doc.forEach((node, position, rootIndex) => {
    // Keep root block indexes and inline positions intact. Non-text content must never
    // look like a reusable empty paragraph, and a soft break occupies one PM position.
    let text = "";
    if (node.type.name === "paragraph") {
      node.forEach((child) => {
        text += child.isText
          ? child.text
          : child.type.name === "hardBreak"
            ? "\n"
            : "\uFFFC".repeat(child.nodeSize);
      });
      if (!text.trim() && node.content.content.some((child) => !child.isText)) {
        // A break-only paragraph is structural content, not a reusable blank paragraph.
        text = "\uFFFC".repeat(node.content.size);
      }
    } else text = "\uFFFC";
    paragraphs.push({
      paragraphIndex: paragraphs.length,
      rootIndex,
      position,
      node,
      text,
    });
  });
  return paragraphs;
}

function paragraphAtCaret(
  editor: Editor,
  paragraphs: readonly EditorParagraph[],
): EditorParagraph | null {
  const position = editor.state.selection.$head.pos;
  return (
    paragraphs.find(
      (paragraph) =>
        paragraph.node.type.name === "paragraph" &&
        position >= paragraph.position + 1 &&
        position <= paragraph.position + paragraph.node.nodeSize - 1,
    ) ?? null
  );
}

function marksAtOffset(paragraph: EditorParagraph, offset: number): readonly Mark[] {
  let cursor = 0;
  let found = false;
  let marks: readonly Mark[] = [];
  paragraph.node.forEach((child) => {
    if (found) return;
    const end = cursor + child.nodeSize;
    if (child.isText && offset >= cursor && offset < end) {
      marks = child.marks;
      found = true;
      return;
    }
    cursor = end;
  });
  return marks;
}

/**
 * 分段构建被改变字符的文本节点：
 * - 整段字符叠加红字（claimReferenceReview）；
 * - 编号替换（kind="number"）：数字与分隔符（"."、"．"、"、"）叠加黄色高亮，空格不叠加；
 * - 引用替换（kind="reference"）：整个替换范围（含两侧空格）叠加黄色高亮与红色下划线。
 */
function changedTextNodes(
  editor: Editor,
  text: string,
  baseMarks: readonly Mark[],
  kind: "number" | "reference",
): ProseMirrorNode[] | null {
  const review = editor.schema.marks.claimReferenceReview;
  const textStyle = editor.schema.marks.textStyle;
  const underline = editor.schema.marks.underline;
  if (!review || !textStyle || !underline) return null;
  const cleanedBase = baseMarks.filter((mark) => mark.type.name !== "claimReferenceReview");
  const existingTextStyle = cleanedBase.find((mark) => mark.type === textStyle);
  const highlight =
    existingTextStyle === undefined
      ? textStyle.create({ backgroundColor: CHANGE_HIGHLIGHT_COLOR })
      : textStyle.create({ ...existingTextStyle.attrs, backgroundColor: CHANGE_HIGHLIGHT_COLOR });
  const baseWithoutHighlight = cleanedBase.filter((mark) => mark !== existingTextStyle);

  const nodes: ProseMirrorNode[] = [];
  const parts = text.split(/(\d+|[.．、])/u).filter((part) => part.length > 0);
  for (const part of parts) {
    const marks: Mark[] = [...baseWithoutHighlight, review.create()];
    const isNumber = /^\d+$/u.test(part);
    const isSeparator = /^[.．、]$/u.test(part);
    if (kind === "reference" || isNumber || (kind === "number" && isSeparator)) {
      marks.push(highlight);
    }
    if (kind === "reference") marks.push(underline.create());
    nodes.push(editor.schema.text(part, marks));
  }
  return nodes;
}

function plannedReplacements(
  paragraphs: readonly EditorParagraph[],
  plan: ClaimInsertionPlan,
): PlannedReplacement[] | null {
  const byIndex = new Map(paragraphs.map((paragraph) => [paragraph.paragraphIndex, paragraph]));
  const replacements: PlannedReplacement[] = [];
  for (const replacement of plan.paragraphNumberReplacements) {
    const source = byIndex.get(replacement.paragraphIndex);
    if (!source) return null;
    replacements.push({
      from: source.position + 1 + replacement.from,
      to: source.position + 1 + replacement.to,
      text: replacement.text,
      kind: "number",
      source,
    });
  }
  for (const replacement of plan.referenceReplacements) {
    const source = byIndex.get(replacement.paragraphIndex);
    if (!source) return null;
    replacements.push({
      from: source.position + 1 + replacement.from,
      to: source.position + 1 + replacement.to,
      text: replacement.text,
      kind: "reference",
      source,
    });
  }
  return replacements.sort((left, right) => right.from - left.from);
}

function insertionParagraph(editor: Editor, source: EditorParagraph, plan: ClaimInsertionPlan) {
  const review = editor.schema.marks.claimReferenceReview;
  if (!review) return null;
  const range = plan.referenceReviewRanges[0];
  if (!range) return null;
  const text = plan.replacementText;
  const middleNodes = changedTextNodes(editor, text.slice(range.from, range.to), [], "reference");
  if (!middleNodes) return null;
  const content = Fragment.fromArray([
    editor.schema.text(text.slice(0, range.from), [review.create()]),
    ...middleNodes,
    editor.schema.text(text.slice(range.to), [review.create()]),
  ]);
  return source.node.type.create(
    {
      ...source.node.attrs,
      nodeId: randomUuid(),
      semanticRole: "claim",
    },
    content,
  );
}

export function insertDependentClaimAtSelection(editor: Editor): ClaimEditorOperationResult {
  if (editor.isDestroyed) return { ok: false, message: "权利要求编辑器尚未就绪，请稍后重试。" };
  const paragraphs = topLevelParagraphs(editor);
  if (
    paragraphs.some(
      (item) =>
        item.node.type.name !== "paragraph" &&
        new RegExp(`${CLAIM_REFERENCE_MARKER_SOURCE}(?!\\s*书)`, "u").test(item.node.textContent),
    )
  ) {
    return {
      ok: false,
      message:
        "表格或列表等内容中包含权利要求引用，无法安全同步编号，未修改原文。请将引用整理到普通段落后重试。",
    };
  }
  // Headings before the first claim are not claim text, but keep their positions.
  const firstParagraph = paragraphs.findIndex((item) => item.node.type.name === "paragraph");
  const active = paragraphAtCaret(editor, paragraphs);
  if (!active) {
    return { ok: false, message: "未能确定光标所在的权利要求，请将光标放入目标权利要求后重试。" };
  }

  const planResult = planDependentClaimInsertion({
    paragraphs: paragraphs.map((paragraph, index) =>
      index < firstParagraph ? "" : paragraph.text,
    ),
    cursorParagraphIndex: active.paragraphIndex,
    cursorParagraphIsEmpty: active.text.trim().length === 0,
  });
  if (!planResult.ok) return { ok: false, message: planResult.error.message };

  const replacements = plannedReplacements(paragraphs, planResult.value);
  const newParagraph = insertionParagraph(editor, active, planResult.value);
  const target = paragraphs.find(
    (paragraph) => paragraph.paragraphIndex === planResult.value.insertionIndex,
  );
  if (!replacements || !newParagraph || (planResult.value.reuseEmptyParagraph && !target)) {
    return { ok: false, message: "权利要求编辑器状态异常，请重新定位光标后重试。" };
  }

  let transaction = closeHistory(editor.state.tr);
  for (const replacement of replacements) {
    const marks = marksAtOffset(
      replacement.source,
      replacement.from - replacement.source.position - 1,
    );
    const nodes = changedTextNodes(editor, replacement.text, marks, replacement.kind);
    if (!nodes) return { ok: false, message: "引用复核标记尚未就绪，请稍后重试。" };
    transaction = transaction.replaceWith(
      replacement.from,
      replacement.to,
      Fragment.fromArray(nodes),
    );
  }

  const insertionPosition = planResult.value.reuseEmptyParagraph
    ? transaction.mapping.map(target?.position ?? -1)
    : transaction.mapping.map(target?.position ?? editor.state.doc.content.size);
  if (insertionPosition < 0) {
    return { ok: false, message: "未找到可插入的权利要求段落，请重新定位光标后重试。" };
  }
  transaction = planResult.value.reuseEmptyParagraph
    ? transaction.replaceWith(
        insertionPosition,
        insertionPosition + (target?.node.nodeSize ?? 0),
        newParagraph,
      )
    : transaction.insert(insertionPosition, newParagraph);
  const caretPosition = insertionPosition + 1 + newParagraph.content.size;
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, caretPosition));
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.commands.focus(undefined, { scrollIntoView: false });

  const parentNumber = planResult.value.replacementText.match(
    /^\d+[.．、]\s*根据权利要求\s*(\d+)/u,
  )?.[1];
  const nextNumber = planResult.value.replacementText.match(/^(\d+)/u)?.[1];
  return {
    ok: true,
    message: `已在第 ${parentNumber} 项后插入第 ${nextNumber} 项从属权利要求，默认引用权利要求 ${parentNumber}。`,
  };
}

function isEmptyParagraph(node: ProseMirrorNode): boolean {
  if (node.type.name !== "paragraph") return false;
  let hasVisibleContent = false;
  node.forEach((child) => {
    if (child.isText) {
      if (child.text?.trim()) hasVisibleContent = true;
    } else {
      hasVisibleContent = true;
    }
  });
  return !hasVisibleContent;
}

export function clearExtraFormatting(editor: Editor): ClaimEditorOperationResult {
  if (editor.isDestroyed) return { ok: false, message: "当前书册编辑器尚未就绪，请稍后重试。" };
  const cleanups: TextCleanup[] = [];
  const copiedIndentParagraphs: number[] = [];
  const textRuns = new Map<ProseMirrorNode, Map<ProseMirrorNode, CleanedTextRun>>();
  editor.state.doc.descendants((node, position, parent) => {
    if (node.type.spec.tableRole === "table") {
      // Tables are deliberately formatted by the user. Only remove text colors;
      // preserve their paragraphs, whitespace, placeholders and all other marks.
      node.descendants((child, offset) => {
        if (!child.isText || child.text === undefined) return;
        const marks = cleanedMarks(child.marks, true);
        if (!marks.removed) return;
        const from = position + 1 + offset;
        cleanups.push({
          from,
          to: from + child.nodeSize,
          text: child.text,
          marks: marks.marks,
          removedFormats: marks.removed,
          normalizedSpaces: 0,
          removedUnderlines: 0,
        });
      });
      return false;
    }
    if (node.type.name === "paragraph" && /^(?:　{2,}| {4,})/u.test(node.textContent)) {
      copiedIndentParagraphs.push(position);
    }
    if (!node.isText || node.text === undefined || !parent) return;
    let runs = textRuns.get(parent);
    if (!runs) {
      runs = cleanedTextRuns(parent);
      textRuns.set(parent, runs);
    }
    const run = runs.get(node);
    if (!run) return;
    const normalized = normalizePatentSpaces(run.text, run.before, run.after);
    const marks = cleanedMarks(node.marks);
    if (normalized.text === node.text && marks.removed === 0 && run.removedUnderlines === 0) {
      return;
    }
    cleanups.push({
      from: position,
      to: position + node.nodeSize,
      text: normalized.text,
      marks: marks.marks,
      removedFormats: marks.removed,
      normalizedSpaces: isEmptyParagraph(parent) ? 0 : normalized.changes,
      removedUnderlines: run.removedUnderlines,
    });
  });
  let transaction = closeHistory(editor.state.tr);
  for (const position of copiedIndentParagraphs) {
    const paragraph = transaction.doc.nodeAt(position);
    if (paragraph?.type.name !== "paragraph") continue;
    const currentIndent = paragraph.attrs.paragraphIndentMm;
    transaction = transaction.setNodeMarkup(position, undefined, {
      ...paragraph.attrs,
      paragraphIndentMm:
        typeof currentIndent === "number" && currentIndent > 0
          ? currentIndent
          : PATENT_FIRST_LINE_INDENT_MM,
    });
  }
  for (const cleanup of cleanups.sort((left, right) => right.from - left.from)) {
    transaction =
      cleanup.text.length === 0
        ? transaction.delete(cleanup.from, cleanup.to)
        : transaction.replaceWith(
            cleanup.from,
            cleanup.to,
            editor.schema.text(cleanup.text, cleanup.marks),
          );
  }
  const extraBreaks: number[] = [];
  transaction.doc.descendants((node, position) => {
    if (node.type.spec.tableRole === "table") return false;
    if (!node.isTextblock) return;
    let lineHasContent = false;
    let trailingBreak: number | null = null;
    node.forEach((child, offset) => {
      if (child.type.name === "hardBreak") {
        const at = position + 1 + offset;
        if (!lineHasContent) extraBreaks.push(at);
        else trailingBreak = at;
        lineHasContent = false;
      } else if (!child.isText || child.text?.trim()) {
        lineHasContent = true;
        trailingBreak = null;
      }
    });
    if (trailingBreak !== null) extraBreaks.push(trailingBreak);
    return false;
  });
  for (const position of extraBreaks.sort((left, right) => right - left)) {
    transaction = transaction.delete(position, position + 1);
  }
  const emptyParagraphs: Array<{ from: number; to: number }> = [];
  transaction.doc.descendants((node, position) => {
    if (node.type.spec.tableRole === "table") return false;
    if (isEmptyParagraph(node)) {
      emptyParagraphs.push({ from: position, to: position + node.nodeSize });
      return false;
    }
  });
  let removedEmptyLines = extraBreaks.length;
  const trailingNode = editor.extensionManager.extensions.find(
    (extension) => extension.name === "trailingNode",
  );
  const trailingNodeName =
    trailingNode?.options.node ||
    editor.schema.topNodeType.contentMatch.defaultType?.name ||
    "paragraph";
  const notAfter = trailingNode?.options.notAfter ?? [];
  const noTrailingNodeAfter = [
    trailingNodeName,
    ...(Array.isArray(notAfter) ? notAfter : [notAfter]),
  ];
  for (const range of emptyParagraphs.reverse()) {
    const resolved = transaction.doc.resolve(range.from);
    const index = resolved.index();
    // A list item or the document may require its final paragraph to remain.
    if (!resolved.parent.canReplace(index, index + 1)) continue;
    // Keep the caret paragraph that TrailingNode would immediately recreate.
    const previous = index > 0 ? resolved.parent.child(index - 1) : null;
    if (
      trailingNode &&
      resolved.depth === 0 &&
      index === resolved.parent.childCount - 1 &&
      previous &&
      !noTrailingNodeAfter.includes(previous.type.name)
    )
      continue;
    transaction = transaction.delete(range.from, range.to);
    removedEmptyLines += 1;
  }
  if (!transaction.docChanged) {
    return { ok: true, message: "未发现需要清理的多余格式或空格。" };
  }
  const mappedSelection = transaction.mapping.map(editor.state.selection.$head.pos);
  const selection = Math.max(1, Math.min(mappedSelection, transaction.doc.content.size));
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, selection));
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.commands.focus(undefined, { scrollIntoView: false });

  const formatCount = cleanups.reduce((total, cleanup) => total + cleanup.removedFormats, 0);
  const spaceCount = cleanups.reduce((total, cleanup) => total + cleanup.normalizedSpaces, 0);
  const underlineCount = cleanups.reduce((total, cleanup) => total + cleanup.removedUnderlines, 0);
  const emptyLineCount = removedEmptyLines;
  const message =
    emptyLineCount > 0 && underlineCount > 0
      ? `已清除 ${formatCount} 处格式，删除 ${emptyLineCount} 处空行、${underlineCount} 处空下划线，并整理 ${spaceCount} 处多余空格。`
      : emptyLineCount > 0
        ? `已清除 ${formatCount} 处格式，删除 ${emptyLineCount} 处空行，并整理 ${spaceCount} 处多余空格。`
        : underlineCount > 0
          ? `已清除 ${formatCount} 处格式，删除 ${underlineCount} 处空下划线，并整理 ${spaceCount} 处多余空格。`
          : `已清除 ${formatCount} 处格式并整理 ${spaceCount} 处多余空格。`;
  return { ok: true, message };
}
