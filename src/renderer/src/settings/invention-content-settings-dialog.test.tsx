import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { InventionContentSettingsDialog } from "./invention-content-settings-dialog";

test("previews presets and saves a custom prefix without editing existing documents", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(<InventionContentSettingsDialog value="作为优化，" onSave={onSave} onClose={onClose} />);
  fireEvent.click(screen.getByRole("radio", { name: "进一步地，" }));
  expect(screen.getByText("进一步地，所述装置包括连接件。")).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "自定义" }));
  fireEvent.change(screen.getByRole("textbox", { name: "自定义开头" }), {
    target: { value: "在另一实施方案中" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).toHaveBeenCalledWith("在另一实施方案中，");
});

test("keeps failed saves open and cancels without saving", async () => {
  const onSave = vi.fn().mockResolvedValue(false);
  const onClose = vi.fn();
  render(<InventionContentSettingsDialog value="自定义，" onSave={onSave} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(onSave).toHaveBeenCalledWith("作为优化，");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSave).toHaveBeenCalledOnce();
});

test("rejects blank custom text", () => {
  render(<InventionContentSettingsDialog value="作为优化，" onSave={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "自定义" }));
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
});
