import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../../../src/renderer/src/editor/extensions.js";

const editor = new Editor({
  element: document.querySelector("#editor"),
  extensions: createPatentExtensions(),
  editorProps: { attributes: { class: "patent-prosemirror" } },
  content:
    '<table><tr><td data-padding-top-mm="1" data-padding-bottom-mm="1" data-vertical-alignment="middle"><p data-line-height="1">单行文字</p></td><td><p></p></td></tr></table><p></p>',
});
Object.assign(window, { resizeTestEditor: editor });
