import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DraftText, type DraftTextHandle } from "./draft-text";

afterEach(cleanup);
it("allows empty intermediate text and commits once when the editor is flushed", () => {
  const ref = createRef<DraftTextHandle>();
  const commit = vi.fn();
  render(<DraftText ref={ref} label="编号" value="1" onCommit={commit} />);
  const input = screen.getByLabelText("编号");
  fireEvent.change(input, { target: { value: "" } });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "42" } });
  act(() => ref.current?.flush());
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledExactlyOnceWith("42");
});
it("Escape discards the draft even if close flushing follows immediately", () => {
  const ref = createRef<DraftTextHandle>();
  const commit = vi.fn();
  render(<DraftText ref={ref} label="编号" value="1" onCommit={commit} />);
  fireEvent.change(screen.getByLabelText("编号"), { target: { value: "42" } });
  fireEvent.keyDown(screen.getByLabelText("编号"), { key: "Escape" });
  act(() => ref.current?.flush());
  expect(commit).not.toHaveBeenCalled();
});
it("restores the actual value after a rejected commit and accepts a later correction", () => {
  const commit = vi.fn((value: string) => value !== "B");
  const { rerender } = render(<DraftText label="字母" value="A" onCommit={commit} />);
  const input = screen.getByLabelText("字母");
  fireEvent.change(input, { target: { value: "B" } });
  fireEvent.blur(input);
  expect(input).toHaveProperty("value", "A");
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "C" } });
  fireEvent.blur(input);
  rerender(<DraftText label="字母" value="C" onCommit={commit} />);
  expect(input).toHaveProperty("value", "C");
  expect(commit).toHaveBeenLastCalledWith("C");
});
