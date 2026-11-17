import { Schema, Slice } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { capturePasteFormatting, switchPasteFormatting } from "./paste-paragraph-formatting";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "text*",
      attrs: { paragraphIndentMm: { default: 0 }, textAlign: { default: "left" } },
    },
    text: {},
  },
});
const paragraph = (text: string, indent = 0) =>
  schema.nodes.paragraph.create({ paragraphIndentMm: indent }, schema.text(text));

test("formatting targets exclude both destination paragraphs merged with pasted content", () => {
  const doc = schema.nodes.doc.create(null, [paragraph("前后", 5)]);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
  const pasted = (indent: number) =>
    Slice.maxOpen(
      schema.nodes.doc.create(null, [
        paragraph("首", indent),
        paragraph("中", indent),
        paragraph("尾", indent),
      ]).content,
    );
  const transaction = state.tr.replaceSelection(pasted(0));
  const alternate = state.tr.replaceSelection(pasted(9.88)).doc;
  const session = capturePasteFormatting(transaction, alternate, transaction.doc, "source", []);
  expect(session.targets).toHaveLength(1);
  const target = session.targets[0];
  if (!target) throw new Error("Missing formatting target");
  expect(transaction.doc.nodeAt(target.position)?.textContent).toBe("中");
});

test("stale paste options cannot alter a subsequently edited document", () => {
  const doc = schema.nodes.doc.create(null, [paragraph("正文")]);
  const state = EditorState.create({ doc });
  const dispatch = vi.fn();
  const view = { state, dispatch } as unknown as EditorView;
  expect(
    switchPasteFormatting(
      view,
      {
        document: schema.nodes.doc.create(null, [paragraph("旧内容")]),
        mode: "source",
        targets: [],
        simplifications: [],
      },
      "body",
    ),
  ).toBeNull();
  expect(dispatch).not.toHaveBeenCalled();
});

test("selecting the already applied format does not create an undo step", () => {
  const doc = schema.nodes.doc.create(null, [paragraph("正文")]);
  const state = EditorState.create({ doc });
  const dispatch = vi.fn();
  const view = { state, dispatch } as unknown as EditorView;
  switchPasteFormatting(
    view,
    {
      document: doc,
      mode: "source",
      targets: [
        {
          position: 0,
          source: { paragraphIndentMm: 0, textAlign: "left" },
          body: { paragraphIndentMm: 9.88, textAlign: "left" },
        },
      ],
      simplifications: [],
    },
    "source",
  );
  expect(dispatch).not.toHaveBeenCalled();
});
