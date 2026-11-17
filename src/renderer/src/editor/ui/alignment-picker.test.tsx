import { fireEvent, render, screen } from "@testing-library/react";
import { AlignmentPicker } from "./alignment-picker";

test("shows one trigger and dispatches alignment from its menu", () => {
  const onCommand = vi.fn();
  render(<AlignmentPicker alignment="right" disabled={false} onCommand={onCommand} />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "段落对齐" }));
  expect(screen.getByRole("menuitemradio", { name: "右对齐" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "居中" }));
  expect(onCommand).toHaveBeenCalledWith("align-center");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("does not open when unavailable", () => {
  render(<AlignmentPicker alignment="left" disabled onCommand={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "段落对齐" }));
  expect(screen.queryByRole("menu")).toBeNull();
});
