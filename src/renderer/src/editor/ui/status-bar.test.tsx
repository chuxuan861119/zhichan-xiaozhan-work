import { fireEvent, render, screen } from "@testing-library/react";
import { createDocumentSession } from "../../documents/document-reducer";
import type { PatentSession } from "../../patents/patent-reducer";
import type { TextCounts } from "../rich-text-editor-core";
import { StatusBar } from "./status-bar";

const zoomProps = {
  zoomPercent: 100,
  onZoomIn: () => {},
  onZoomOut: () => {},
  onZoomReset: () => {},
} as const;

test("shows library counts without zoom controls or an open document status", () => {
  render(
    <StatusBar
      session={createDocumentSession("后台文档", "library-count-test")}
      libraryPatents={[{ patentType: "invention" }, { patentType: "utility-model" }]}
      {...zoomProps}
    />,
  );
  expect(screen.getByText("专利库")).toBeDefined();
  expect(screen.getByText("总计 2 项 · 发明 1 项 · 新型 1 项")).toBeDefined();
  expect(screen.queryByRole("button", { name: "缩放 100%，点击重置" })).toBeNull();
  expect(screen.queryByRole("button", { name: "缩小" })).toBeNull();
  expect(screen.queryByRole("button", { name: "放大" })).toBeNull();
  expect(screen.queryByText("修订 0")).toBeNull();
});

test("disables zoom in at the supplied per-pane limit", () => {
  render(<StatusBar session={null} {...zoomProps} zoomPercent={107} maxZoomPercent={107} />);
  expect((screen.getByRole("button", { name: "放大" }) as HTMLButtonElement).disabled).toBe(true);
});

test("distinguishes fitted columns from absolute page zoom", () => {
  const view = render(<StatusBar session={null} {...zoomProps} zoomMode="fit-width" />);
  const reset = screen.getByRole("button", { name: "缩放 100%，点击重置" });
  expect(reset.textContent).toBe("适应宽度");
  expect(reset.getAttribute("title")).toContain("恢复适应宽度");
  view.rerender(<StatusBar session={null} {...zoomProps} zoomMode="fit-width" zoomPercent={120} />);
  expect(screen.getByRole("button", { name: "缩放 120%，点击重置" }).textContent).toBe(
    "适应宽度 × 120%",
  );
  view.rerender(<StatusBar session={null} {...zoomProps} zoomPercent={35.621} />);
  expect(screen.getByRole("button", { name: "缩放 36%，点击重置" }).textContent).toBe("36%");
});

test("shows the final save state without an obsolete autosave choice", () => {
  render(<StatusBar session={createDocumentSession("文档 1", "session-1")} {...zoomProps} />);

  expect(screen.getByRole("status", { name: "已保存" })).toBeDefined();
  expect(screen.getByText("修订 0")).toBeDefined();
  expect(screen.queryByText(/自动保存|分钟|关闭/u)).toBeNull();
});

test("releases editor focus when interacting with selectable status text", () => {
  render(
    <>
      <div contentEditable data-testid="editor" />
      <StatusBar session={null} {...zoomProps} />
    </>,
  );

  const editor = screen.getByTestId("editor");
  const statusText = screen.getByText("专利库");
  editor.focus();
  expect(document.activeElement).toBe(editor);

  fireEvent.pointerDown(statusText);

  expect(document.activeElement).not.toBe(editor);
  expect(statusText.closest(".status-bar")?.classList.contains("status-bar")).toBe(true);
});

test("shows a patent library status when no document tab is active", () => {
  render(<StatusBar session={null} {...zoomProps} />);

  expect(screen.getByText("专利库")).toBeDefined();
  expect(screen.queryByText("文档库")).toBeNull();
  expect(screen.queryByText("持续保存已开启")).toBeNull();
});

test("shows zoom shortcuts in hover text", () => {
  render(<StatusBar session={null} {...zoomProps} />);

  expect(screen.getByRole("button", { name: "缩小" }).getAttribute("title")).toBe("缩小（Ctrl+-）");
  expect(screen.getByRole("button", { name: "缩放 100%，点击重置" }).getAttribute("title")).toBe(
    "Ctrl+0",
  );
  expect(screen.getByRole("button", { name: "放大" }).getAttribute("title")).toBe(
    "放大（Ctrl+= / Ctrl+Shift+=）",
  );
});

test("shows the active patent save state instead of a false library status", () => {
  const patentSession = {
    patent: { name: "折叠式支架" },
    aggregateSaveState: "saved",
    persistedRevision: 7,
    lastSavedAt: "2026-08-02T08:00:00.000Z",
  } as PatentSession;

  render(<StatusBar session={null} patentSession={patentSession} {...zoomProps} />);

  expect(screen.getByText("折叠式支架")).toBeDefined();
  expect(screen.getByRole("status", { name: "已保存" })).toBeDefined();
  expect(screen.getByText("修订 7")).toBeDefined();
  expect(screen.queryByText("文档库")).toBeNull();
});

const patentCounts: TextCounts = {
  chineseCharacters: 100,
  totalCharacters: 123,
  selectedCharacters: 12,
};

const patentSession = {
  patent: { name: "折叠式支架" },
  aggregateSaveState: "saved",
  persistedRevision: 7,
  lastSavedAt: "2026-08-02T08:00:00.000Z",
} as PatentSession;

test("shows patent word count for text books", () => {
  render(
    <StatusBar
      session={null}
      patentSession={{ ...patentSession, activeBookKind: "description" }}
      patentTextCounts={patentCounts}
      {...zoomProps}
    />,
  );

  expect(screen.getByText("已选 12 / 共 123 字")).toBeDefined();
});

test("places patent word count immediately after the revision status", () => {
  render(
    <StatusBar
      session={null}
      patentSession={{ ...patentSession, activeBookKind: "description" }}
      patentTextCounts={patentCounts}
      {...zoomProps}
    />,
  );

  const saveState = document.querySelector(".status-save-state");
  expect(saveState?.nextElementSibling?.textContent).toBe("已选 12 / 共 123 字");
});

test("shows total patent word count when there is no selection", () => {
  render(
    <StatusBar
      session={null}
      patentSession={{ ...patentSession, activeBookKind: "claims" }}
      patentTextCounts={{ ...patentCounts, selectedCharacters: 0 }}
      {...zoomProps}
    />,
  );

  expect(screen.getByText("字数：123")).toBeDefined();
  expect(screen.queryByText(/已选/u)).toBeNull();
});

test("shows zero until an active text editor publishes counts", () => {
  render(
    <StatusBar
      session={null}
      patentSession={{ ...patentSession, activeBookKind: "abstract" }}
      patentTextCounts={null}
      {...zoomProps}
    />,
  );

  expect(screen.getByText("字数：0")).toBeDefined();
});

test("hides patent word count for drawing books", () => {
  render(
    <StatusBar
      session={null}
      patentSession={{ ...patentSession, activeBookKind: "description-drawings" }}
      patentTextCounts={patentCounts}
      {...zoomProps}
    />,
  );

  expect(screen.queryByText(/字/u)).toBeNull();
});

test("Mac fitted-page reset advertises the Command binding", () => {
  vi.stubGlobal("documentFontPlatform", "darwin");
  try {
    render(<StatusBar session={null} {...zoomProps} zoomMode="fit-width" />);
    expect(screen.getByRole("button", { name: "缩放 100%，点击重置" }).getAttribute("title")).toBe(
      "恢复适应宽度（⌘+0）",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
