import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Invisible semantic ownership marker for numbers inserted by the reference-mark tool.
 * Visual highlighting is rendered exclusively by ReferenceMarkKeywordDecorations.
 */
export const ReferenceMarkToken = Mark.create({
  name: "referenceMarkToken",
  inclusive: false,

  addAttributes() {
    return {
      number: {
        default: null,
        parseHTML: (element) => Number(element.getAttribute("data-reference-mark-number")),
        renderHTML: (attributes) => ({
          "data-reference-mark-number": attributes.number,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-reference-mark-number]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});
