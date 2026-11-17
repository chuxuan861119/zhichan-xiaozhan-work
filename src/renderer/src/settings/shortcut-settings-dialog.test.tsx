import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "../../../shared/settings/shortcuts";
import { ShortcutSettingsDialog } from "./shortcut-settings-dialog";

vi.mock("../shared/app-dialog", () => ({
  confirmAppAction: vi.fn(async () => true),
}));

function renderDialog(overrides: Partial<ComponentProps<typeof ShortcutSettingsDialog>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn(async () => true);
  const view = render(
    <ShortcutSettingsDialog
      open
      value={DEFAULT_SHORTCUT_SETTINGS}
      onClose={onClose}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { ...view, onClose, onSave };
}

describe("shortcut settings dialog", () => {
  test("configures the description supplement shortcut", async () => {
    const { onSave } = renderDialog();
    const button = screen.getByRole("button", { name: "设置增补编号快捷键" });
    await userEvent.click(button);
    fireEvent.keyDown(button, { code: "F9", key: "F9" });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ "supplement-reference-numbers": "F9" }),
    );
  });
  test("defaults to configurable shortcuts and switches to a dense fixed-shortcut tab", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();

    expect(screen.getByRole("tab", { name: "自定义快捷键", selected: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /设置.*快捷键/u })).toHaveLength(7);
    expect(screen.queryByText("Ctrl+B")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "固定快捷键" }));
    expect(screen.getByRole("tab", { name: "固定快捷键", selected: true })).toBeTruthy();
    expect(screen.getByText("Ctrl+B")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "设置附图排序快捷键" })).toBeNull();
    expect(container.querySelector(".shortcut-settings-dialog__fixed-list--dense")).toBeTruthy();
  });

  test("lists default configurable actions without function-key guidance", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByText(/F1.*F12/u)).toBeNull();
    expect(
      screen.getByText("点击快捷键框后直接按键，按 Backspace 或 Delete 可清除。修改后立即保存。"),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /设置.*快捷键/u })).toHaveLength(7);
    expect(screen.getByRole("button", { name: "设置本地检查快捷键" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置导入图片快捷键" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "固定快捷键" }));
    expect(screen.getByText(/加粗/u)).toBeTruthy();
    expect(screen.getByText("Ctrl+B")).toBeTruthy();
  });

  test("automatically saves a normalized shortcut without save or cancel buttons", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    const button = screen.getByRole("button", { name: "设置附图排序快捷键" });
    await user.click(button);
    expect(button.textContent).toBe("请按快捷键");
    fireEvent.keyDown(button, { code: "F8", key: "F8" });
    expect(screen.getByRole("button", { name: "设置附图排序快捷键" }).textContent).toContain("F8");

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ "toggle-drawing-sort": "F8" }));
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  test("blocks fixed shortcut conflicts and lets Escape and Delete restore or clear a row", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({
      value: { ...DEFAULT_SHORTCUT_SETTINGS, "toggle-drawing-sort": "F8" },
    });

    const sortButton = screen.getByRole("button", {
      name: "设置附图排序快捷键",
    });
    await user.click(sortButton);
    fireEvent.keyDown(sortButton, { code: "KeyB", key: "b", ctrlKey: true });
    expect(screen.getByRole("alert").textContent).toContain("与加粗（Ctrl+B）冲突");
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(sortButton, { code: "Escape", key: "Escape" });
    expect(screen.getByRole("button", { name: "设置附图排序快捷键" }).textContent).toContain("F8");

    await user.click(screen.getByRole("button", { name: "设置附图排序快捷键" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "设置附图排序快捷键" }), {
      code: "Delete",
      key: "Delete",
    });
    expect(screen.getByRole("button", { name: "设置附图排序快捷键" }).textContent).toContain(
      "未设置",
    );
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ "toggle-drawing-sort": null }));
  });

  test("restores the previous shortcut and shows an error when automatic saving fails", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => false);
    const { onClose } = renderDialog({ onSave });

    await user.click(screen.getByRole("button", { name: "设置附图排序快捷键" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "设置附图排序快捷键" }), {
      code: "F8",
      key: "F8",
    });
    const dialog = screen.getByRole("dialog", { name: "快捷键设置" });
    expect(await within(dialog).findByText("自动保存快捷键失败，请重试。")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "设置附图排序快捷键" }).textContent,
    ).toContain("未设置");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("places clear-all in the fixed header and automatically persists cleared settings", async () => {
    const user = userEvent.setup();
    const value = { ...DEFAULT_SHORTCUT_SETTINGS, "toggle-drawing-sort": "F8" };
    const { container, onSave } = renderDialog({ embedded: true, value });

    const header = container.querySelector(".shortcut-settings-dialog__header");
    expect(header).toBeTruthy();
    await user.click(
      within(header as HTMLElement).getByRole("button", {
        name: "恢复默认快捷键",
      }),
    );

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ "toggle-drawing-sort": null }));
    expect(container.querySelector(".shortcut-settings-dialog__footer")).toBeNull();
  });

  test("shows configured custom dual-view presets in their own shortcut group", () => {
    renderDialog({
      customDualViewPresets: [
        { leftBookKind: "description", rightBookKind: "claims" },
        { leftBookKind: "claims", rightBookKind: "description" },
        { leftBookKind: "abstract", rightBookKind: "claims" },
        { leftBookKind: "description-drawings", rightBookKind: "abstract" },
      ],
    });

    expect(screen.getByRole("region", { name: "同屏双显快捷键" })).toBeTruthy();
    expect(screen.getByText("说明书｜权利要求书")).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置说明书｜权利要求书快捷键" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置说明书附图｜说明书摘要快捷键" })).toBeTruthy();
  });

  test("opens custom dual-view settings from the dual-view shortcut group", async () => {
    const user = userEvent.setup();
    const onOpenCustomDualView = vi.fn();
    const { unmount } = renderDialog({ onOpenCustomDualView });

    const group = screen.getByRole("region", { name: "同屏双显快捷键" });
    await user.click(within(group).getByRole("button", { name: "自定义同屏双显" }));

    expect(onOpenCustomDualView).toHaveBeenCalledTimes(1);

    unmount();
    renderDialog();
    expect(screen.queryByRole("button", { name: "自定义同屏双显" })).toBeNull();
  });
});
