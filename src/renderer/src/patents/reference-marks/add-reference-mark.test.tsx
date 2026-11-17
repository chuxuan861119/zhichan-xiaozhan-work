import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AddReferenceMark } from "./add-reference-mark";
import { ActiveEditorSessionContext, EditorSessionScope } from "../../shared/editor-session-scope";

afterEach(cleanup);
test("plus opens a styled dialog, validates registration and closes only on success", () => {
  const add = vi.fn(() => ({ ok: true, message: "" }));
  render(<AddReferenceMark entries={[]} onAdd={add} />);
  fireEvent.click(screen.getByRole("button", { name: "新增附图标记" }));
  const dialog = screen.getByRole("dialog", { name: "新增附图标记" });
  fireEvent.change(within(dialog).getByLabelText("关键词"), { target: { value: " 底座 " } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
  expect(add).toHaveBeenCalledWith({ number: 1, keyword: "底座" });
});
test("duplicate numbers are rejected without calling the writer", () => {
  const add = vi.fn(() => ({ ok: true, message: "" }));
  render(<AddReferenceMark entries={[{ number: 1, keyword: "底座" }]} onAdd={add} />);
  fireEvent.click(screen.getByRole("button", { name: "新增附图标记" }));
  const dialog = screen.getByRole("dialog", { name: "新增附图标记" });
  fireEvent.change(within(dialog).getByLabelText("编号"), { target: { value: "1" } });
  fireEvent.change(within(dialog).getByLabelText("关键词"), { target: { value: "外壳" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
  expect(add).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("alert").textContent).toContain("已存在");
});

test("switching patents hides the dialog and restores its own draft without exposing it to the other patent", () => {
  const add = vi.fn(() => ({ ok: true, message: "" }));
  const content = (active: string) => <ActiveEditorSessionContext.Provider value={active}>
    <EditorSessionScope sessionId="patent-a"><AddReferenceMark entries={[]} onAdd={add} /></EditorSessionScope>
  </ActiveEditorSessionContext.Provider>;
  const view = render(content("patent-a"));
  fireEvent.click(screen.getByRole("button", { name: "新增附图标记" }));
  fireEvent.change(screen.getByLabelText("关键词"), { target: { value: "底座" } });
  view.rerender(content("patent-b"));
  expect(screen.queryByRole("dialog", { name: "新增附图标记" })).toBeNull();
  view.rerender(content("patent-a"));
  expect(screen.getByLabelText("关键词")).toHaveProperty("value", "底座");
  expect(add).not.toHaveBeenCalled();
});
