import { randomUUID } from "node:crypto";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import type {
  TextPolishConversationEvent,
  TextPolishConversationSnapshot,
} from "../../../../shared/ai-correction/text-polish-contract";
import { createPatentExtensions } from "../../editor/extensions";
import { TextPolishPanel } from "./text-polish-panel";
import { useTextPolish } from "./use-text-polish";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const patentId = randomUUID(),
    sessionId = randomUUID(),
    conversationId = randomUUID(),
    turnId = randomUUID();
  const snapshot: TextPolishConversationSnapshot = {
    patentId,
    sessionId,
    conversationId,
    bookKind: "description",
    conversationRevision: 1,
    source: { kind: "generation", requirement: "起草" },
    model: {} as never,
    messages: [
      {
        role: "assistant",
        turnId,
        messageId: randomUUID(),
        reply: { kind: "revision", message: "完成", revisedText: "第一版" },
      },
    ],
    activeTurn: null,
    lastTurnOutcome: { status: "completed", turnId },
    latestValidDraft: "第一版",
    summary: null,
  };
  let listener!: (event: TextPolishConversationEvent) => void;
  const api = {
    onPolishEvent: () => () => undefined,
    onConversationEvent: (fn: typeof listener) => {
      listener = fn;
      return () => undefined;
    },
    startConversation: vi.fn(async () => ({
      ok: true as const,
      value: { conversationId, turnId, snapshot },
    })),
    snapshotConversation: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    sendConversation: vi.fn(async () => ({ ok: true as const, value: { snapshot } })),
    cancelConversation: vi.fn(async () => ({ ok: false as const, error: { message: "停止失败" } })),
    resetConversation: vi.fn(async () => ({ ok: false as const, error: { message: "重置失败" } })),
  };
  Object.defineProperty(window, "patentApi", { configurable: true, value: { aiCorrection: api } });
  const editor = new Editor({ extensions: createPatentExtensions(), content: "<p>测试</p>" });
  const props = {
    patentId,
    sessionId,
    openSessionIds: [sessionId],
    bookKind: "description" as const,
    editor,
    prepare: async () => ({ patentId, sessionId, expectedRevision: 1 }),
  };
  return {
    api,
    props,
    snapshot,
    emit: (event: TextPolishConversationEvent) => listener(event),
    editor,
  };
}

test.each(["prepare", "acknowledgement"] as const)(
  "does not revive a closed patent during start %s",
  async (stage) => {
    const f = fixture();
    Object.assign(f.api, { cancelPolish: vi.fn(async () => ({ ok: true })) });
    const saved = deferred<Awaited<ReturnType<typeof f.props.prepare>>>();
    const accepted = deferred<Awaited<ReturnType<typeof f.api.startConversation>>>();
    const props: Parameters<typeof useTextPolish>[0] = {
      ...f.props,
      prepare: stage === "prepare" ? () => saved.promise : f.props.prepare,
    };
    if (stage === "acknowledgement")
      f.api.startConversation.mockImplementation(() => accepted.promise);
    const hook = renderHook((input: Parameters<typeof useTextPolish>[0]) => useTextPolish(input), {
      initialProps: props,
    });
    let starting!: Promise<void>;
    act(() => {
      starting = hook.result.current.start("起草背景技术");
    });
    if (stage === "acknowledgement")
      await waitFor(() => expect(f.api.startConversation).toHaveBeenCalledOnce());
    hook.rerender({ ...props, patentId: null, sessionId: null, openSessionIds: [] });
    const newSession = randomUUID();
    hook.rerender({ ...props, sessionId: newSession, openSessionIds: [newSession] });
    await act(async () => {
      if (stage === "prepare") saved.resolve(await f.props.prepare());
      else
        accepted.resolve({
          ok: true,
          value: {
            conversationId: f.snapshot.conversationId as ReturnType<typeof randomUUID>,
            turnId: randomUUID(),
            snapshot: f.snapshot,
          },
        });
      await starting;
    });
    expect(hook.result.current.conversationId).toBeNull();
    expect(hook.result.current.status).toBe("idle");
    if (stage === "prepare") expect(f.api.startConversation).not.toHaveBeenCalled();
    hook.unmount();
    f.editor.destroy();
  },
);

