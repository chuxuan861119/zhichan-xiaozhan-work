import { Editor } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { ContentLayoutMotion } from "../../src/renderer/src/editor/extensions/content-layout-motion.ts";
import { PatentTextAttributes } from "../../src/renderer/src/editor/nodes/text-attributes.ts";

const editor = new Editor({
  element: document.querySelector("#editor"),
  extensions: [
    StarterKit,
    TextStyle,
    Color,
    FontFamily,
    Subscript,
    Superscript,
    PatentTextAttributes,
    TextAlign.configure({ types: ["paragraph", "heading"] }),
    ContentLayoutMotion,
  ],
  content: "<p>第一段文字，用于检查删除与对齐动画。</p><p>后续内容应该平滑补位。</p>",
});
Object.assign(window, { motionEditor: editor });
