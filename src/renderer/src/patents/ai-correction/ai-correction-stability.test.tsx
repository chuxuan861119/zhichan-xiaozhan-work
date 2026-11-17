import { createHash, randomUUID } from "node:crypto";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type {
  AiCorrectionEvent,
  AiCorrectionIssue,
  AiCorrectionStartRequest,
} from "../../../../shared/ai-correction/contract";
import { createBlankPatent } from "../../../../shared/patent/defaults";
import { createPatentExtensions } from "../../editor/extensions";
import { AiCorrectionPanel } from "./ai-correction-panel";
import { applyCorrectionIssues, locateCorrectionAnchor } from "./correction-anchor";
import { useAiCorrection } from "./use-ai-correction";

const issue: AiCorrectionIssue = {
  issueId: randomUUID(),
  category: "spelling",
  risk: "low",
  applicability: "replace",
  replacement: "正确",
  explanation: "错字",
  anchor: {
    bookKind: "description",
    blockId: randomUUID(),
    startOffset: 0,
    endOffset: 2,
    originalText: "错误",
    originalTextHash: "0".repeat(64),
  },
};
const noop = () => undefined;
const panelProps = {
  open: true,
  onStart: noop,
  onCancel: noop,
  onClose: noop,
  onOpenSettings: noop,
  onLocate: noop,
  onAccept: noop,
  onBatchAccept: noop,
};

function setup(prepareWait: Promise<void> = Promise.resolve(), editor: Editor | null = null) {
  const prepared = { patentId: randomUUID(), sessionId: randomUUID(), expectedRevision: 0 };
  let listener: (event: AiCorrectionEvent) => void = noop;
  const start = vi.fn(async (request: AiCorrectionStartRequest) => ({
    ok: true as const,
    value: { jobId: request.jobId },
  }));
  const cancel = vi.fn(async () => ({
    ok: false as const,
    error: { code: "INTERNAL" as const, message: "停止请求失败" },
  }));
  const api = {
    start,
    cancel,
    onEvent: (next: typeof listener) => {
      listener = next;
      return noop;
    },
  };
  Object.defineProperty(window, "patentApi", { configurable: true, value: { aiCorrection: api } });
  const openSessionIds = [prepared.sessionId];
  const hook = renderHook(() =>
    useAiCorrection({
      ...prepared,
      openSessionIds,
      bookKind: "description",
      editor,
      thinkingEnabled: true,
      prepare: async () => {
        await prepareWait;
        return prepared;
      },
    }),
  );
  return { ...hook, start, cancel, emit: (event: AiCorrectionEvent) => listener(event) };
}

