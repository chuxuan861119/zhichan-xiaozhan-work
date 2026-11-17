import { Editor } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import { createPatentExtensions } from "../editor/extensions";
import { findLiteralMatches } from "../editor/find-replace";
import {
  resolveContentSearchMatch,
  selectContentSearchAnnotation,
} from "./content-search-location";

test.each(["name", "note"] as const)(
  "locates and selects table %s without modifying the document",
  (kind) => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "table",
            attrs: {
              nodeId: "table-1",
              tableNameEnabled: true,
              tableName: " 循环关键词实验 ",
              tableNoteEnabled: true,
              tableNote: "环境关键词温度",
            },
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "关键词" }] }],
                  },
                ],
              },
            ],
          },
          { type: "paragraph" },
        ],
      },
    });
    const before = editor.getJSON();
    const root = element.querySelector<HTMLElement>(`.table-annotation--${kind}`)!;
    root.scrollIntoView = vi.fn();
    try {
      const offset = kind === "name" ? 3 : 2;
      const match = resolveContentSearchMatch(editor.state.doc, "关键词", undefined, {
        occurrence: 0,
        queryOffset: offset,
        nodeId: "table-1",
        textOffset: offset,
        annotation: kind,
      });
      expect(match?.annotation?.kind).toBe(kind);
      expect(selectContentSearchAnnotation(editor, match!)).toBe(true);
      const input = root.querySelector("textarea")!;
      expect(document.activeElement).toBe(input);
      expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("关键词");
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
      element.remove();
    }
  },
);

test.each(["inlineMath", "inlineFigure"])(
  "locates across marks after %s with the same boundaries as editor find",
  (atom) => {
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "p-1" },
            content: [
              { type: "text", text: "前" },
              {
                type: atom,
                attrs: atom === "inlineMath" ? { latex: "x" } : { assetId: "test-image" },
              },
              { type: "text", text: "关", marks: [{ type: "bold" }] },
              { type: "text", text: "键词" },
            ],
          },
        ],
      },
    });
    try {
      const match = resolveContentSearchMatch(editor.state.doc, "关键词", undefined, {
        occurrence: 0,
        queryOffset: 2,
        nodeId: "p-1",
        textOffset: 2,
      });
      expect(match).toEqual(findLiteralMatches(editor.state.doc, "关键词")[0]);
      expect(editor.state.doc.textBetween(match!.from, match!.to)).toBe("关键词");
      expect(resolveContentSearchMatch(editor.state.doc, "前关键词")).toBeUndefined();
      expect(findLiteralMatches(editor.state.doc, "前关键词")).toEqual([]);
    } finally {
      editor.destroy();
    }
  },
);
