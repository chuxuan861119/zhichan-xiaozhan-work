import { type Content, Editor } from "@tiptap/core";
import { createPatentExtensions } from "./extensions";
import {
  expandReplacement,
  findLiteralMatches,
  findQueryError,
  replaceAllLiteral,
  selectWrappedMatch,
} from "./find-replace";

function editorWith(content: Content) {
  return new Editor({ extensions: createPatentExtensions(), content });
}

test("finds literal text across marked text nodes and wraps next and previous", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a.", marks: [{ type: "bold" }] },
          { type: "text", text: "b a.b" },
        ],
      },
    ],
  });
  const matches = findLiteralMatches(editor.state.doc, "a.b");
  expect(matches).toHaveLength(2);
  expect(selectWrappedMatch(matches, matches[1]?.to ?? 0, "next")).toEqual(matches[0]);
  expect(selectWrappedMatch(matches, matches[0]?.from ?? 0, "previous")).toEqual(matches[1]);
  editor.destroy();
});

test("replaces from the end without touching formula source", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "技术 技" },
          { type: "inlineMath", attrs: { latex: "技术+x" } },
          { type: "text", text: "技术" },
        ],
      },
    ],
  });
  expect(replaceAllLiteral(editor, "技术", "方案")).toBe(2);
  const content = editor.getJSON().content?.[0]?.content as
    | Array<{ type?: string; text?: string; attrs?: Record<string, unknown> }>
    | undefined;
  expect(content?.filter((node) => node.type === "text").map((node) => node.text)).toEqual([
    "方案 技",
    "方案",
  ]);
  expect(content?.find((node) => node.type === "inlineMath")?.attrs).toMatchObject({
    latex: "技术+x",
  });
  editor.destroy();
  warning.mockRestore();
});

test("does not match across a visible hard break", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "foo" },
          { type: "hardBreak" },
          { type: "text", text: "bar" },
        ],
      },
    ],
  });

  expect(findLiteralMatches(editor.state.doc, "foobar")).toEqual([]);
  expect(replaceAllLiteral(editor, "foobar", "changed")).toBe(0);
  expect(editor.getText()).toBe("foo\nbar");
  editor.destroy();
});

test("honors the case sensitivity option", () => {
  const editor = editorWith("Apple apple");
  expect(findLiteralMatches(editor.state.doc, "apple", { caseSensitive: true })).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "apple", { caseSensitive: false })).toHaveLength(2);
  editor.destroy();
});

test("defaults to case-insensitive matching when options are omitted", () => {
  const editor = editorWith("Apple apple");
  expect(findLiteralMatches(editor.state.doc, "apple")).toHaveLength(2);
  editor.destroy();
});

test("keeps match positions correct after multi-byte text", () => {
  const editor = editorWith("😀技术");
  const matches = findLiteralMatches(editor.state.doc, "技术");
  expect(matches).toEqual([{ from: 3, to: 5 }]);
  editor.destroy();
});

test("treats literal special characters as plain text", () => {
  const editor = editorWith("a.b aXb");
  expect(findLiteralMatches(editor.state.doc, "a.b")).toHaveLength(1);
  editor.destroy();
});

test("whole word matches do not glue English words together", () => {
  const editor = editorWith("cat concatenate");
  expect(findLiteralMatches(editor.state.doc, "cat", { wholeWord: true })).toHaveLength(1);
  editor.destroy();
});

test("whole word matches work inside adjacent Chinese text", () => {
  const editor = editorWith("新技术");
  expect(findLiteralMatches(editor.state.doc, "技术", { wholeWord: true })).toHaveLength(1);
  editor.destroy();
});

test("supports regex searches and ignores invalid patterns", () => {
  const editor = editorWith("abc abc");
  expect(findLiteralMatches(editor.state.doc, "a.c", { useRegex: true })).toHaveLength(2);
  expect(findLiteralMatches(editor.state.doc, "(", { useRegex: true })).toEqual([]);
  editor.destroy();
});

