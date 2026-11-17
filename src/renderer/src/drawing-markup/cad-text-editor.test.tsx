import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadTextEditor } from "./cad-text-editor";

afterEach(cleanup);

function setup(value = "已有文字") {
  const onChange = vi.fn();
  const onFinish = vi.fn();
  const view = render(
    <svg>
      <CadTextEditor
        value={value}
        x={10}
        y={20}
        width={120}
        fontSize={16}
        onChange={onChange}
        onFinish={onFinish}
      />
    </svg>,
  );
  return { ...view, onChange, onFinish, editor: screen.getByRole("textbox", { name: "画布文字" }) };
}

test("edits the visible text in place without a separate input or textarea", () => {
  const { editor, container, onChange } = setup();
  expect(editor.getAttribute("contenteditable")).toBe("plaintext-only");
  expect(editor.textContent).toBe("已有文字");
  expect(container.querySelector("input, textarea")).toBeNull();
  editor.textContent = "改后文字";
  fireEvent.input(editor);
  expect(onChange).toHaveBeenCalledWith("改后文字");
});

test("Enter is a newline, Ctrl+Enter commits, Escape cancels and composition never commits", () => {
  const { editor, onFinish } = setup();
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(onFinish).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(onFinish).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
  expect(onFinish).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(onFinish).toHaveBeenLastCalledWith(false);
});

test("changing font size does not replace the editing node or reset the draft", () => {
  const { editor, rerender, onChange, onFinish } = setup();
  editor.textContent = "未提交草稿";
  fireEvent.input(editor);
  rerender(
    <svg>
      <CadTextEditor
        value="未提交草稿"
        x={10}
        y={20}
        width={120}
        fontSize={24}
        onChange={onChange}
        onFinish={onFinish}
      />
    </svg>,
  );
  expect(screen.getByRole("textbox", { name: "画布文字" })).toBe(editor);
  expect(editor.textContent).toBe("未提交草稿");
  expect(editor.style.fontSize).toBe("24px");
});
