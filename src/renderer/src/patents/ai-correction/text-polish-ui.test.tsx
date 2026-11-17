import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TextPolishPanel } from "./text-polish-panel";

const anchor = {
  bookKind: "description" as const,
  blocks: [{ blockId: "block", blockType: "paragraph" as const, startOffset: 0, endOffset: 4 }],
  originalText: "需要润色",
  originalTextHash: "a".repeat(64),
};
const common = {
  open: true,
  status: "idle" as const,
  selection: {
    status: "ready" as const,
    text: anchor.originalText,
    characterCount: 4,
    scope: {
      kind: "selection" as const,
      bookKind: "description" as const,
      blocks: anchor.blocks,
      selectedText: anchor.originalText,
    },
  },
  result: null,
  onStart: vi.fn(),
  onCancel: vi.fn(),
  onClose: vi.fn(),
  onOpenSettings: vi.fn(),
};
const messages = [
  {
    role: "assistant" as const,
    messageId: "reply",
    turnId: "turn",
    reply: { kind: "revision" as const, message: "已优化", revisedText: "优化后的内容" },
  },
];

test("clears copied feedback when a later copy fails and supports retry", async () => {
  const onCopyText = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  render(
    <TextPolishPanel
      {...common}
      conversationId="copy"
      status="completed"
      messages={messages}
      onCopyText={onCopyText}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "已复制" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("复制失败"));
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy());
  expect(screen.queryByRole("alert")).toBeNull();
});

test("appends presets without losing existing requirements or duplicating them", () => {
  const onStart = vi.fn();
  render(<TextPolishPanel {...common} onStart={onStart} />);
  const input = screen.getByRole("textbox", { name: "润色需求" });
  fireEvent.change(input, { target: { value: "保留部件名称" } });
  fireEvent.click(screen.getByText("常用需求", { selector: "summary" }));
  const chip = screen.getByRole("button", { name: "专业严谨" });
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-pressed")).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe("保留部件名称\n专业严谨");
  fireEvent.click(chip);
  expect((input as HTMLTextAreaElement).value).toBe("保留部件名称\n专业严谨");
  fireEvent.click(screen.getByRole("button", { name: "开始润色" }));
  expect(onStart).toHaveBeenCalledWith("保留部件名称\n专业严谨");
});

test("rejects overlong input visibly without truncating or replacing the previous draft", () => {
  render(<TextPolishPanel {...common} />);
  const input = screen.getByRole("textbox", { name: "润色需求" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "保留原要求" } });
  expect(input.hasAttribute("maxlength")).toBe(false);
  fireEvent.change(input, { target: { value: "字".repeat(2001) } });
  expect(input.value).toBe("保留原要求");
  expect(screen.getByRole("alert").textContent).toContain("未写入");
});

test("shows selection status and previews selected paragraphs before sending", () => {
  render(<TextPolishPanel {...common} />);
  expect(screen.getByText("选择文字：")).toBeTruthy();
  expect(screen.getByText("说明书 · 已选中 4 字")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "预览选中文字" }));
  expect(screen.getByText("需要润色")).toBeTruthy();
});

test("keeps stop outside the reading region and allows drafting but not sending while thinking", () => {
  render(
    <TextPolishPanel
      {...common}
      conversationId="a"
      status="running"
      phase="thinking"
      reasoning="分析内容"
      messages={messages}
    />,
  );
  const footer = screen.getByRole("group", { name: "对话操作" });
  expect(within(footer).getByRole("button", { name: "停止本轮" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "继续对话" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "下一轮问题" } });
  expect(input.value).toBe("下一轮问题");
  expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  expect(screen.getByRole("log").contains(footer)).toBe(false);
});

test("offers a full draft reader and returns to the transcript", () => {
  render(
    <TextPolishPanel
      {...common}
      conversationId="a"
      status="completed"
      source={{ kind: "selection", anchor }}
      messages={messages}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看完整润色稿" }));
  expect(screen.getByRole("region", { name: "完整文本" }).textContent).toContain("优化后的内容");
  fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
  expect(screen.getByRole("region", { name: "完整文本" }).textContent).toContain("需要润色");
  fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
  expect(screen.getByRole("log")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "继续对话" })).toBeTruthy();
  expect(screen.queryByText("Enter 发送 · Shift+Enter 换行")).toBeNull();
});

test("restores each conversation's transcript scroll position", () => {
  const { rerender } = render(
    <TextPolishPanel {...common} conversationId="a" status="completed" messages={messages} />,
  );
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 300 },
  });
  log.scrollTop = 360;
  fireEvent.scroll(log);
  rerender(<TextPolishPanel {...common} conversationId="b" status="completed" messages={[]} />);
  log.scrollTop = 0;
  fireEvent.scroll(log);
  rerender(
    <TextPolishPanel {...common} conversationId="a" status="completed" messages={messages} />,
  );
  expect(screen.getByRole("log").scrollTop).toBe(360);
});

test("rejects overlong combined requirements without truncating handwritten text", () => {
  const onStart = vi.fn();
  render(
    <TextPolishPanel
      {...common}
      onStart={onStart}
      inputDraft={{ text: "字".repeat(1995), presets: ["专业严谨"] }}
    />,
  );
  const input = screen.getByRole("textbox", { name: "润色需求" }) as HTMLTextAreaElement;
  expect(screen.getByRole("alert").textContent).toContain("超过 2000");
  expect((screen.getByRole("button", { name: "开始润色" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(input.value).toHaveLength(1995);
  expect(onStart).not.toHaveBeenCalled();
});

test("does not report a new reply just because the same snapshot is refreshed", () => {
  const { rerender } = render(
    <TextPolishPanel {...common} conversationId="a" status="completed" messages={messages} />,
  );
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 300 },
  });
  log.scrollTop = 140;
  fireEvent.scroll(log);
  rerender(
    <TextPolishPanel {...common} conversationId="a" status="completed" messages={[...messages]} />,
  );
  expect(screen.queryByRole("button", { name: "有新回复" })).toBeNull();
});

test("starts a newly arrived long answer at its heading", () => {
  const { rerender } = render(
    <TextPolishPanel {...common} conversationId="a" status="running" messages={[]} />,
  );
  const log = screen.getByRole("log");
  const scrollTo = vi.fn();
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 2000 },
    scrollTo: { value: scrollTo },
  });
  rerender(
    <TextPolishPanel {...common} conversationId="a" status="completed" messages={messages} />,
  );
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
});

test("lets generated conversations read their complete requirement", () => {
  render(
    <TextPolishPanel
      {...common}
      conversationId="a"
      status="completed"
      source={{ kind: "generation", requirement: "长需求".repeat(300) }}
      messages={messages}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看需求" }));
  expect(screen.getByRole("region", { name: "完整文本" }).textContent).toContain(
    "长需求".repeat(300),
  );
});

test("places model setup before the input so the blocked action has a visible reason", () => {
  render(<TextPolishPanel {...common} modelConfigured={false} />);
  const setup = screen.getByText("尚未配置模型");
  const input = screen.getByRole("textbox", { name: "润色需求" });
  expect(setup.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
