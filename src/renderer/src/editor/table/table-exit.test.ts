import { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { createPatentExtensions } from "../extensions";
import { PATENT_BODY_TIPTAP_ATTRIBUTES } from "../extensions/patent-paragraph-rules";
import { canonicalToTiptap, tiptapToPatentBookDocument } from "../model-adapter";

async function createEditor(content: string, readOnly = false) {
  const editor = new Editor({
    element: document.createElement("div"),
    editable: !readOnly,
    extensions: createPatentExtensions("", { patentParagraphRules: true, readOnly }),
    content,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}

function lastCellEnd(editor: Editor) {
  const table = editor.state.doc.firstChild;
  if (!table) throw new Error("Expected table");
  const offset = TableMap.get(table).map.at(-1);
  if (offset === undefined) throw new Error("Expected cell offset");
  const pos = 1 + offset;
  const cell = editor.state.doc.nodeAt(pos);
  if (!cell) throw new Error("Expected cell");
  return TextSelection.near(editor.state.doc.resolve(pos + cell.nodeSize - 1), -1).from;
}

function press(editor: Editor, key: string, ctrlKey = false) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
  );
}

function enterEnd(editor: Editor) {
  editor.commands.setTextSelection(lastCellEnd(editor));
  press(editor, "ArrowRight");
  expect(editor.state.selection.toJSON().type).toBe("patent-table-end");
}

test("right arrow reaches a real table-end selection without changing the document", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table>");
  try {
    const before = editor.getJSON();
    expect(editor.state.doc.childCount).toBe(1);
    enterEnd(editor);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.from).toBe(editor.state.doc.firstChild?.nodeSize);
    expect(
      Selection.fromJSON(editor.state.doc, editor.state.selection.toJSON()).eq(
        editor.state.selection,
      ),
    ).toBe(true);
  } finally {
    editor.destroy();
  }
});

test.each(["ArrowLeft", "Backspace"])(
  "%s at the boundary returns to the cell without deleting anything",
  async (key) => {
    const editor = await createEditor("<table><tr><td>末格</td></tr></table>");
    try {
      const before = editor.getJSON();
      const end = lastCellEnd(editor);
      enterEnd(editor);
      press(editor, key);
      expect(editor.state.selection.from).toBe(end);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  },
);

test("typing creates body text without header formatting and supports undo/redo", async () => {
  const editor = await createEditor(
    '<table><tr><th style="text-align:center"><strong>标题</strong></th></tr></table>',
  );
  try {
    const before = editor.getJSON();
    enterEnd(editor);
    editor.view.dispatch(editor.state.tr.insertText("新的正文"));
    expect(editor.state.doc.lastChild?.textContent).toBe("新的正文");
    expect(editor.state.doc.lastChild?.attrs).toMatchObject(PATENT_BODY_TIPTAP_ATTRIBUTES);
    expect(editor.state.doc.lastChild?.firstChild?.marks).toEqual([]);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.toJSON().type).toBe("patent-table-end");
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.lastChild?.textContent).toBe("新的正文");
  } finally {
    editor.destroy();
  }
});

test("Enter at the boundary creates or reuses exactly one body paragraph", async () => {
  for (const tail of ["", "<p></p>"]) {
    const editor = await createEditor(`<table><tr><td>末格</td></tr></table>${tail}`);
    try {
      enterEnd(editor);
      press(editor, "Enter");
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.selection.$from.depth).toBe(1);
      expect(editor.state.doc.lastChild?.attrs).toMatchObject(PATENT_BODY_TIPTAP_ATTRIBUTES);
    } finally {
      editor.destroy();
    }
  }
});

test("typing at the boundary never overwrites a nonempty following paragraph", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table><p>已有正文</p>");
  try {
    enterEnd(editor);
    editor.view.dispatch(editor.state.tr.insertText("新增正文"));
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).textContent).toBe("新增正文");
    expect(editor.state.doc.lastChild?.textContent).toBe("已有正文");
  } finally {
    editor.destroy();
  }
});

test("Backspace removes an empty following paragraph and returns to table-end, with undo", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table><p></p>");
  try {
    const before = editor.getJSON();
    editor.commands.setTextSelection((editor.state.doc.firstChild?.nodeSize ?? 0) + 1);
    press(editor, "Backspace");
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.selection.toJSON().type).toBe("patent-table-end");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    editor.destroy();
  }
});

