import { Editor, type JSONContent } from "@tiptap/core";
import { createPatentExtensions } from "../../editor/extensions";
import { insertDependentClaimAtSelection as insert } from "./claim-editor-operations";

const first = "1. 一种装置，其特征在于：包括箱体。";
const dependent = (n: number, ref: string) =>
  `${n}. 根据权利要求${ref}所述的一种装置，其特征在于：特征${n}。`;
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
function editorFor(content: Array<string | JSONContent>) {
  const editor = new Editor({
    extensions: createPatentExtensions("claim-integrity", { patentParagraphRules: true }),
    content: {
      type: "doc",
      content: content.map((x) => (typeof x === "string" ? paragraph(x) : x)),
    },
  });
  const tr = editor.state.tr.setMeta("addToHistory", false);
  editor.state.doc.descendants((node, pos) => {
    if ("nodeId" in node.attrs)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: crypto.randomUUID() });
  });
  editor.view.dispatch(tr);
  return editor;
}
function caret(editor: Editor, index: number) {
  editor.state.doc.forEach((node, pos, i) => {
    if (i === index) editor.commands.setTextSelection(pos + 1 + node.content.size);
  });
}
function texts(editor: Editor) {
  return editor.state.doc.content.content.map((n) => n.textContent);
}

describe("dependent claim insertion integrity", () => {
  test.each([
    ["3. 根据权利", "要求2所述的一种装置，其特征在于：A。"],
    ["4. 根据权利要求2", "，或3所述的一种装置，其特征在于：A。"],
  ])(
    "rejects a reference spanning paragraphs instead of partially renumbering: %s",
    (start, end) => {
      const editor = editorFor(
        start.startsWith("4.")
          ? [first, dependent(2, "1"), dependent(3, "1"), start, end]
          : [first, dependent(2, "1"), start, end],
      );
      try {
        caret(editor, 0);
        const before = editor.getJSON();
        expect(insert(editor).ok).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.undo()).toBe(false);
      } finally {
        editor.destroy();
      }
    },
  );

  test.each(["，或", ",或", "，或者", "、或", "， 或 "])(
    "updates the whole mixed alternative reference %s on consecutive middle insertions",
    (connector) => {
      const editor = editorFor([
        first,
        dependent(2, "1"),
        dependent(3, "1"),
        dependent(4, `2${connector}3`),
      ]);
      try {
        const snapshots = [editor.getJSON()];
        for (let i = 0; i < 3; i++) {
          caret(editor, 0);
          expect(insert(editor).ok).toBe(true);
          expect(texts(editor).at(-1)?.replace(/\s/gu, "")).toContain(
            `权利要求${3 + i}${connector.replace(/\s/gu, "")}${4 + i}所述`,
          );
          snapshots.push(editor.getJSON());
        }
        for (let i = 2; i >= 0; i--) {
          expect(editor.commands.undo()).toBe(true);
          expect(editor.getJSON()).toEqual(snapshots[i]);
        }
        for (let i = 1; i <= 3; i++) {
          expect(editor.commands.redo()).toBe(true);
          expect(editor.getJSON()).toEqual(snapshots[i]);
        }
      } finally {
        editor.destroy();
      }
    },
  );

  test.each([
    "2，以及3",
    "2，及3",
    "2，和3",
    "2；或3",
    "2，或",
    "2，或99",
    "1和2或3",
    "1或2和3",
    "1和2任一项",
  ])(
    "rejects an unsupported or incomplete punctuated reference without partial changes: %s",
    (ref) => {
      const editor = editorFor([first, dependent(2, "1"), dependent(3, "1"), dependent(4, ref)]);
      try {
        caret(editor, 0);
        const before = editor.getJSON();
        expect(insert(editor).ok).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.undo()).toBe(false);
      } finally {
        editor.destroy();
      }
    },
  );

  test.each([1, 2, 3])("retains a manual break inside the reference marker at %i", (split) => {
    const marker = "权利要求";
    const editor = editorFor([
      first,
      dependent(2, "1"),
      {
        type: "paragraph",
        content: [
          { type: "text", text: `3. 根据${marker.slice(0, split)}` },
          { type: "hardBreak" },
          { type: "text", text: `${marker.slice(split)}2所述的一种装置，其特征在于：原文。` },
        ],
      },
    ]);
    try {
      caret(editor, 0);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[3]).toContain("权利要求 3 所述");
      expect(
        editor.getJSON().content?.[3]?.content?.filter((n) => n.type === "hardBreak"),
      ).toHaveLength(1);
      caret(editor, 3);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[4]).toBe("5. 根据权利要求 4 所述的一种装置，其特征在于：");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("preserves number formatting independently of the adjacent spaces", () => {
    const marks = [
      { type: "bold" },
      { type: "italic" },
      { type: "textStyle", attrs: { fontFamily: "宋体", fontSizePt: 14 } },
    ];
    const editor = editorFor([
      first,
      dependent(2, "1"),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "3. 根据权利要求 " },
          { type: "text", text: "2", marks },
          { type: "text", text: " 所述的一种装置，其特征在于：原文。" },
        ],
      },
    ]);
    try {
      const before = editor.getJSON();
      for (let i = 0; i < 3; i++) {
        caret(editor, 0);
        expect(insert(editor).ok).toBe(true);
        const content = editor.getJSON().content?.at(-1)?.content ?? [];
        const number = content.find((n) => "text" in n && n.text === String(3 + i));
        expect(number?.marks).toContainEqual({ type: "bold" });
        expect(number?.marks).toContainEqual({ type: "italic" });
        expect(number?.marks).toContainEqual(
          expect.objectContaining({
            type: "textStyle",
            attrs: expect.objectContaining({ fontFamily: "宋体", fontSizePt: 14 }),
          }),
        );
        expect(
          content.find((n) => "text" in n && n.text?.endsWith("权利要求 "))?.marks ?? [],
        ).toEqual([]);
        expect(
          content.find((n) => "text" in n && n.text?.startsWith(" 所述"))?.marks ?? [],
        ).toEqual([]);
      }
      for (let i = 0; i < 3; i++) expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("preserves each endpoint's formatting when a range becomes a disjoint list", () => {
    const editor = editorFor([
      first,
      dependent(2, "1"),
      dependent(3, "1"),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "4. 根据权利要求" },
          { type: "text", text: "1", marks: [{ type: "bold" }] },
          { type: "text", text: "至" },
          { type: "text", text: "3", marks: [{ type: "italic" }] },
          { type: "text", text: "任一项所述的一种装置，其特征在于：原文。" },
        ],
      },
    ]);
    try {
      caret(editor, 1);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor).at(-1)?.replace(/\s/gu, "")).toContain("权利要求1或2或4任一项");
      const content = editor.getJSON().content?.at(-1)?.content ?? [];
      expect(content.find((n) => "text" in n && n.text === "1")?.marks).toContainEqual({
        type: "bold",
      });
      expect(content.find((n) => "text" in n && n.text === "4")?.marks).toContainEqual({
        type: "italic",
      });
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("preserves a paragraph containing only manual line breaks", () => {
    const editor = editorFor([
      first,
      { type: "paragraph", content: [{ type: "hardBreak" }, { type: "hardBreak" }] },
      dependent(2, "1"),
    ]);
    try {
      caret(editor, 0);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(true);
      expect(editor.getJSON().content?.slice(0, 2)).toEqual(before.content?.slice(0, 2));
      expect(texts(editor)[2]).toMatch(/^2\. 根据/u);
      const after = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(after);
    } finally {
      editor.destroy();
    }
  });

  test("does not mistake the claims document heading for a nested reference", () => {
    const editor = editorFor([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "权利要求书" }] },
      first,
    ]);
    try {
      caret(editor, 1);
      const original = editor.getJSON().content;
      expect(insert(editor).ok).toBe(true);
      expect(editor.getJSON().content?.slice(0, 2)).toEqual(original);
      expect(texts(editor)[2]).toMatch(/^2\. 根据/u);
    } finally {
      editor.destroy();
    }
  });

  test("preserves indentation and the soft break immediately after a renumbered prefix", () => {
    const editor = editorFor([
      first,
      {
        type: "paragraph",
        content: [
          { type: "text", text: "　　2." },
          { type: "hardBreak" },
          { type: "text", text: "根据权利要求1所述的一种装置，其特征在于：A。" },
        ],
      },
    ]);
    try {
      caret(editor, 0);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[2]).toMatch(/^　　3\.根据/u);
      expect(
        editor.getJSON().content?.[2]?.content?.filter((n) => n.type === "hardBreak"),
      ).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  test("keeps block formulas inside a multi-block claim", () => {
    const editor = editorFor([
      first,
      { type: "blockMath", attrs: { latex: "x=1" } },
      dependent(2, "1"),
    ]);
    try {
      const formula = editor.getJSON().content?.[1];
      caret(editor, 0);
      expect(insert(editor).ok).toBe(true);
      expect(editor.getJSON().content?.[1]).toEqual(formula);
      expect(texts(editor)[2]).toMatch(/^2\. 根据/u);
    } finally {
      editor.destroy();
    }
  });

  test("does not partially renumber references inside an unsupported nested block", () => {
    const editor = editorFor([
      first,
      dependent(2, "1"),
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph("权利要求2所述的结构")] }],
      },
    ]);
    try {
      caret(editor, 0);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("rejects multiple-dependent references to another multiple-dependent claim", () => {
    const editor = editorFor([
      first,
      dependent(2, "1"),
      dependent(3, "1或2"),
      dependent(4, "1或3"),
    ]);
    try {
      caret(editor, 1);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  test("allows a single reference to a multiple-dependent claim", () => {
    const editor = editorFor([first, dependent(2, "1"), dependent(3, "1或2")]);
    try {
      caret(editor, 2);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[3]).toContain("权利要求 3 ");
    } finally {
      editor.destroy();
    }
  });

  test("refuses a split range expansion without deleting its existing soft break", () => {
    const editor = editorFor([
      first,
      dependent(2, "1"),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "3. 根据权利要求1至" },
          { type: "hardBreak" },
          { type: "text", text: "2任一项所述的一种装置，其特征在于：A。" },
        ],
      },
    ]);
    try {
      caret(editor, 0);
      const before = editor.getJSON();
      expect(insert(editor).ok).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });
  test.each(["", "    ", "　　", "\t"])(
    "keeps the subject through consecutive insertion with indent %j",
    (indent) => {
      const editor = editorFor([indent + first, indent + dependent(2, "1")]);
      try {
        caret(editor, 1);
        for (let n = 3; n <= 25; n++) {
          expect(insert(editor).ok).toBe(true);
          expect(texts(editor)[n - 1]).toBe(
            `${n}. 根据权利要求 ${n - 1} 所述的一种装置，其特征在于：`,
          );
        }
      } finally {
        editor.destroy();
      }
    },
  );

  test.each([0, 1, 2])("inserts after the whole claim from paragraph %i", (index) => {
    const original = ["1. 一种装置，其特征在于：包括：", "箱体；", "盖板。", dependent(2, "1")];
    const editor = editorFor(original);
    try {
      caret(editor, index);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor).slice(0, 3)).toEqual(original.slice(0, 3));
      expect(texts(editor)[3]).toMatch(/^2\. 根据权利要求 1 /u);
    } finally {
      editor.destroy();
    }
  });

  test("retains a formula-only paragraph and its exact node", () => {
    const editor = editorFor([
      first,
      { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "E=mc^2" } }] },
      dependent(2, "1"),
    ]);
    try {
      const formula = editor.getJSON().content?.[1];
      caret(editor, 0);
      expect(insert(editor).ok).toBe(true);
      expect(editor.getJSON().content?.[1]).toEqual(formula);
      expect(texts(editor)[2]).toMatch(/^2\. 根据权利要求 1 /u);
    } finally {
      editor.destroy();
    }
  });

  test.each(["hardBreak", "inlineMath"])(
    "maps reference offsets past %s without touching the object",
    (type) => {
      const atom: JSONContent = type === "hardBreak" ? { type } : { type, attrs: { latex: "x^2" } };
      const editor = editorFor([
        first,
        dependent(2, "1"),
        {
          type: "paragraph",
          content: [
            { type: "text", text: "3. 根据" },
            atom,
            { type: "text", text: "权利要求2所述的一种装置，其特征在于：B。" },
          ],
        },
      ]);
      try {
        caret(editor, 0);
        expect(insert(editor).ok).toBe(true);
        expect(texts(editor)[3]).toBe("4. 根据权利要求 3 所述的一种装置，其特征在于：B。");
        expect(editor.getJSON().content?.[3]?.content?.filter((n) => n.type === type)).toHaveLength(
          1,
        );
      } finally {
        editor.destroy();
      }
    },
  );

  test.each(["-", "－", "—", "–", "~", "～", "至", "到"])(
    "preserves the original set when inserting inside a %s range",
    (separator) => {
      const editor = editorFor([
        first,
        dependent(2, "1"),
        dependent(3, "1"),
        dependent(4, `1${separator}3任一项`),
      ]);
      try {
        caret(editor, 1);
        expect(insert(editor).ok).toBe(true);
        const ref = texts(editor)[4]?.split("权利要求")[1]?.split("任一项")[0];
        expect(ref?.replace(/\s/gu, "")).toBe("1或2或4");
      } finally {
        editor.destroy();
      }
    },
  );

  test.each(["或", "或者", "、", "，", ","])("updates every member of a %s list", (separator) => {
    const editor = editorFor([
      first,
      dependent(2, "1"),
      dependent(3, "1"),
      dependent(4, `2${separator}3任一项`),
    ]);
    try {
      caret(editor, 0);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[4]?.replace(/\s/gu, "")).toContain(`权利要求3${separator}4任一项`);
    } finally {
      editor.destroy();
    }
  });

  test.each(["2 及 3", "2以及3", "2/3", "2—", "3至2", "0", "4", "99", "１"])(
    "rejects invalid or incomplete references atomically: %s",
    (reference) => {
      const editor = editorFor([
        first,
        dependent(2, "1"),
        dependent(3, "1"),
        dependent(4, reference),
      ]);
      try {
        caret(editor, 0);
        const before = editor.getJSON();
        expect(insert(editor).ok).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.undo()).toBe(false);
      } finally {
        editor.destroy();
      }
    },
  );

  test("follows the referenced independent claim instead of the nearest one", () => {
    const editor = editorFor([first, "2. 一种方法，其特征在于：执行A。", dependent(3, "1")]);
    try {
      caret(editor, 2);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[3]).toContain("所述的一种装置");
    } finally {
      editor.destroy();
    }
  });

  test("ends the subject at the characteristic phrase before a later comma", () => {
    const editor = editorFor(["1. 一种装置其特征在于：箱体，盖板。"]);
    try {
      caret(editor, 0);
      expect(insert(editor).ok).toBe(true);
      expect(texts(editor)[1]).toBe("2. 根据权利要求 1 所述的一种装置，其特征在于：");
    } finally {
      editor.destroy();
    }
  });

  test("separates consecutive insertion and typing into exact undo/redo steps", () => {
    const editor = editorFor([first]);
    try {
      caret(editor, 0);
      const states = [editor.getJSON()];
      editor.commands.insertContent("文字");
      states.push(editor.getJSON());
      for (let i = 0; i < 3; i++) {
        expect(insert(editor).ok).toBe(true);
        states.push(editor.getJSON());
      }
      editor.commands.insertContent("新增技术特征。");
      states.push(editor.getJSON());
      for (let i = states.length - 2; i >= 0; i--) {
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON()).toEqual(states[i]);
      }
      for (let i = 1; i < states.length; i++) {
        expect(editor.commands.redo()).toBe(true);
        expect(editor.getJSON()).toEqual(states[i]);
      }
    } finally {
      editor.destroy();
    }
  });
});
