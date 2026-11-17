import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorCommandBus } from "../../../src/renderer/src/app/command-bus";
import { createPatentExtensions } from "../../../src/renderer/src/editor/extensions";
import { EditorContextMenus } from "../../../src/renderer/src/editor/ui/editor-context-menus";
import { ToolBar } from "../../../src/renderer/src/editor/ui/tool-bar";
import { defaultDocumentFont } from "../../../src/shared/document/font-policy";

const bus = new EditorCommandBus();
const editor = new Editor({
  extensions: createPatentExtensions(),
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { defaultFontSizePt: 14 },
        content: [
          {
            type: "text",
            text: "甲",
            marks: [
              { type: "textStyle", attrs: { fontSizePt: 10.5, fontFamily: defaultDocumentFont() } },
            ],
          },
          {
            type: "text",
            text: "乙",
            marks: [{ type: "textStyle", attrs: { fontFamily: "Source Han Serif CN" } }],
          },
        ],
      },
    ],
  },
});
bus.register("fixture", editor);
const noop = () => {};

function Fixture() {
  const [format, setFormat] = useState(() => bus.getFormatState("fixture"));
  useEffect(() => bus.subscribeFormatState("fixture", setFormat), []);
  return (
    <>
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextSelection({ from: 1, to: 3 }).run()}
      >
        选择混合文字
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextSelection({ from: 1, to: 2 }).run()}
      >
        选择单一文字
      </button>
      <ToolBar
        onNewDocument={noop}
        onOpenDocument={noop}
        onImportDocx={noop}
        onSaveDocument={noop}
        onExportDocx={noop}
        onExportPdf={noop}
        onPrint={noop}
        onInsertFlowchart={noop}
        onInsertCircuitDiagram={noop}
        onCommand={(command) => bus.execute("fixture", command)}
        onParagraphStyle={(style) => bus.setParagraphStyle("fixture", style)}
        onFontFamily={(font) => bus.setFontFamily("fixture", font)}
        onFontSize={(size) => bus.setFontSizePt("fixture", size)}
        onColor={(color) => bus.setColor("fixture", color)}
        onInsertTable={noop}
        onInsertFormula={noop}
        onFind={noop}
        formatState={format}
      />
      <div style={{ paddingTop: 100 }}>
        <EditorContent editor={editor} />
      </div>
      <EditorContextMenus editor={editor} editorId="fixture" commandBus={bus} />
      <output aria-label="格式状态">
        {JSON.stringify({
          format,
          from: editor.state.selection.from,
          to: editor.state.selection.to,
          doc: editor.getJSON(),
        })}
      </output>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
