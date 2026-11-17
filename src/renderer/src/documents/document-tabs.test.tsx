import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDocumentSession } from "./document-reducer";
import { CloseDecisionDialog, DocumentTabs } from "./document-tabs";

describe("document tabs", () => {
  test("pins the document library as the first non-closable tab", async () => {
    const user = userEvent.setup();
    const first = createDocumentSession("文档 1", "session-1");
    const onOpenLibrary = vi.fn();

    render(
      <DocumentTabs
        sessions={[first]}
        activeSessionId="session-1"
        libraryActive
        onActivate={vi.fn()}
        onRequestClose={vi.fn()}
        onReorder={vi.fn()}
        onNewDocument={vi.fn()}
        onOpenLibrary={onOpenLibrary}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toContain("文档库");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect((tabs[0] as HTMLButtonElement | undefined)?.draggable).toBe(false);
    expect(tabs[1]?.textContent).toContain("文档 1");
    expect(screen.queryByRole("button", { name: "关闭 文档库" })).toBeNull();

    await user.click(tabs[0] as HTMLElement);
    expect(onOpenLibrary).toHaveBeenCalledOnce();
  });

  test("renders accessible tabs and activates the next one with ArrowRight", async () => {
    const user = userEvent.setup();
    const first = createDocumentSession("文档 1", "session-1");
    const second = createDocumentSession("文档 2", "session-2");
    const onActivate = vi.fn();

    render(
      <DocumentTabs
        sessions={[first, second]}
        activeSessionId="session-1"
        onActivate={onActivate}
        onRequestClose={vi.fn()}
        onReorder={vi.fn()}
        onNewDocument={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    await user.click(tabs[0] as HTMLElement);
    await user.keyboard("{ArrowRight}");
    expect(onActivate).toHaveBeenLastCalledWith("session-2");
  });

  test("shows a saved marker and routes close through the queue-only close flow", async () => {
    const user = userEvent.setup();
    const saved = createDocumentSession("待保存", "saved-session");
    const onRequestClose = vi.fn();

    render(
      <DocumentTabs
        sessions={[saved]}
        activeSessionId={saved.sessionId}
        onActivate={vi.fn()}
        onRequestClose={onRequestClose}
        onReorder={vi.fn()}
        onNewDocument={vi.fn()}
      />,
    );

    expect(screen.getByText("已保存")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "关闭 待保存" }));
    expect(onRequestClose).toHaveBeenCalledWith("saved-session");
  });

  test("shows a visible failed marker when the save queue stops", () => {
    const failed = {
      ...createDocumentSession("保存失败文档", "failed-session"),
      saveState: "failed" as const,
    };

    render(
      <DocumentTabs
        sessions={[failed]}
        activeSessionId={failed.sessionId}
        onActivate={vi.fn()}
        onRequestClose={vi.fn()}
        onReorder={vi.fn()}
        onNewDocument={vi.fn()}
      />,
    );

    expect(screen.getByText("保存失败")).toBeDefined();
  });
});

describe("close decision dialog", () => {
  test("provides save, discard, cancel, and a standard close decision", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();

    render(
      <CloseDecisionDialog
        documentTitle="待保存"
        onSave={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "保存更改" });
    expect(dialog.querySelectorAll("button")).toHaveLength(4);
    expect(
      screen
        .getByRole("button", { name: "取消保存更改" })
        .classList.contains("dialog-close-button"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "不保存" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
