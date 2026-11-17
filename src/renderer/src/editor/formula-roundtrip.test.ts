import { Editor, type JSONContent } from "@tiptap/core";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { BlockFormulaNode, ParagraphNode } from "../../../shared/document/model";
import { runEditorCommand } from "./commands";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";

describe("formula model round-trip", () => {
  test.each(["left", "center", "right"] as const)(
    "applies and persists block formula %s alignment in its live node view",
    (alignment) => {
      const base = createBlankDocument("公式对齐");
      const editor = new Editor({
        extensions: createPatentExtensions(""),
        content: {
          type: "doc",
          content: [
            {
              type: "blockMath",
              attrs: {
                nodeId: "00000000-0000-4000-8000-000000000299",
                latex: "x^2",
              },
            },
          ],
        },
      });
      try {
        editor.commands.setNodeSelection(0);
        expect(runEditorCommand(editor, `align-${alignment}`)).toBe(true);
        const dom = editor.view.dom.querySelector<HTMLElement>('[data-type="block-math"]');
        expect(dom?.style.textAlign).toBe(alignment);
        expect(dom?.querySelector(".katex-display")).not.toBeNull();
        expect(dom?.querySelector<HTMLElement>(".katex-display > .katex")?.style.textAlign).toBe(
          "inherit",
        );
        const saved = tiptapToCanonical(editor.getJSON(), base);
        expect(saved.ok).toBe(true);
        if (!saved.ok) throw new Error(saved.error.message);
        const block = saved.value.content[0];
        expect(block?.type).toBe("block-formula");
        expect((block as unknown as { alignment?: string }).alignment ?? "center").toBe(alignment);
        editor.commands.setContent(canonicalToTiptap(saved.value));
        expect(editor.state.doc.firstChild?.attrs.alignment).toBe(alignment);
      } finally {
        editor.destroy();
      }
    },
  );
  test("preserves exact inline and block LaTeX source", () => {
    const base = createBlankDocument("公式测试");
    const paragraph = base.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const inline: ParagraphNode = {
      ...paragraph,
      content: [
        { type: "text", text: "能量 ", marks: [] },
        { type: "inline-formula", source: "E=mc^2", formulaKind: "math" },
      ],
    };
    const block: BlockFormulaNode = {
      id: "00000000-0000-4000-8000-000000000201",
      type: "block-formula",
      source: String.raw`\int_0^1 x^2\,dx`,
      formulaKind: "math",
    };
    const document = { ...base, content: [inline, block] };

    const result = tiptapToCanonical(canonicalToTiptap(document), document);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(document.content);
  });

  test("preserves chemistry kind across the Tiptap model boundary", () => {
    const base = createBlankDocument("化学公式测试");
    const paragraph = base.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const inline: ParagraphNode = {
      ...paragraph,
      content: [
        {
          type: "inline-formula",
          source: String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`,
          formulaKind: "chemistry",
        },
      ],
    };
    const block: BlockFormulaNode = {
      id: "00000000-0000-4000-8000-000000000202",
      type: "block-formula",
      source: String.raw`\ce{H2 + O2 -> H2O}`,
      formulaKind: "chemistry",
    };
    const document = { ...base, content: [inline, block] };

    const tiptap = canonicalToTiptap(document);
    expect(tiptap.content?.[0]?.content?.[0]?.attrs).toMatchObject({ formulaKind: "chemistry" });
    expect(tiptap.content?.[1]?.attrs).toMatchObject({ formulaKind: "chemistry" });
    const result = tiptapToCanonical(tiptap, document);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toEqual(document.content);
  });

  test("defaults legacy Tiptap formula attributes to math", () => {
    const base = createBlankDocument("旧公式");
    const editorJson = canonicalToTiptap(base);
    editorJson.content?.push({
      type: "blockMath",
      attrs: {
        nodeId: "00000000-0000-4000-8000-000000000212",
        latex: "x^2",
      },
    });

    expect(tiptapToCanonical(editorJson, base)).toMatchObject({
      ok: true,
      value: { content: [{}, { formulaKind: "math" }] },
    });
  });

  test("rejects an unsupported Tiptap formula kind instead of silently changing it to math", () => {
    const base = createBlankDocument("非法公式类型");
    const editorJson = canonicalToTiptap(base);
    editorJson.content?.push({
      type: "blockMath",
      attrs: {
        nodeId: "00000000-0000-4000-8000-000000000213",
        latex: "x^2",
        formulaKind: "unknown",
      },
    });

    expect(tiptapToCanonical(editorJson, base)).toMatchObject({ ok: false });
  });

  test("inserts and visually updates inline and block formulas", () => {
    const editor = new Editor({ extensions: createPatentExtensions(), content: "<p></p>" });
    expect(editor.commands.insertInlineMath({ latex: "x^2" })).toBe(true);
    const inlinePosition = (() => {
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "inlineMath") position = pos;
      });
      return position;
    })();
    expect(editor.commands.updateInlineMath({ pos: inlinePosition, latex: "x^3" })).toBe(true);
    const inlineJson = editor.getJSON() as JSONContent;
    expect(inlineJson.content?.[0]?.content?.[0]?.attrs?.latex).toBe("x^3");

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.commands.insertBlockMath({ latex: String.raw`\frac{a}{b}` })).toBe(true);
    const block = (editor.getJSON() as JSONContent).content?.find(
      (node) => node.type === "blockMath",
    );
    expect(block?.attrs?.latex).toBe(String.raw`\frac{a}{b}`);
    editor.destroy();
  });

  test("stores formula kind on Tiptap nodes and sends it to edit callbacks", () => {
    const onFormulaEdit = vi.fn();
    const editor = new Editor({
      extensions: createPatentExtensions("", { onFormulaEdit }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "inlineMath",
                attrs: { latex: String.raw`\ce{H2O}`, formulaKind: "chemistry" },
              },
            ],
          },
        ],
      },
    });

    expect((editor.getJSON() as JSONContent).content?.[0]?.content?.[0]?.attrs).toMatchObject({
      formulaKind: "chemistry",
    });
    const formula = editor.view.dom.querySelector("[data-type=inline-math]");
    formula?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onFormulaEdit).toHaveBeenCalledWith({
      mode: "inline",
      latex: String.raw`\ce{H2O}`,
      kind: "chemistry",
      position: 1,
    });

    expect(editor.commands.insertBlockMath({ latex: "x^2" })).toBe(true);
    const inserted = (editor.getJSON() as JSONContent).content?.find(
      (node) => node.type === "blockMath",
    );
    expect(inserted?.attrs).toMatchObject({ formulaKind: "math" });
    editor.destroy();
  });

  test.each([
    ["inline math", "inlineMath", "inline", "math", "x^2"],
    ["inline chemistry", "inlineMath", "inline", "chemistry", String.raw`\ce{H2O}`],
    ["block math", "blockMath", "block", "math", "x^2"],
    ["block chemistry", "blockMath", "block", "chemistry", String.raw`\ce{H2O}`],
  ] as const)(
    "deduplicates a slow real double-click sequence for %s but permits a later edit",
    (_label, nodeType, mode, kind, latex) => {
      vi.useFakeTimers();
      const onFormulaEdit = vi.fn();
      const editor = new Editor({
        extensions: createPatentExtensions("", { onFormulaEdit }),
        content:
          nodeType === "inlineMath"
            ? {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "inlineMath", attrs: { latex, formulaKind: kind } }],
                  },
                ],
              }
            : {
                type: "doc",
                content: [{ type: "blockMath", attrs: { latex, formulaKind: kind } }],
              },
      });
      const formula = editor.view.dom.querySelector(
        nodeType === "inlineMath" ? "[data-type=inline-math]" : "[data-type=block-math]",
      );
      if (!formula) throw new Error("公式节点未渲染");

      formula.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      vi.advanceTimersByTime(1_200);
      const doubleClickFormula = editor.view.dom.querySelector(
        nodeType === "inlineMath" ? "[data-type=inline-math]" : "[data-type=block-math]",
      );
      if (!doubleClickFormula) throw new Error("公式节点未渲染");
      doubleClickFormula.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      doubleClickFormula.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

      expect(onFormulaEdit).toHaveBeenCalledOnce();
      expect(onFormulaEdit).toHaveBeenCalledWith({
        mode,
        latex,
        kind,
        position: expect.any(Number),
      });

      vi.advanceTimersByTime(501);
      const laterFormula = editor.view.dom.querySelector(
        nodeType === "inlineMath" ? "[data-type=inline-math]" : "[data-type=block-math]",
      );
      if (!laterFormula) throw new Error("公式节点未渲染");
      laterFormula.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      expect(onFormulaEdit).toHaveBeenCalledTimes(2);
      editor.destroy();
      vi.useRealTimers();
    },
  );

  test("does not deduplicate two different formulas", () => {
    const onFormulaEdit = vi.fn();
    const editor = new Editor({
      extensions: createPatentExtensions("", { onFormulaEdit }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "inlineMath", attrs: { latex: "x^2", formulaKind: "math" } },
              { type: "inlineMath", attrs: { latex: "y^2", formulaKind: "math" } },
            ],
          },
        ],
      },
    });
    const formulas = editor.view.dom.querySelectorAll("[data-type=inline-math]");
    const first = formulas.item(0);
    const second = formulas.item(1);
    if (!first || !second) throw new Error("公式节点未渲染");

    first.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    second.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    expect(onFormulaEdit).toHaveBeenCalledTimes(2);
    editor.destroy();
  });

  test("does not deduplicate a replacement formula with the same position and source", () => {
    vi.useFakeTimers();
    const onFormulaEdit = vi.fn();
    const editor = new Editor({
      extensions: createPatentExtensions("", { onFormulaEdit }),
      content: {
        type: "doc",
        content: [
          {
            type: "blockMath",
            attrs: {
              nodeId: "00000000-0000-4000-8000-000000000301",
              latex: "x^2",
              formulaKind: "math",
            },
          },
        ],
      },
    });
    const firstFormula = editor.view.dom.querySelector("[data-type=block-math]");
    if (!firstFormula) throw new Error("公式节点未渲染");
    firstFormula.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    const previous = editor.state.doc.firstChild;
    const blockMath = editor.state.schema.nodes.blockMath;
    if (!previous || !blockMath) throw new Error("公式节点未创建");
    editor.view.dispatch(
      editor.state.tr.replaceWith(
        0,
        previous.nodeSize,
        blockMath.create({
          nodeId: "00000000-0000-4000-8000-000000000302",
          latex: "x^2",
          formulaKind: "math",
        }),
      ),
    );
    const replacementFormula = editor.view.dom.querySelector("[data-type=block-math]");
    if (!replacementFormula) throw new Error("替换后的公式节点未渲染");
    replacementFormula.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    expect(onFormulaEdit).toHaveBeenCalledTimes(2);
    expect(onFormulaEdit).toHaveBeenLastCalledWith({
      mode: "block",
      latex: "x^2",
      kind: "math",
      position: 0,
    });
    editor.destroy();
    vi.useRealTimers();
  });

  test("keeps invalid but non-empty LaTeX in the canonical model", () => {
    const base = createBlankDocument("无效公式");
    const editorJson = canonicalToTiptap(base);
    editorJson.content?.push({
      type: "blockMath",
      attrs: {
        nodeId: "00000000-0000-4000-8000-000000000211",
        latex: String.raw`\frac{`,
      },
    });

    const result = tiptapToCanonical(editorJson, base);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.content.at(-1)).toMatchObject({ source: String.raw`\frac{` });
  });
});
