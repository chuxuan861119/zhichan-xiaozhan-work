import { randomUUID } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { AiCorrectionBookKind } from "../../../../shared/ai-correction/contract";
import type {
  TextPolishConversationEvent,
  TextPolishEvent,
} from "../../../../shared/ai-correction/text-polish-contract";
import {
  ApplicationCloseProvider,
  useApplicationCloseParticipant,
  useApplicationPersistence,
} from "../../app/application-close-coordinator";
import { createPatentExtensions } from "../../editor/extensions";
import { useTextPolish } from "./use-text-polish";

function editorWith(blockId: string) {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [{ type: "text", text: "该装置能够进行工作。" }],
        },
      ],
    },
  });
}

function editorWithTwoBlocks(firstBlockId: string, secondBlockId: string) {
  return new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: firstBlockId },
          content: [{ type: "text", text: "背景技术" }],
        },
        {
          type: "paragraph",
          attrs: { nodeId: secondBlockId },
          content: [{ type: "text", text: "发明内容" }],
        },
      ],
    },
  });
}

describe("use text polish", () => {
  test("batches reasoning renders, preserves every delta and flushes before terminal events", async () => {
    const patentId = randomUUID(),
      sessionId = randomUUID(),
      conversationId = randomUUID(),
      turnId = randomUUID();
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const snapshot = {
      conversationId,
      patentId,
      sessionId,
      bookKind: "description",
      conversationRevision: 1,
      source: { kind: "generation", requirement: "测试" },
      model: {},
      messages: [],
      latestValidDraft: null,
      summary: null,
      activeTurn: { turnId, clientRequestId: randomUUID(), instruction: "测试", status: "running" },
      lastTurnOutcome: null,
    };
    vi.stubGlobal("patentApi", {
      aiCorrection: {
        startConversation: async () => ({ ok: true, value: { conversationId, turnId, snapshot } }),
        polishWorkspace: async () => ({
          ok: true,
          value: { snapshot: null, draft: { text: "", presets: [] }, history: [] },
        }),
        snapshotConversation: async () => ({ ok: true, value: snapshot }),
        onConversationEvent: (callback: typeof listener) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        onPolishEvent: () => () => {},
      },
    });
    const sessions = [sessionId];
    const prepare = async () => ({ patentId, sessionId, expectedRevision: 1 });
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders++;
      return useTextPolish({
        patentId,
        sessionId,
        openSessionIds: sessions,
        bookKind: "description",
        editor: null,
        prepare,
      });
    });
    await act(async () => result.current.start("测试"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const before = renders;
      for (let index = 0; index < 10; index++) {
        await act(async () =>
          listener?.({
            type: "reasoning",
            conversationId,
            conversationRevision: index + 2,
            turnId,
            delta: String(index),
          }),
        );
      }
      expect(renders).toBe(before);
      await act(async () => vi.advanceTimersByTime(40));
      expect(result.current.reasoning).toBe("0123456789");
      expect(renders - before).toBe(1);
      await act(async () =>
        listener?.({
          type: "reasoning",
          conversationId,
          conversationRevision: 12,
          turnId,
          delta: "末尾",
        }),
      );
      await act(async () =>
        listener?.({
          type: "message",
          conversationId,
          conversationRevision: 13,
          turnId,
          message: {
            role: "assistant",
            messageId: randomUUID(),
            turnId,
            reply: { kind: "answer", message: "完成" },
          },
        }),
      );
      expect(result.current.status).toBe("completed");
      expect(result.current.reasoningByTurn[turnId]?.text).toBe("0123456789末尾");
      await act(async () => vi.advanceTimersByTime(100));
      expect(result.current.reasoning).toBe("");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  test("application close waits for draft acknowledgement and failed saves retain input", async () => {
    const patentId = randomUUID();
    const sessionId = randomUUID();
    let acknowledge!: (result: unknown) => void;
    const pending = new Promise((resolve) => {
      acknowledge = resolve;
    });
    const polishWorkspace = vi.fn(async (request: { action: string }) =>
      request.action === "draft"
        ? pending
        : { ok: true, value: { snapshot: null, draft: { text: "", presets: [] }, history: [] } },
    );
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        application: {},
        aiCorrection: { polishWorkspace },
      },
    });
    const openSessionIds = [sessionId];
    const hook = renderHook(
      () => {
        const polish = useTextPolish({
          patentId,
          sessionId,
          openSessionIds,
          bookKind: "description",
          editor: null,
          prepare: async () => null,
        });
        const persistence = useApplicationPersistence();
        useApplicationCloseParticipant("drafts", polish.flushInputDrafts);
        return { polish, persistence };
      },
      { wrapper: ApplicationCloseProvider },
    );
    await waitFor(() => expect(hook.result.current.polish.historyLoading).toBe(false));
    act(() => hook.result.current.polish.saveInputDraft({ text: "未发送的最新输入", presets: [] }));
    let finished = false;
    const closing = hook.result.current.persistence.flushAll("application-close").then((result) => {
      finished = true;
      return result;
    });
    expect(finished).toBe(false);
    await act(async () => {
      acknowledge({ ok: false, error: { message: "磁盘写入失败" } });
      expect((await closing).ok).toBe(false);
    });
    expect(hook.result.current.polish.inputDraft.text).toBe("未发送的最新输入");
    expect(hook.result.current.polish.storageError).toBe("磁盘写入失败");
    await act(async () => hook.result.current.polish.manageHistory("stop", randomUUID()));
    expect(polishWorkspace).toHaveBeenCalledWith(expect.objectContaining({ action: "stop" }));
    expect(hook.result.current.polish.inputDraft.text).toBe("未发送的最新输入");
    polishWorkspace.mockResolvedValue({ ok: true, value: {} });
    await act(async () =>
      expect((await hook.result.current.persistence.flushAll("application-close")).ok).toBe(true),
    );
    hook.unmount();
  });
  test("a failed draft in another patent does not block current patent operations", async () => {
    const a = { patentId: randomUUID(), sessionId: randomUUID() };
    const b = { patentId: randomUUID(), sessionId: randomUUID() };
    const openSessionIds = [a.sessionId, b.sessionId];
    const polishWorkspace = vi.fn(async (request: { action: string; patentId: string }) =>
      request.action === "draft" && request.patentId === a.patentId
        ? { ok: false, error: { message: "A 写入失败" } }
        : { ok: true, value: { snapshot: null, draft: { text: "", presets: [] }, history: [] } },
    );
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { aiCorrection: { polishWorkspace } },
    });
    const hook = renderHook(
      (props) =>
        useTextPolish({
          ...props,
          openSessionIds,
          bookKind: "description",
          editor: null,
          prepare: async () => null,
        }),
      { initialProps: a },
    );
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    act(() => hook.result.current.saveInputDraft({ text: "A 草稿", presets: [] }));
    await act(async () =>
      expect(await hook.result.current.flushPatentDrafts(a.patentId)).toBe(false),
    );
    hook.rerender(b);
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    act(() => hook.result.current.saveInputDraft({ text: "B 草稿", presets: [] }));
    await act(async () =>
      expect(await hook.result.current.flushPatentDrafts(b.patentId)).toBe(true),
    );
    await act(async () => hook.result.current.manageHistory("rename", randomUUID(), "新名称"));
    expect(polishWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rename", patentId: b.patentId }),
    );
    await act(async () => expect(await hook.result.current.flushInputDrafts()).toBe(false));
    hook.unmount();
  });
  test("metadata transactions do not republish the selection", () => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { aiCorrection: {} },
    });
    const editor = editorWith(randomUUID());
    const openSessionIds: string[] = [];
    let renders = 0;
    const view = renderHook(() => {
      renders++;
      return useTextPolish({
        patentId: null,
        sessionId: null,
        bookKind: "description",
        editor,
        openSessionIds,
        prepare: async () => null,
      });
    });
    const initial = renders;
    for (let i = 0; i < 10; i++)
      act(() => editor.view.dispatch(editor.state.tr.setMeta("position", i)));
    expect(renders).toBe(initial);
    act(() => editor.commands.setTextSelection({ from: 1, to: 4 }));
    expect(view.result.current.selection.status).toBe("ready");
    view.unmount();
    editor.destroy();
  });
  test("tracks live selection, streams a task, and restores its result after book switches", async () => {
    let listener: ((event: TextPolishEvent) => void) | undefined;
    const polish = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    const selectedTextHash = "b".repeat(64);
    const hashText = vi.fn(async () => ({ ok: true as const, value: selectedTextHash }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          hashText,
          polish,
          cancelPolish: vi.fn(),
          onPolishEvent: (next: typeof listener) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const blockId = randomUUID();
    const editor = editorWith(blockId);
    const props: {
      patentId: string;
      sessionId: string;
      bookKind: AiCorrectionBookKind;
      editor: Editor;
    } = { patentId, sessionId, bookKind: "description", editor };
    const { result, rerender } = renderHook(
      (current) =>
        useTextPolish({
          ...current,
          openSessionIds: [sessionId],
          prepare: async () => ({ patentId, sessionId, expectedRevision: 2 }),
        }),
      { initialProps: props },
    );

    expect(result.current.selection.status).toBe("empty");
    act(() => editor.commands.setTextSelection({ from: 4, to: 10 }));
    await waitFor(() => expect(result.current.selection.status).toBe("ready"));
    await act(async () => result.current.start("更加简洁"));
    const request = polish.mock.calls[0]?.[0];
    if (!request) throw new Error("missing request");
    expect(request).toMatchObject({
      patentId,
      sessionId,
      requirement: "更加简洁",
      scope: {
        bookKind: "description",
        blocks: [{ blockId, blockType: "paragraph", startOffset: 3, endOffset: 9 }],
        selectedTextHash,
      },
    });
    expect(hashText).toHaveBeenCalledWith("能够进行工作");

    act(() => listener?.({ type: "phase", jobId: request.jobId, phase: "thinking" }));
    act(() => listener?.({ type: "reasoning", jobId: request.jobId, delta: "正在优化语序" }));
    await waitFor(() => expect(result.current.reasoning).toBe("正在优化语序"));
    act(() =>
      listener?.({
        type: "polish-completed",
        jobId: request.jobId,
        result: {
          anchor: {
            bookKind: "description",
            blocks: [{ blockId, blockType: "paragraph", startOffset: 3, endOffset: 9 }],
            originalText: "能够进行工作",
            originalTextHash: "a".repeat(64),
          },
          polishedText: "可正常工作",
        },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("completed"));

    const claimsEditor = editorWith(randomUUID());
    rerender({ ...props, bookKind: "claims", editor: claimsEditor });
    expect(result.current.status).toBe("completed");
    rerender(props);
    expect(result.current.status).toBe("completed");
    const completedResult = result.current.result;
    expect(
      completedResult && "polishedText" in completedResult ? completedResult.polishedText : null,
    ).toBe("可正常工作");
    claimsEditor.destroy();
    editor.destroy();
  });

  test("stops only the active document polish task", async () => {
    const cancelPolish = vi.fn(async () => ({ ok: true as const, value: undefined }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          hashText: async () => ({ ok: true as const, value: "d".repeat(64) }),
          polish: vi.fn(async (request: { jobId: string }) => ({
            ok: true as const,
            value: { jobId: request.jobId },
          })),
          cancelPolish,
          onPolishEvent: () => () => undefined,
        },
      },
    });
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const editor = editorWith(randomUUID());
    editor.commands.setTextSelection({ from: 4, to: 10 });
    const { result } = renderHook(() =>
      useTextPolish({
        patentId,
        sessionId,
        openSessionIds: [sessionId],
        bookKind: "description",
        editor,
        prepare: async () => ({ patentId, sessionId, expectedRevision: 1 }),
      }),
    );
    await act(async () => result.current.start(""));
    await act(async () => result.current.cancel());
    expect(cancelPolish).toHaveBeenCalledWith({ jobId: expect.any(String) });
    editor.destroy();
  });

  test("starts a requirement-only generation without hashing or reading an empty selection", async () => {
    const polish = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    const hashText = vi.fn();
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          hashText,
          polish,
          cancelPolish: vi.fn(),
          onPolishEvent: () => () => undefined,
        },
      },
    });
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const editor = editorWith(randomUUID());
    const { result } = renderHook(() =>
      useTextPolish({
        patentId,
        sessionId,
        openSessionIds: [sessionId],
        bookKind: "description",
        editor,
        prepare: async () => ({ patentId, sessionId, expectedRevision: 1 }),
      }),
    );

    await act(async () => result.current.start("起草一段技术背景。"));

    expect(hashText).not.toHaveBeenCalled();
    expect(polish).toHaveBeenCalledWith(
      expect.objectContaining({
        requirement: "起草一段技术背景。",
        scope: { kind: "generation", bookKind: "description" },
      }),
    );
    editor.destroy();
  });

  test("renders the selected line boxes behind the editor while the polish panel takes focus", async () => {
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const editor = editorWith(randomUUID());
    editor.commands.setTextSelection({ from: 4, to: 10 });
    const host = editor.view.dom.parentElement;
    if (!host) throw new Error("missing editor host");
    document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 200,
      top: 200,
      left: 100,
      right: 700,
      bottom: 1100,
      width: 600,
      height: 900,
      toJSON: () => ({}),
    });
    Object.defineProperty(host, "offsetWidth", { configurable: true, value: 600 });
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        {
          x: 120,
          y: 240,
          top: 240,
          left: 120,
          right: 220,
          bottom: 260,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        },
      ],
    });
    const requirementInput = document.createElement("textarea");
    document.body.append(requirementInput);
    requirementInput.focus();
    const { rerender } = renderHook(
      ({ keepSelectionHighlight }) =>
        useTextPolish({
          patentId,
          sessionId,
          openSessionIds: [sessionId],
          bookKind: "description",
          editor,
          keepSelectionHighlight,
          prepare: async () => ({ patentId, sessionId, expectedRevision: 1 }),
        }),
      { initialProps: { keepSelectionHighlight: true } },
    );

    const selectionRect = await waitFor(() => {
      const current = host.querySelector<HTMLElement>(".editor-selection-overlay__rect");
      expect(current).not.toBeNull();
      return current;
    });
    const layer = host.querySelector<HTMLElement>('.editor-selection-overlay[data-tone="active"]');
    expect(selectionRect).toMatchObject({
      style: expect.objectContaining({ left: "20px", top: "40px", width: "100px" }),
    });
    expect(editor.view.dom.querySelector(".text-polish-selection-highlight")).toBeNull();
    expect(document.activeElement).toBe(requirementInput);
    expect(layer?.hidden).toBe(false);
    act(() => editor.commands.focus());
    await waitFor(() => expect(layer?.hidden).toBe(true));
    requirementInput.focus();
    await waitFor(() => expect(layer?.hidden).toBe(false));
    rerender({ keepSelectionHighlight: false });
    await waitFor(() => expect(host.querySelector(".editor-selection-overlay")).toBeNull());
    requirementInput.remove();
    host.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
    editor.destroy();
  });

  test("does not paint block element boxes when a polish selection crosses paragraphs", async () => {
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const editor = editorWithTwoBlocks(randomUUID(), randomUUID());
    editor.commands.setTextSelection({ from: 1, to: 11 });
    const host = editor.view.dom.parentElement;
    if (!host) throw new Error("missing editor host");
    document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 200,
      top: 200,
      left: 100,
      right: 700,
      bottom: 1100,
      width: 600,
      height: 900,
      toJSON: () => ({}),
    });
    Object.defineProperty(host, "offsetWidth", { configurable: true, value: 600 });
    const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const textOnly =
          this.startContainer === this.endContainer &&
          this.startContainer.nodeType === Node.TEXT_NODE;
        if (textOnly) {
          const secondLine = this.startContainer.textContent === "发明内容";
          return [
            {
              x: 120,
              y: secondLine ? 280 : 240,
              top: secondLine ? 280 : 240,
              left: 120,
              right: 220,
              bottom: secondLine ? 300 : 260,
              width: 100,
              height: 20,
              toJSON: () => ({}),
            },
          ];
        }
        return [
          {
            x: 110,
            y: 230,
            top: 230,
            left: 110,
            right: 610,
            bottom: 310,
            width: 500,
            height: 80,
            toJSON: () => ({}),
          },
          {
            x: 120,
            y: 240,
            top: 240,
            left: 120,
            right: 220,
            bottom: 260,
            width: 100,
            height: 20,
            toJSON: () => ({}),
          },
          {
            x: 120,
            y: 280,
            top: 280,
            left: 120,
            right: 220,
            bottom: 300,
            width: 100,
            height: 20,
            toJSON: () => ({}),
          },
        ];
      },
    });
    const requirementInput = document.createElement("textarea");
    document.body.append(requirementInput);
    requirementInput.focus();

    const { unmount } = renderHook(() =>
      useTextPolish({
        patentId,
        sessionId,
        openSessionIds: [sessionId],
        bookKind: "description",
        editor,
        keepSelectionHighlight: true,
        prepare: async () => ({ patentId, sessionId, expectedRevision: 1 }),
      }),
    );

    await waitFor(() => {
      const widths = [...host.querySelectorAll<HTMLElement>(".editor-selection-overlay__rect")].map(
        (element) => element.style.width,
      );
      expect(widths).toEqual(["100px", "100px"]);
    });

    unmount();
    requirementInput.remove();
    host.remove();
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
    editor.destroy();
  });

  test("uses the continuous conversation API when it is available", async () => {
    let conversationListener:
      | ((event: { type: string; conversationId: string; [key: string]: unknown }) => void)
      | undefined;
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const patentId = randomUUID();
    const sessionId = randomUUID();
    let currentSnapshot: Record<string, unknown> | null = null;
    let resolveSnapshot:
      | ((value: { ok: true; value: Record<string, unknown> }) => void)
      | undefined;
    const snapshotConversation = vi.fn(async () => {
      if (currentSnapshot) return { ok: true as const, value: currentSnapshot as never };
      return await new Promise<{ ok: true; value: never }>((resolve) => {
        resolveSnapshot = resolve as never;
      });
    });
    const startConversation = vi.fn(async () => ({
      ok: true as const,
      value: {
        conversationId,
        turnId,
        snapshot: {
          conversationId,
          patentId,
          sessionId,
          bookKind: "description",
          conversationRevision: 1,
          source: { kind: "generation", requirement: "初始" },
          model: {},
          messages: [],
          latestValidDraft: null,
          summary: null,
          activeTurn: {
            turnId,
            clientRequestId: randomUUID(),
            instruction: "初始",
            status: "running",
          },
          lastTurnOutcome: null,
        } as never,
      },
    }));
    const sendConversation = vi.fn(async () => ({
      ok: true as const,
      value: {
        snapshot: {
          conversationId,
          patentId,
          sessionId,
          bookKind: "description",
          conversationRevision: 3,
          source: { kind: "generation", requirement: "初始" },
          model: {},
          messages: [],
          latestValidDraft: null,
          summary: null,
          activeTurn: null,
          lastTurnOutcome: { status: "completed", turnId },
        } as never,
      },
    }));
    const editor = editorWith(randomUUID());
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          hashText: vi.fn(),
          startConversation,
          sendConversation,
          resetConversation: vi.fn(async () => ({ ok: true, value: undefined })),
          cancelConversation: vi.fn(),
          snapshotConversation,
          onConversationEvent: (listener: typeof conversationListener) => {
            conversationListener = listener;
            return () => undefined;
          },
          polish: vi.fn(),
          cancelPolish: vi.fn(),
          onPolishEvent: () => () => undefined,
        },
      },
    });
    const { result } = renderHook(() =>
      useTextPolish({
        patentId,
        sessionId,
        openSessionIds: [],
        bookKind: "description",
        editor,
        prepare: async () => ({ patentId, sessionId, expectedRevision: 3 }),
      }),
    );
    await act(async () => result.current.start("初始要求"));
    expect(startConversation).toHaveBeenCalledOnce();
    expect((startConversation.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      expectedPatentRevision: 3,
      instruction: "初始要求",
    });
    currentSnapshot = {
      conversationId,
      patentId,
      sessionId,
      bookKind: "description",
      conversationRevision: 1,
      source: { kind: "generation", requirement: "初始" },
      model: {},
      messages: [],
      latestValidDraft: null,
      summary: null,
      activeTurn: {
        turnId,
        clientRequestId: randomUUID(),
        instruction: "初始",
        status: "running",
      },
      lastTurnOutcome: null,
    };
    resolveSnapshot?.({ ok: true, value: currentSnapshot });
    await act(async () =>
      conversationListener?.({
        type: "reasoning",
        conversationId,
        conversationRevision: 2,
        turnId,
        delta: "分析".repeat(10_001),
      }),
    );
    await waitFor(() => expect(result.current.reasoningTruncated).toBe(true));
    await act(async () =>
      conversationListener?.({
        type: "message",
        conversationId,
        conversationRevision: 3,
        message: {
          role: "assistant",
          messageId: randomUUID(),
          turnId,
          reply: { kind: "answer", message: "可以继续调整。" },
        },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.reasoning).toBe("");
    expect(result.current.reasoningTruncated).toBe(false);
    expect(result.current.reasoningByTurn[turnId]).toEqual({
      text: "分析".repeat(10_000),
      truncated: true,
    });
    await act(async () => expect(await result.current.send("请改得更正式")).toBe(true));
    expect(result.current.reasoningByTurn[turnId]?.text).toBe("分析".repeat(10_000));
    expect(sendConversation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "new", instruction: "请改得更正式" }),
    );
    snapshotConversation.mockClear();
    currentSnapshot = null;
    await act(async () => {
      conversationListener?.({
        type: "phase",
        conversationId,
        conversationRevision: 10,
        turnId,
        phase: "thinking",
      });
      conversationListener?.({
        type: "phase",
        conversationId,
        conversationRevision: 10,
        turnId,
        phase: "thinking",
      });
    });
    expect(snapshotConversation).toHaveBeenCalledTimes(1);
    const failedSnapshot = {
      conversationId,
      patentId,
      sessionId,
      bookKind: "description",
      conversationRevision: 10,
      source: { kind: "generation", requirement: "初始" },
      model: {},
      messages: [],
      latestValidDraft: null,
      summary: null,
      activeTurn: null,
      lastTurnOutcome: {
        status: "failed",
        turnId,
        message: "服务暂不可用",
        retryable: true,
      },
    };
    resolveSnapshot?.({ ok: true, value: failedSnapshot });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toBe("服务暂不可用");
    expect(result.current.canRetry).toBe(true);
    await act(async () => result.current.reset());
    expect(result.current.reasoningByTurn).toEqual({});
    editor.destroy();
  });

  test("recovers a completed reply that arrives while a gap snapshot is still loading", async () => {
    let conversationListener: ((event: TextPolishConversationEvent) => void) | undefined;
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const userMessage = {
      role: "user" as const,
      messageId: randomUUID(),
      turnId,
      text: "请润色",
    };
    const assistantMessage = {
      role: "assistant" as const,
      messageId: randomUUID(),
      turnId,
      reply: {
        kind: "revision" as const,
        message: "已完成润色",
        revisedText: "润色完成后的结果",
      },
    };
    const snapshot = (revision: number, completed = false) =>
      ({
        conversationId,
        patentId,
        sessionId,
        bookKind: "description" as const,
        conversationRevision: revision,
        source: { kind: "generation" as const, requirement: "请润色" },
        model: {},
        messages: completed ? [userMessage, assistantMessage] : [userMessage],
        latestValidDraft: completed ? assistantMessage.reply.revisedText : null,
        summary: null,
        activeTurn: completed
          ? null
          : {
              turnId,
              clientRequestId: randomUUID(),
              instruction: "请润色",
              status: "running" as const,
            },
        lastTurnOutcome: completed ? { status: "completed" as const, turnId } : null,
      }) as never;
    let resolveGapSnapshot: ((value: { ok: true; value: never }) => void) | undefined;
    const snapshotConversation = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: snapshot(1) })
      .mockImplementationOnce(
        async () =>
          await new Promise<{ ok: true; value: never }>((resolve) => {
            resolveGapSnapshot = resolve;
          }),
      )
      .mockResolvedValue({ ok: true as const, value: snapshot(4, true) });
    const editor = editorWith(randomUUID());
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          hashText: vi.fn(),
          startConversation: vi.fn(async () => ({
            ok: true as const,
            value: { conversationId, turnId, snapshot: snapshot(1) },
          })),
          sendConversation: vi.fn(),
          cancelConversation: vi.fn(),
          snapshotConversation,
          onConversationEvent: (listener: typeof conversationListener) => {
            conversationListener = listener;
            return () => undefined;
          },
          polish: vi.fn(),
          cancelPolish: vi.fn(),
          onPolishEvent: () => () => undefined,
        },
      },
    });
    const { result } = renderHook(() =>
      useTextPolish({
        patentId,
        sessionId,
        openSessionIds: [sessionId],
        bookKind: "description",
        editor,
        prepare: async () => ({ patentId, sessionId, expectedRevision: 3 }),
      }),
    );

    await act(async () => result.current.start("请润色"));
    await waitFor(() => expect(snapshotConversation).toHaveBeenCalledTimes(1));
    act(() =>
      conversationListener?.({
        type: "phase",
        conversationId,
        conversationRevision: 3,
        turnId,
        phase: "thinking",
      }),
    );
    await waitFor(() => expect(snapshotConversation).toHaveBeenCalledTimes(2));
    act(() =>
      conversationListener?.({
        type: "message",
        conversationId,
        conversationRevision: 4,
        message: assistantMessage,
      }),
    );
    resolveGapSnapshot?.({ ok: true, value: snapshot(3) });

    await waitFor(() =>
      expect(
        result.current.messages.find((message) => message.role === "assistant")?.reply,
      ).toMatchObject({ kind: "revision", revisedText: "润色完成后的结果" }),
    );
    expect(result.current.status).toBe("completed");
    expect(snapshotConversation).toHaveBeenCalledTimes(3);
    editor.destroy();
  });
});