test("matches astral Unicode characters as complete code points in regex mode", () => {
  const editor = editorWith("A😀𠮷中");
  expect(findLiteralMatches(editor.state.doc, ".", { useRegex: true })).toEqual([
    { from: 1, to: 2 },
    { from: 2, to: 4 },
    { from: 4, to: 6 },
    { from: 6, to: 7 },
  ]);
  expect(findLiteralMatches(editor.state.doc, "\\p{Script=Han}", { useRegex: true })).toEqual([
    { from: 4, to: 6 },
    { from: 6, to: 7 },
  ]);
  editor.destroy();
});

test("does not leave a lone surrogate when replacing one regex match", () => {
  const editor = editorWith("A😀中");
  const match = findLiteralMatches(editor.state.doc, ".", { useRegex: true })[1];
  if (!match) throw new Error("缺少表情字符匹配");
  editor.view.dispatch(editor.state.tr.insertText("X", match.from, match.to));
  expect(editor.getText()).toBe("AX中");
  editor.destroy();
});

test("expands capture groups during replace all in regex mode", () => {
  const editor = editorWith("技术 技术");
  expect(replaceAllLiteral(editor, "(技)术", "[$1]", { useRegex: true })).toBe(2);
  expect(editor.getText()).toBe("[技] [技]");
  editor.destroy();
});

test("expands capture groups for a single replacement", () => {
  expect(expandReplacement("(技)术", { useRegex: true }, "技术", "[$1]")).toBe("[技]");
  expect(expandReplacement("技术", {}, "技术", "$1")).toBe("$1");
});

test("keeps dollar signs literal outside regex mode", () => {
  const editor = editorWith("价格 $100");
  expect(replaceAllLiteral(editor, "$100", "100元")).toBe(1);
  expect(editor.getText()).toBe("价格 100元");
  editor.destroy();
});

test("preserves inline formatting when replacing matched text", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "技术", marks: [{ type: "bold" }] }],
      },
    ],
  });
  expect(replaceAllLiteral(editor, "技术", "方案")).toBe(1);
  expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
    type: "text",
    text: "方案",
    marks: [{ type: "bold" }],
  });
  editor.destroy();
});

test("keeps mixed inline formatting when a replacement leaves text unchanged", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "技术", marks: [{ type: "bold" }] },
          { type: "text", text: "方案" },
        ],
      },
    ],
  });
  const before = editor.getJSON();

  expect(replaceAllLiteral(editor, "技术方案", "技术方案")).toBe(0);
  expect(editor.getJSON()).toEqual(before);
  editor.destroy();
});

test("preserves unchanged mixed-format text around the replaced characters", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "技术", marks: [{ type: "bold" }] },
          { type: "text", text: "方案" },
        ],
      },
    ],
  });

  expect(replaceAllLiteral(editor, "技术方案", "技术设计")).toBe(1);
  expect(editor.getJSON().content?.[0]?.content).toEqual([
    { type: "text", text: "技术", marks: [{ type: "bold" }] },
    { type: "text", text: "设计" },
  ]);
  editor.destroy();
});

test("returns no matches for an empty query", () => {
  const editor = editorWith("abc");
  expect(findLiteralMatches(editor.state.doc, "")).toEqual([]);
  expect(replaceAllLiteral(editor, "", "x")).toBe(0);
  editor.destroy();
});

test("supports Word-style special codes without treating paragraph marks as searchable", () => {
  const editor = editorWith("图1、图２、图٣；技术A；^p");
  expect(findLiteralMatches(editor.state.doc, "图^#")).toHaveLength(3);
  expect(findLiteralMatches(editor.state.doc, "^汉")).toHaveLength(5);
  expect(findLiteralMatches(editor.state.doc, "^$")).toHaveLength(7);
  expect(findLiteralMatches(editor.state.doc, "^^p")).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "^p")).toHaveLength(1);
  editor.destroy();
});

test("supports whitespace and Chinese punctuation special codes", () => {
  const editor = editorWith({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "甲  \t\u00a0乙，丙。" }] }],
  });
  expect(findLiteralMatches(editor.state.doc, "^w")).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "^t")).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "^s")).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "^中标")).toHaveLength(2);
  editor.destroy();
});

