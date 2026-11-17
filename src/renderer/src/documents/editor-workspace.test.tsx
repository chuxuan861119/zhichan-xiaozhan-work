import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createBlankDocument } from "../../../shared/document/defaults";
import type { EditorCommandBus } from "../app/command-bus";
import type { DocumentSession } from "./document-reducer";
import { EditorWorkspace } from "./editor-workspace";

vi.mock("../editor/PatentEditor", () => ({
  PatentEditor: () => <div data-testid="patent-editor" />,
}));

function session(title: string, sessionId: string): DocumentSession {
  const model = createBlankDocument(title);
  return {
    sessionId,
    libraryDocumentId: `library-${sessionId}`,
    model,
    saveState: "saved",
    localRevision: 0,
    persistedRevision: 0,
    lastSavedAt: null,
    saveError: null,
    selection: null,
    scrollTop: 0,
    textCounts: { chineseCharacters: 0, totalCharacters: 0, selectedCharacters: 0 },
  };
}

function commandBus() {
  return {} as unknown as EditorCommandBus;
}

describe("EditorWorkspace page CSS variables", () => {
  test("injects --editor-page-* mm variables matching document.page", () => {
    const s = session("文档", "session-1");
    s.model.page = {
      widthMm: 180,
      heightMm: 240,
      marginTopMm: 30,
      marginRightMm: 20,
      marginBottomMm: 30,
      marginLeftMm: 20,
    };
    render(
      <EditorWorkspace
        sessions={[s]}
        activeSessionId="session-1"
        commandBus={commandBus()}
        onModelChange={() => undefined}
        onTextCounts={() => undefined}
        zoomPercent={100}
      />,
    );

    const paper = document.querySelector(".editor-paper") as HTMLElement | null;
    expect(paper).not.toBeNull();
    expect(paper?.style.getPropertyValue("--editor-page-width")).toBe("180mm");
    expect(paper?.style.getPropertyValue("--editor-page-height")).toBe("240mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-top")).toBe("30mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-right")).toBe("20mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-bottom")).toBe("30mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-left")).toBe("20mm");
    expect(screen.getByTestId("patent-editor")).toBeDefined();
  });

  test("injects Word defaults by default", () => {
    const s = session("文档", "session-2");
    render(
      <EditorWorkspace
        sessions={[s]}
        activeSessionId="session-2"
        commandBus={commandBus()}
        onModelChange={() => undefined}
        onTextCounts={() => undefined}
        zoomPercent={100}
      />,
    );

    const paper = document.querySelector(".editor-paper") as HTMLElement | null;
    expect(paper?.style.getPropertyValue("--editor-page-width")).toBe("210mm");
    expect(paper?.style.getPropertyValue("--editor-page-height")).toBe("297mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-top")).toBe("25.4mm");
    expect(paper?.style.getPropertyValue("--editor-page-margin-left")).toBe("31.7mm");
  });
});
