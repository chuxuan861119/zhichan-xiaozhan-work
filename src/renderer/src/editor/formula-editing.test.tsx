import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Plugin } from "@tiptap/pm/state";
import { createBlankDocument } from "../../../shared/document/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { createPatentExtensions } from "./extensions";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import type { FormulaEditRequest } from "./nodes/formula-node";
import { RichTextEditorCore } from "./rich-text-editor-core";

async function setup() {
  const bus = new EditorCommandBus();
  const document = createBlankDocument("公式保存测试");
  let openFormula!: (request: FormulaEditRequest) => void;
  const view = render(
    <RichTextEditorCore
      editorId="formula-edit-test"
      title={document.title}
      document={document}
      commandBus={bus}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        formulas: true,
        chemistry: false,
        images: false,
        pageBreaks: true,
      }}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={vi.fn()}
      extensionFactory={(id, options) => {
        if (!options.onFormulaEdit) throw new Error("缺少公式编辑入口");
        openFormula = options.onFormulaEdit;
        return createPatentExtensions(id, options);
      }}
    />,
  );
  await waitFor(() => expect(bus.getEditor("formula-edit-test")).not.toBeNull());
  const editor = bus.getEditor("formula-edit-test");
  if (!editor) throw new Error("编辑器未注册");
  act(() => {
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "inlineMath", attrs: { latex: "a" } },
            { type: "text", text: "---" },
            { type: "inlineMath", attrs: { latex: "b" } },
          ],
        },
      ],
    });
  });
  return {
    editor,
    bus,
    openFormula: (position: number) =>
      act(() =>
        openFormula({
          kind: "math",
          mode: "inline",
          latex: String(editor.state.doc.nodeAt(position)?.attrs.latex),
          position,
        }),
      ),
    close: () => {
      view.unmount();
      editor.destroy();
    },
  };
}

function enter(latex: string) {
  const field = screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & {
    value: string;
  };
  field.value = latex;
  fireEvent.input(field);
}

test.each(["inline", "block"].flatMap((mode) => [false, true].map((range) => ({ mode, range }))))(
  "new $mode formula inherits size and preserves original text (range=$range)",
  async ({ mode, range }) => {
    const fixture = await setup();
    try {
      act(() => {
        fixture.editor.commands.setContent("<p>原文后文</p>");
        fixture.editor.commands.setTextSelection(range ? { from: 2, to: 4 } : 3);
        fixture.bus.setFontSizePt("formula-edit-test", 10.5);
        fixture.bus.openFormulaEditor("formula-edit-test");
      });
      enter("x^2");
      if (mode === "block") fireEvent.click(screen.getByRole("radio", { name: "独立公式" }));
      fireEvent.click(screen.getByRole("button", { name: "确定" }));
      const formulas: unknown[] = [];
      fixture.editor.state.doc.descendants((node) => {
        if (node.type.name === (mode === "inline" ? "inlineMath" : "blockMath"))
          formulas.push(node.attrs);
      });
      expect(formulas).toEqual([expect.objectContaining({ latex: "x^2", fontSizePt: 10.5 })]);
      expect(fixture.editor.state.doc.textContent).toBe("原文后文");
    } finally {
      fixture.close();
    }
  },
);

test("the toolbar edits the selected formula instead of creating a new formula", async () => {
  const fixture = await setup();
  try {
    act(() => fixture.editor.commands.setNodeSelection(5));
    act(() => fixture.bus.openFormulaEditor("formula-edit-test"));
    expect(screen.getByRole("dialog", { name: "编辑数学公式" })).toBeDefined();
    enter("b+1");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("b+1");
    expect(fixture.editor.state.doc.firstChild?.childCount).toBe(3);
  } finally {
    fixture.close();
  }
});

test("saving a moved formula updates its new position, not the previous occupant", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("b+2");
    act(() => {
      fixture.editor.commands.insertContentAt(1, "xxxx");
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("a");
    expect(fixture.editor.state.doc.nodeAt(9)?.attrs.latex).toBe("b+2");
  } finally {
    fixture.close();
  }
});

test("deleting the target refuses saving and retains the draft", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("b+2");
    act(() => {
      fixture.editor.commands.deleteRange({ from: 5, to: 6 });
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert").textContent).toContain("原公式");
    expect(screen.getByRole("textbox", { name: "可视公式编辑器" })).toBeDefined();
    expect(fixture.editor.state.doc.nodeAt(1)?.attrs.latex).toBe("a");
  } finally {
    fixture.close();
  }
});

test("different targets with identical original contents do not share edited drafts", async () => {
  const fixture = await setup();
  try {
    act(() => {
      fixture.editor.commands.updateInlineMath({ pos: 5, latex: "a" });
    });
    fixture.openFormula(1);
    enter("a+1");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fixture.openFormula(1);
    expect(
      (screen.getByRole("textbox", { name: "可视公式编辑器" }) as HTMLElement & { value: string })
        .value,
    ).toBe("a+1");
    fixture.openFormula(5);
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("a");
  } finally {
    fixture.close();
  }
});