test("ignores an old history response after closing and reopening the patent", async () => {
  const f = fixture();
  const oldOpen = deferred<unknown>();
  const reopened = deferred<unknown>();
  const freshSession = randomUUID();
  const workspace = vi.fn(async (request: { action: string; sessionId: string }) => {
    if (request.action === "open") return oldOpen.promise;
    if (request.sessionId === freshSession) return reopened.promise;
    return {
      ok: true,
      value: { snapshot: f.snapshot, draft: { text: "旧草稿", presets: [] }, history: [] },
    };
  });
  Object.assign(f.api, { polishWorkspace: workspace });
  const hook = renderHook((props: Parameters<typeof useTextPolish>[0]) => useTextPolish(props), {
    initialProps: f.props as Parameters<typeof useTextPolish>[0],
  });
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  let opening!: Promise<void>;
  act(() => {
    opening = hook.result.current.openHistory(f.snapshot.conversationId);
  });
  hook.rerender({ ...f.props, patentId: null, sessionId: null, openSessionIds: [] });
  hook.rerender({ ...f.props, sessionId: freshSession, openSessionIds: [freshSession] });
  await act(async () => {
    oldOpen.resolve({
      ok: true,
      value: { snapshot: f.snapshot, draft: { text: "旧草稿", presets: [] }, history: [] },
    });
    await opening;
  });
  expect(hook.result.current.conversationId).toBeNull();
  expect(hook.result.current.inputDraft.text).not.toBe("旧草稿");
  await act(async () => {
    reopened.resolve({
      ok: true,
      value: { snapshot: null, draft: { text: "新会话草稿", presets: [] }, history: [] },
    });
  });
  expect(hook.result.current.inputDraft.text).toBe("新会话草稿");
  hook.unmount();
  f.editor.destroy();
});

test("switches running conversations without mixing drafts, events or fixed sources", async () => {
  const f = fixture();
  const first = {
    ...f.snapshot,
    activeTurn: {
      turnId: randomUUID(),
      clientRequestId: randomUUID(),
      instruction: "任务 A",
      status: "running" as const,
    },
    lastTurnOutcome: null,
  };
  const second = {
    ...first,
    conversationId: randomUUID(),
    source: { kind: "generation" as const, requirement: "任务 B" },
    messages: [],
    activeTurn: { ...first.activeTurn, turnId: randomUUID() },
  };
  let selected: TextPolishConversationSnapshot | null = first;
  const snapshots = new Map([
    [first.conversationId, first],
    [second.conversationId, second],
  ]);
  const workspace = vi.fn(async (request: { action: string; conversationId: string | null }) => {
    if (request.action === "open")
      selected = request.conversationId ? (snapshots.get(request.conversationId) ?? null) : null;
    return {
      ok: true,
      value: { snapshot: selected, draft: { text: "", presets: [] }, history: [] },
    };
  });
  Object.assign(f.api, { polishWorkspace: workspace });
  f.api.snapshotConversation.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { conversationId: string };
    const value = snapshots.get(request.conversationId);
    if (!value) throw new Error("Unknown fixture conversation");
    return { ok: true, value };
  });
  f.api.resetConversation.mockResolvedValue({ ok: true, value: { snapshot: first } } as never);
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.status).toBe("running"));
  act(() => hook.result.current.saveInputDraft({ text: "A 草稿", presets: [] }));
  await act(async () => hook.result.current.openHistory(second.conversationId));
  expect(hook.result.current.conversationId).toBe(second.conversationId);
  expect(hook.result.current.inputDraft.text).toBe("");
  act(() => hook.result.current.saveInputDraft({ text: "B 草稿", presets: [] }));
  act(() =>
    f.emit({
      type: "reasoning",
      conversationId: first.conversationId,
      conversationRevision: 1,
      turnId: first.activeTurn.turnId,
      delta: "仅属于 A",
    }),
  );
  expect(hook.result.current.reasoning).not.toContain("仅属于 A");
  first.reasoningByTurn = { [first.activeTurn.turnId]: { text: "仅属于 A", truncated: false } };
  await act(async () => hook.result.current.openHistory(first.conversationId));
  expect(hook.result.current.inputDraft.text).toBe("A 草稿");
  expect(hook.result.current.reasoning).toBe("仅属于 A");
  expect(hook.result.current.source).toEqual(first.source);
  await act(async () => hook.result.current.reset());
  expect(hook.result.current.conversationId).toBeNull();
  await act(async () => hook.result.current.openHistory(second.conversationId));
  expect(hook.result.current.status).toBe("running");
  expect(hook.result.current.inputDraft.text).toBe("B 草稿");
  expect(f.api.cancelConversation).not.toHaveBeenCalled();
  expect(f.api.startConversation).not.toHaveBeenCalled();
  hook.unmount();
  f.editor.destroy();
});

