import { Editor, type JSONContent } from "@tiptap/core";
import type { AssetDescriptor } from "../../../shared/document/model";
import { createPatentExtensions } from "../editor/extensions";
import { EditorCommandBus } from "./command-bus";

const asset: AssetDescriptor = {
  assetId: "00000000-0000-4000-8000-000000000901",
  kind: "image",
  originalName: "test.png",
  mediaType: "image/png",
  extension: "png",
  byteLength: 4,
  sha256: "A".repeat(64),
  widthPx: 120,
  heightPx: 80,
  previewByteLength: 4,
  previewSha256: "B".repeat(64),
};

test.each(["table", "list"])(
  "toolbar image insertion stays inside the selected %s",
  async (container) => {
    const content =
      container === "table"
        ? "<table><tr><td><p>前后</p></td><td><p>相邻单元格</p></td></tr></table>"
        : "<ul><li><p>前后</p></li><li><p>下一项</p></li></ul>";
    const editor = new Editor({ extensions: createPatentExtensions(), content });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bus = new EditorCommandBus();
    const addAsset = vi.fn();
    bus.register("image", editor, addAsset);
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "前后") position = pos + 1;
    });
    editor.commands.setTextSelection(position);
    const original = editor.getJSON();
    expect(bus.insertFigures("image", [asset])).toBe(true);
    const cell = (editor.getJSON() as JSONContent).content?.[0]?.content?.[0]?.content?.[0];
    const paragraph = container === "table" ? cell?.content?.[0] : cell;
    expect(paragraph?.content?.map((node) => node.type)).toEqual(["text", "inlineFigure", "text"]);
    expect(editor.state.doc.textContent).toBe(
      container === "table" ? "前后相邻单元格" : "前后下一项",
    );
    editor.state.doc.check();
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
    editor.commands.redo();
    expect(editor.getJSON()).not.toEqual(original);
    editor.destroy();
  },
);
