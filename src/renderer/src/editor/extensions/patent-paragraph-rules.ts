import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import {
  defaultDocumentFont,
  defaultDocumentFontSizePt,
} from "../../../../shared/document/font-policy";
import { PATENT_BODY_PARAGRAPH_ATTRIBUTES } from "../../../../shared/patent/formatting";

export const PATENT_BODY_TIPTAP_ATTRIBUTES = {
  textAlign: PATENT_BODY_PARAGRAPH_ATTRIBUTES.alignment,
  paragraphIndentMm: PATENT_BODY_PARAGRAPH_ATTRIBUTES.paragraphIndentMm,
  lineHeight: PATENT_BODY_PARAGRAPH_ATTRIBUTES.lineSpacing,
  defaultFontFamily: defaultDocumentFont(),
  defaultFontSizePt: defaultDocumentFontSizePt(),
};

/** 列表项 / 表格单元格内的内容属于结构化容器，其中的段落不使用正文首行缩进。 */
const STRUCTURED_CONTAINER_NODE_NAMES = ["listItem", "tableCell", "tableHeader"];

/** 选区所在位置是否位于列表项 / 表格单元格等结构化容器内。 */
export function isInsideStructuredContainer($pos: ResolvedPos): boolean {
  return Array.from({ length: $pos.depth + 1 }, (_value, depth) => $pos.node(depth).type.name).some(
    (name) => STRUCTURED_CONTAINER_NODE_NAMES.includes(name),
  );
}

export const PatentParagraphRules = Extension.create({
  name: "patentParagraphRules",

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        if (
          !selection.empty ||
          $from.parentOffset !== 0 ||
          $from.parent.type.name !== "paragraph"
        ) {
          return false;
        }
        if (isInsideStructuredContainer($from) || $from.parent.attrs.paragraphIndentMm <= 0) {
          return false;
        }
        return this.editor.commands.updateAttributes("paragraph", { paragraphIndentMm: 0 });
      },
      Enter: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        if (!selection.empty || $from.parentOffset !== $from.parent.content.size) return false;
        if (isInsideStructuredContainer($from)) return false;
        if (!["paragraph", "heading"].includes($from.parent.type.name)) return false;
        const isCenteredFirstLineTitle =
          $from.depth === 1 && $from.index(0) === 0 && $from.parent.attrs.textAlign === "center";
        if (!isCenteredFirstLineTitle) {
          // Removing the current paragraph's indent is local to that paragraph.
          // A new body paragraph resumes the normal first-line indent, without
          // replacing the user's other formatting or reformatting existing text.
          if ($from.parent.type.name !== "paragraph" || $from.parent.attrs.paragraphIndentMm !== 0)
            return false;
          return this.editor
            .chain()
            .splitBlock()
            .updateAttributes("paragraph", {
              paragraphIndentMm: PATENT_BODY_TIPTAP_ATTRIBUTES.paragraphIndentMm,
            })
            .run();
        }
        return this.editor
          .chain()
          .splitBlock()
          .updateAttributes("paragraph", {
            ...PATENT_BODY_TIPTAP_ATTRIBUTES,
            defaultFontSizePt: defaultDocumentFontSizePt(),
          })
          .run();
      },
    };
  },
});