test.each(["rejected", "transport"] as const)(
  "reports a %s snapshot failure and recovers without resending",
  async (mode) => {
    const f = fixture();
    const workspace = vi.fn(async () => ({
      ok: true,
      value: { snapshot: f.snapshot, draft: { text: "磁盘旧稿", presets: [] }, history: [] },
    }));
    Object.assign(f.api, { polishWorkspace: workspace });
    const hook = renderHook(() => useTextPolish(f.props));
    await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
    const turnId = randomUUID();
    const userMessage = { role: "user" as const, turnId, messageId: randomUUID(), text: "继续" };
    act(() =>
      f.emit({
        type: "message",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 2,
        message: userMessage,
      }),
    );
    if (mode === "transport")
      f.api.snapshotConversation.mockRejectedValueOnce(new Error("连接中断"));
    else
      f.api.snapshotConversation.mockResolvedValueOnce({
        ok: false,
        error: { message: "读取失败" },
      } as never);
    act(() =>
      f.emit({
        type: "phase",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 5,
        turnId,
        phase: "thinking",
      }),
    );
    await waitFor(() => expect(hook.result.current.error).toContain("历史对话"));
    expect(hook.result.current.messages).toEqual([...f.snapshot.messages, userMessage]);
    expect(hook.result.current.status).toBe("running");
    expect(f.api.sendConversation).not.toHaveBeenCalled();
    const recovered = {
      ...f.snapshot,
      conversationRevision: 6,
      latestValidDraft: "恢复的回复",
      messages: [
        ...f.snapshot.messages,
        userMessage,
        {
          role: "assistant" as const,
          turnId,
          messageId: randomUUID(),
          reply: { kind: "answer" as const, message: "恢复的回复" },
        },
      ],
      lastTurnOutcome: { status: "completed" as const, turnId },
    };
    workspace.mockResolvedValue({
      ok: true,
      value: { snapshot: recovered, draft: { text: "磁盘旧稿", presets: [] }, history: [] },
    });
    act(() => hook.result.current.saveInputDraft({ text: "未发送的要求", presets: [] }));
    await act(async () => hook.result.current.refreshHistory());
    expect(hook.result.current.conversationRevision).toBe(6);
    expect(hook.result.current.status).toBe("completed");
    expect(hook.result.current.messages.at(-1)).toMatchObject({ reply: { message: "恢复的回复" } });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.inputDraft.text).toBe("未发送的要求");
    expect(f.api.sendConversation).not.toHaveBeenCalled();
    hook.unmount();
    f.editor.destroy();
  },
);

test("a late failed snapshot never marks a newer completed reply as unsynchronized", async () => {
  const f = fixture();
  const response = deferred<Awaited<ReturnType<typeof f.api.snapshotConversation>>>();
  const hook = renderHook(() => useTextPolish(f.props));
  await act(async () => hook.result.current.start("起草"));
  f.api.snapshotConversation.mockImplementationOnce(() => response.promise);
  act(() =>
    f.emit({
      type: "phase",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 5,
      turnId: randomUUID(),
      phase: "thinking",
    }),
  );
  act(() =>
    f.emit({
      type: "message",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 2,
      message: {
        role: "assistant",
        messageId: randomUUID(),
        turnId: randomUUID(),
        reply: { kind: "answer", message: "新回复" },
      },
    }),
  );
  await act(async () =>
    response.resolve({ ok: false, error: { message: "迟到的读取失败" } } as never),
  );
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.messages.at(-1)).toMatchObject({ reply: { message: "新回复" } });
  hook.unmount();
  f.editor.destroy();
});

test("a late navigation snapshot failure cannot replace a newly received reply", async () => {
  const f = fixture();
  const hook = renderHook((props) => useTextPolish(props), {
    initialProps: { ...f.props, bookKind: "description" as "description" | "claims" },
  });
  await act(async () => hook.result.current.start("起草"));
  const response = deferred<Awaited<ReturnType<typeof f.api.snapshotConversation>>>();
  f.api.snapshotConversation.mockImplementationOnce(() => response.promise);
  hook.rerender({ ...f.props, bookKind: "claims" });
  act(() =>
    f.emit({
      type: "message",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 2,
      message: {
        role: "assistant",
        messageId: randomUUID(),
        turnId: randomUUID(),
        reply: { kind: "answer", message: "已经收到的新回复" },
      },
    }),
  );
  await act(async () => response.resolve({ ok: false, error: { message: "旧读取失败" } } as never));
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.messages.at(-1)).toMatchObject({
    reply: { message: "已经收到的新回复" },
  });
  hook.unmount();
  f.editor.destroy();
});

test.each(["pending", "failed"])(
  "preserves %s local drafts when reopening and switching histories",
  async (mode) => {
    const f = fixture();
    const other = randomUUID();
    const pending = deferred<unknown>();
    Object.assign(f.api, {
      polishWorkspace: vi.fn(async (request: { action: string; conversationId?: string }) => {
        if (request.action === "draft")
          return mode === "pending"
            ? pending.promise
            : { ok: false, error: { message: "草稿未保存" } };
        return {
          ok: true,
          value: {
            snapshot: {
              ...f.snapshot,
              conversationId: request.conversationId ?? f.snapshot.conversationId,
            },
            draft: { text: "磁盘旧稿", presets: [] },
            history: [],
          },
        };
      }),
    });
    const hook = renderHook(() => useTextPolish(f.props));
    await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
    await act(async () => hook.result.current.saveInputDraft({ text: "本地新稿", presets: [] }));
    await act(async () => hook.result.current.openHistory(f.snapshot.conversationId));
    expect(hook.result.current.inputDraft.text).toBe("本地新稿");
    if (mode === "failed")
      await waitFor(() => expect(hook.result.current.storageError).toBe("草稿未保存"));
    await act(async () => hook.result.current.openHistory(other));
    expect(hook.result.current.inputDraft.text).toBe("磁盘旧稿");
    await act(async () => hook.result.current.openHistory(f.snapshot.conversationId));
    expect(hook.result.current.inputDraft.text).toBe("本地新稿");
    if (mode === "failed") expect(hook.result.current.storageError).toBe("草稿未保存");
    if (mode === "pending") await act(async () => pending.resolve({ ok: true, value: {} }));
    hook.unmount();
    f.editor.destroy();
  },
);

