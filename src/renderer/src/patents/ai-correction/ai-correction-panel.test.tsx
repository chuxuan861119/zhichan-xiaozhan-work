import { randomUUID } from "node:crypto";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AiCorrectionIssue } from "../../../../shared/ai-correction/contract";
import { AiCorrectionPanel } from "./ai-correction-panel";

const issue: AiCorrectionIssue = {
  issueId: randomUUID(),
  category: "terminology",
  risk: "high",
  applicability: "analysis-only",
  anchor: {
    bookKind: "description",
    blockId: randomUUID(),
    startOffset: 0,
    endOffset: 2,
    originalText: "装置",
    originalTextHash: "0".repeat(64),
  },
  replacement: null,
  explanation: "需要人工确认是否影响保护范围。",
};

const complianceIssue: AiCorrectionIssue = {
  issueId: randomUUID(),
  category: "compliance",
  risk: "medium",
  applicability: "analysis-only",
  anchor: {
    bookKind: "abstract",
    blockId: randomUUID(),
    startOffset: 0,
    endOffset: 4,
    originalText: "效果极佳",
    originalTextHash: "1".repeat(64),
  },
  replacement: null,
  explanation: "宣传性表述。该定位仅表示相关位置，不是替换目标。",
};

describe("AI correction panel", () => {
  test("restoring ignored suggestions affects only the current document task", () => {
    const first = { ...issue, issueId: randomUUID() };
    const second = { ...issue, issueId: randomUUID() };
    const props = { ...callbacks, open: true, status: "completed" as const };
    const { rerender } = render(
      <AiCorrectionPanel {...props} taskKey="patent:description" issues={[first]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    rerender(<AiCorrectionPanel {...props} taskKey="patent:claims" issues={[second]} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    rerender(<AiCorrectionPanel {...props} taskKey="patent:description" issues={[first]} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复已忽略建议" }));
    expect(screen.getByRole("button", { name: "忽略" })).toBeTruthy();
    rerender(<AiCorrectionPanel {...props} taskKey="patent:claims" issues={[second]} />);
    expect(screen.queryByRole("button", { name: "忽略" })).toBeNull();
    expect(screen.getByRole("button", { name: "恢复已忽略建议" })).toBeTruthy();
  });
  const callbacks = {
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onLocate: vi.fn(),
    onAccept: vi.fn(),
    onBatchAccept: vi.fn(),
  };
  test("shows batch counts as text while thinking without a progress bar", () => {
    const props = { ...callbacks, open: true, status: "running" as const, issues: [] };
    const { rerender } = render(
      <AiCorrectionPanel {...props} progress={{ completed: 0, total: 5 }} />,
    );
    expect(screen.getByText(/已检查 0\/5 批/)).toBeTruthy();
    rerender(<AiCorrectionPanel {...props} progress={{ completed: 2, total: 5 }} />);
    expect(screen.getByText(/已检查 2\/5 批/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<AiCorrectionPanel {...props} progress={{ completed: 0, total: 1 }} />);
    expect(screen.queryByText(/已检查/)).toBeNull();
  });
  test("numbers all result cards and removes only the correction kicker", () => {
    const replaceable: AiCorrectionIssue = {
      ...issue,
      issueId: "replaceable",
      risk: "low",
      applicability: "replace",
      replacement: "设备",
    };
    render(
      <AiCorrectionPanel {...callbacks} open status="completed" issues={[issue, replaceable]} />,
    );
    expect(screen.queryByText("智能辅助")).toBeNull();
    const notice = screen.getByRole("button", { name: "AI 纠错实验功能说明" });
    expect(notice.textContent).toBe("实验功能");
    fireEvent.mouseEnter(notice);
    expect(screen.getByRole("dialog", { name: "AI 纠错实验功能说明" }).textContent).toContain(
      "DeepSeek 官方接口",
    );
    fireEvent.mouseLeave(notice, { relatedTarget: document.body });
    expect(screen.queryByRole("dialog", { name: "AI 纠错实验功能说明" })).toBeNull();
    fireEvent.click(notice);
    fireEvent.mouseLeave(notice, { relatedTarget: document.body });
    expect(screen.getByRole("dialog", { name: "AI 纠错实验功能说明" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "AI 纠错实验功能说明" })).toBeNull();
    const cards = screen.getAllByRole("article");
    expect(
      screen.getByRole("article", { name: "第 1 项" }).querySelector(".ai-issue-number")
        ?.textContent,
    ).toBe("1");
    expect(
      screen.getByRole("article", { name: "第 2 项" }).querySelector(".ai-issue-number")
        ?.textContent,
    ).toBe("2");
    expect(cards[0]?.querySelector("blockquote.ai-issue-anchor-text")).toBeTruthy();
    expect(cards[1]?.querySelector("del")?.textContent).toBe("装置");
    expect(cards[1]?.querySelector("ins")?.textContent).toBe("设备");
  });
  test("shows the bounded retry status and keeps stop available", () => {
    const onCancel = vi.fn();
    render(
      <AiCorrectionPanel
        {...callbacks}
        open
        status="running"
        issues={[]}
        phase="retrying"
        reasoning="先前分析"
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("未收到正式答案，正在重试（1/1）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止思考" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  test("keeps completed reasoning collapsed and allows reopening it", () => {
    render(
      <AiCorrectionPanel {...callbacks} open status="completed" issues={[]} reasoning="核对记录" />,
    );
    const toggle = screen.getByRole("button", { name: "展开思考过程" });
    expect(screen.queryByText("核对记录")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("核对记录")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制思考过程" })).toBeTruthy();
  });

  test("uses named icon actions and keeps bulk controls outside the scrolling result list", () => {
    const replaceable: AiCorrectionIssue = {
      ...issue,
      issueId: "replaceable",
      risk: "low",
      applicability: "replace",
      replacement: "设备",
    };
    const onLocate = vi.fn();
    const onAccept = vi.fn();
    const onBatchAccept = vi.fn();
    render(
      <AiCorrectionPanel
        {...callbacks}
        open
        status="completed"
        issues={[replaceable, issue]}
        onLocate={onLocate}
        onAccept={onAccept}
        onBatchAccept={onBatchAccept}
      />,
    );
    const list = screen.getByRole("region", { name: "纠错建议" });
    const card = within(list).getAllByRole("article")[0];
    if (!card) throw new Error("Expected a replaceable suggestion card");
    for (const name of ["定位", "忽略", "接受"]) {
      const button = within(card).getByRole("button", { name });
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toBeTruthy();
      expect(button.getAttribute("title")).toBeTruthy();
    }
    fireEvent.click(within(card).getByRole("button", { name: "定位" }));
    expect(onLocate).toHaveBeenCalledWith(replaceable);
    fireEvent.click(within(card).getByRole("button", { name: "接受" }));
    expect(onAccept).toHaveBeenCalledWith(replaceable);
    fireEvent.click(within(card).getByRole("checkbox"));
    const batchButton = screen.getByRole("button", { name: "接受所选" });
    expect(list.contains(batchButton)).toBe(false);
    fireEvent.click(batchButton);
    expect(onBatchAccept).toHaveBeenCalledWith([replaceable]);
    const reviewCard = within(list).getAllByRole("article")[1];
    if (!reviewCard) throw new Error("Expected an analysis-only suggestion card");
    expect(reviewCard.querySelector("del")).toBeNull();
    expect(within(reviewCard).queryByRole("button", { name: "接受" })).toBeNull();
  });

  test("keeps connection feedback inside the thinking surface and disables a pending stop", () => {
    const { rerender } = render(
      <AiCorrectionPanel {...callbacks} open status="starting" phase="connecting" issues={[]} />,
    );
    const stream = screen.getByRole("region", { name: "正在连接 AI 服务" });
    expect(stream.querySelector("pre")).toBeNull();
    expect(screen.getByRole("button", { name: "展开思考过程" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(
      <AiCorrectionPanel
        {...callbacks}
        open
        status="stopping"
        phase="thinking"
        reasoning="正在核对"
        issues={[]}
      />,
    );
    expect((screen.getByRole("button", { name: "正在停止…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("shows a restrained empty state without presenting invalid or partial results as clean", () => {
    const { rerender } = render(
      <AiCorrectionPanel {...callbacks} open status="completed" issues={[]} />,
    );
    expect(screen.getByText("AI 结果供参考，仍建议人工复核。")).toBeTruthy();
    expect(document.querySelector(".ai-correction-empty-state svg")).toBeTruthy();
    rerender(
      <AiCorrectionPanel
        {...callbacks}
        open
        status="cancelled"
        issues={[]}
        progress={{ completed: 1, total: 3 }}
      />,
    );
    expect(screen.getByText(/剩余|其余内容尚未完成检查/u)).toBeTruthy();
    expect(screen.queryByText("当前范围未发现可报告的问题。")).toBeNull();
    rerender(
      <AiCorrectionPanel
        {...callbacks}
        open
        status="completed"
        issues={[]}
        discardedIssueCount={2}
      />,
    );
    expect(screen.getByText("没有可安全显示的建议，请缩小范围或重新检查。")).toBeTruthy();
  });

  test("does not activate the selection card when no editor selection exists", () => {
    const onStart = vi.fn();
    render(
      <AiCorrectionPanel
        open
        status="idle"
        issues={[]}
        selectionAvailable={false}
        onStart={onStart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("选中文字", { exact: true }));
    fireEvent.click(screen.getByText("请先在正文中选择文字"));
    const radio = screen.getByRole("radio", { name: /选中文字/ }) as HTMLInputElement;
    fireEvent.click(radio.closest("label") as HTMLLabelElement);
    expect(radio.checked).toBe(false);
    expect(radio.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "开始思考" }));
    expect(onStart).toHaveBeenCalledWith("current-book");
  });
  test("prompts users without a configured model and opens model settings", () => {
    const onOpenSettings = vi.fn();
    const onStart = vi.fn();
    render(
      <AiCorrectionPanel
        open
        status="idle"
        issues={[]}
        modelConfigured={false}
        onStart={onStart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={onOpenSettings}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );

    expect(screen.getByText("模型或密钥尚未就绪")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    const startButton = screen.getByRole("button", { name: "开始思考" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.click(startButton);
    expect(onStart).not.toHaveBeenCalled();
  });

  test("starts the current document without a separate upload confirmation", () => {
    const onStart = vi.fn();
    const { rerender } = render(
      <AiCorrectionPanel
        open
        status="idle"
        issues={[]}
        onStart={onStart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );
    expect(screen.getByText("当前文档")).toBeTruthy();
    expect(screen.queryByText("发送前确认")).toBeNull();
    expect(screen.queryByLabelText(/我确认将上述正文/u)).toBeNull();
    expect((screen.getByRole("button", { name: "开始思考" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始思考" }));
    expect(onStart).toHaveBeenCalledWith("current-book");

    rerender(
      <AiCorrectionPanel
        open
        status="completed"
        issues={[issue]}
        onStart={onStart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );
    expect(screen.getByText("需要人工确认是否影响保护范围。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
  });

  test("does not expose the removed full-patent scope or result switch", () => {
    const onStart = vi.fn();
    const onRestart = vi.fn();
    const { rerender } = render(
      <AiCorrectionPanel
        open
        status="idle"
        issues={[]}
        onStart={onStart}
        onRestart={onRestart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );

    expect(screen.queryByLabelText("整件专利")).toBeNull();
    rerender(
      <AiCorrectionPanel
        open
        status="completed"
        issues={[]}
        onStart={onStart}
        onRestart={onRestart}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={() => undefined}
        onAccept={() => undefined}
        onBatchAccept={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "当前文档结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全文结果" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  test("keeps thinking mode fixed and renders streamed analysis as plain text", () => {
    const onCancel = vi.fn();
    const common = {
      open: true,
      issues: [],
      onStart: () => undefined,
      onCancel,
      onClose: () => undefined,
      onOpenSettings: () => undefined,
      onLocate: () => undefined,
      onAccept: () => undefined,
      onBatchAccept: () => undefined,
    } as const;
    const { rerender } = render(<AiCorrectionPanel {...common} status="idle" />);

    expect(screen.queryByRole("switch", { name: "深度思考" })).toBeNull();
    expect(screen.queryByText(/单个分块最长等待/u)).toBeNull();

    rerender(
      <AiCorrectionPanel {...common} status="running" phase="thinking" reasoning="<b>原文</b>" />,
    );
    expect(screen.getByText("正在思考")).toBeTruthy();
    expect(screen.queryByText("AI 正在思考")).toBeNull();
    expect(screen.queryByText("模型中间分析")).toBeNull();
    expect(screen.queryByText("仅供参考，不代表最终纠错结论")).toBeNull();
    expect(screen.queryByText("正在准备安全上下文…")).toBeNull();
    expect(document.querySelector(".ai-progress")).toBeNull();
    const thinkingStream = screen.getByRole("region", { name: "正在思考" });
    expect(screen.queryByText("<b>原文</b>")).toBeNull();
    expect(
      thinkingStream.closest(".ai-correction-running")?.classList.contains("is-thinking"),
    ).toBe(true);
    const streamHeader = screen.getByRole("button", { name: "展开思考过程" });
    expect(thinkingStream.querySelectorAll(".ai-running-mark--inline span")).toHaveLength(3);
    fireEvent.click(streamHeader);
    const streamedText = screen.getByText("<b>原文</b>");
    expect(streamedText.tagName).toBe("PRE");
    expect(streamedText.querySelector("b")).toBeNull();
    fireEvent.click(streamHeader);
    const closing = screen.getByText("<b>原文</b>").closest(".spatial-collapse");
    expect(closing?.getAttribute("data-motion")).toBe("exit");
    expect(closing?.getAttribute("aria-hidden")).toBe("true");
    expect(closing?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "停止思考" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("shows elapsed time and honest silence feedback without blocking stop", () => {
    vi.useFakeTimers();
    try {
      const { rerender, unmount } = render(
        <AiCorrectionPanel
          {...callbacks}
          open
          status="running"
          phase="thinking"
          issues={[]}
          reasoning="开头"
        />,
      );
      act(() => vi.advanceTimersByTime(46_000));
      expect(screen.getByText("已等待 46 秒")).toBeTruthy();
      expect(screen.getByText("暂未收到新内容，仍在等待响应。")).toBeTruthy();
      rerender(
        <AiCorrectionPanel
          {...callbacks}
          open
          status="running"
          phase="thinking"
          issues={[]}
          reasoning="开头新内容"
        />,
      );
      expect(screen.queryByText("暂未收到新内容，仍在等待响应。")).toBeNull();
      expect(screen.getByText("已等待 46 秒")).toBeTruthy();
      expect(screen.getByRole("button", { name: "停止思考" })).toBeTruthy();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  test("temporarily hides without unmounting", () => {
    const common = {
      open: true,
      status: "idle" as const,
      issues: [],
      onStart: () => undefined,
      onCancel: () => undefined,
      onClose: () => undefined,
      onOpenSettings: () => undefined,
      onLocate: () => undefined,
      onAccept: () => undefined,
      onBatchAccept: () => undefined,
    };
    const { rerender } = render(<AiCorrectionPanel {...common} hidden={false} />);

    rerender(<AiCorrectionPanel {...common} hidden />);
    const hiddenPanel = document.querySelector(".ai-correction-panel") as HTMLElement | null;
    expect(hiddenPanel?.hidden).toBe(true);

    rerender(<AiCorrectionPanel {...common} hidden={false} />);
    expect(screen.getByText("当前文档")).toBeTruthy();
  });

  test("shows compliance findings as locatable analysis without replacement controls", () => {
    const onLocate = vi.fn();
    const onAccept = vi.fn();
    render(
      <AiCorrectionPanel
        open
        status="completed"
        issues={[complianceIssue]}
        resultLimitReached
        discardedIssueCount={2}
        onStart={() => undefined}
        onCancel={() => undefined}
        onClose={() => undefined}
        onOpenSettings={() => undefined}
        onLocate={onLocate}
        onAccept={onAccept}
        onBatchAccept={() => undefined}
      />,
    );

    expect(screen.getByText("规范")).toBeTruthy();
    expect(screen.getByText("本次结果已达到单个分块上限，可能仍有未报告的问题。")).toBeTruthy();
    expect(screen.getByText("另有 2 项模型结果因格式或定位无效而未显示。")).toBeTruthy();
    expect(screen.queryByText("当前范围未发现可报告的问题。")).toBeNull();
    expect(screen.getByText("效果极佳").tagName).not.toBe("DEL");
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "定位" }));
    expect(onLocate).toHaveBeenCalledWith(complianceIssue);
    expect(onAccept).not.toHaveBeenCalled();
  });
  test("shows content consistency as locatable analysis without accepting it", () => {
    const finding: AiCorrectionIssue = { ...issue, category: "consistency" };
    render(<AiCorrectionPanel {...callbacks} open status="completed" issues={[finding]} />);
    expect(screen.getByText("内容一致性")).toBeTruthy();
    expect(screen.getByRole("button", { name: "定位" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
  });
});
