import { Mark, mergeAttributes } from "@tiptap/core";

export const ClaimReferenceReview = Mark.create({
  name: "claimReferenceReview",
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-claim-reference-review="true"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-claim-reference-review": "true",
        class: "claim-reference-review",
      }),
      0,
    ];
  },
});