test("reset success invalidates the old conversation even if opening the new workspace fails", async () => {
  const f = fixture();
  f.api.resetConversation.mockResolvedValue({ ok: true, value: {} } as never);
  let recovered = false;
  Object.assign(f.api, {
    polishWorkspace: vi.fn(async (request: { action: string; conversationId?: string | null }) => {
      if (request.action === "open" && request.conversationId === f.snapshot.conversationId)
        return {
          ok: true,
          value: { snapshot: f.snapshot, draft: { text: "保留草稿", presets: [] }, history: [] },
        };
      if (request.action === "open") return { ok: false, error: { message: "读取失败" } };
      if (request.action === "draft" && !recovered)
        return { ok: false, error: { message: "损坏草稿未恢复，无法保存" } };
      if (request.action === "recover") recovered = true;
      return {
        ok: true,
        value: {
          snapshot: request.action === "load" ? f.snapshot : null,
          draft: { text: "保留草稿", presets: [] },
          history: [],
        },
      };
    }),
  });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  await act(async () => {
    await expect(hook.result.current.reset()).rejects.toThrow("读取失败");
  });
  expect(hook.result.current.conversationId).toBeNull();
  expect(hook.result.current.inputDraft.text).toBe("");
  expect(hook.result.current.historyRecoveryAvailable).toBe(true);
  await act(async () => {
    expect(await hook.result.current.send("不能发送至旧会话")).toBe(false);
  });
  expect(f.api.sendConversation).not.toHaveBeenCalled();
  act(() => hook.result.current.saveInputDraft({ text: "恢复前继续输入", presets: [] }));
  await waitFor(() => expect(hook.result.current.storageError).toBe("损坏草稿未恢复，无法保存"));
  await act(async () => hook.result.current.recoverHistory());
  expect(hook.result.current.inputDraft.text).toBe("恢复前继续输入");
  expect(hook.result.current.historyRecoveryAvailable).toBe(false);
  expect(hook.result.current.storageError).toBeNull();
  await act(async () => hook.result.current.openHistory(f.snapshot.conversationId));
  expect(hook.result.current.inputDraft.text).toBe("保留草稿");
  hook.unmount();
  f.editor.destroy();
});

test("changes the active model with revision identity while retaining unsaved input", async () => {
  const f = fixture();
  const target = { ...f.snapshot.model, modelId: "replacement" };
  const workspace = vi.fn(async (request: { action: string }) => ({
    ok: true,
    value: {
      snapshot:
        request.action === "change-model"
          ? { ...f.snapshot, model: target, conversationRevision: 2 }
          : f.snapshot,
      draft: { text: "磁盘旧稿", presets: [] },
      history: [],
    },
  }));
  Object.assign(f.api, { polishWorkspace: workspace });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  await act(async () => hook.result.current.saveInputDraft({ text: "不丢失", presets: [] }));
  await act(async () => hook.result.current.changeModel(target));
  expect(workspace).toHaveBeenLastCalledWith({
    patentId: f.props.patentId,
    sessionId: f.props.sessionId,
    action: "change-model",
    conversationId: f.snapshot.conversationId,
    expectedConversationRevision: 1,
    targetModel: target,
  });
  expect(hook.result.current.model).toEqual(target);
  expect(hook.result.current.inputDraft.text).toBe("不丢失");
  hook.unmount();
  f.editor.destroy();
});

test("model changes reject failures without replacing the conversation and serialize requests", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  const workspace = vi.fn(async (request: { action: string }) =>
    request.action === "change-model"
      ? pending.promise
      : {
          ok: true,
          value: {
            snapshot: f.snapshot,
            draft: { text: "草稿", presets: [] },
            history: [],
          },
        },
  );
  Object.assign(f.api, { polishWorkspace: workspace });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.changeModel(f.snapshot.model);
  });
  await act(async () => hook.result.current.changeModel(f.snapshot.model));
  expect(
    workspace.mock.calls.filter(([request]) => request.action === "change-model"),
  ).toHaveLength(1);
  await act(async () => {
    pending.resolve({ ok: false, error: { message: "切换失败" } });
    await expect(first).rejects.toThrow("切换失败");
  });
  expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId);
  expect(hook.result.current.inputDraft.text).toBe("草稿");
  expect(hook.result.current.model).toEqual(f.snapshot.model);
  hook.unmount();
  f.editor.destroy();
});

