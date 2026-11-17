import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandDisclosure } from "./command-disclosure";

test("commands are initially collapsed and close after execution or Escape", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <CommandDisclosure label="数据处理">
      <button type="button" onClick={action}>
        列设置
      </button>
    </CommandDisclosure>,
  );
  const summary = screen.getByText("数据处理");
  const disclosure = summary.closest("details");
  expect(disclosure?.open).toBe(false);
  await user.click(summary);
  await user.click(screen.getByRole("button", { name: "列设置" }));
  expect(action).toHaveBeenCalledOnce();
  expect(disclosure?.open).toBe(false);
  await user.click(summary);
  fireEvent.keyDown(summary, { key: "Escape", isComposing: true });
  expect(disclosure?.open).toBe(true);
  fireEvent.keyDown(summary, { key: "Escape" });
  expect(disclosure?.open).toBe(false);
  await user.click(summary);
  fireEvent.pointerDown(document.body);
  expect(disclosure?.open).toBe(false);
});
