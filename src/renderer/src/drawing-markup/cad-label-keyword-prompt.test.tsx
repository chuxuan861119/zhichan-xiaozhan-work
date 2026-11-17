import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CadLabelKeywordPrompt } from "./cad-label-keyword-prompt";
import { createRef } from "react";
import type { CadLabelKeywordPromptHandle } from "./cad-label-keyword-prompt";

afterEach(cleanup);
const props = { x: 30, y: 40, units: 1, number: 9 };
test("keyword prompt does not steal focus, accepts optional text and isolates keyboard events", () => {
  const commit = vi.fn(() => ({ ok: true, message: "" })), close = vi.fn(), key = vi.fn();
  render(<svg onKeyDown={key}><CadLabelKeywordPrompt {...props} onCommit={commit} onClose={close} /></svg>);
  const input = screen.getByPlaceholderText("填入关键词（选填）");
  expect(document.activeElement).not.toBe(input);
  fireEvent.change(input, { target: { value: " 底座 " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(commit).toHaveBeenCalledWith("底座");
  expect(close).toHaveBeenCalledOnce();
  expect(key).not.toHaveBeenCalled();
});
test("empty blur and Escape skip registration; errors remain editable and IME Enter does not submit", () => {
  const commit = vi.fn(() => ({ ok: false, message: "编号已存在" })), close = vi.fn();
  const view = render(<svg><CadLabelKeywordPrompt key="first" {...props} onCommit={commit} onClose={close} /></svg>);
  let input = screen.getByPlaceholderText("填入关键词（选填）");
  fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled();
  close.mockClear();
  view.rerender(<svg><CadLabelKeywordPrompt key="second" {...props} onCommit={commit} onClose={close} /></svg>);
  input = screen.getByPlaceholderText("填入关键词（选填）");
  fireEvent.change(input, { target: { value: "底座" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toContain("已存在");
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("pan, zoom, outside interaction and blur retain the draft until the next label begins", () => {
  const commit = vi.fn(() => ({ ok: true, message: "" })), close = vi.fn();
  const ref = createRef<CadLabelKeywordPromptHandle>();
  render(<svg><CadLabelKeywordPrompt {...props} ref={ref} onCommit={commit} onClose={close} /></svg>);
  const input = screen.getByPlaceholderText("填入关键词（选填）");
  fireEvent.change(input, { target: { value: "外壳" } });
  fireEvent.pointerDown(document.body, { button: 1 });
  fireEvent.pointerDown(document.body, { button: 2 });
  fireEvent.wheel(document.body, { deltaY: 100 });
  fireEvent.blur(input);
  expect(close).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(input).toHaveProperty("value", "外壳");
  expect(ref.current?.finish()).toBe(true);
  expect(commit).toHaveBeenCalledWith("外壳");
  expect(close).toHaveBeenCalledOnce();
});
