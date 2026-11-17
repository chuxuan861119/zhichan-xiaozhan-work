import { randomUUID } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type {
  AiCorrectionBookKind,
  AiCorrectionEvent,
} from "../../../../shared/ai-correction/contract";
import { createPatentExtensions } from "../../editor/extensions";
import { useAiCorrection } from "./use-ai-correction";

describe("use AI correction", () => {
  test("cancels running requests when the workbench unmounts", async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const start = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { aiCorrection: { start, cancel, onEvent: () => () => undefined } },
    });
    const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 1 };
    const { result, unmount } = renderHook(() =>
      useAiCorrection({
        ...prepared,
        openSessionIds: [prepared.sessionId],
        bookKind: "description",
        editor: null,
        thinkingEnabled: true,
        prepare: async () => prepared,
      }),
    );
    await act(async () => result.current.start("current-book"));
    expect(result.current.status).toBe("running");
    unmount();
    expect(cancel).toHaveBeenCalledWith({ jobId: start.mock.calls[0]?.[0].jobId });
  });
  test.each(["需要检查文字", "字".repeat(120_000)])(
    "uses the preload hash boundary without a selection character cap (%#)",
    async (text) => {
      const blockId = randomUUID();
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { nodeId: blockId },
              content: [{ type: "text", text }],
            },
          ],
        },
      });
      editor.commands.selectAll();
      const selectedTextHash = "c".repeat(64);
      const hashText = vi.fn(async () => ({ ok: true as const, value: selectedTextHash }));
      const start = vi.fn(async (request: { jobId: string }) => ({
        ok: true as const,
        value: { jobId: request.jobId },
      }));
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: {
          aiCorrection: {
            hashText,
            start,
            cancel: vi.fn(),
            onEvent: () => () => undefined,
          },
        },
      });
      const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 1 };
      const { result } = renderHook(() =>
        useAiCorrection({
          patentId: prepared.patentId,
          sessionId: prepared.sessionId,
          openSessionIds: [prepared.sessionId],
          bookKind: "description",
          editor,
          thinkingEnabled: true,
          prepare: async () => prepared,
        }),
      );

      await act(async () => result.current.start("selection"));

      expect(hashText).toHaveBeenCalledWith(expect.stringContaining(text));
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({ selectedTextHash }),
        }),
      );
      editor.destroy();
    },
  );

  test("allows one continuous selection across multiple paragraphs", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: firstId },
            content: [{ type: "text", text: "第一段" }],
          },
          {
            type: "paragraph",
            attrs: { nodeId: secondId },
            content: [{ type: "text", text: "第二段" }],
          },
        ],
      },
    });
    editor.commands.selectAll();
    const hashText = vi.fn(async () => ({ ok: true as const, value: "d".repeat(64) }));
    const start = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: { aiCorrection: { hashText, start, cancel: vi.fn(), onEvent: () => () => undefined } },
    });
    const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 1 };
    const { result } = renderHook(() =>
      useAiCorrection({
        patentId: prepared.patentId,
        sessionId: prepared.sessionId,
        openSessionIds: [prepared.sessionId],
        bookKind: "description",
        editor,
        thinkingEnabled: true,
        prepare: async () => prepared,
      }),
    );
    await act(async () => result.current.start("selection"));
    expect(hashText).toHaveBeenCalledWith("第一段\n第二段");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          blocks: [
            expect.objectContaining({ blockId: firstId, startOffset: 0, endOffset: 3 }),
            expect.objectContaining({ blockId: secondId, startOffset: 0, endOffset: 3 }),
          ],
        }),
      }),
    );
    editor.destroy();
  });

  test.each([
    {
      name: "IPC rejection",
      start: vi.fn(async () => {
        throw new Error("IPC 启动失败");
      }),
      message: "IPC 启动失败",
    },
    {
      name: "mismatched task identity",
      start: vi.fn(async () => ({
        ok: true as const,
        value: { jobId: randomUUID() },
      })),
      message: "AI 纠错任务标识不一致。",
    },
  ])("cleans the pending state after $name", async ({ start, message }) => {
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          start,
          cancel: vi.fn(),
          onEvent: () => () => undefined,
        },
      },
    });
    const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 2 };
    const { result } = renderHook(() =>
      useAiCorrection({
        patentId: prepared.patentId,
        sessionId: prepared.sessionId,
        openSessionIds: [prepared.sessionId],
        bookKind: "description",
        editor: null,
        thinkingEnabled: true,
        prepare: async () => prepared,
      }),
    );

    let failure: unknown;
    await act(async () => {
      try {
        await result.current.start("current-book");
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toEqual(expect.objectContaining({ message }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toBe(message);
    expect(result.current.phase).toBeNull();
  });

  test("starts after persisted preparation and accepts matching completion events", async () => {
    let listener: ((event: AiCorrectionEvent) => void) | undefined;
    const start = vi.fn(async (request: { jobId: string }) => {
      listener?.({ type: "phase", jobId: request.jobId, phase: "thinking" });
      listener?.({ type: "reasoning", jobId: request.jobId, delta: "正在核对术语" });
      return { ok: true as const, value: { jobId: request.jobId } };
    });
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          start,
          cancel: vi.fn(),
          onEvent: (next: typeof listener) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 2 };
    const { result } = renderHook(() =>
      useAiCorrection({
        patentId: prepared.patentId,
        sessionId: prepared.sessionId,
        // The parent session list can lag one render behind the already active session.
        openSessionIds: [],
        bookKind: "description",
        editor: null,
        thinkingEnabled: true,
        prepare: async () => prepared,
      }),
    );

    await act(async () => result.current.start("current-book"));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        ...prepared,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: true,
        uploadConfirmed: true,
      }),
    );
    const jobId = start.mock.calls[0]?.[0].jobId;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/u);
    if (!jobId) throw new Error("missing job id");
    act(() => listener?.({ type: "reasoning", jobId: randomUUID(), delta: "不属于当前任务" }));
    await waitFor(() => expect(result.current.phase).toBe("thinking"));
    expect(result.current.reasoning).toBe("正在核对术语");
    act(() => listener?.({ type: "completed", jobId, issues: [], resultLimitReached: false }));
    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.phase).toBeNull();
    expect(result.current.reasoning).toBe("正在核对术语");
  });

  test("uses the saved preference again after a thinking task is restarted", async () => {
    let listener: ((event: AiCorrectionEvent) => void) | undefined;
    const start = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          start,
          cancel: vi.fn(),
          onEvent: (next: typeof listener) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const { result, rerender } = renderHook(
      ({ thinkingEnabled }) =>
        useAiCorrection({
          patentId,
          sessionId,
          openSessionIds: [sessionId],
          bookKind: "description",
          editor: null,
          thinkingEnabled,
          prepare: async () => ({ patentId, sessionId, expectedRevision: 2 }),
        }),
      { initialProps: { thinkingEnabled: true } },
    );

    await act(async () => result.current.start("current-book"));
    const jobId = start.mock.calls[0]?.[0].jobId;
    if (!jobId) throw new Error("missing job id");
    rerender({ thinkingEnabled: false });
    expect(result.current.thinkingEnabled).toBe(true);

    act(() => listener?.({ type: "completed", jobId, issues: [], resultLimitReached: false }));
    await waitFor(() => expect(result.current.status).toBe("completed"));
    act(() => result.current.restart());

    expect(result.current.status).toBe("idle");
    expect(result.current.thinkingEnabled).toBe(false);
  });

  test("restores local results after switching books or patents", async () => {
    let listener: ((event: AiCorrectionEvent) => void) | undefined;
    const start = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          start,
          cancel: vi.fn(),
          onEvent: (next: typeof listener) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const patentA = randomUUID();
    const sessionA = randomUUID();
    const patentB = randomUUID();
    const sessionB = randomUUID();
    const props: { patentId: string; sessionId: string; bookKind: AiCorrectionBookKind } = {
      patentId: patentA,
      sessionId: sessionA,
      bookKind: "description" as const,
    };
    const { result, rerender } = renderHook(
      (current) =>
        useAiCorrection({
          ...current,
          openSessionIds: [sessionA, sessionB],
          editor: null,
          thinkingEnabled: false,
          prepare: async () => ({
            patentId: current.patentId,
            sessionId: current.sessionId,
            expectedRevision: 2,
          }),
        }),
      { initialProps: props },
    );

    await act(async () => result.current.start("current-book"));
    const jobId = start.mock.calls[0]?.[0].jobId;
    if (!jobId) throw new Error("missing job id");
    act(() => listener?.({ type: "completed", jobId, issues: [], resultLimitReached: false }));
    await waitFor(() => expect(result.current.status).toBe("completed"));

    rerender({ ...props, bookKind: "claims" });
    expect(result.current.status).toBe("idle");
    rerender(props);
    expect(result.current.status).toBe("completed");
    rerender({ patentId: patentB, sessionId: sessionB, bookKind: "description" });
    expect(result.current.status).toBe("idle");
    rerender(props);
    expect(result.current.status).toBe("completed");
  });

  test("tracks concurrent jobs independently for different books in one patent", async () => {
    let listener: ((event: AiCorrectionEvent) => void) | undefined;
    const start = vi.fn(async (request: { jobId: string }) => ({
      ok: true as const,
      value: { jobId: request.jobId },
    }));
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        aiCorrection: {
          start,
          cancel: vi.fn(),
          onEvent: (next: typeof listener) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const patentId = randomUUID();
    const sessionId = randomUUID();
    const props: { patentId: string; sessionId: string; bookKind: AiCorrectionBookKind } = {
      patentId,
      sessionId,
      bookKind: "claims",
    };
    const { result, rerender } = renderHook(
      (current) =>
        useAiCorrection({
          ...current,
          openSessionIds: [sessionId],
          editor: null,
          thinkingEnabled: true,
          prepare: async () => ({ patentId, sessionId, expectedRevision: 3 }),
        }),
      { initialProps: props },
    );

    await act(async () => result.current.start("current-book"));
    const claimsJobId = start.mock.calls[0]?.[0].jobId;
    if (!claimsJobId) throw new Error("missing claims job id");
    rerender({ ...props, bookKind: "description" });
    expect(result.current.status).toBe("idle");

    await act(async () => result.current.start("current-book"));
    const descriptionJobId = start.mock.calls[1]?.[0].jobId;
    if (!descriptionJobId) throw new Error("missing description job id");
    rerender(props);
    expect(result.current.status).toBe("running");
    act(() =>
      listener?.({ type: "completed", jobId: claimsJobId, issues: [], resultLimitReached: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("completed"));

    rerender({ ...props, bookKind: "description" });
    expect(result.current.status).toBe("running");
    act(() => listener?.({ type: "cancelled", jobId: descriptionJobId }));
    await waitFor(() => expect(result.current.status).toBe("cancelled"));
  });
});
