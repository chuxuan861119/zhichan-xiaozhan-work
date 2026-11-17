import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PatentApi } from "../../../shared/ipc/contract";
import { ApplicationCloseProvider } from "../app/application-close-coordinator";
import { ApplicationSettingsDialog } from "./application-settings-dialog";

function renderDialog() {
  const onClose = vi.fn();
  const actions = {
    onOpenDefaultTemplates: vi.fn(),
    onOpenShortcutSettings: vi.fn(),
    onOpenAiCorrectionSettings: vi.fn(),
    onOpenDataSafety: vi.fn(),
    onOpenBackupManager: vi.fn(),
    onOpenSnapshotManager: vi.fn(),
  };
  window.patentApi = {
    application: {
      onPrepareClose: vi.fn(() => vi.fn()),
      closeResult: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
    patentTemplates: {
      readSummary: vi.fn(async () => ({
        ok: true as const,
        value: {
          invention: { selection: { kind: "system" as const }, selectedTemplateName: null },
          "utility-model": {
            selection: { kind: "system" as const },
            selectedTemplateName: null,
          },
        },
      })),
      openEditor: vi.fn(() => new Promise(() => undefined)),
      closeEditor: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  } as unknown as PatentApi;
  render(
    <ApplicationCloseProvider>
      <ApplicationSettingsDialog open onClose={onClose} {...actions} />
    </ApplicationCloseProvider>,
  );
  return { onClose, ...actions };
}

describe("application settings dialog", () => {
  test("closes through the dialog close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    const closeButton = screen
      .getAllByRole("button", { name: "关闭设置" })
      .find((button) => button.classList.contains("dialog-close-control"));

    if (!closeButton) throw new Error("未找到设置窗口的关闭按钮");

    await user.click(closeButton);

    expect(onClose).toHaveBeenCalledOnce();
  });

  test("does not close when the settings overlay is clicked and closes with Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    const overlay = document.querySelector<HTMLElement>(".application-settings-dialog__backdrop");
    if (!overlay) throw new Error("未找到设置窗口遮罩");

    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("keeps the settings dialog open while routing to page settings", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "页边距" }));

    expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "页边距" })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("uses the selected settings hierarchy and grouped navigation", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "设置" })).toBeDefined();
    expect(screen.queryByText("知产小栈Work")).toBeNull();
    expect(screen.queryByText("管理模板、快捷键、AI 纠错和本机数据安全设置。")).toBeNull();
    expect(screen.getByRole("button", { name: "默认模板" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: /^AI 设置/ })).toBeDefined();
    expect(screen.getByRole("heading", { name: "文档与写作" })).toBeDefined();
    expect(screen.getByText("界面与启动")).toBeDefined();
    expect(screen.getByText("智能辅助")).toBeDefined();
    expect(screen.getByText("数据与安全")).toBeDefined();
  });

  test("uses the fixed-size workspace shell", () => {
    renderDialog();

    expect(
      screen
        .getByRole("dialog", { name: "设置" })
        .classList.contains("application-settings-dialog--workspace"),
    ).toBe(true);
  });

  test("routes data safety management within the settings dialog", async () => {
    const user = userEvent.setup();
    const { onClose, onOpenDataSafety, onOpenBackupManager, onOpenSnapshotManager } =
      renderDialog();

    await user.click(screen.getByRole("button", { name: "存储与备份" }));
    await user.click(screen.getByRole("button", { name: "备份文件" }));

    expect(screen.getByRole("dialog", { name: "设置" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "存储与备份" })).toBeDefined();
    expect(screen.getByRole("region", { name: "备份管理器" })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenDataSafety).not.toHaveBeenCalled();
    expect(onOpenBackupManager).not.toHaveBeenCalled();
    expect(onOpenSnapshotManager).not.toHaveBeenCalled();
  });
});
