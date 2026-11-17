import { act, render, screen, waitFor } from "@testing-library/react";
import { createBlankBookDocument } from "../../../shared/document/defaults";
import type { OpenedPatent } from "../../../shared/ipc/contract";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { EditorCommandBus } from "../app/command-bus";
import { AuxiliaryDocumentEditor, auxiliaryDocumentEditorId } from "./auxiliary-document-editor";
import { createPatentSession } from "./patent-reducer";

const patentId = "00000000-0000-4000-8000-000000000101";
const sessionId = "00000000-0000-4000-8000-000000000201";
const auxiliaryDocumentId = "00000000-0000-4000-8000-000000000401";

function session() {
  const patent = createBlankPatent({ patentType: "invention", name: "夹具专利" });
  patent.patentId = patentId;
  patent.auxiliaryDocuments = [
    {
      auxiliaryDocumentId,
      title: "实验记录",
      document: createBlankBookDocument("实验记录"),
      editorState: { source: "manual" },
      localRevision: 0,
      persistedRevision: 0,
      sourceFileName: null,
    },
  ];
  const opened: OpenedPatent = {
    patentId,
    sessionId,
    revision: 0,
    patent,
    saveState: "saved",
  };
  return createPatentSession(opened);
}

describe("auxiliary document editor", () => {
  test("uses the same full-width zoom page frame and page margins as text patent books", () => {
    const activeSession = session();
    const auxiliary = activeSession.patent.auxiliaryDocuments[0];
    if (!auxiliary) throw new Error("Missing auxiliary document fixture.");

    const { container } = render(
      <AuxiliaryDocumentEditor
        session={activeSession}
        auxiliaryDocumentId={auxiliaryDocumentId}
        commandBus={new EditorCommandBus()}
        zoomPercent={150}
        onDocumentChange={vi.fn()}
      />,
    );

    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    const zoomFrame = container.querySelector<HTMLElement>(".patent-page-zoom-frame");
    const editor = container.querySelector<HTMLElement>(".auxiliary-document-editor");
    expect(layout).not.toBeNull();
    expect(zoomFrame).not.toBeNull();
    expect(zoomFrame?.contains(editor)).toBe(true);
    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.5");
    expect(layout?.style.getPropertyValue("--patent-book-page-width")).toBe(
      `${auxiliary.document.page.widthMm}mm`,
    );
    expect(layout?.style.getPropertyValue("--patent-book-page-min-height")).toBe(
      `${auxiliary.document.page.heightMm}mm`,
    );
    expect(layout?.style.getPropertyValue("--patent-page-margin-top")).toBe(
      `${auxiliary.document.page.marginTopMm}mm`,
    );
    expect(layout?.style.getPropertyValue("--patent-page-margin-right")).toBe(
      `${auxiliary.document.page.marginRightMm}mm`,
    );
    expect(layout?.style.getPropertyValue("--patent-page-margin-bottom")).toBe(
      `${auxiliary.document.page.marginBottomMm}mm`,
    );
    expect(layout?.style.getPropertyValue("--patent-page-margin-left")).toBe(
      `${auxiliary.document.page.marginLeftMm}mm`,
    );
  });

  test("centers the fixed-width page without an empty function rail and restores the rail for tools", () => {
    const activeSession = session();
    const commandBus = new EditorCommandBus();
    const editorId = auxiliaryDocumentEditorId(sessionId, auxiliaryDocumentId);
    const baseProps = {
      session: activeSession,
      auxiliaryDocumentId,
      commandBus,
      zoomPercent: 125,
      onDocumentChange: vi.fn(),
    };
    const { container, rerender } = render(<AuxiliaryDocumentEditor {...baseProps} />);

    const layout = container.querySelector<HTMLElement>(".patent-page-with-rail");
    expect(layout?.getAttribute("data-structure-ruler-offset")).toBeNull();
    expect(container.querySelector(".patent-global-function-rail-slot")).toBeNull();
    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.25");
    expect(container.querySelector(".patent-page-zoom-frame")).not.toBeNull();

    rerender(
      <AuxiliaryDocumentEditor
        {...baseProps}
        findSession={{
          mode: "find",
          scope: "single",
          target: { patentId, kind: "auxiliary", auxiliaryDocumentId },
          editorId,
          bookmark: null,
        }}
        findQuery="实验"
        onFindModeChange={vi.fn()}
      />,
    );

    expect(layout?.getAttribute("data-structure-ruler-offset")).toBe("true");
    expect(container.querySelector(".patent-global-function-rail-slot")).not.toBeNull();
    expect(layout?.style.getPropertyValue("--patent-page-zoom")).toBe("1.25");
  });

  test("registers an independent rich-text editor and forwards changes", async () => {
    const commandBus = new EditorCommandBus();
    const onDocumentChange = vi.fn();

    render(
      <AuxiliaryDocumentEditor
        session={session()}
        auxiliaryDocumentId={auxiliaryDocumentId}
        commandBus={commandBus}
        onDocumentChange={onDocumentChange}
      />,
    );

    const editorId = auxiliaryDocumentEditorId(sessionId, auxiliaryDocumentId);
    await waitFor(() => expect(commandBus.has(editorId)).toBe(true));
    expect(screen.getByText("实验记录")).not.toBeNull();
    const editor = commandBus.getEditor(editorId);
    if (!editor) throw new Error("Missing auxiliary editor.");
    act(() => {
      editor.commands.insertContent("测试数据");
    });
    await waitFor(() => expect(onDocumentChange).toHaveBeenCalled());
    expect(onDocumentChange.mock.calls.at(-1)?.[0]).toBe(auxiliaryDocumentId);
    expect(onDocumentChange.mock.calls.at(-1)?.[2]).toEqual({ source: "manual" });
  });
});
