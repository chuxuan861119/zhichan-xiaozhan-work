import { Editor } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { inspectPatent } from "../../../shared/patent/validation";
import type { PatentLocation } from "../../../shared/patent-inspection/types";
import { createPatentExtensions } from "../editor/extensions";
import { inspectionSelectionKey } from "../editor/extensions/inspection-selection";
import { waitForPatentCheckEditor } from "./patent-check-editor-wait";
import {
  centerPatentIssue,
  resolvePatentIssueRange,
  selectPatentIssueInEditor,
} from "./patent-check-locate";

function textEditor(nodeId = "block-1") {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId },
          content: [{ type: "text", text: "世界领先技术" }],
        },
      ],
    },
  });
}

function atomEditor(nodeId = "formula-1") {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "blockMath",
          attrs: { nodeId, latex: "x^2", formulaKind: "math" },
        },
      ],
    },
  });
}

function location(overrides: Partial<PatentLocation> = {}): PatentLocation {
  return { bookKind: "description", targetId: "block-1", ...overrides };
}

describe("patent check locate", () => {
  test("maps offsets past an inline picture and hard break without selecting the other occurrence", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "block-1" },
            content: [
              { type: "text", text: "世界领先" },
              {
                type: "inlineFigure",
                attrs: { nodeId: "image", assetId: "image-asset", widthMm: 20 },
              },
              { type: "hardBreak" },
              { type: "text", text: "世界领先" },
            ],
          },
        ],
      },
    });
    try {
      expect(
        resolvePatentIssueRange(editor, location({ startOffset: 5, endOffset: 9 }), "世界领先"),
      ).toEqual({ status: "exact", from: 7, to: 11 });
    } finally {
      editor.destroy();
    }
  });
  test("maps canonical formula source offsets to inline atoms before repeated excerpts", () => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "block-1" },
            content: [
              { type: "inlineMath", attrs: { latex: "x^2", formulaKind: "math" } },
              { type: "text", text: "世界领先；世界领先" },
            ],
          },
        ],
      },
    });
    try {
      expect(
        resolvePatentIssueRange(editor, location({ startOffset: 3, endOffset: 7 }), "世界领先"),
      ).toEqual({ status: "exact", from: 2, to: 6 });
      expect(
        resolvePatentIssueRange(editor, location({ startOffset: 8, endOffset: 12 }), "世界领先"),
      ).toEqual({ status: "exact", from: 7, to: 11 });
    } finally {
      editor.destroy();
    }
  });
  test("uses the same native smooth scrolling as inserted document content", () => {
    const editor = textEditor();
    const paragraph = editor.view.dom.querySelector("p")!;
    const scrollIntoView = vi.fn();
    paragraph.scrollIntoView = scrollIntoView;
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    try {
      centerPatentIssue(editor, 1, 5, "smooth");
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    } finally {
      vi.unstubAllGlobals();
      editor.destroy();
    }
  });

  test.each([
    [700, 500],
    [-100, 0],
    [1900, 1200],
  ])("centers the selected text at %s within scroll limits", (top, expected) => {
    const editor = textEditor();
    const viewport = document.createElement("div");
    viewport.style.overflowY = "auto";
    viewport.append(editor.view.dom);
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientHeight: { value: 600 },
      offsetHeight: { value: 600 },
      scrollHeight: { value: 1800 },
    });
    viewport.scrollTop = 200;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 700,
      height: 600,
    } as DOMRect);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top, bottom: top, left: 0, right: 0 });
    selectPatentIssueInEditor(editor, location({ startOffset: 0, endOffset: 4 }), "世界领先");
    expect(viewport.scrollTop).toBe(expected);
    editor.destroy();
    viewport.remove();
  });
  test("relocates a unique excerpt after text is inserted before it", () => {
    const editor = textEditor();
    editor.commands.insertContentAt(1, "新增文字：");
    const range = resolvePatentIssueRange(
      editor,
      location({ startOffset: 0, endOffset: 4 }),
      "世界领先",
    );
    expect(range.status).toBe("exact");
    if (range.status !== "missing")
      expect(editor.state.doc.textBetween(range.from, range.to)).toBe("世界领先");
    editor.destroy();
  });
  test("selects the detected repeated periods without the preceding Chinese character", () => {
    const patent = createBlankPatent({ name: "装置", patentType: "invention" });
    const book = patent.books.find((item) => item.kind === "abstract");
    if (!book) throw new Error("fixture");
    const text = "防护壳与支撑底座之间留有通风缝隙。。";
    book.document.content = [
      {
        id: "punctuation-block",
        type: "paragraph",
        attrs: {
          alignment: "left",
          paragraphIndentMm: 0,
          lineSpacing: 1.5,
          defaultFontFamily: "SimSun",
          defaultFontSizePt: 14,
        },
        content: [{ type: "text", text, marks: [] }],
      },
    ];
    const issue = inspectPatent(patent).issues.find(
      (item) => item.legacyCode === "repeated-punctuation",
    );
    const location = issue?.locations[0];
    const evidence = issue?.evidence[0];
    if (!location || !evidence) throw new Error("Expected duplicate punctuation issue");
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "punctuation-block" },
            content: [{ type: "text", text }],
          },
        ],
      },
    });
    try {
      expect(selectPatentIssueInEditor(editor, location, evidence.excerpt)).toBe("exact");
      const { from, to } = editor.state.selection;
      expect(editor.state.doc.textBetween(from, to)).toBe("。。");
    } finally {
      editor.destroy();
    }
  });
  test("resolves an exact range when offsets match the excerpt", () => {
    const editor = textEditor();
    expect(
      resolvePatentIssueRange(editor, location({ startOffset: 0, endOffset: 4 }), "世界领先"),
    ).toEqual({ status: "exact", from: 1, to: 5 });
    editor.destroy();
  });

  test("trusts offsets when no excerpt is available", () => {
    const editor = textEditor();
    expect(
      resolvePatentIssueRange(editor, location({ startOffset: 2, endOffset: 6 }), null),
    ).toEqual({ status: "exact", from: 3, to: 7 });
    editor.destroy();
  });

  test("degrades to the whole paragraph when the excerpt no longer matches", () => {
    const editor = textEditor();
    expect(
      resolvePatentIssueRange(editor, location({ startOffset: 0, endOffset: 4 }), "质量最佳"),
    ).toEqual({ status: "paragraph", from: 1, to: 7 });
    editor.destroy();
  });

  test("finds a unique excerpt even when the old offsets are out of bounds", () => {
    const editor = textEditor();
    expect(
      resolvePatentIssueRange(editor, location({ startOffset: 0, endOffset: 100 }), "世界领先技术"),
    ).toEqual({ status: "exact", from: 1, to: 7 });
    editor.destroy();
  });

  test("reports missing for a null target and a missing block", () => {
    const editor = textEditor();
    expect(resolvePatentIssueRange(editor, location({ targetId: null }), null)).toEqual({
      status: "missing",
    });
    expect(resolvePatentIssueRange(editor, location({ targetId: "ghost" }), null)).toEqual({
      status: "missing",
    });
    editor.destroy();
  });

  test("selects the whole text block when only a target id is given", () => {
    const editor = textEditor();
    expect(resolvePatentIssueRange(editor, location(), null)).toEqual({
      status: "paragraph",
      from: 1,
      to: 7,
    });
    editor.destroy();
  });

  test("positions a collapsed cursor at a non-text block instead of selecting text", () => {
    const editor = atomEditor();
    expect(
      resolvePatentIssueRange(editor, { bookKind: "description", targetId: "formula-1" }, null),
    ).toEqual({ status: "paragraph", from: 0, to: 0 });
    editor.destroy();
  });

  test("applies the resolved selection and reports the outcome", () => {
    const editor = textEditor();
    expect(
      selectPatentIssueInEditor(editor, location({ startOffset: 0, endOffset: 4 }), "世界领先"),
    ).toBe("exact");
    expect(editor.state.selection.from).toBe(1);
    expect(inspectionSelectionKey.getState(editor.state)).toBe(true);
    expect(editor.state.selection.to).toBe(5);

    expect(selectPatentIssueInEditor(editor, location({ targetId: "ghost" }), null)).toBe(
      "missing",
    );
    editor.destroy();
  });
});

describe("patent check editor wait", () => {
  test("times out and unsubscribes when the requested editor never registers", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const commandBus = {
      getEditor: vi.fn(() => undefined),
      subscribeEditors: vi.fn(() => unsubscribe),
    };
    const pending = waitForPatentCheckEditor(commandBus as never, "missing", 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