describe("AI correction stability regressions", () => {
  test("does not revive a cancelled task when preparation later rejects", async () => {
    let rejectPreparation!: (error: Error) => void;
    const hook = setup(
      new Promise<void>((_, reject) => {
        rejectPreparation = reject;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.start("current-book");
    });
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );
    await act(async () => hook.result.current.cancel());
    await act(async () => {
      rejectPreparation(new Error("保存失败"));
      await settled;
    });
    expect(await settled).toBe("resolved");
    expect(hook.result.current.status).toBe("cancelled");
    expect(hook.start).not.toHaveBeenCalled();
    hook.unmount();
  });
  test("tracks changes while awaiting results and after sequential acceptance", async () => {
    const blockId = randomUUID();
    const editor = new Editor({
      extensions: createPatentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { nodeId: blockId },
            content: [{ type: "text", text: "错误与语病" }],
          },
        ],
      },
    });
    const hook = setup(Promise.resolve(), editor);
    try {
      await act(async () => hook.result.current.start("current-book"));
      const jobId = hook.start.mock.calls[0]?.[0].jobId;
      if (!jobId) throw new Error("job missing");
      const a = {
        ...issue,
        replacement: "正",
        anchor: { ...issue.anchor, blockId, contextBefore: "", contextAfter: "与语病" },
      };
      const b = {
        ...issue,
        issueId: randomUUID(),
        replacement: "表述",
        anchor: {
          ...issue.anchor,
          blockId,
          startOffset: 3,
          endOffset: 5,
          originalText: "语病",
          contextBefore: "错误与",
          contextAfter: "",
        },
      };
      editor.commands.insertContentAt(1, "前文");
      act(() => hook.emit({ type: "completed", jobId, issues: [a, b], resultLimitReached: false }));
      expect(applyCorrectionIssues(editor, [a]).skippedIssueIds).toEqual([]);
      expect(locateCorrectionAnchor(editor, b).status).toBe("ready");
      expect(applyCorrectionIssues(editor, [b]).skippedIssueIds).toEqual([]);
      expect(editor.getText()).toBe("前文正与表述");
    } finally {
      hook.unmount();
      editor.destroy();
    }
  });
  test("locks the document before asynchronous preparation and preserves the first job", async () => {
    let release!: () => void;
    const hook = setup(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      const first = hook.result.current.start("current-book");
      const second = hook.result.current.start("current-book");
      release();
      await Promise.all([first, second]);
    });
    expect(hook.start).toHaveBeenCalledTimes(1);
    const jobId = hook.start.mock.calls[0]![0].jobId;
    act(() => hook.emit({ type: "completed", jobId, issues: [issue], resultLimitReached: false }));
    expect(hook.result.current.issues).toEqual([issue]);
  });

  test("makes cancellation failures visible and permits retry", async () => {
    const hook = setup();
    await act(async () => hook.result.current.start("current-book"));
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.error).toBe("停止请求失败");
    expect(hook.result.current.status).toBe("running");
    await act(async () => hook.result.current.cancel());
    expect(hook.cancel).toHaveBeenCalledTimes(2);
  });

  test("retains partial results through failure and distinguishes accepted suggestions", async () => {
    const hook = setup();
    await act(async () => hook.result.current.start("current-book"));
    const jobId = hook.start.mock.calls[0]![0].jobId;
    act(() =>
      hook.emit({
        type: "partial",
        jobId,
        issues: [issue],
        resultLimitReached: true,
        discardedIssueCount: 0,
        completedChunks: 1,
        totalChunks: 2,
      }),
    );
    act(() => hook.emit({ type: "failed", jobId, message: "后续超时" }));
    expect(hook.result.current.issues).toEqual([issue]);
    expect(hook.result.current.progress).toEqual({ completed: 1, total: 2 });
    expect(hook.result.current.resultLimitReached).toBe(true);
    act(() => hook.result.current.removeIssues([issue.issueId]));
    expect(hook.result.current.reportedIssueCount).toBe(1);
    render(
      <AiCorrectionPanel
        {...panelProps}
        status="failed"
        issues={hook.result.current.issues}
        reportedIssueCount={hook.result.current.reportedIssueCount}
        error="后续超时"
      />,
    );
    expect(screen.getByText("建议已全部处理。")).toBeTruthy();
    expect(screen.getByText(/检查未完成/u)).toBeTruthy();
  });

  test("stopping during preparation prevents uploading the document", async () => {
    let release!: () => void;
    const hook = setup(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.start("current-book");
    });
    await act(async () => hook.result.current.cancel());
    await act(async () => {
      release();
      await pending;
    });
    expect(hook.start).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("cancelled");
  });

  test.each(["empty-paragraph", "hard-break"] as const)(
    "accepts an unchanged full selection containing %s end to end",
    async (mode) => {
      // Exercise the real main-process implementation without adding main code to the web TS project.
      const { buildPatentCorrectionContext } = await vi.importActual<{
        buildPatentCorrectionContext(
          patent: ReturnType<typeof createBlankPatent>,
          scope: AiCorrectionStartRequest["scope"],
          limit: number,
        ): { characterCount: number };
      }>("../../../../main/ai-correction/patent-context-builder");
      const patent = createBlankPatent({ patentType: "invention", name: null });
      const book = patent.books.find((b) => b.kind === "description")!;
      const base = book.document.content.find((b) => b.type === "paragraph")!;
      if (base.type !== "paragraph") throw new Error("fixture");
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      book.document.content =
        mode === "empty-paragraph"
          ? ids.map((id, index) => ({
              ...base,
              id,
              content:
                index === 1
                  ? []
                  : [{ type: "text" as const, text: index === 0 ? "第一段" : "第二段", marks: [] }],
            }))
          : [
              {
                ...base,
                id: ids[0]!,
                content: [
                  { type: "text", text: "第一行", marks: [] },
                  { type: "hard-break" },
                  { type: "text", text: "第二行", marks: [] },
                ],
              },
            ];
      const editor = new Editor({
        extensions: createPatentExtensions(),
        content: {
          type: "doc",
          content: book.document.content.map((block) => ({
            type: "paragraph",
            attrs: { nodeId: block.id },
            content:
              block.type === "paragraph"
                ? block.content.map((node) =>
                    node.type === "text"
                      ? { type: "text", text: node.text }
                      : { type: "hardBreak" },
                  )
                : [],
          })),
        },
      });
      editor.commands.selectAll();
      const hashText = async (text: string) => ({
        ok: true as const,
        value: createHash("sha256").update(text).digest("hex"),
      });
      const start = vi.fn(async (request: AiCorrectionStartRequest) => {
        const context = buildPatentCorrectionContext(patent, request.scope, 50000);
        expect(context.characterCount).toBeGreaterThan(0);
        return { ok: true as const, value: { jobId: request.jobId } };
      });
      Object.defineProperty(window, "patentApi", {
        configurable: true,
        value: { aiCorrection: { hashText, start, cancel: noop, onEvent: () => noop } },
      });
      const prepared = {
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: patent.revision,
      };
      const openSessionIds = [prepared.sessionId];
      const hook = renderHook(() =>
        useAiCorrection({
          ...prepared,
          openSessionIds,
          bookKind: "description",
          editor,
          thinkingEnabled: true,
          prepare: async () => prepared,
        }),
      );
      try {
        await act(async () => hook.result.current.start("selection"));
        expect(hook.result.current.status).toBe("running");
      } finally {
        hook.unmount();
        editor.destroy();
      }
    },
  );

  test("does not describe ignored suggestions as an error-free inspection", () => {
    render(<AiCorrectionPanel {...panelProps} status="completed" issues={[issue]} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.queryByText("当前范围未发现可报告的问题。")).toBeNull();
    expect(screen.getByText(/建议已全部忽略/u)).toBeTruthy();
  });

  test("keeps partial results visible with an explicit incomplete warning", () => {
    render(
      <AiCorrectionPanel {...panelProps} status="failed" issues={[issue]} error="第二部分超时" />,
    );
    expect(screen.getByText("错误")).toBeTruthy();
    expect(screen.getByText(/检查未完成/u)).toBeTruthy();
    expect(screen.getByText(/第二部分超时/u)).toBeTruthy();
  });

  test("shows a cancellation error alongside the stop control", () => {
    render(<AiCorrectionPanel {...panelProps} status="running" issues={[]} error="停止请求失败" />);
    expect(screen.getByRole("alert").textContent).toContain("停止请求失败");
    expect(screen.getByRole("button", { name: "停止思考" })).toBeTruthy();
  });
});