test("explicit recovery targets a damaged history even after initial load succeeded", async () => {
  const f = fixture();
  const damaged = randomUUID();
  const workspace = vi.fn(async () => ({
    ok: true,
    value: {
      snapshot: f.snapshot,
      draft: { text: "", presets: [] },
      history: [],
    },
  }));
  Object.assign(f.api, { polishWorkspace: workspace });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
  await act(async () => hook.result.current.recoverHistory(damaged));
  expect(workspace).toHaveBeenLastCalledWith({
    patentId: f.props.patentId,
    sessionId: f.props.sessionId,
    action: "recover",
    conversationId: damaged,
  });
  hook.unmount();
  f.editor.destroy();
});

test("reset locks start until its follow-up workspace read finishes and releases on failure", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  f.api.resetConversation.mockResolvedValue({ ok: true, value: {} } as never);
  Object.assign(f.api, {
    polishWorkspace: vi.fn(async (request: { action: string }) =>
      request.action === "open"
        ? pending.promise
        : {
            ok: true,
            value: { snapshot: f.snapshot, draft: { text: "", presets: [] }, history: [] },
          },
    ),
  });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  let resetting!: Promise<void>;
  await act(async () => {
    resetting = hook.result.current.reset();
  });
  expect(hook.result.current.conversationId).toBeNull();
  await act(async () => hook.result.current.start("尚不能启动"));
  expect(f.api.startConversation).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ ok: false, error: { message: "读取失败" } });
    await expect(resetting).rejects.toThrow("读取失败");
  });
  await act(async () => hook.result.current.start("失败后锁已释放"));
  expect(f.api.startConversation).toHaveBeenCalledTimes(1);
  hook.unmount();
  f.editor.destroy();
});

test("reset does not overlap a pending model change", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  Object.assign(f.api, {
    polishWorkspace: vi.fn(async (request: { action: string }) =>
      request.action === "change-model"
        ? pending.promise
        : {
            ok: true,
            value: { snapshot: f.snapshot, draft: { text: "", presets: [] }, history: [] },
          },
    ),
  });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId));
  let changing!: Promise<void>;
  act(() => {
    changing = hook.result.current.changeModel(f.snapshot.model);
  });
  await act(async () => {
    await hook.result.current.reset().catch(() => undefined);
  });
  expect(f.api.resetConversation).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ ok: false, error: { message: "切换失败" } });
    await expect(changing).rejects.toThrow("切换失败");
  });
  await act(async () => {
    await expect(hook.result.current.reset()).rejects.toThrow("重置失败");
  });
  expect(f.api.resetConversation).toHaveBeenCalledTimes(1);
  hook.unmount();
  f.editor.destroy();
});

test("locks start immediately while saving", async () => {
  const f = fixture();
  const saved = deferred<Awaited<ReturnType<typeof f.props.prepare>>>();
  const hook = renderHook(() => useTextPolish({ ...f.props, prepare: () => saved.promise }));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = hook.result.current.start("起草");
    second = hook.result.current.start("起草");
  });
  expect(hook.result.current.status).toBe("preparing");
  await act(async () => hook.result.current.reset());
  expect(hook.result.current.status).toBe("preparing");
  await act(async () => {
    saved.resolve(await f.props.prepare());
    await Promise.all([first, second]);
  });
  expect(f.api.startConversation).toHaveBeenCalledTimes(1);
  hook.unmount();
  f.editor.destroy();
});

test("failed restoration stops loading and explicit recovery restores the workspace", async () => {
  const f = fixture();
  const workspace = vi.fn(async (request: { action: string }) =>
    request.action === "recover"
      ? {
          ok: true,
          value: { snapshot: null, draft: { text: "恢复草稿", presets: [] }, history: [] },
        }
      : { ok: false, error: { message: "记录损坏" } },
  );
  Object.assign(f.api, { polishWorkspace: workspace });
  const hook = renderHook(() => useTextPolish(f.props));
  await waitFor(() => expect(hook.result.current.storageError).toBe("记录损坏"));
  expect(hook.result.current.historyLoading).toBe(false);
  expect(hook.result.current.historyRecoveryAvailable).toBe(true);
  await act(async () => hook.result.current.recoverHistory());
  expect(hook.result.current.storageError).toBeNull();
  expect(hook.result.current.inputDraft.text).toBe("恢复草稿");
  expect(hook.result.current.historyLoading).toBe(false);
  expect(hook.result.current.historyRecoveryAvailable).toBe(false);
  act(() => hook.result.current.saveInputDraft({ text: "新的未发送输入", presets: [] }));
  await waitFor(() => expect(hook.result.current.storageError).toBe("记录损坏"));
  await act(async () => hook.result.current.recoverHistory());
  expect(hook.result.current.inputDraft.text).toBe("新的未发送输入");
  expect(workspace.mock.calls.filter(([request]) => request.action === "recover")).toHaveLength(1);
  hook.unmount();
  f.editor.destroy();
});