test("finds and removes manual line breaks and page breaks", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "甲" },
          { type: "hardBreak" },
          { type: "text", text: "乙" },
        ],
      },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "丙" }] },
    ],
  });
  expect(findLiteralMatches(editor.state.doc, "甲^l乙")).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "^m")).toHaveLength(1);
  expect(replaceAllLiteral(editor, "^l", "")).toBe(1);
  expect(replaceAllLiteral(editor, "^m", "")).toBe(1);
  expect(editor.getText()).toBe("甲乙\n\n丙");
  editor.destroy();
});

test("supports Word wildcard patterns and grouped replacement", () => {
  const editor = editorWith("图1 图22 图333 技术A 技术B");
  expect(findLiteralMatches(editor.state.doc, "图[0-9]@", { searchMode: "wildcard" })).toHaveLength(
    3,
  );
  expect(findLiteralMatches(editor.state.doc, "技术?", { searchMode: "wildcard" })).toHaveLength(2);
  expect(
    findLiteralMatches(editor.state.doc, "<[技]*>", { searchMode: "wildcard" }).length,
  ).toBeGreaterThan(0);
  expect(replaceAllLiteral(editor, "(技术)([A-Z])", "\\2-\\1", { searchMode: "wildcard" })).toBe(2);
  expect(editor.getText()).toContain("A-技术 B-技术");
  editor.destroy();
});

test("supports the remaining common Word wildcard operators", () => {
  const editor = editorWith("cat cot cut caat c123d cXd ?");
  expect(findLiteralMatches(editor.state.doc, "c[!o]t", { searchMode: "wildcard" })).toHaveLength(
    2,
  );
  expect(findLiteralMatches(editor.state.doc, "ca{2}t", { searchMode: "wildcard" })).toHaveLength(
    1,
  );
  expect(findLiteralMatches(editor.state.doc, "c*d", { searchMode: "wildcard" })).toHaveLength(1);
  expect(findLiteralMatches(editor.state.doc, "\\?", { searchMode: "wildcard" })).toHaveLength(1);
  editor.destroy();
});

test("can insert a manual line break through replacement", () => {
  const editor = editorWith("甲，乙");
  expect(replaceAllLiteral(editor, "，", "^l")).toBe(1);
  expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual([
    "text",
    "hardBreak",
    "text",
  ]);
  editor.destroy();
});

test("can insert and replace a page break without corrupting the document", () => {
  const editor = editorWith("甲，乙");
  expect(replaceAllLiteral(editor, "，", "^m")).toBe(1);
  expect(editor.getJSON().content?.some((node) => node.type === "pageBreak")).toBe(true);
  expect(replaceAllLiteral(editor, "^m", "分页")).toBe(1);
  expect(editor.getText()).toContain("分页");
  editor.destroy();
});

test("reports invalid wildcard and regex queries", () => {
  expect(findQueryError("[abc", { searchMode: "wildcard" })).toBeTruthy();
  expect(findQueryError("(", { searchMode: "regex" })).toBeTruthy();
  expect(findQueryError("^#", { searchMode: "literal" })).toBeNull();
});

test("supports the original match token in replacements", () => {
  const editor = editorWith("图1 图2");
  expect(replaceAllLiteral(editor, "图^#", "【^&】")).toBe(2);
  expect(editor.getText()).toBe("【图1】 【图2】");
  editor.destroy();
});

test("keeps structural nodes outside raw regex matches", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "甲" },
          { type: "hardBreak" },
          { type: "text", text: "乙" },
        ],
      },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "丙" }] },
    ],
  });

  expect(findLiteralMatches(editor.state.doc, ".", { searchMode: "regex" })).toHaveLength(3);
  expect(replaceAllLiteral(editor, ".", "X", { searchMode: "regex" })).toBe(3);
  const json = editor.getJSON();
  expect(json.content?.[0]?.content?.map((node) => node.type)).toEqual([
    "text",
    "hardBreak",
    "text",
  ]);
  expect(json.content?.some((node) => node.type === "pageBreak")).toBe(true);
  editor.destroy();
});

test("supports the original match token in wildcard replacements", () => {
  const editor = editorWith("图1 图2");
  expect(replaceAllLiteral(editor, "(图)([0-9])", "【^&】", { searchMode: "wildcard" })).toBe(2);
  expect(editor.getText()).toBe("【图1】 【图2】");
  editor.destroy();
});

