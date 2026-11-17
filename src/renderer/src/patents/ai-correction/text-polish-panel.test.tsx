import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import * as appDialogs from "../../shared/app-dialog";
import { TextPolishPanel } from "./text-polish-panel";

const common = {
  open: true,
  status: "idle" as const,
  selection: { status: "empty" as const },
  result: null,
  onStart: vi.fn(),
  onCancel: vi.fn(),
  onClose: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe("text polish panel", () => {
  test("continuation includes newer requirements after the existing summary", () => {
    render(
      <TextPolishPanel
        {...common}
        conversationId="current"
        onManageHistory={async () => {}}
        source={{ kind: "generation", requirement: "用方案一" }}
        messages={[
          { role: "user", messageId: "old", turnId: "old-turn", text: "用方案一" },
          { role: "user", messageId: "new", turnId: "new-turn", text: "改用方案二，保留铜材质" },
        ]}
        summary={{
          summaryId: "summary",
          coveredThroughMessageId: "old",
          items: [
            {
              kind: "requirement",
              text: "用方案一",
              sourceMessageIds: ["old"],
              evidenceQuotes: ["方案一"],
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText("对话容量与参考材料"));
    fireEvent.click(screen.getByRole("button", { name: "携带约定开启新对话" }));
    const text = (screen.getByRole("textbox", { name: "衔接约定" }) as HTMLTextAreaElement).value;
    expect(text).toContain("用方案一");
    expect(text).toContain("改用方案二，保留铜材质");
    expect(text.indexOf("方案一")).toBeLessThan(text.indexOf("方案二"));
  });
  test("reviews continuation before creating a new chat without sending automatically", async () => {
    const onManageHistory = vi.fn(async () => {});
    const onSend = vi.fn();
    render(
      <TextPolishPanel
        {...common}
        conversationId="current"
        onManageHistory={onManageHistory}
        onSend={onSend}
        source={{ kind: "generation", requirement: "保留部件名称" }}
        latestValidDraft="最新完整稿"
      />,
    );
    fireEvent.click(screen.getByText("对话容量与参考材料"));
    fireEvent.click(screen.getByRole("button", { name: "携带约定开启新对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "衔接约定" }), {
      target: { value: "只保留确认的术语" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并新建" }));
    await waitFor(() =>
      expect(onManageHistory).toHaveBeenCalledWith("continue-new", "current", "只保留确认的术语"),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  test("adds new selected material only when explicitly requested and keeps existing instructions", () => {
    render(
      <TextPolishPanel
        {...common}
        conversationId="current"
        selection={{
          status: "ready",
          text: "新增技术材料",
          characterCount: 6,
          scope: { kind: "selection", bookKind: "description", blocks: [] },
        }}
      />,
    );
    const input = screen.getByRole("textbox", { name: "继续对话" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "原来的要求" } });
    expect(input.value).not.toContain("新增技术材料");
    fireEvent.click(screen.getByText("参考文字（可选）"));
    fireEvent.click(screen.getByRole("button", { name: "添加选中文字" }));
    expect(input.value).toBe("原来的要求");
    expect(
      (screen.getByRole("textbox", { name: "本轮参考文字" }) as HTMLTextAreaElement).value,
    ).toBe("新增技术材料");
    fireEvent.click(screen.getByRole("button", { name: "移除参考文字" }));
    expect(
      (screen.getByRole("textbox", { name: "本轮参考文字" }) as HTMLTextAreaElement).value,
    ).toBe("");
  });
  test("sends long reference separately and preserves it when sending fails", async () => {
    const onSend = vi.fn(async () => false);
    render(<TextPolishPanel {...common} conversationId="reference" onSend={onSend} />);
    fireEvent.click(screen.getByText("参考文字（可选）"));
    const reference = screen.getByRole("textbox", { name: "本轮参考文字" }) as HTMLTextAreaElement;
    fireEvent.change(reference, { target: { value: "材".repeat(20000) } });
    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "根据材料解释" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("根据材料解释", "材".repeat(20000)));
    expect(reference.value).toHaveLength(20000);
    fireEvent.change(reference, { target: { value: "材".repeat(20001) } });
    expect(reference.value).toHaveLength(20000);
    expect(screen.getByRole("alert").textContent).toContain("20000");
  });
  test("shows the current summary batch and a carried draft before the first send", () => {
    const { rerender } = render(
      <TextPolishPanel {...common} conversationId="carried" latestValidDraft="携带稿" />,
    );
    expect(screen.getByText("已携带约定和最新稿 · 尚未发送")).toBeTruthy();
    rerender(
      <TextPolishPanel
        {...common}
        conversationId="carried"
        status="running"
        phase="summarizing"
        summaryBatch={3}
      />,
    );
    expect(screen.getByText(/第 3 批/)).toBeTruthy();
  });
  test.each([false, true])(
    "clears only the accepted conversation draft after switching (edited: %s)",
    async (edited) => {
      let resolve!: (value: boolean) => void;
      const onSend = vi.fn(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );
      const changeA = vi.fn();
      const changeB = vi.fn();
      const propsA = {
        ...common,
        conversationId: "a",
        inputDraft: { text: "A 的问题", presets: [] },
        onInputDraftChange: changeA,
        onSend,
      };
      const { rerender } = render(<TextPolishPanel {...propsA} />);
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      if (edited)
        rerender(<TextPolishPanel {...propsA} inputDraft={{ text: "A 新草稿", presets: [] }} />);
      rerender(
        <TextPolishPanel
          {...common}
          conversationId="b"
          inputDraft={{ text: edited ? "A 的问题" : "B 的草稿", presets: [] }}
          onInputDraftChange={changeB}
          onSend={onSend}
        />,
      );
      // Flush the acknowledgement while B is visible; its contents cannot govern A's draft.
      await act(async () => resolve(true));
      expect(onSend).toHaveBeenCalledOnce();
      if (edited) expect(changeA).not.toHaveBeenCalled();
      else expect(changeA).toHaveBeenCalledWith({ text: "", presets: [] });
      expect(changeB).not.toHaveBeenCalled();
    },
  );
  test("allows new and historical conversations while another reply is running", async () => {
    const onReset = vi.fn(async () => {});
    const onOpenHistory = vi.fn(async () => {});
    render(
      <TextPolishPanel
        {...common}
        status="running"
        conversationId="running"
        onReset={onReset}
        onOpenHistory={onOpenHistory}
        history={[
          { conversationId: "other", title: "另一个对话", updatedAt: "2026-09-13T00:00:00Z" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(await screen.findByRole("button", { name: /另一个对话/ }));
    await waitFor(() => expect(onOpenHistory).toHaveBeenCalledWith("other"));
    expect(common.onCancel).not.toHaveBeenCalled();
  });
  test("keeps a pending history read and its error inside its own patent", async () => {
    let reject!: (error: Error) => void;
    const onRefreshHistory = () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    const props = {
      ...common,
      onReset: vi.fn(async () => {}),
      onOpenHistory: vi.fn(async () => {}),
      onRefreshHistory,
    };
    const { rerender } = render(<TextPolishPanel {...props} documentKey="patent-a" />);
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    rerender(<TextPolishPanel {...props} documentKey="patent-b" />);
    expect((screen.getByRole("button", { name: "新对话" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    reject(new Error("A 的历史读取失败"));
    await waitFor(() => expect(screen.queryByText("A 的历史读取失败")).toBeNull());
    rerender(<TextPolishPanel {...props} documentKey="patent-a" />);
    expect(await screen.findByText("A 的历史读取失败")).toBeTruthy();
  });
  test("requires confirmation of a changed model and never auto-sends the draft", async () => {
    const model = {
      profileId: "old",
      providerId: "deepseek",
      displayName: "旧配置",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    };
    const target = {
      ...model,
      profileId: "new",
      displayName: "新配置",
      model: "deepseek-reasoner",
    };
    const onChangeModel = vi.fn(async () => {});
    const onSend = vi.fn(async () => true);
    render(
      <TextPolishPanel
        {...common}
        conversationId="conversation"
        model={model}
        configuredModel={target}
        inputDraft={{ text: "继续完善", presets: [] }}
        onChangeModel={onChangeModel}
        onSend={onSend}
      />,
    );
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认使用新配置继续" }));
    await waitFor(() => expect(onChangeModel).toHaveBeenCalledWith(target));
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "继续对话" }) as HTMLTextAreaElement).value).toBe(
      "继续完善",
    );
  });
  test("offers explicit recovery for a corrupt history row", async () => {
    const onRecoverHistory = vi.fn(async () => {});
    render(
      <TextPolishPanel
        {...common}
        onOpenHistory={vi.fn(async () => {})}
        history={[
          { conversationId: "bad", title: "无法读取的历史对话", updatedAt: "", error: "损坏" },
        ]}
        onRecoverHistory={onRecoverHistory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(await screen.findByRole("button", { name: "保留异常文件并隔离此对话" }));
    await waitFor(() => expect(onRecoverHistory).toHaveBeenCalledWith("bad"));
  });
  test("matches the preview welcome and keeps starter prompts editable without sending", () => {
    const onStart = vi.fn();
    render(<TextPolishPanel {...common} onStart={onStart} />);
    expect(screen.getByRole("heading", { name: /从一个想法/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "整理背景技术" }));
    expect((screen.getByRole("textbox", { name: "生成需求" }) as HTMLTextAreaElement).value).toBe(
      "请帮我整理背景技术",
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "精简一段表述" })).toBeNull();
    const abstractStarter = screen.getByRole("button", { name: "生成说明书摘要" });
    expect(
      Array.from(abstractStarter.parentElement?.querySelectorAll("button") ?? []).map(
        (button) => button.textContent,
      ),
    ).toEqual(["整理背景技术", "解释技术内容", "生成说明书摘要"]);
    fireEvent.click(abstractStarter);
    expect((screen.getByRole("textbox", { name: "生成需求" }) as HTMLTextAreaElement).value).toBe(
      "请帮我整理背景技术\n请帮我生成说明书摘要",
    );
    expect(onStart).not.toHaveBeenCalled();
    const presets = screen.getByText("常用需求", { selector: "summary" }).closest("details");
    expect(presets?.open).toBe(false);
  });
  test("uses a trailing chevron for common requirements without the keyboard hint", () => {
    render(<TextPolishPanel {...common} conversationId="minimal" onSend={vi.fn()} />);
    expect(screen.queryByText("Enter 发送 · Shift+Enter 换行")).toBeNull();
    const disclosure = screen.getByText("常用需求", { selector: "summary" });
    expect(disclosure.querySelector("svg")).not.toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure.closest("details")?.open).toBe(true);
  });
  test("uses accessible symbol actions in the minimal conversation layout", () => {
    const { rerender } = render(
      <TextPolishPanel {...common} conversationId="minimal" onSend={vi.fn()} />,
    );
    const send = screen.getByRole("button", { name: "发送" });
    expect(send.textContent).toBe("");
    expect(send.querySelector("svg")).not.toBeNull();
    rerender(<TextPolishPanel {...common} conversationId="minimal" status="running" />);
    const stop = screen.getByRole("button", { name: "停止本轮" });
    expect(stop.textContent).toBe("");
    expect(stop.querySelector("svg")).not.toBeNull();
  });
  test("offers expansion and history without discarding the supplied input draft", async () => {
    const onInputDraftChange = vi.fn();
    const onOpenHistory = vi.fn(async () => {});
    render(
      <TextPolishPanel
        {...common}
        inputDraft={{ text: "恢复的需求", presets: [] }}
        onInputDraftChange={onInputDraftChange}
        history={[
          { conversationId: "old", title: "旧对话需求", updatedAt: "2026-09-07T00:00:00Z" },
        ]}
        onOpenHistory={onOpenHistory}
      />,
    );
    expect((screen.getByRole("textbox", { name: "生成需求" }) as HTMLTextAreaElement).value).toBe(
      "恢复的需求",
    );
    fireEvent.click(screen.getByRole("button", { name: "展开小栈AI助手面板" }));
    expect(
      screen.getByRole("complementary", { name: "小栈AI助手" }).classList.contains("is-expanded"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    fireEvent.click(await screen.findByRole("button", { name: /旧对话需求/ }));
    expect(onOpenHistory).toHaveBeenCalledWith("old");
  });
  test("keeps completed reasoning collapsed beside its reply across later turns", () => {
    const props = {
      ...common,
      conversationId: "conversation",
      messages: [
        {
          role: "assistant" as const,
          messageId: "reply",
          turnId: "turn",
          reply: { kind: "answer" as const, message: "回复正文" },
        },
      ],
      reasoningByTurn: { turn: { text: "保留的思考文字", truncated: false } },
    };
    const { rerender } = render(<TextPolishPanel {...props} status="completed" />);
    const details = screen.getByText("思考过程").closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("思考过程"));
    expect(details?.open).toBe(true);
    expect(screen.getByText("保留的思考文字").tagName).toBe("PRE");
    rerender(<TextPolishPanel {...props} status="running" reasoning="下一轮思考" />);
    expect(screen.getByText("保留的思考文字")).toBeTruthy();
  });
  test("prompts for a valid selection, applies a common requirement, and handles model setup", () => {
    const onOpenSettings = vi.fn();
    const onStart = vi.fn();
    const { rerender } = render(
      <TextPolishPanel
        {...common}
        modelConfigured={false}
        onOpenSettings={onOpenSettings}
        onStart={onStart}
      />,
    );

    expect(screen.getByText("未选中文字")).toBeTruthy();
    expect(screen.getByText("选择文字：")).toBeTruthy();
    expect(screen.getByText("未选中文字").classList.contains("polish-selection-status")).toBe(true);
    expect(screen.getByText("尚未配置模型")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "开始生成" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <TextPolishPanel
        {...common}
        modelConfigured
        selection={{
          status: "ready",
          text: "需要润色",
          characterCount: 4,
          scope: { bookKind: "description", blocks: [], selectedText: "需要润色" } as never,
        }}
        onStart={onStart}
      />,
    );
    expect(screen.getByRole("button", { name: "预览选中文字" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "预览选中文字" }).textContent).toBe(
      "说明书 · 已选中 4 字",
    );
    expect(screen.getByText("选择文字：")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "常用润色需求" })).toBeNull();
    fireEvent.click(screen.getByText("常用需求", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "专业严谨" }));
    expect((screen.getByRole("textbox", { name: "润色需求" }) as HTMLTextAreaElement).value).toBe(
      "专业严谨",
    );
    fireEvent.click(screen.getByRole("button", { name: "开始润色" }));
    expect(onStart).toHaveBeenCalledWith("专业严谨");
  });

  test("initial input uses Enter to send and Shift Enter to retain a newline", () => {
    const onStart = vi.fn();
    render(<TextPolishPanel {...common} onStart={onStart} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "请解释结构" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("请解释结构");
  });

  test("damaged history is visible but does not disable starting a new dialogue", () => {
    render(
      <TextPolishPanel
        {...common}
        history={[
          {
            conversationId: "damaged",
            title: "无法读取的历史对话",
            updatedAt: "",
            error: "原文件已保留",
          },
        ]}
        onOpenHistory={async () => undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("部分历史对话无法读取");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "起草背景技术" } });
    expect((screen.getByRole("button", { name: "开始生成" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("persists preset text and clears legacy hidden selections", () => {
    const onInputDraftChange = vi.fn();
    render(
      <TextPolishPanel
        {...common}
        inputDraft={{ text: "旧需求", presets: ["专业严谨"] }}
        onInputDraftChange={onInputDraftChange}
      />,
    );
    fireEvent.click(screen.getByText("常用需求", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "生成背景技术" }));
    expect(onInputDraftChange).toHaveBeenCalledWith({
      text: "旧需求\n表达更加专业、严谨，符合专利文书风格。\n生成背景技术",
      presets: [],
    });
  });

  test("reuses the thinking stream and only offers icon copy actions on completion", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <TextPolishPanel
        {...common}
        status="running"
        phase="thinking"
        reasoning="正在比较措辞"
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("region", { name: "正在思考" })).toBeTruthy();
    expect(screen.queryByText("正在比较措辞")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开思考过程" }));
    expect(screen.getByText("正在比较措辞").tagName).toBe("PRE");
    fireEvent.click(screen.getByRole("button", { name: "停止思考" }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <TextPolishPanel
        {...common}
        status="completed"
        result={{
          anchor: {
            bookKind: "description",
            blocks: [
              {
                blockId: "00000000-0000-4000-8000-000000000901",
                blockType: "paragraph",
                startOffset: 0,
                endOffset: 4,
              },
            ],
            originalText: "需要润色",
            originalTextHash: "a".repeat(64),
          },
          polishedText: "需要优化表述",
        }}
        error="复制失败，请重试。"
      />,
    );
    expect(screen.getByText("需要优化表述")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "替换原文" })).toBeNull();
    const copy = screen.getByRole("button", { name: "复制润色稿" });
    expect(copy.textContent).toBe("");
    expect(copy.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("复制失败");
  });

  test("uses a required generation request without selection and only offers copying generated text", () => {
    const onStart = vi.fn();
    const onCopy = vi.fn(() => true);
    const { rerender } = render(
      <TextPolishPanel {...common} modelConfigured onStart={onStart} onCopyText={onCopy} />,
    );

    expect(screen.getByText("未选中文字")).toBeTruthy();
    const action = screen.getByRole("button", { name: "开始生成" }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "生成需求" }), {
      target: { value: "起草一段技术背景。" },
    });
    expect((screen.getByRole("button", { name: "开始生成" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(onStart).toHaveBeenCalledWith("起草一段技术背景。");

    rerender(
      <TextPolishPanel
        {...common}
        status="completed"
        result={{ kind: "generated", generatedText: "现有技术中，电池冷却仍存在不足。" }}
        onCopyText={onCopy}
      />,
    );
    expect(screen.getByText("生成结果")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制文案" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "替换原文" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制文案" }));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  test("keeps a conversation transcript and copies drafts without replacement", async () => {
    const onSend = vi.fn(async () => true);
    const onCopyText = vi.fn(async () => true);
    render(
      <TextPolishPanel
        {...common}
        status="completed"
        conversationId="00000000-0000-4000-8000-000000000999"
        source={{
          kind: "selection",
          anchor: {
            bookKind: "description",
            blocks: [
              {
                blockId: "00000000-0000-4000-8000-000000001010",
                blockType: "paragraph",
                startOffset: 0,
                endOffset: 4,
              },
            ],
            originalText: "需要润色",
            originalTextHash: "a".repeat(64),
          },
        }}
        messages={[
          {
            role: "user",
            messageId: "00000000-0000-4000-8000-000000001001",
            turnId: "00000000-0000-4000-8000-000000001002",
            text: "请再精简一些",
          },
          {
            role: "assistant",
            messageId: "00000000-0000-4000-8000-000000001003",
            turnId: "00000000-0000-4000-8000-000000001002",
            reply: { kind: "revision", message: "已完成精简", revisedText: "精简后的句子" },
          },
        ]}
        onSend={onSend}
        onCopyText={onCopyText}
      />,
    );
    expect(screen.getByText("请再精简一些")).toBeTruthy();
    expect(screen.getByText("精简后的句子")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "请改成更正式的表达" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("请改成更正式的表达");
    await waitFor(() => expect(screen.queryByRole("button", { name: "替换原文" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(onCopyText).toHaveBeenCalledWith("精简后的句子");
    const copy = screen.getByRole("button", { name: "复制" });
    expect(copy.textContent).toBe("");
    expect(copy.getAttribute("title")).toBe("复制");
    fireEvent.click(screen.getByRole("button", { name: "查看完整润色稿" }));
    expect(screen.queryByRole("button", { name: "替换原文" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制润色稿" }));
    expect(onCopyText).toHaveBeenCalledWith("精简后的句子");
  });

  test("keeps the source compact and places live reasoning inside the scrollable transcript", () => {
    render(
      <TextPolishPanel
        {...common}
        status="running"
        phase="thinking"
        conversationId="00000000-0000-4000-8000-000000000999"
        source={{
          kind: "selection",
          anchor: {
            bookKind: "description",
            blocks: [
              {
                blockId: "00000000-0000-4000-8000-000000001010",
                blockType: "paragraph",
                startOffset: 0,
                endOffset: 12,
              },
            ],
            originalText: "这是一段很长的首次选中文字",
            originalTextHash: "a".repeat(64),
          },
        }}
        reasoning={`第一段需要逐句核对技术术语和上下文关系。\n\n第二段继续检查语序、指代和专利文书表达。`}
      />,
    );

    const stream = screen.getByRole("region", { name: "正在思考" });
    expect(stream.classList.contains("ai-thinking-feedback")).toBe(true);
    expect(screen.getByRole("log", { name: "连续对话记录" }).contains(stream)).toBe(true);
    expect(stream.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开思考过程" }));
    expect(stream.querySelector("pre")?.textContent).toContain("第二段继续检查");
    expect(screen.queryByText("这是一段很长的首次选中文字")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    expect(screen.getByText("这是一段很长的首次选中文字")).toBeTruthy();
  });

  test("resumes transcript following when a later turn starts so live thinking stays visible", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000999";
    const firstTurnId = "00000000-0000-4000-8000-000000001002";
    const secondTurnId = "00000000-0000-4000-8000-000000001012";
    const firstMessages = [
      {
        role: "user" as const,
        messageId: "00000000-0000-4000-8000-000000001001",
        turnId: firstTurnId,
        text: "请先精简",
      },
      {
        role: "assistant" as const,
        messageId: "00000000-0000-4000-8000-000000001003",
        turnId: firstTurnId,
        reply: { kind: "answer" as const, message: "第一轮已经完成。" },
      },
    ];
    const onSend = vi.fn(async () => true);
    const { rerender } = render(
      <TextPolishPanel
        {...common}
        status="completed"
        conversationId={conversationId}
        messages={firstMessages}
        onSend={onSend}
      />,
    );
    const transcript = screen.getByRole("log", { name: "连续对话记录" });
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    fireEvent.change(screen.getByRole("textbox", { name: "继续对话" }), {
      target: { value: "请继续统一术语" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    scrollTo.mockClear();

    rerender(
      <TextPolishPanel
        {...common}
        status="running"
        phase="thinking"
        conversationId={conversationId}
        messages={[
          ...firstMessages,
          {
            role: "user",
            messageId: "00000000-0000-4000-8000-000000001011",
            turnId: secondTurnId,
            text: "请继续统一术语",
          },
        ]}
        onSend={onSend}
      />,
    );

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: transcript.scrollHeight, behavior: "auto" }),
    );
    expect(screen.getByRole("region", { name: "正在思考" })).toBeTruthy();
  });

  test("preserves a rejected instruction and only offers retry when main marks it retryable", async () => {
    const onSend = vi.fn(async () => false);
    const { rerender } = render(
      <TextPolishPanel
        {...common}
        status="completed"
        conversationId="00000000-0000-4000-8000-000000000999"
        messages={[]}
        model={{
          profileId: "00000000-0000-4000-8000-000000000901",
          providerId: "custom",
          displayName: "固定模型",
          baseUrl: "https://provider.example/v1",
          model: "model-a",
        }}
        source={{
          kind: "generation",
          requirement: "起草技术背景",
        }}
        onSend={onSend}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "继续对话" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "请保留这条失败后的要求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(composer.value).toBe("请保留这条失败后的要求");
    expect(screen.queryByRole("button", { name: "重试本轮" })).toBeNull();
    expect(screen.getByText("本对话固定使用：固定模型")).toBeTruthy();
    expect(screen.getByText("生成主题 · 起草技术背景")).toBeTruthy();

    rerender(
      <TextPolishPanel
        {...common}
        status="failed"
        conversationId="00000000-0000-4000-8000-000000000999"
        messages={[]}
        canRetry
        onSend={onSend}
        onRetry={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole("button", { name: "重试本轮" })).toBeTruthy();
  });

  test("explains a stopped turn and lets the user retry it", () => {
    const onRetry = vi.fn(async () => true);
    render(
      <TextPolishPanel
        {...common}
        status="cancelled"
        conversationId="00000000-0000-4000-8000-000000000999"
        messages={[
          {
            role: "user",
            messageId: "00000000-0000-4000-8000-000000001011",
            turnId: "00000000-0000-4000-8000-000000001012",
            text: "这一轮已经停止",
          },
        ]}
        canRetry
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("本轮已停止");
    fireEvent.click(screen.getByRole("button", { name: "重试本轮" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("supports chips, Enter sending, Shift+Enter and confirmed new conversations", async () => {
    const onSend = vi.fn(async () => true);
    const onReset = vi.fn(async () => undefined);
    const confirm = vi.spyOn(appDialogs, "confirmAppAction").mockResolvedValue(true);
    render(
      <TextPolishPanel
        {...common}
        status="completed"
        conversationId="00000000-0000-4000-8000-000000000999"
        messages={[]}
        onSend={onSend}
        onReset={onReset}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "继续对话" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "保留术语" } });
    fireEvent.click(screen.getByText("常用需求", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "专业严谨" }));
    expect(composer.value).toBe("保留术语\n专业严谨");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith("保留术语\n专业严谨");
    await waitFor(() => expect(composer.value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(confirm).not.toHaveBeenCalled();
  });

  test("reports copy status next to the selected assistant message", async () => {
    const onCopyText = vi.fn(async () => true);
    render(
      <TextPolishPanel
        {...common}
        status="completed"
        conversationId="00000000-0000-4000-8000-000000000999"
        messages={[
          {
            role: "assistant",
            messageId: "00000000-0000-4000-8000-000000001003",
            turnId: "00000000-0000-4000-8000-000000001002",
            reply: { kind: "answer", message: "这是解释内容" },
          },
        ]}
        onCopyText={onCopyText}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy());
  });
});

test("mixed revision hides transport markers and exposes a guarded apply action", () => {
  const originalText = '〔片段1 正文〕比较高〔只读1.2 公式 "Q=P/R"〕';
  const revisedText = originalText.replace("比较高", "较高");
  const anchor = {
    bookKind: "description" as const,
    formatVersion: 2 as const,
    blocks: [
      {
        blockId: "00000000-0000-4000-8000-000000000001",
        blockType: "paragraph" as const,
        startOffset: 0,
        endOffset: 4,
      },
    ],
    originalText,
    originalTextHash: "a".repeat(64),
  };
  const onApplyResult = vi.fn();
  render(
    <TextPolishPanel
      {...common}
      status="completed"
      conversationId="mixed"
      source={{ kind: "selection", anchor }}
      messages={[
        {
          role: "assistant",
          messageId: "m",
          turnId: "t",
          reply: { kind: "revision", message: "已修改", revisedText },
        },
      ]}
      onApplyResult={onApplyResult}
    />,
  );
  expect(screen.getByText("较高Q=P/R")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "采纳文字修改" }));
  expect(onApplyResult).toHaveBeenCalledWith({ anchor, polishedText: revisedText });
});