test("does not revive old reasoning while a retry acknowledgement is pending", async () => {
  const f = fixture();
  const turnId = randomUUID();
  f.snapshot.messages = [{ role: "user", messageId: randomUUID(), turnId, text: "起草" }];
  f.snapshot.lastTurnOutcome = { status: "failed", turnId, message: "请求失败", retryable: true };
  f.snapshot.reasoningByTurn = { [turnId]: { text: "上一轮思考", truncated: false } };
  const pending = deferred<Awaited<ReturnType<typeof f.api.sendConversation>>>();
  f.api.sendConversation.mockImplementation(() => pending.promise);
  const hook = renderHook((props) => useTextPolish(props), {
    initialProps: { ...f.props, bookKind: "description" as "description" | "claims" },
  });
  await act(async () => hook.result.current.start("起草"));
  let retry!: Promise<boolean>;
  act(() => {
    retry = hook.result.current.retry();
  });
  await act(async () => hook.rerender({ ...f.props, bookKind: "claims" }));
  expect(hook.result.current.reasoningByTurn[turnId]?.text).toBe("");
  await act(async () => {
    pending.resolve({
      ok: true,
      value: {
        snapshot: {
          ...f.snapshot,
          conversationRevision: 2,
          activeTurn: {
            turnId,
            clientRequestId: randomUUID(),
            instruction: "起草",
            status: "running",
          },
          lastTurnOutcome: null,
          reasoningByTurn: { [turnId]: { text: "", truncated: false } },
        },
      },
    });
    await retry;
  });
  expect(hook.result.current.reasoningByTurn[turnId]?.text).toBe("");
  hook.unmount();
  f.editor.destroy();
});

test.each(["rejected", "transport"] as const)(
  "preserves reasoning when retry is %s",
  async (failure) => {
    const f = fixture();
    const turnId = randomUUID();
    f.snapshot.messages = [{ role: "user", messageId: randomUUID(), turnId, text: "起草" }];
    f.snapshot.lastTurnOutcome = { status: "failed", turnId, message: "请求失败", retryable: true };
    f.snapshot.reasoningByTurn = { [turnId]: { text: "原有思考", truncated: true } };
    if (failure === "transport")
      f.api.sendConversation.mockRejectedValueOnce(new Error("连接中断"));
    else
      f.api.sendConversation.mockResolvedValueOnce({
        ok: false,
        error: { message: "请求被拒绝" },
      } as never);
    const hook = renderHook(() => useTextPolish(f.props));
    await act(async () => hook.result.current.start("起草"));
    await act(async () => {
      await expect(hook.result.current.retry()).resolves.toBe(false);
    });
    expect(hook.result.current.reasoningByTurn[turnId]).toEqual({
      text: "原有思考",
      truncated: true,
    });
    hook.unmount();
    f.editor.destroy();
  },
);

test("disables new conversation while preparing the first request", () => {
  const onReset = vi.fn();
  const panel = render(
    <TextPolishPanel
      open
      status="preparing"
      selection={{ status: "empty" }}
      result={null}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onClose={vi.fn()}
      onOpenSettings={vi.fn()}
      onReset={onReset}
    />,
  );
  const button = panel.getByRole("button", { name: "新对话" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(onReset).not.toHaveBeenCalled();
});

test("recovery is explicit and shows a new recovery failure", async () => {
  const recover = vi.fn(async () => {
    throw new Error("仍无法读取磁盘");
  });
  const panel = render(
    <TextPolishPanel
      open
      status="idle"
      selection={{ status: "empty" }}
      result={null}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onClose={vi.fn()}
      onOpenSettings={vi.fn()}
      storageError="文件损坏"
      historyRecoveryAvailable
      onRecoverHistory={recover}
    />,
  );
  expect(recover).not.toHaveBeenCalled();
  fireEvent.click(panel.getByRole("button", { name: "保留异常文件并恢复" }));
  await waitFor(() => expect(panel.getByRole("alert").textContent).toContain("仍无法读取磁盘"));
  expect(recover).toHaveBeenCalledTimes(1);
});

test.each(["accepted", "failed", "edited"] as const)(
  "clears only the accepted unchanged launch draft (%s)",
  async (scenario) => {
    const f = fixture();
    const writes: string[] = [];
    const polishWorkspace = vi.fn(
      async (request: {
        action: string;
        conversationId?: string | null;
        draft?: { text: string };
      }) => {
        if (request.action === "draft") writes.push(request.draft?.text ?? "");
        return {
          ok: true,
          value: { snapshot: null, draft: { text: "", presets: [] }, history: [] },
        };
      },
    );
    Object.assign(f.api, { polishWorkspace });
    if (scenario === "failed")
      f.api.startConversation.mockResolvedValueOnce({
        ok: false,
        error: { message: "启动失败" },
      } as never);
    const saved = deferred<Awaited<ReturnType<typeof f.props.prepare>>>();
    const hook = renderHook(() => useTextPolish({ ...f.props, prepare: () => saved.promise }));
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    act(() => hook.result.current.saveInputDraft({ text: "起草", presets: [] }));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.start("起草");
    });
    if (scenario === "edited")
      act(() => hook.result.current.saveInputDraft({ text: "保留新输入", presets: [] }));
    await act(async () => {
      saved.resolve(await f.props.prepare());
      await pending;
    });
    await act(async () => hook.result.current.flushInputDrafts());
    expect(writes.at(-1)).toBe(
      scenario === "accepted" ? "" : scenario === "edited" ? "保留新输入" : "起草",
    );
    expect(hook.result.current.inputDraft.text).toBe(
      scenario === "accepted" ? "" : scenario === "edited" ? "保留新输入" : "起草",
    );
    if (scenario === "edited")
      expect(polishWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "draft",
          conversationId: f.snapshot.conversationId,
          draft: { text: "保留新输入", presets: [] },
        }),
      );
    hook.unmount();
    f.editor.destroy();
  },
);

