import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { createBlankDocument } from "../../../../shared/document/defaults";
import { EditorCommandBus } from "../../app/command-bus";
import * as dialogs from "../../shared/app-dialog";
import { canonicalToTiptap, tiptapToCanonical } from "../model-adapter";
import { RichTextEditorCore } from "../rich-text-editor-core";

const htmlTable = (columns: number) =>
  `<table style="width:1000px"><tr>${"<td><p>实验数据</p></td>".repeat(columns)}</tr></table>`;
test.each([false, true])("oversized mixed paste is atomic (inside table: %s)", async (inside) => {
  const alert = vi.spyOn(dialogs, "showAppAlert").mockImplementation(() => {});
  const commandBus = new EditorCommandBus();
  const document = createBlankDocument("粘贴宽度");
  const view = render(
    <RichTextEditorCore
      editorId="paste-width"
      title={document.title}
      document={document}
      commandBus={commandBus}
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
    />,
  );
  try {
    await waitFor(() => expect(commandBus.getEditor("paste-width")).not.toBeNull());
    const editor = commandBus.getEditor("paste-width")!;
    act(() => {
      editor.commands.setContent(
        inside ? "<table><tr><td><p>原单元格</p></td></tr></table>" : "<p>原段落保留</p>",
      );
      if (inside) editor.commands.setTextSelection(4);
      else editor.commands.setTextSelection({ from: 1, to: 3 });
    });
    const before = editor.getJSON(),
      selection = editor.state.selection.toJSON();
    fireEvent.paste(screen.getByRole("textbox", { name: "编辑 粘贴宽度" }), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? inside
              ? htmlTable(30)
              : `<p>前文</p>${htmlTable(2)}<p>后文</p>${htmlTable(30)}`
            : "实验数据",
      },
    });
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.toJSON()).toEqual(selection);
  } finally {
    view.unmount();
    alert.mockRestore();
  }
});
