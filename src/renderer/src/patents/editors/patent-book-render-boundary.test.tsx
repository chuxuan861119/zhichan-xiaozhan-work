import { render } from "@testing-library/react";
import { createBlankBookDocument } from "../../../../shared/document/defaults";
import { EditorCommandBus } from "../../app/command-bus";
import { RichTextEditorCore } from "../../editor/rich-text-editor-core";
import { capabilitiesForPatentBook } from "../patent-toolbar-capabilities";
import { PatentBookRichTextEditor } from "./patent-book-rich-text-editor";

vi.mock("../../editor/rich-text-editor-core", () => ({ RichTextEditorCore: vi.fn(() => null) }));

test("unchanged editor bodies skip parent renders without retaining obsolete UI callbacks", () => {
  const document = createBlankBookDocument("说明书");
  const commandBus = new EditorCommandBus();
  const first = vi.fn(),
    second = vi.fn();
  const view = (onDocumentChange: typeof first) => (
    <PatentBookRichTextEditor
      editorId="memo-boundary"
      bookKind="description"
      document={document}
      availableAssetIds={new Set()}
      assets={[]}
      referenceMarks={[]}
      referenceMarkIssueLocations={[]}
      commandBus={commandBus}
      capabilities={capabilitiesForPatentBook("description")}
      onDocumentChange={onDocumentChange}
    />
  );
  const rendered = render(view(first));
  expect(RichTextEditorCore).toHaveBeenCalledTimes(1);
  rendered.rerender(view(second));
  expect(RichTextEditorCore).toHaveBeenCalledTimes(1);
  vi.mocked(RichTextEditorCore).mock.calls[0]?.[0].onDocumentChange(document);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(document, []);
});