test.each(["failed", "superseded"] as const)(
  "keeps migrated launch input safe when its save is %s",
  async (scenario) => {
    const f = fixture();
    const saved = deferred<Awaited<ReturnType<typeof f.props.prepare>>>();
    const migrated = deferred<unknown>();
    const polishWorkspace = vi.fn(
      async (request: {
        action: string;
        conversationId?: string | null;
        draft?: { text: string };
      }) => {
        if (
          request.action === "draft" &&
          request.conversationId &&
          request.draft?.text === "保留新输入"
        )
          return migrated.promise;
        return {
          ok: true,
          value: { snapshot: null, draft: { text: "", presets: [] }, history: [] },
        };
      },
    );
    Object.assign(f.api, { polishWorkspace });
    const hook = renderHook(() => useTextPolish({ ...f.props, prepare: () => saved.promise }));
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    act(() => hook.result.current.saveInputDraft({ text: "起草", presets: [] }));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.start("起草");
    });
    act(() => hook.result.current.saveInputDraft({ text: "保留新输入", presets: [] }));
    await act(async () => {
      saved.resolve(await f.props.prepare());
      await pending;
    });
    expect(hook.result.current.inputDraft.text).toBe("保留新输入");
    if (scenario === "superseded")
      await act(async () =>
        hook.result.current.saveInputDraft({ text: "更新的输入", presets: [] }),
      );
    await waitFor(() =>
      expect(polishWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "draft",
          conversationId: f.snapshot.conversationId,
        }),
      ),
    );
    await act(async () => migrated.resolve({ ok: false, error: { message: "迁移草稿保存失败" } }));
    expect(hook.result.current.inputDraft.text).toBe(
      scenario === "failed" ? "保留新输入" : "更新的输入",
    );
    expect(hook.result.current.storageError).toBe(
      scenario === "failed" ? "迁移草稿保存失败" : null,
    );
    hook.unmount();
    f.editor.destroy();
  },
);