test("a changed target is not overwritten by an older draft", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("oldDraft");
    act(() => {
      fixture.editor.commands.updateInlineMath({ pos: 5, latex: "newValue" });
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert").textContent).toContain("原公式");
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("newValue");
  } finally {
    fixture.close();
  }
});

test("a moved block formula saves correctly and participates in undo and redo", async () => {
  const fixture = await setup();
  try {
    act(() => {
      fixture.editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "前文" }] },
          { type: "blockMath", attrs: { latex: "x" } },
        ],
      });
    });
    // Use the actual double-click entry so the requested mode comes from the node.
    const formula = fixture.editor.view.dom.querySelector('[data-type="block-math"]');
    if (!formula) throw new Error("缺少独立公式");
    fireEvent.doubleClick(formula);
    enter("x+1");
    act(() => {
      fixture.editor.commands.insertContentAt(1, "更多");
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    const blockLatex = () =>
      fixture.editor.getJSON().content?.find((node) => node.type === "blockMath")?.attrs?.latex;
    expect(blockLatex()).toBe("x+1");
    act(() => {
      fixture.editor.commands.undo();
    });
    expect(blockLatex()).toBe("x");
    act(() => {
      fixture.editor.commands.redo();
    });
    expect(blockLatex()).toBe("x+1");
  } finally {
    fixture.close();
  }
});

test("target tracking includes appended document normalization transactions", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("b+2");
    fixture.editor.registerPlugin(
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (transactions.some((tr) => tr.getMeta("test-normalize")))
            return state.tr.insertText("xxxx", 1);
          return null;
        },
      }),
    );
    act(() => {
      fixture.editor.view.dispatch(fixture.editor.state.tr.setMeta("test-normalize", true));
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("a");
    expect(fixture.editor.state.doc.nodeAt(9)?.attrs.latex).toBe("b+2");
  } finally {
    fixture.close();
  }
});

test("switching to read-only keeps the formula draft instead of silently closing", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("b+2");
    act(() => fixture.editor.setEditable(false));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert").textContent).toContain("不可编辑");
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe("b");
  } finally {
    fixture.close();
  }
});

test("reopened math formula can change position in both directions and undo", async () => {
  const fixture = await setup();
  try {
    fixture.openFormula(5);
    enter("b");
    fireEvent.click(screen.getByRole("radio", { name: "独立公式" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    let position = -1;
    fixture.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "blockMath") position = pos;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    expect(fixture.editor.state.doc.nodeAt(position)?.attrs.latex).toBe("b");
    expect(fixture.editor.state.doc.nodeAt(position)?.attrs.formulaKind).toBe("math");
    expect(fixture.editor.state.doc.textContent).toBe("---");
    const node = fixture.editor.view.dom.querySelector('[data-type="block-math"]');
    if (!node) throw new Error("Missing block formula");
    fireEvent.doubleClick(node);
    await screen.findByRole("radio", { name: "行内公式" });
    fireEvent.click(screen.getByRole("radio", { name: "行内公式" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    let blockCount = 0;
    let inlineCount = 0;
    fixture.editor.state.doc.descendants((node) => {
      if (node.type.name === "blockMath") blockCount++;
      if (node.type.name === "inlineMath") inlineCount++;
    });
    expect(blockCount).toBe(0);
    expect(inlineCount).toBe(2);
    expect(fixture.editor.state.doc.textContent).toBe("---");
    act(() => {
      fixture.editor.commands.undo();
    });
    expect(fixture.editor.getJSON().content?.some((node) => node.type === "blockMath")).toBe(true);
  } finally {
    fixture.close();
  }
});
test("confirming a formula never inserts into a focused editor from another patent", async () => {
  const bus = new EditorCommandBus();
  const makeEditor = (sessionId: string) => (
    <RichTextEditorCore
      key={sessionId}
      editorId={sessionId + ":description"}
      extensionSessionId={sessionId}
      title={sessionId}
      document={createBlankDocument(sessionId)}
      commandBus={bus}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        formulas: true,
        chemistry: false,
        images: false,
        pageBreaks: true,
      }}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={vi.fn()}
      extensionFactory={createPatentExtensions}
    />
  );
  render(
    <>
      {makeEditor("patent-a")}
      {makeEditor("patent-b")}
    </>,
  );
  await waitFor(() => expect(bus.getEditor("patent-b:description")).not.toBeNull());
  act(() => bus.openFormulaEditor("patent-a:description"));
  enter("x^2+7");
  act(() => bus.focus("patent-b:description"));
  expect(bus.getFocusedEditor()?.editorId).toBe("patent-b:description");
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(JSON.stringify(bus.getEditor("patent-a:description")?.getJSON())).toContain("x^2+7");
  expect(JSON.stringify(bus.getEditor("patent-b:description")?.getJSON())).not.toContain("x^2+7");
});
