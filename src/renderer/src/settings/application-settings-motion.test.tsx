import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApplicationSettingsDialog } from "./application-settings-dialog";

vi.mock("./application-settings-workspace", () => ({
  ApplicationSettingsWorkspace: () => <div>设置内容</div>,
}));
test("settings closing retains inert paint and releases Escape immediately", () => {
  vi.useFakeTimers();
  try {
    const onClose = vi.fn();
    const view = render(<ApplicationSettingsDialog open onClose={onClose} />);
    view.rerender(<ApplicationSettingsDialog open={false} onClose={onClose} />);
    expect(view.container.querySelector(".application-settings-dialog")).not.toBeNull();
    expect(view.container.querySelector("[inert]")).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(420));
    expect(view.container.querySelector(".application-settings-dialog")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("quick reopening cancels removal and keeps the same settings contents", () => {
  vi.useFakeTimers();
  try {
    const onClose = vi.fn();
    const view = render(<ApplicationSettingsDialog open onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "设置" });
    view.rerender(<ApplicationSettingsDialog open={false} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(200));
    view.rerender(<ApplicationSettingsDialog open onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "设置" })).toBe(dialog);
    expect(dialog.closest("[inert]")).toBeNull();
    act(() => vi.advanceTimersByTime(420));
    expect(screen.getByRole("dialog", { name: "设置" })).toBe(dialog);
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