test.each([
  { incomingRevision: 2, incoming: "完整的思考过程", local: "完整的", expected: "完整的思考过程" },
  { incomingRevision: 2, incoming: "完整的", local: "完整的思考过程", expected: "完整的思考过程" },
  { incomingRevision: 1, incoming: "上一轮更长的旧思考记录", local: "新思考", expected: "新思考" },
])("restores reasoning safely from snapshot $incomingRevision/$incoming", async (scenario) => {
  const f = fixture();
  const message = f.snapshot.messages[0];
  if (!message || message.role === "system") throw new Error("missing test turn");
  const turnId = message.turnId;
  f.snapshot.activeTurn = {
    turnId,
    clientRequestId: randomUUID(),
    instruction: "起草",
    status: "running",
  };
  f.snapshot.lastTurnOutcome = null;
  const hook = renderHook((props) => useTextPolish(props), {
    initialProps: { ...f.props, bookKind: "description" as "description" | "claims" },
  });
  await act(async () => hook.result.current.start("起草"));
  act(() =>
    f.emit({
      type: "phase",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 2,
      turnId,
      phase: "thinking",
    }),
  );
  act(() =>
    f.emit({
      type: "reasoning",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 2,
      turnId,
      delta: scenario.local,
    }),
  );
  f.api.snapshotConversation.mockResolvedValue({
    ok: true,
    value: {
      ...f.snapshot,
      conversationRevision: scenario.incomingRevision,
      reasoningByTurn: { [turnId]: { text: scenario.incoming, truncated: false } },
    },
  });
  await act(async () => hook.rerender({ ...f.props, bookKind: "claims" }));
  // Let the buffered stream commit too: a transient snapshot match is not enough.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(hook.result.current.reasoningByTurn[turnId]?.text).toBe(scenario.expected);
  expect(hook.result.current.reasoning).toBe(scenario.expected);
  act(() =>
    f.emit({
      type: "reasoning",
      conversationId: f.snapshot.conversationId,
      conversationRevision: 3,
      turnId,
      delta: "，继续思考",
    }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(hook.result.current.reasoning).toBe(`${scenario.expected}，继续思考`);
  hook.unmount();
  f.editor.destroy();
});

test.each([false, true])(
  "late send response (error=%s) never overwrites the newer completed reply",
  async (failed) => {
    const f = fixture();
    const response = deferred<Awaited<ReturnType<typeof f.api.sendConversation>>>();
    f.api.sendConversation.mockImplementation(() => response.promise);
    const hook = renderHook(() => useTextPolish(f.props));
    await act(async () => hook.result.current.start("起草"));
    let send!: Promise<boolean>;
    act(() => {
      send = hook.result.current.send("继续");
    });
    const turnId = randomUUID();
    const user = { role: "user" as const, turnId, messageId: randomUUID(), text: "继续" };
    act(() =>
      f.emit({
        type: "message",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 2,
        message: user,
      }),
    );
    act(() =>
      f.emit({
        type: "phase",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 3,
        turnId,
        phase: "thinking",
      }),
    );
    await act(async () => {
      await hook.result.current.cancel().catch(() => undefined);
    });
    expect(f.api.cancelConversation).toHaveBeenCalled();
    act(() =>
      f.emit({
        type: "message",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 4,
        message: {
          role: "assistant",
          turnId,
          messageId: randomUUID(),
          reply: { kind: "revision", message: "完成", revisedText: "第二版" },
        },
      }),
    );
    await act(async () => {
      response.resolve(
        failed
          ? ({ ok: false, error: { code: "REVISION_CONFLICT", message: "迟到的失败" } } as never)
          : {
              ok: true,
              value: {
                snapshot: {
                  ...f.snapshot,
                  conversationRevision: 2,
                  messages: [...f.snapshot.messages, user],
                  activeTurn: {
                    turnId,
                    clientRequestId: turnId,
                    instruction: "继续",
                    status: "preparing",
                  },
                  lastTurnOutcome: null,
                },
              },
            },
      );
      await send;
    });
    expect(hook.result.current.status).toBe("completed");
    expect(hook.result.current.messages.at(-1)).toMatchObject({ reply: { revisedText: "第二版" } });
    await act(async () => {
      await expect(hook.result.current.reset()).rejects.toThrow("重置失败");
    });
    expect(hook.result.current.conversationId).toBe(f.snapshot.conversationId);
    hook.unmount();
    f.editor.destroy();
  },
);

test.each(["open", "refresh"] as const)(
  "keeps buffered reasoning when %s history returns a shorter snapshot",
  async (action) => {
    const f = fixture();
    const message = f.snapshot.messages[0];
    if (!message || message.role === "system") throw new Error("missing test turn");
    const turnId = message.turnId;
    f.snapshot.activeTurn = {
      turnId,
      clientRequestId: randomUUID(),
      instruction: "起草",
      status: "running",
    };
    f.snapshot.lastTurnOutcome = null;
    const workspace = vi.fn(async () => ({
      ok: true,
      value: { snapshot: f.snapshot, draft: { text: "", presets: [] }, history: [] },
    }));
    Object.assign(f.api, { polishWorkspace: workspace });
    const hook = renderHook(() => useTextPolish(f.props));
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    act(() =>
      f.emit({
        type: "phase",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 2,
        turnId,
        phase: "thinking",
      }),
    );
    act(() =>
      f.emit({
        type: "reasoning",
        conversationId: f.snapshot.conversationId,
        conversationRevision: 2,
        turnId,
        delta: "完整的思考过程",
      }),
    );
    workspace.mockResolvedValue({
      ok: true,
      value: {
        snapshot: {
          ...f.snapshot,
          conversationRevision: 2,
          reasoningByTurn: { [turnId]: { text: "完整的", truncated: false } },
        },
        draft: { text: "", presets: [] },
        history: [],
      },
    });
    await act(async () => {
      if (action === "open") await hook.result.current.openHistory(f.snapshot.conversationId);
      else await hook.result.current.refreshHistory();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(hook.result.current.reasoning).toBe("完整的思考过程");
    hook.unmount();
    f.editor.destroy();
  },
);

test("isolates unsent instructions and never offers replacement during a turn", () => {
  const common = {
    open: true,
    status: "completed" as const,
    selection: { status: "empty" as const },
    result: null,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onReplaceText: vi.fn(),
  };
  const panel = render(<TextPolishPanel {...common} conversationId="A" />);
  fireEvent.change(panel.getByLabelText("继续对话"), { target: { value: "A的要求" } });
  panel.rerender(<TextPolishPanel {...common} conversationId="B" />);
  expect((panel.getByLabelText("继续对话") as HTMLTextAreaElement).value).toBe("");
  panel.rerender(<TextPolishPanel {...common} conversationId="A" />);
  expect((panel.getByLabelText("继续对话") as HTMLTextAreaElement).value).toBe("A的要求");
  panel.rerender(
    <TextPolishPanel
      {...common}
      conversationId="A"
      status="running"
      source={{
        kind: "selection",
        anchor: {
          originalText: "原文",
          bookKind: "description",
          blocks: [],
          originalTextHash: "a".repeat(64),
        },
      }}
      messages={[
        {
          role: "assistant",
          messageId: "m",
          turnId: "t",
          reply: { kind: "revision", message: "完成", revisedText: "稿件" },
        },
      ]}
    />,
  );
  expect(panel.queryByRole("button", { name: "替换原文" })).toBeNull();
});