test("Backspace at the start of following text moves to the boundary without swallowing text", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table><p>保留正文</p>");
  try {
    const before = editor.getJSON();
    editor.commands.setTextSelection((editor.state.doc.firstChild?.nodeSize ?? 0) + 1);
    press(editor, "Backspace");
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.toJSON().type).toBe("patent-table-end");
  } finally {
    editor.destroy();
  }
});

test("the logically last merged cell can reach table-end", async () => {
  const editor = await createEditor(
    '<table><tr><td>前格</td><td rowspan="2">合并格</td></tr><tr><td>下格</td></tr></table>',
  );
  try {
    enterEnd(editor);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
  } finally {
    editor.destroy();
  }
});

test.each(["", "保留正文"])(
  "Backspace removes body indentation before returning to the table: %s",
  async (text) => {
    const editor = await createEditor(`<table><tr><td>末格</td></tr></table><p>${text}</p>`);
    try {
      const position = (editor.state.doc.firstChild?.nodeSize ?? 0) + 1;
      editor.commands.setTextSelection(position);
      editor.commands.updateAttributes("paragraph", { paragraphIndentMm: 9.88 });
      const before = editor.getJSON();
      press(editor, "Backspace");
      expect(editor.state.selection.toJSON().type).toBe("text");
      expect(editor.state.selection.from).toBe(position);
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.attrs.paragraphIndentMm).toBe(0);
      expect(editor.state.doc.lastChild?.textContent).toBe(text);
      const unindented = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(unindented);
      press(editor, "Backspace");
      expect(editor.state.selection.toJSON().type).toBe("patent-table-end");
      expect(editor.state.doc.firstChild?.textContent).toBe("末格");
      if (text) expect(editor.state.doc.lastChild?.textContent).toBe(text);
      else expect(editor.state.doc.childCount).toBe(1);
    } finally {
      editor.destroy();
    }
  },
);

test("ordinary Enter, repeated Enter and Ctrl+Enter stay inside cells", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table>");
  try {
    editor.commands.setTextSelection(lastCellEnd(editor) - 1);
    press(editor, "ArrowRight");
    expect(editor.state.selection.toJSON().type).not.toBe("patent-table-end");
    editor.commands.setTextSelection(lastCellEnd(editor));
    press(editor, "Enter");
    press(editor, "Enter");
    expect(editor.state.selection.$from.depth).toBe(4);
    press(editor, "Enter", true);
    expect(editor.state.selection.$from.depth).toBe(4);
    expect(editor.state.doc.childCount).toBe(1);
  } finally {
    editor.destroy();
  }
});

test("pasting at the boundary saves and reloads as ordinary body text", async () => {
  const editor = await createEditor("<table><tr><td>原格</td></tr></table>");
  try {
    enterEnd(editor);
    editor.view.dispatch(
      editor.state.tr.replaceSelection(
        new Slice(Fragment.from(editor.schema.text("粘贴正文")), 0, 0),
      ),
    );
    expect(editor.state.doc.lastChild?.attrs).toMatchObject(PATENT_BODY_TIPTAP_ATTRIBUTES);
    const saved = tiptapToPatentBookDocument(
      editor.getJSON(),
      createBlankBookDocument("表格正文"),
      new Set(),
    );
    if (!saved.ok) throw new Error(saved.error.message);
    const reloaded = new Editor({
      extensions: createPatentExtensions(),
      content: canonicalToTiptap(saved.value),
    });
    try {
      expect(reloaded.state.doc.firstChild?.textContent).toBe("原格");
      expect(reloaded.state.doc.lastChild?.textContent).toBe("粘贴正文");
      expect(editor.getHTML()).not.toContain("table-end-caret");
    } finally {
      reloaded.destroy();
    }
  } finally {
    editor.destroy();
  }
});

test("removing the table maps the boundary selection safely", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table><p>正文</p>");
  try {
    enterEnd(editor);
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild?.nodeSize ?? 0));
    expect(editor.state.selection.toJSON().type).not.toBe("patent-table-end");
    expect(editor.state.doc.textContent).toBe("正文");
  } finally {
    editor.destroy();
  }
});

test("read-only editors do not register table-end editing", async () => {
  const editor = await createEditor("<table><tr><td>末格</td></tr></table>", true);
  try {
    expect(
      editor.extensionManager.extensions.some((extension) => extension.name === "tableExit"),
    ).toBe(false);
  } finally {
    editor.destroy();
  }
});
