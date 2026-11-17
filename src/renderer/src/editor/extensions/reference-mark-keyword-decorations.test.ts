import { type Content, Editor } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createPatentExtensions } from "../extensions";
import {
  referenceMarkKeywordDecorationSnapshot,
  setReferenceMarkKeywordDecorations,
} from "./reference-mark-keyword-decorations";

const marks = [
  { referenceMarkId: "mark-short", keyword: "自行车", number: 1 },
  { referenceMarkId: "mark-long", keyword: "自行车把手", number: 2 },
  { referenceMarkId: "mark-battery", keyword: "电池包", number: 7 },
] as const;

function editorWith(content: Content) {
  return new Editor({ extensions: createPatentExtensions(), content });
}

describe("reference mark keyword decorations", () => {
  test.each(["description", "abstract"] as const)(
    "wraps optional %s numbers, including wrong numbers, but not measurements",
    (bookKind) => {
      const editor = editorWith({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: "00000000-0000-4000-8000-000000008870" },
            content: [
              {
                type: "text",
                text: "自行车把手2，电池包7、电池包８、电池包(9)、电池包，电池包5mm、电池包5个。",
              },
            ],
          },
        ],
      });
      const before = editor.getJSON();
      const config = {
        enabled: true,
        bookKind,
        referenceMarks: marks,
        activeReferenceMarkId: null,
        recentReferenceMarkId: null,
      };
      setReferenceMarkKeywordDecorations(editor, config);
      const texts = () =>
        referenceMarkKeywordDecorationSnapshot(editor).map((match) =>
          editor.state.doc.textBetween(match.from, match.to, "", ""),
        );
      expect(texts()).toEqual([
        "自行车把手2",
        "电池包7",
        "电池包８",
        "电池包(9)",
        "电池包",
        "电池包",
        "电池包",
      ]);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.can().undo()).toBe(false);
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "电池包7");
      expect(texts().at(-1)).toBe("电池包7");
      editor.commands.undo();
      expect(editor.getJSON()).toEqual(before);
      setReferenceMarkKeywordDecorations(editor, { ...config, enabled: false });
      expect(texts()).toEqual([]);
      editor.destroy();
    },
  );

  test("prefers longer keywords and wraps a claims keyword together with its number", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "自行", marks: [{ type: "bold" }] },
            { type: "text", text: "车把手与自行车，电池包（ 7 ）。" },
          ],
        },
      ],
    });

    setReferenceMarkKeywordDecorations(editor, {
      enabled: true,
      bookKind: "claims",
      referenceMarks: marks,
      activeReferenceMarkId: null,
      recentReferenceMarkId: null,
    });

    const snapshot = referenceMarkKeywordDecorationSnapshot(editor);
    expect(snapshot.map((match) => match.referenceMarkId)).toEqual([
      "mark-long",
      "mark-short",
      "mark-battery",
    ]);
    expect(
      snapshot.map((match) => editor.state.doc.textBetween(match.from, match.to, "", "")),
    ).toEqual(["自行车把手", "自行车", "电池包（ 7 ）"]);
    expect(
      Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>('[data-reference-mark-id="mark-battery"]'),
      )
        .map((element) => element.textContent)
        .join(""),
    ).toBe("电池包（ 7 ）");
    editor.destroy();
  });

  test("uses active orange state before recent-number state and recomputes after typing", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "电池包。" }] }],
    });
    const canonicalBeforeDecoration = editor.state.doc.toJSON();

    setReferenceMarkKeywordDecorations(editor, {
      enabled: true,
      bookKind: "description",
      referenceMarks: marks,
      activeReferenceMarkId: "mark-battery",
      recentReferenceMarkId: "mark-battery",
    });
    expect(editor.state.doc.toJSON()).toEqual(canonicalBeforeDecoration);
    expect(editor.can().undo()).toBe(false);
    expect(referenceMarkKeywordDecorationSnapshot(editor)).toMatchObject([
      { referenceMarkId: "mark-battery", state: "active" },
    ]);

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "另一个电池包");
    expect(referenceMarkKeywordDecorationSnapshot(editor)).toMatchObject([
      { referenceMarkId: "mark-battery", state: "active" },
      { referenceMarkId: "mark-battery", state: "active" },
    ]);
    editor.destroy();
  });

  test("removes every keyword decoration when the feature is disabled", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "自行车把手" }] }],
    });

    setReferenceMarkKeywordDecorations(editor, {
      enabled: false,
      bookKind: "abstract",
      referenceMarks: marks,
      activeReferenceMarkId: null,
      recentReferenceMarkId: "mark-long",
    });

    expect(referenceMarkKeywordDecorationSnapshot(editor)).toEqual([]);
    editor.destroy();
  });
});
