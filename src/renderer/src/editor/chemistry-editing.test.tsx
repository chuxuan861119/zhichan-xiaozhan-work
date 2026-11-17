import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createBlankDocument } from "../../../shared/document/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { canonicalToTiptap, tiptapToCanonical } from "./model-adapter";
import { RichTextEditorCore } from "./rich-text-editor-core";

async function setup() {
  const bus = new EditorCommandBus();
  const document = createBlankDocument("化学式编辑回归");
  const view = render(
    <RichTextEditorCore
      editorId="chemistry-edit"
      title={document.title}
      document={document}
      commandBus={bus}
      capabilities={{
        headings: true,
        lists: true,
        tables: true,
        formulas: true,
        chemistry: true,
        images: false,
        pageBreaks: true,
      }}
      toTiptap={canonicalToTiptap}
      fromTiptap={tiptapToCanonical}
      onDocumentChange={vi.fn()}
    />,
  );
  await waitFor(() => expect(bus.getEditor("chemistry-edit")).toBeDefined());
  const editor = bus.getEditor("chemistry-edit");
  if (!editor) throw new Error("Missing editor");
  act(() =>
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "inlineMath",
              attrs: { latex: String.raw`\ce{H2O}`, formulaKind: "chemistry" },
            },
            { type: "text", text: "---" },
            {
              type: "inlineMath",
              attrs: { latex: String.raw`\ce{CO2}`, formulaKind: "chemistry" },
            },
          ],
        },
      ],
    }),
  );
  const formulas = editor.view.dom.querySelectorAll('[data-type="inline-math"]');
  const second = formulas[1];
  if (!second) throw new Error("Missing chemical equation");
  fireEvent.doubleClick(second);
  const field = (await screen.findByRole("textbox", {
    name: "化学方程式编辑器",
  })) as HTMLElement & { value: string };
  field.value = "NaCl";
  fireEvent.input(field);
  return {
    editor,
    bus,
    close: () => {
      view.unmount();
      editor.destroy();
    },
  };
}

test.each(["inline", "block"])(
  "new %s chemical equation inherits the chosen font size",
  async (mode) => {
    const fixture = await setup();
    // jsdom has no Range layout API; native scrolling is exercised in Electron E2E.
    fixture.editor.view.setProps({ handleScrollToSelection: () => true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      act(() => {
        fixture.editor.commands.setContent("<p>前文后文</p>");
        fixture.editor.commands.setTextSelection(3);
        fixture.bus.setFontSizePt("chemistry-edit", 12);
        fixture.bus.openChemistryEditor("chemistry-edit");
      });
      const field = screen.getByRole("textbox", { name: "化学方程式编辑器" }) as HTMLElement & {
        value: string;
      };
      field.value = "H2O";
      fireEvent.input(field);
      if (mode === "block") fireEvent.click(screen.getByRole("radio", { name: "独立方程式" }));
      fireEvent.click(screen.getByRole("button", { name: "插入" }));
      await waitFor(() => {
        const formulas: unknown[] = [];
        fixture.editor.state.doc.descendants((node) => {
          if (node.type.name === (mode === "inline" ? "inlineMath" : "blockMath"))
            formulas.push(node.attrs);
        });
        expect(formulas).toEqual([
          expect.objectContaining({
            latex: String.raw`\ce{H2O}`,
            fontSizePt: 12,
            formulaKind: "chemistry",
          }),
        ]);
      });
      expect(fixture.editor.state.doc.textContent).toBe("前文后文");
    } finally {
      fixture.close();
    }
  },
);

test("editing a moved chemical equation updates only its new position", async () => {
  const fixture = await setup();
  try {
    act(() => fixture.editor.commands.insertContentAt(1, "xxxx"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fixture.editor.state.doc.nodeAt(9)?.attrs.latex).toBe(String.raw`\ce{NaCl}`),
    );
    expect(fixture.editor.state.doc.nodeAt(5)?.attrs.latex).toBe(String.raw`\ce{H2O}`);
  } finally {
    fixture.close();
  }
});

test.each(
  ["math", "chemistry"].flatMap((kind) =>
    ["table", "list"].map((container) => ({ kind, container })),
  ),
)("block $kind insertion does not split a $container", async ({ kind, container }) => {
  const fixture = await setup();
  try {
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    act(() => {
      fixture.editor.commands.setContent(
        container === "table"
          ? "<table><tr><td><p>前后</p></td><td><p>保留</p></td></tr></table>"
          : "<ul><li><p>前后</p></li><li><p>保留</p></li></ul>",
      );
      fixture.editor.commands.setTextSelection(4);
      if (kind === "math") fixture.bus.openFormulaEditor("chemistry-edit");
      else fixture.bus.openChemistryEditor("chemistry-edit");
    });
    const field = screen.getByRole("textbox", {
      name: kind === "math" ? "可视公式编辑器" : "化学方程式编辑器",
    }) as HTMLElement & { value: string };
    field.value = kind === "math" ? "x^2" : "H2O";
    fireEvent.input(field);
    fireEvent.click(
      screen.getByRole("radio", { name: kind === "math" ? "独立公式" : "独立方程式" }),
    );
    const before = fixture.editor.getJSON();
    fireEvent.click(screen.getByRole("button", { name: kind === "math" ? "确定" : "插入" }));
    expect(fixture.editor.getJSON()).toEqual(before);
    expect(screen.getByRole("alert").textContent).toContain("行内");
  } finally {
    fixture.close();
  }
});

test.each(["delete", "change", "read-only"])(
  "chemical equation keeps its draft after target %s",
  async (action) => {
    const fixture = await setup();
    try {
      act(() => {
        if (action === "delete") fixture.editor.commands.deleteRange({ from: 5, to: 6 });
        else if (action === "change")
          fixture.editor.commands.updateInlineMath({ pos: 5, latex: String.raw`\ce{O2}` });
        else fixture.editor.setEditable(false);
      });
      const original = fixture.editor.getJSON();
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
      expect(screen.getByRole("dialog", { name: "编辑化学方程式" })).toBeDefined();
      expect(fixture.editor.getJSON()).toEqual(original);
    } finally {
      fixture.close();
    }
  },
);

test("reopened chemical formula can change position in both directions and undo", async () => {
  const fixture = await setup();
  try {
    fireEvent.click(screen.getByRole("radio", { name: "独立方程式" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    let position = -1;
    fixture.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "blockMath") position = pos;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    expect(fixture.editor.state.doc.nodeAt(position)?.attrs.latex).toBe("\\ce{NaCl}");
    expect(fixture.editor.state.doc.nodeAt(position)?.attrs.formulaKind).toBe("chemistry");
    expect(fixture.editor.state.doc.textContent).toBe("---");
    const node = fixture.editor.view.dom.querySelector('[data-type="block-math"]');
    if (!node) throw new Error("Missing block formula");
    fireEvent.doubleClick(node);
    await screen.findByRole("radio", { name: "行内方程式" });
    fireEvent.click(screen.getByRole("radio", { name: "行内方程式" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
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
