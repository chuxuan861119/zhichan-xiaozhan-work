import { Editor } from "@tiptap/core";
import { createPatentExtensions } from "../extensions";

test("renders a claim reference review mark as an editor-only annotation", () => {
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "根据权利要求" },
            { type: "text", text: "2", marks: [{ type: "claimReferenceReview" }] },
            { type: "text", text: "所述的装置，其特征在于：" },
          ],
        },
      ],
    },
  });

  expect(editor.getHTML()).toContain('data-claim-reference-review="true"');
  expect(editor.getHTML()).toContain("根据权利要求");
  expect(editor.getHTML()).toContain(">2<");
  editor.destroy();
});