test("does not reinterpret original or captured text as replacement special codes", () => {
  const literalEditor = editorWith("字面^l字面");
  expect(replaceAllLiteral(literalEditor, "^^l", "【^&】")).toBe(1);
  expect(literalEditor.getText()).toBe("字面【^l】字面");
  expect(
    literalEditor.getJSON().content?.[0]?.content?.some((node) => node.type === "hardBreak"),
  ).toBe(false);
  literalEditor.destroy();

  const wildcardEditor = editorWith("字面^m字面");
  expect(
    replaceAllLiteral(wildcardEditor, "(字面)(\\^m)", "\\1【\\2】", {
      searchMode: "wildcard",
    }),
  ).toBe(1);
  expect(wildcardEditor.getText()).toBe("字面【^m】字面");
  expect(wildcardEditor.getJSON().content?.some((node) => node.type === "pageBreak")).toBe(false);
  wildcardEditor.destroy();

  const regexEditor = editorWith("字面^l字面");
  expect(replaceAllLiteral(regexEditor, "(字面)(\\^l)", "$1【$2】", { searchMode: "regex" })).toBe(
    1,
  );
  expect(regexEditor.getText()).toBe("字面【^l】字面");
  expect(
    regexEditor.getJSON().content?.[0]?.content?.some((node) => node.type === "hardBreak"),
  ).toBe(false);
  regexEditor.destroy();
});

test("preserves an actual structural match through the original-match token", () => {
  const editor = editorWith({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "甲" },
          { type: "hardBreak" },
          { type: "text", text: "乙" },
        ],
      },
    ],
  });
  expect(replaceAllLiteral(editor, "^l", "^&")).toBe(0);
  expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual([
    "text",
    "hardBreak",
    "text",
  ]);
  editor.destroy();
});

test("supports JavaScript named groups and two-digit capture fallback", () => {
  const namedEditor = editorWith("技术");
  expect(
    replaceAllLiteral(namedEditor, "(?<term>技术)", "[$<term>]", { searchMode: "regex" }),
  ).toBe(1);
  expect(namedEditor.getText()).toBe("[技术]");
  namedEditor.destroy();

  expect(expandReplacement("(技)术", { searchMode: "regex" }, "技术", "$10")).toBe("技0");
  expect(expandReplacement("(技)术", { searchMode: "regex" }, "技术", "$01")).toBe("技");
  expect(expandReplacement("(?<term>技术)", { searchMode: "regex" }, "技术", "$<missing>")).toBe(
    "",
  );
});

test("supports JavaScript prefix and suffix replacement tokens within a search chunk", () => {
  const editor = editorWith("前技术后");
  expect(replaceAllLiteral(editor, "技术", "[$`][$&][$']", { searchMode: "regex" })).toBe(1);
  expect(editor.getText()).toBe("前[前][技术][后]后");
  editor.destroy();
});

test("reports valid zero-width regex matches as unsupported instead of missing", () => {
  const editor = editorWith("技术方案");
  expect(findQueryError("(?=技术)", { searchMode: "regex" }, editor.state.doc)).toMatch(/零宽/);
  expect(findLiteralMatches(editor.state.doc, "(?=技术)", { searchMode: "regex" })).toEqual([]);
  editor.destroy();
});

test("rejects advanced patterns with nested repetition before execution", () => {
  expect(findQueryError("(a+)+$", { searchMode: "regex" })).toMatch(/嵌套重复/);
  expect(findQueryError("(a@)@", { searchMode: "wildcard" })).toMatch(/嵌套重复/);
  expect(findQueryError("(ab)+", { searchMode: "regex" })).toBeNull();
  expect(findQueryError("(?:ab)+", { searchMode: "regex" })).toBeNull();
  expect(findQueryError("(技术|方案)+", { searchMode: "regex" })).toBeNull();
  expect(findQueryError("(a|aa)+$", { searchMode: "regex" })).toMatch(/嵌套重复/);
  expect(findQueryError("(A|a)+$", { searchMode: "regex" })).toMatch(/嵌套重复/);
});
