import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AiExperimentalEntry, AiExperimentalNotice } from "./ai-experimental-notice";

afterEach(cleanup);
test("notice does not launch the action and supports pin, outside dismissal and keyboard activation", () => {
  const action = vi.fn();
  render(
    <AiExperimentalEntry label="小栈AI助手">
      <button type="button" onClick={action}>
        小栈AI助手
      </button>
    </AiExperimentalEntry>,
  );
  const trigger = screen.getByRole("button", { name: "小栈AI助手实验功能说明" });
  fireEvent.click(trigger);
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("未公开专利");
  fireEvent.mouseLeave(trigger, { relatedTarget: document.body });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.focus(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.blur(trigger, { relatedTarget: document.body });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("hiding the source panel removes its pinned notice", async () => {
  const view = render(
    <aside>
      <AiExperimentalNotice feature="AI 纠错" />
    </aside>,
  );
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {
    view.rerender(
      <aside hidden>
        <AiExperimentalNotice feature="AI 纠错" />
      </aside>,
    );
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
