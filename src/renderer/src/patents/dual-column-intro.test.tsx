import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DualColumnIntro } from "./dual-column-intro";

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});
test("shows a nonblocking introduction only once after entering columns", () => {
  vi.useFakeTimers();
  const view = render(<DualColumnIntro enabled />);
  expect(screen.queryByRole("status")).toBeNull();
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("status").textContent).toContain("左列底部接右列顶部");
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<DualColumnIntro enabled={false} />);
  view.rerender(<DualColumnIntro enabled />);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByRole("status")).toBeNull();
});
