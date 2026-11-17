import { randomUUID } from "node:crypto";
import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { describe, expect, test } from "vitest";
import type { AiCorrectionIssue } from "../../../../shared/ai-correction/contract";
import { AUTOMATIC_EDIT_RED } from "../../../../shared/patent/reference-marks";
import { createPatentExtensions } from "../../editor/extensions";
import { inspectionSelectionKey } from "../../editor/extensions/inspection-selection";
import {
  applyCorrectionIssues,
  locateCorrectionAnchor,
  selectCorrectionAnchor,
  startCorrectionAnchorTracking,
} from "./correction-anchor";

function editorWith(blockId: string) {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [{ type: "text", text: "错别字以及语病" }],
        },
      ],
    },
  });
}

function issue(
  blockId: string,
  startOffset: number,
  endOffset: number,
  originalText: string,
  replacement: string,
): AiCorrectionIssue {
  return {
    issueId: randomUUID(),
    category: "spelling",
    risk: "low",
    applicability: "replace",
    anchor: {
      bookKind: "description",
      blockId,
      startOffset,
      endOffset,
      originalText,
      originalTextHash: "0".repeat(64),
    },
    replacement,
    explanation: "测试",
  };
}

describe("AI correction editor anchors", () => {
  test("undo restores the exact occurrence while retaining unrelated document edits", () => {
    const blockId = randomUUID();
    const editor = customEditor(
      blockId,
      [{ type: "text", text: "甲错乙甲错乙" }],
      [{ type: "paragraph", content: [{ type: "text", text: "其他内容" }] }],
    );
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 4, 5, "错", "正");
    try {
      editor.commands.insertContentAt(10, "新增");
      editor.view.dispatch(closeHistory(editor.state.tr));
      const beforeTargetEdit = editor.getJSON();
      editor.commands.insertContentAt({ from: 5, to: 6 }, "误");
      expect(locateCorrectionAnchor(editor, target).status).toBe("stale");
      editor.commands.undo();
      expect(editor.getJSON()).toEqual(beforeTargetEdit);
      expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 5, to: 6 });
      editor.commands.redo();
      expect(locateCorrectionAnchor(editor, target).status).toBe("stale");
      editor.commands.undo();
      expect(applyCorrectionIssues(editor, [target]).appliedIssueIds).toEqual([target.issueId]);
      expect(editor.getText()).toContain("甲错乙甲正乙");
      expect(editor.getText()).toContain("新增");
      editor.commands.undo();
      expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 5, to: 6 });
    } finally {
      stop();
      editor.destroy();
    }
  });

  test("undo of a grouped multi-step target edit restores its shifted anchor", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 0, 1, "错", "正");
    try {
      editor.commands.insertContentAt(1, "前缀");
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.insertContentAt({ from: 3, to: 4 }, "误");
      editor.commands.insertContentAt({ from: 3, to: 4 }, "误字");
      editor.commands.undo();
      expect(editor.getText()).toBe("前缀错别字以及语病");
      expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 3, to: 4 });
    } finally {
      stop();
      editor.destroy();
    }
  });

  test("restores tracked anchors after undoing a manual edit and follows later edits", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 0, 1, "错", "正");
    try {
      editor.commands.insertContentAt({ from: 1, to: 2 }, "误");
      expect(locateCorrectionAnchor(editor, target).status).toBe("stale");
      editor.commands.undo();
      expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 1, to: 2 });
      editor.commands.redo();
      expect(locateCorrectionAnchor(editor, target).status).toBe("stale");
      editor.commands.undo();
      editor.commands.insertContentAt(1, "前文");
      expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 3, to: 4 });
      expect(applyCorrectionIssues(editor, [target]).appliedIssueIds).toEqual([target.issueId]);
      expect(editor.getText()).toBe("前文正别字以及语病");
    } finally {
      stop();
      editor.destroy();
    }
  });
  test("marks AI locate selections without suppressing subsequent manual selections", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    expect(selectCorrectionAnchor(editor, issue(blockId, 0, 1, "错", "正"))).toBe(true);
    expect(inspectionSelectionKey.getState(editor.state)).toBe(true);
    editor.commands.setTextSelection({ from: 2, to: 4 });
    expect(inspectionSelectionKey.getState(editor.state)).toBe(false);
    editor.destroy();
  });
  test("restores issue state and its anchor on undo and reapplies state on redo", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const changes: boolean[] = [];
    const stop = startCorrectionAnchorTracking(editor, (_issues, applied) => changes.push(applied));
    const target = issue(blockId, 0, 1, "错", "正");
    applyCorrectionIssues(editor, [target]);
    editor.commands.undo();
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 1, to: 2 });
    editor.commands.redo();
    expect(changes).toEqual([true, false, true]);
    stop();
    editor.destroy();
  });
  test("uses verified snapshot offsets for repeated identical contexts", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "甲错乙甲错乙" }]);
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 4, 5, "错", "正");
    target.anchor.contextBefore = "甲";
    target.anchor.contextAfter = "乙";
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 5, to: 6 });
    stop();
    editor.destroy();
  });
  test("locates tracked analysis spanning a soft break but never replaces the break", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [
      { type: "text", text: "甲" },
      { type: "hardBreak" },
      { type: "text", text: "乙" },
    ]);
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 0, 3, "甲\n乙", "甲乙");
    editor.commands.insertContentAt(1, "前");
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 2, to: 5 });
    expect(applyCorrectionIssues(editor, [target]).skippedIssueIds).toEqual([target.issueId]);
    expect(editor.getJSON().content?.[0]?.content?.[1]?.type).toBe("hardBreak");
    stop();
    editor.destroy();
  });

  test("formatting-only edits leave tracked text positions valid", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const stop = startCorrectionAnchorTracking(editor);
    editor.chain().setTextSelection({ from: 1, to: 2 }).setBold().run();
    expect(locateCorrectionAnchor(editor, issue(blockId, 0, 1, "错", "正"))).toEqual({
      status: "ready",
      from: 1,
      to: 2,
    });
    stop();
    editor.destroy();
  });
  test("bounds retained transaction maps and requires a fresh check after the limit", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const stop = startCorrectionAnchorTracking(editor);
    const tr = editor.state.tr;
    for (let index = 0; index <= 10_000; index++) tr.insertText("前", 1);
    editor.view.dispatch(tr);
    expect(locateCorrectionAnchor(editor, issue(blockId, 0, 1, "错", "正"))).toEqual({
      status: "stale",
    });
    stop();
    editor.destroy();
  });

  test("an older cleanup is idempotent and cannot remove a newer request tracker", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const stopOld = startCorrectionAnchorTracking(editor);
    const stopNew = startCorrectionAnchorTracking(editor);
    stopOld();
    stopOld();
    const target = issue(blockId, 0, 1, "错", "正");
    target.anchor.contextAfter = "别字以及语病";
    editor.commands.insertContentAt(2, "后缀");
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 1, to: 2 });
    stopNew();
    editor.destroy();
  });
  test("tracks pending request anchors and sequential accepts despite changed nearby context", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "错甲；错乙" }]);
    const stop = startCorrectionAnchorTracking(editor);
    const first = issue(blockId, 0, 1, "错", "正确");
    first.anchor.contextAfter = "甲；错乙";
    const second = issue(blockId, 3, 4, "错", "正");
    second.anchor.contextBefore = "错甲；";
    second.anchor.contextAfter = "乙";
    editor.commands.insertContentAt(1, "前缀");
    expect(applyCorrectionIssues(editor, [first]).skippedIssueIds).toEqual([]);
    expect(applyCorrectionIssues(editor, [second]).skippedIssueIds).toEqual([]);
    expect(editor.getText()).toBe("前缀正确甲；正乙");
    stop();
    editor.destroy();
  });

  test("does not retarget a deleted tracked occurrence to a surviving identical occurrence", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "错甲；错乙" }]);
    const stop = startCorrectionAnchorTracking(editor);
    const target = issue(blockId, 0, 1, "错", "正");
    target.anchor.contextAfter = "甲；错乙";
    editor.commands.deleteRange({ from: 1, to: 2 });
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "stale" });
    stop();
    editor.destroy();
  });

  test("matches backend newline context after a soft break without replacing the break", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [
      { type: "text", text: "甲" },
      { type: "hardBreak" },
      { type: "text", text: "错乙" },
    ]);
    const target = issue(blockId, 2, 3, "错", "正");
    target.anchor.contextBefore = "甲\n";
    target.anchor.contextAfter = "乙";
    expect(applyCorrectionIssues(editor, [target]).skippedIssueIds).toEqual([]);
    expect(editor.getJSON().content?.[0]?.content?.[1]?.type).toBe("hardBreak");
    editor.destroy();
  });

  test.each(["list", "table"])("replaces ordinary text inside a %s container", (container) => {
    const blockId = randomUUID();
    const paragraph = {
      type: "paragraph",
      attrs: { nodeId: blockId },
      content: [{ type: "text", text: "错字" }],
    };
    const block =
      container === "list"
        ? { type: "bulletList", content: [{ type: "listItem", content: [paragraph] }] }
        : {
            type: "table",
            content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph] }] }],
          };
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: { type: "doc", content: [block] },
    });
    expect(
      applyCorrectionIssues(editor, [issue(blockId, 0, 1, "错", "正")]).skippedIssueIds,
    ).toEqual([]);
    expect(editor.getText()).toContain("正字");
    editor.destroy();
  });
  function customEditor(blockId: string, content: JSONContent[], extra: JSONContent[] = []) {
    return new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [{ type: "paragraph", attrs: { nodeId: blockId }, content }, ...extra],
      },
    });
  }

  test("never follows an old offset into a different paragraph", () => {
    const blockId = randomUUID();
    const editor = customEditor(
      blockId,
      [{ type: "text", text: "甲" }],
      [{ type: "paragraph", content: [{ type: "text", text: "语病" }] }],
    );
    expect(locateCorrectionAnchor(editor, issue(blockId, 3, 5, "语病", "表述"))).toEqual({
      status: "stale",
    });
    editor.destroy();
  });

  test("rejects ambiguous legacy anchors even when the old offset still matches", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "阀甲；阀乙" }]);
    expect(locateCorrectionAnchor(editor, issue(blockId, 0, 1, "阀", "阀门"))).toEqual({
      status: "stale",
    });
    editor.destroy();
  });

  test("uses adjacent context after insertion even when the old offset matches another occurrence", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "阀丙；阀甲；阀乙" }]);
    const target = issue(blockId, 3, 4, "阀", "阀门");
    Object.assign(target.anchor, { contextBefore: "阀甲；", contextAfter: "乙" });
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "ready", from: 7, to: 8 });
    Object.assign(target.anchor, { contextAfter: "已改" });
    expect(locateCorrectionAnchor(editor, target)).toEqual({ status: "stale" });
    editor.destroy();
  });

  test.each(["inlineMath", "hardBreak"])("does not replace a range crossing %s", (type) => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [
      { type: "text", text: "甲" },
      { type, attrs: { latex: "x" } },
      { type: "text", text: "乙" },
    ]);
    const original = editor.getJSON();
    const target = issue(blockId, 0, 3, "甲\uFFFC乙", "甲乙");
    expect(applyCorrectionIssues(editor, [target])).toEqual({
      appliedIssueIds: [],
      skippedIssueIds: [target.issueId],
      skippedReasons: ["涉及换行或行内对象，请人工修改。"],
    });
    expect(editor.getJSON()).toEqual(original);
    editor.destroy();
  });

  test("rejects replacement object placeholders", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const target = issue(blockId, 0, 1, "错", "正\uFFFC");
    expect(applyCorrectionIssues(editor, [target]).skippedIssueIds).toEqual([target.issueId]);
    expect(editor.getText()).toBe("错别字以及语病");
    editor.destroy();
  });

  test("preserves untouched local formatting and inherits changed text marks under red", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [
      { type: "text", text: "H", marks: [{ type: "bold" }] },
      { type: "text", text: "2", marks: [{ type: "subscript" }] },
      {
        type: "text",
        text: "错",
        marks: [
          { type: "bold" },
          { type: "textStyle", attrs: { fontFamily: "宋体", color: "#0000FF" } },
        ],
      },
    ]);
    const original = editor.getJSON();
    applyCorrectionIssues(editor, [issue(blockId, 0, 3, "H2错", "H2正")]);
    const nodes = editor.getJSON().content?.[0]?.content;
    expect(nodes?.slice(0, 2)).toEqual(original.content?.[0]?.content?.slice(0, 2));
    expect(nodes?.[2]?.marks).toEqual(
      expect.arrayContaining([
        { type: "bold" },
        {
          type: "textStyle",
          attrs: expect.objectContaining({ fontFamily: "宋体", color: AUTOMATIC_EDIT_RED }),
        },
      ]),
    );
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
    editor.destroy();
  });

  test("skips overly complex diffs without a formatting reset", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [{ type: "text", text: "甲".repeat(1500) }]);
    const target = issue(blockId, 0, 1500, "甲".repeat(1500), "乙".repeat(1500));
    expect(applyCorrectionIssues(editor, [target]).skippedIssueIds).toEqual([target.issueId]);
    expect(editor.getText()).toBe("甲".repeat(1500));
    editor.destroy();
  });

  test("keeps a changed textual subscript and preserves an adjacent formula", () => {
    const blockId = randomUUID();
    const editor = customEditor(blockId, [
      { type: "text", text: "错", marks: [{ type: "subscript" }] },
      { type: "inlineMath", attrs: { latex: "x" } },
    ]);
    const formula = editor.getJSON().content?.[0]?.content?.[1];
    expect(
      applyCorrectionIssues(editor, [issue(blockId, 0, 1, "错", "正")]).skippedIssueIds,
    ).toEqual([]);
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toContainEqual({
      type: "subscript",
    });
    expect(editor.getJSON().content?.[0]?.content?.[1]).toEqual(formula);
    editor.destroy();
  });

  test("one undo restores the pre-correction document without undoing an earlier user edit", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    editor.commands.insertContentAt(1, "前文");
    const beforeCorrection = editor.getJSON();
    applyCorrectionIssues(editor, [issue(blockId, 0, 1, "错", "正")]);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(beforeCorrection);
    editor.destroy();
  });

  test("supports deleting text without constructing an empty text node", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    expect(applyCorrectionIssues(editor, [issue(blockId, 0, 1, "错", "")]).skippedIssueIds).toEqual(
      [],
    );
    expect(editor.getText()).toBe("别字以及语病");
    editor.commands.undo();
    expect(editor.getText()).toBe("错别字以及语病");
    editor.destroy();
  });

  test("locates a block by persistent nodeId and rejects stale original text", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    expect(locateCorrectionAnchor(editor, issue(blockId, 0, 1, "错", "正"))).toMatchObject({
      status: "ready",
    });
    expect(locateCorrectionAnchor(editor, issue(blockId, 0, 1, "旧", "正"))).toEqual({
      status: "stale",
    });
    editor.destroy();
  });

  test("applies selected non-overlapping issues in one undoable transaction", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const result = applyCorrectionIssues(editor, [
      issue(blockId, 0, 1, "错", "正"),
      issue(blockId, 5, 7, "语病", "表述"),
    ]);
    expect(result).toEqual({
      appliedIssueIds: expect.any(Array),
      skippedIssueIds: [],
      skippedReasons: [],
    });
    expect(editor.getText()).toBe("正别字以及表述");
    const replacements = editor
      .getJSON()
      .content?.flatMap((block) => block.content ?? [])
      .filter((node) => "text" in node && (node.text === "正" || node.text === "表述"));
    expect(replacements).toHaveLength(2);
    for (const replacement of replacements ?? []) {
      expect(replacement.marks).toContainEqual({
        type: "textStyle",
        attrs: expect.objectContaining({ color: AUTOMATIC_EDIT_RED }),
      });
    }
    editor.commands.undo();
    expect(editor.getText()).toBe("错别字以及语病");
    editor.destroy();
  });

  test("relocates unchanged unique original text after an earlier edit shifts its offset", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    editor.commands.insertContentAt({ from: 1, to: 2 }, "已经修正");

    const shifted = issue(blockId, 5, 7, "语病", "表述");
    expect(locateCorrectionAnchor(editor, shifted)).toMatchObject({ status: "ready" });
    expect(applyCorrectionIssues(editor, [shifted]).skippedIssueIds).toEqual([]);
    expect(editor.getText()).toBe("已经修正别字以及表述");
    editor.destroy();
  });

  test("does not guess when the same original text occurs more than once after an edit", () => {
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [{ type: "text", text: "语病甲语病" }],
        },
      ],
    });
    expect(locateCorrectionAnchor(editor, issue(blockId, 1, 3, "语病", "表述"))).toEqual({
      status: "stale",
    });
    editor.destroy();
  });
});

test("locates standalone formulas for analysis and invalidates changed formulas", () => {
  const id = randomUUID();
  const editor = editorWith(id);
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "blockMath", attrs: { nodeId: id, latex: "Q=P/R" } }],
  });
  const stop = startCorrectionAnchorTracking(editor);
  const finding: AiCorrectionIssue = {
    ...issue(id, 0, 1, "\uFFFC", ""),
    applicability: "analysis-only",
    replacement: null,
  };
  expect(locateCorrectionAnchor(editor, finding)).toMatchObject({
    status: "ready",
    from: 0,
    to: 1,
  });
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(0, undefined, {
      ...editor.state.doc.firstChild!.attrs,
      latex: "Q=P*R",
    }),
  );
  expect(locateCorrectionAnchor(editor, finding)).toEqual({ status: "stale" });
  stop();
  editor.destroy();
});
