import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AiThinkingFeedback, useThinkingActivity } from "./ai-thinking-feedback";

describe("compact thinking feedback", () => {
  test("keeps clocks independent across tasks and resets after completion", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender, unmount } = renderHook(
        ({ active, task }) => useThinkingActivity(active, task, "thinking", "text"),
        { initialProps: { active: true, task: "a" } },
      );
      act(() => vi.advanceTimersByTime(10_000));
      rerender({ active: true, task: "b" });
      expect(result.current.elapsed).toBe(0);
      act(() => vi.advanceTimersByTime(5_000));
      rerender({ active: true, task: "a" });
      expect(result.current.elapsed).toBe(15);
      rerender({ active: false, task: "a" });
      rerender({ active: true, task: "a" });
      expect(result.current.elapsed).toBe(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not pull readers back down and copies the complete retained text", async () => {
    const onCopy = vi.fn().mockResolvedValue(true);
    const props = {
      label: "正在思考",
      text: "段落\n".repeat(8000),
      truncated: false,
      activity: { started: 0, elapsed: 4, quiet: false },
      onCopy,
    };
    const { rerender } = render(<AiThinkingFeedback {...props} />);
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开思考过程" }));
    const content = document.querySelector(".ai-thinking-feedback__content") as HTMLDivElement;
    Object.defineProperties(content, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
    });
    content.scrollTop = 100;
    fireEvent.scroll(content);
    rerender(<AiThinkingFeedback {...props} text={`${props.text}更新`} />);
    expect(content.scrollTop).toBe(100);
    expect(content.querySelector("pre")?.textContent?.length).toBe(20_000);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制思考过程" })));
    expect(onCopy).toHaveBeenCalledWith(`${props.text}更新`);
    expect(screen.getByText("已复制思考过程")).toBeTruthy();
  });
});
