import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  type AiCorrectionSettings,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "../../shared/ai-correction/model.js";
import type {
  TextPolishAssistantReply,
  TextPolishConversationSendRequest,
  TextPolishConversationStartRequest,
} from "../../shared/ai-correction/text-polish-contract.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { AiRequestError } from "./https-json-client.js";
import {
  ContextWindowExceededError,
  IncompatibleModelError,
} from "./openai-compatible-provider.js";
import { PatentPolishService } from "./patent-polish-service.js";

function fixture() {
  const patent = createBlankPatent({ patentType: "invention", name: "不得上传" });
  patent.revision = 7;
  const book = patent.books.find((candidate) => candidate.kind === "description");
  const block = book?.document.content.find((candidate) => candidate.type === "paragraph");
  if (!book || block?.type !== "paragraph") throw new Error("fixture");
  block.content = [{ type: "text", text: "该装置能够进行工作。", marks: [] }];
  const selectedText = "能够进行工作";
  const startOffset = 3;
  return { patent, block, selectedText, startOffset };
}

describe("patent polish service", () => {
  test("sends only the verified selection and emits an anchored polish result", async () => {
    const { patent, block, selectedText, startOffset } = fixture();
    const profileId = randomUUID();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const polish = vi.fn(
      async (
        _input: Parameters<
          ConstructorParameters<typeof PatentPolishService>[0]["provider"]["polish"]
        >[0],
      ) => "可正常工作",
    );
    const service = new PatentPolishService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "model-a",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => structuredClone(patent) },
      provider: { polish },
      emit: (event) => {
        events.push(event);
        if (event.type === "polish-completed" || event.type === "failed") finish();
      },
    });
    const jobId = randomUUID();

    await service.start({
      jobId,
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: {
        kind: "selection",
        bookKind: "description",
        blocks: [
          {
            blockId: block.id,
            blockType: "paragraph",
            startOffset,
            endOffset: startOffset + selectedText.length,
          },
        ],
        selectedTextHash: createHash("sha256").update(selectedText).digest("hex"),
      },
      requirement: "更加简洁",
      uploadConfirmed: true,
    });
    await completed;

    expect(polish).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedText,
        requirement: "更加简洁",
        timeoutMs: 600_000,
        thinkingEnabled: true,
      }),
    );
    expect(JSON.stringify(polish.mock.calls[0]?.[0])).not.toContain("不得上传");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "polish-completed",
        jobId,
        result: {
          anchor: expect.objectContaining({
            bookKind: "description",
            blocks: [
              {
                blockId: block.id,
                blockType: "paragraph",
                startOffset,
                endOffset: startOffset + selectedText.length,
              },
            ],
            originalText: selectedText,
          }),
          polishedText: "可正常工作",
        },
      }),
    );
  });

  test("generates a standalone draft from a requirement without reading patent text or emitting an anchor", async () => {
    const { patent } = fixture();
    const profileId = randomUUID();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const polish = vi.fn(
      async (
        _input: Parameters<
          ConstructorParameters<typeof PatentPolishService>[0]["provider"]["polish"]
        >[0],
      ) => "一种电池冷却机构，包括电池主体和冷却组件。",
    );
    const service = new PatentPolishService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "model-a",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => structuredClone(patent) },
      provider: { polish },
      emit: (event) => {
        events.push(event);
        if (event.type === "polish-completed" || event.type === "failed") finish();
      },
    });
    const jobId = randomUUID();

    await service.start({
      jobId,
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "generation", bookKind: "description" },
      requirement: "起草一项电池冷却机构的技术方案。",
      uploadConfirmed: true,
    });
    await completed;

    expect(polish).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "generation",
        requirement: "起草一项电池冷却机构的技术方案。",
      }),
    );
    expect(polish.mock.calls[0]?.[0]).not.toHaveProperty("selectedText");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "polish-completed",
        jobId,
        result: {
          kind: "generated",
          generatedText: "一种电池冷却机构，包括电池主体和冷却组件。",
        },
      }),
    );
  });

  test("sends one verified continuous selection across multiple paragraphs", async () => {
    const { patent, block, startOffset } = fixture();
    const book = patent.books.find((candidate) => candidate.kind === "description");
    if (!book) throw new Error("fixture");
    const secondBlock = structuredClone(block);
    secondBlock.id = randomUUID();
    secondBlock.content = [{ type: "text", text: "第二段文字。", marks: [] }];
    const sourceIndex = book.document.content.findIndex((candidate) => candidate.id === block.id);
    book.document.content.splice(sourceIndex + 1, 0, secondBlock);
    const selectedText = "能够进行工作。\n第二段";
    const profileId = randomUUID();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const polish = vi.fn(async () => "能够稳定运行。\n第二部分");
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const service = new PatentPolishService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "model-a",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => structuredClone(patent) },
      provider: { polish },
      emit: (event) => {
        events.push(event);
        if (event.type === "polish-completed") finish();
      },
    });

    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: {
        kind: "selection",
        bookKind: "description",
        blocks: [
          { blockId: block.id, blockType: "paragraph", startOffset, endOffset: 10 },
          {
            blockId: secondBlock.id,
            blockType: "paragraph",
            startOffset: 0,
            endOffset: 3,
          },
        ],
        selectedTextHash: createHash("sha256").update(selectedText).digest("hex"),
      },
      requirement: "保持段落层次",
      uploadConfirmed: true,
    });
    await completed;

    expect(polish).toHaveBeenCalledWith(expect.objectContaining({ selectedText }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "polish-completed",
        result: expect.objectContaining({
          anchor: expect.objectContaining({
            blocks: [
              { blockId: block.id, blockType: "paragraph", startOffset, endOffset: 10 },
              {
                blockId: secondBlock.id,
                blockType: "paragraph",
                startOffset: 0,
                endOffset: 3,
              },
            ],
            originalText: selectedText,
          }),
        }),
      }),
    );
  });

  test("rejects a second running polish for the same book and supports cancellation", async () => {
    const { patent, block, selectedText, startOffset } = fixture();
    const profileId = randomUUID();
    const events: string[] = [];
    const service = new PatentPolishService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "model-a",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: {
        polish: async ({ signal }) =>
          await new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => resolve(""), { once: true });
          }),
      },
      emit: (event) => events.push(event.type),
    });
    const request = {
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: {
        kind: "selection" as const,
        bookKind: "description" as const,
        blocks: [
          {
            blockId: block.id,
            blockType: "paragraph" as const,
            startOffset,
            endOffset: startOffset + selectedText.length,
          },
        ],
        selectedTextHash: createHash("sha256").update(selectedText).digest("hex"),
      },
      requirement: "",
      uploadConfirmed: true as const,
    };

    await service.start(request);
    await expect(service.start({ ...request, jobId: randomUUID() })).rejects.toMatchObject({
      code: "BUSY",
    });
    expect(service.cancel(request.jobId)).toBe(true);
    await vi.waitFor(() => expect(events).toContain("cancelled"));
  });
});

function conversationFixture(
  history?: import("./text-polish-history-store.js").TextPolishHistoryStore,
) {
  const { patent, block, selectedText, startOffset } = fixture();
  const profileId = randomUUID();
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const provider = {
    polish: vi.fn(async () => "旧接口结果"),
    converseTextPolish: vi.fn(
      async (
        _input: Parameters<
          NonNullable<
            ConstructorParameters<typeof PatentPolishService>[0]["provider"]["converseTextPolish"]
          >
        >[0],
      ): Promise<TextPolishAssistantReply> => ({
        kind: "revision" as const,
        message: "已按要求修订。",
        revisedText: "一种改进装置。",
      }),
    ),
    summarizeTextPolishConversation: vi.fn<
      NonNullable<
        ConstructorParameters<
          typeof PatentPolishService
        >[0]["provider"]["summarizeTextPolishConversation"]
      >
    >(async () => ({
      coveredThroughMessageId: null,
      items: [],
    })),
  };
  const settings: AiCorrectionSettings = {
    ...DEFAULT_AI_CORRECTION_SETTINGS,
    activeProfileId: profileId,
    profiles: [
      {
        profileId,
        providerId: "deepseek",
        displayName: "测试模型",
        baseUrl: "https://api.deepseek.com",
        model: "model-a",
      },
    ],
  };
  const vault: ConstructorParameters<typeof PatentPolishService>[0]["vault"] = {
    hasApiKey: async () => true,
    withApiKey: async (_profileId, use) => await use("secret"),
  };
  const service = new PatentPolishService({
    ...(history ? { history } : {}),
    readSettings: async () => settings,
    vault,
    patents: { requireActiveReadSession: () => structuredClone(patent) },
    provider,
    emit: (event) => events.push(event),
  });
  const startRequest: TextPolishConversationStartRequest = {
    clientRequestId: randomUUID(),
    patentId: patent.patentId,
    sessionId: randomUUID(),
    expectedPatentRevision: patent.revision,
    scope: {
      kind: "selection",
      bookKind: "description",
      blocks: [
        {
          blockId: block.id,
          blockType: "paragraph",
          startOffset,
          endOffset: startOffset + selectedText.length,
        },
      ],
      selectedTextHash: createHash("sha256").update(selectedText).digest("hex"),
    },
    instruction: "更加严谨",
    uploadConfirmed: true,
  };
  return { service, provider, events, patent, startRequest, profileId, settings, vault };
}

describe("patent polish conversation state machine", () => {
  test("sends and retries independent reference material without merging it into instructions", async () => {
    const { service, provider, startRequest } = conversationFixture();
    const first = await service.startConversation("owner", startRequest);
    const identity = {
      patentId: first.snapshot.patentId,
      sessionId: first.snapshot.sessionId,
      bookKind: first.snapshot.bookKind,
      conversationId: first.conversationId,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    const before = await service.snapshotConversation("owner", identity);
    provider.converseTextPolish.mockRejectedValueOnce(new Error("network failure"));
    const referenceText = "参".repeat(20000);
    const sent = await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: before.conversationRevision,
      kind: "new",
      instruction: "解释",
      referenceText,
    });
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    const failed = await service.snapshotConversation("owner", identity);
    expect(provider.converseTextPolish.mock.calls.at(-1)?.[0]).toMatchObject({
      instruction: "解释",
      referenceText,
    });
    expect(failed.messages.at(-1)).toMatchObject({ role: "user", text: "解释", referenceText });
    if (!sent.snapshot.activeTurn) throw new Error("Missing submitted turn");
    await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: failed.conversationRevision,
      kind: "retry",
      turnId: sent.snapshot.activeTurn.turnId,
    });
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    expect(provider.converseTextPolish.mock.calls.at(-1)?.[0].referenceText).toBe(referenceText);
  });
  test.each(["capacity", "mixed"] as const)(
    "protects restored conversation boundary: %s",
    async (mode) => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
      const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "assistant-boundary-")));
      const { service, provider, startRequest } = conversationFixture(store);
      const first = await service.startConversation("owner", startRequest);
      const identity = {
        patentId: first.snapshot.patentId,
        sessionId: first.snapshot.sessionId,
        bookKind: first.snapshot.bookKind,
        conversationId: first.conversationId,
      };
      await vi.waitFor(async () =>
        expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
      );
      const snapshot = await service.snapshotConversation("owner", identity);
      service.releaseSession(identity.sessionId);
      if (mode === "capacity") {
        snapshot.messages = Array.from({ length: 33 }, () => ({
          role: "assistant" as const,
          messageId: randomUUID(),
          turnId: randomUUID(),
          reply: { kind: "revision" as const, message: "完成", revisedText: "文".repeat(20000) },
        }));
        snapshot.latestValidDraft = "文".repeat(20000);
      } else {
        if (snapshot.source.kind !== "selection") throw new Error("fixture");
        snapshot.source.anchor.formatVersion = 2;
        snapshot.latestValidDraft = '〔片段1 正文〕使用〔只读1.1 公式 "x+y"〕计算。';
      }
      store.save(snapshot);
      const restored = await service.workspace("owner", { ...identity, action: "open" });
      if (!restored.snapshot) throw new Error("fixture");
      if (mode === "capacity") {
        await expect(
          service.sendConversation("owner", {
            identity,
            clientRequestId: randomUUID(),
            expectedConversationRevision: restored.snapshot.conversationRevision,
            kind: "new",
            instruction: "继续",
          }),
        ).rejects.toMatchObject({ code: "CONTEXT_CAPACITY_EXCEEDED" });
        expect((await service.snapshotConversation("owner", identity)).messages).toEqual(
          snapshot.messages,
        );
      } else {
        const next = await service.workspace("owner", {
          ...identity,
          action: "continue-new",
          expectedConversationRevision: restored.snapshot.conversationRevision,
          continuation: "保留公式",
        });
        expect(next.snapshot?.latestValidDraft).toBe("使用x+y计算。");
      }
      expect(provider.converseTextPolish).toHaveBeenCalledOnce();
    },
  );
  test("stops a live request even when history listing and draft persistence are unavailable", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "assistant-stop-")));
    const { service, provider, startRequest } = conversationFixture(store);
    let signal: AbortSignal | undefined;
    provider.converseTextPolish.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        }),
    );
    const first = await service.startConversation("owner", startRequest);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const list = vi.spyOn(store, "list").mockRejectedValue(new Error("unavailable"));
    const writes = vi
      .spyOn(store, "waitForDraftWrites")
      .mockRejectedValue(new Error("unavailable"));
    await service.workspace("owner", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      conversationId: first.conversationId,
      action: "stop",
    });
    expect(signal?.aborted).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
  test("deletion validates the next draft before removing the active conversation", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const root = mkdtempSync(join(tmpdir(), "assistant-delete-atomic-"));
    const store = new TextPolishHistoryStore(root);
    const { service, startRequest } = conversationFixture(store);
    const first = await service.startConversation("owner", startRequest);
    await vi.waitFor(() =>
      expect(store.snapshot(startRequest.patentId, first.conversationId)?.activeTurn).toBeNull(),
    );
    writeFileSync(join(root, startRequest.patentId, "draft-new.json"), "broken");
    await expect(
      service.workspace("owner", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        conversationId: first.conversationId,
        action: "delete",
      }),
    ).rejects.toThrow();
    expect(store.snapshot(startRequest.patentId, first.conversationId)).not.toBeNull();
    expect(store.active(startRequest.patentId)).toBe(first.conversationId);
  });
  test("manages owned histories, rejects running deletion and carries only reviewed context into a new chat", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "assistant-manage-")));
    const { service, provider, startRequest } = conversationFixture(store);
    let resolve!: (reply: TextPolishAssistantReply) => void;
    provider.converseTextPolish.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = await service.startConversation("owner", startRequest);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const base = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      conversationId: first.conversationId,
    };
    await expect(service.workspace("other", { ...base, action: "delete" })).rejects.toThrow();
    await expect(service.workspace("owner", { ...base, action: "delete" })).rejects.toMatchObject({
      code: "BUSY",
    });
    const running = await service.workspace("owner", { ...base, action: "load" });
    expect(running.history[0]?.status).toBe("running");
    resolve({ kind: "revision", message: "完成", revisedText: "最新稿件" });
    await vi.waitFor(() =>
      expect(store.snapshot(base.patentId, base.conversationId)?.activeTurn).toBeNull(),
    );
    const renamed = await service.workspace("owner", {
      ...base,
      action: "rename",
      title: "命名的会话",
    });
    expect(renamed.history[0]?.title).toBe("命名的会话");
    if (!renamed.snapshot) throw new Error("Missing current conversation");
    const next = await service.workspace("owner", {
      ...base,
      action: "continue-new",
      expectedConversationRevision: renamed.snapshot.conversationRevision,
      continuation: "只保留已确认术语",
    });
    expect(next.snapshot?.conversationId).not.toBe(first.conversationId);
    expect(next.snapshot?.source).toMatchObject({
      kind: "generation",
      requirement: "只保留已确认术语",
    });
    expect(next.snapshot?.latestValidDraft).toBe("最新稿件");
    expect(next.snapshot?.messages).toEqual([]);
    expect(provider.converseTextPolish).toHaveBeenCalledOnce();
    const deleted = await service.workspace("owner", { ...base, action: "delete" });
    expect(deleted.history).toHaveLength(1);
    expect(deleted.snapshot?.conversationId).toBe(next.snapshot?.conversationId);
  });
  test("runs independent conversations in one patent and restores live history without cancelling", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "assistant-independent-")));
    const { service, provider, startRequest } = conversationFixture(store);
    const pending: Array<{ signal: AbortSignal; resolve(value: TextPolishAssistantReply): void }> =
      [];
    provider.converseTextPolish.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          pending.push({ signal: input.signal, resolve });
        }),
    );
    const first = await service.startConversation("owner", startRequest);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // A streaming revision may advance after the user clicks New conversation.
    await service.resetConversation("owner", {
      identity: first.snapshot,
      expectedConversationRevision: first.snapshot.conversationRevision,
    });
    expect(pending[0]?.signal.aborted).toBe(false);
    const second = await service.startConversation("owner", {
      ...startRequest,
      clientRequestId: randomUUID(),
      scope: { kind: "generation", bookKind: "abstract" },
      instruction: "第二个独立任务",
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const background = await service.snapshotConversation("owner", {
      ...startRequest,
      bookKind: "claims",
      conversationId: first.conversationId,
    });
    expect(background.activeTurn?.turnId).toBe(first.turnId);
    await expect(
      service.snapshotConversation("other-owner", {
        ...startRequest,
        bookKind: "description",
        conversationId: first.conversationId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.snapshotConversation("owner", {
        ...startRequest,
        patentId: randomUUID(),
        bookKind: "description",
        conversationId: first.conversationId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() => service.assertReadyForDataTransfer()).toThrow(/思考/);
    const duplicate = await service.startConversation("owner", startRequest);
    expect(duplicate.conversationId).toBe(first.conversationId);
    const opened = await service.workspace("owner", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      action: "open",
      conversationId: first.conversationId,
    });
    expect(opened.snapshot?.activeTurn?.turnId).toBe(first.turnId);
    expect(opened.snapshot?.source).toEqual(first.snapshot.source);
    expect(opened.history).toHaveLength(2);
    service.cancelConversation("owner", { identity: first.snapshot, turnId: first.turnId });
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(false);
    pending[0]?.resolve({ kind: "answer", message: "不能进入第二个对话" });
    pending[1]?.resolve({ kind: "answer", message: "第二个独立回复" });
    await vi.waitFor(() =>
      expect(
        store.snapshot(startRequest.patentId, second.conversationId)?.lastTurnOutcome?.status,
      ).toBe("completed"),
    );
    const secondOpened = await service.workspace("owner", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      action: "open",
      conversationId: second.conversationId,
    });
    expect(secondOpened.snapshot?.messages).toHaveLength(2);
    expect(secondOpened.snapshot?.messages.at(-1)).toMatchObject({
      reply: { message: "第二个独立回复" },
    });
    expect(provider.converseTextPolish.mock.calls[1]?.[0].source).toEqual(second.snapshot.source);
    expect(JSON.stringify(provider.converseTextPolish.mock.calls[1]?.[0].messages)).not.toContain(
      "更加严谨",
    );
    const firstSaved = store.snapshot(startRequest.patentId, first.conversationId);
    expect(firstSaved?.lastTurnOutcome?.status).toBe("cancelled");
    provider.converseTextPolish.mockResolvedValue({ kind: "answer", message: "继续 B" });
    if (!secondOpened.snapshot) throw new Error("Missing second conversation");
    await service.sendConversation("owner", {
      identity: { ...second.snapshot, bookKind: "claims" },
      expectedConversationRevision: secondOpened.snapshot.conversationRevision,
      clientRequestId: randomUUID(),
      kind: "new",
      instruction: "追加 B 的要求",
    });
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledTimes(3));
    expect(provider.converseTextPolish.mock.calls[2]?.[0].source).toEqual(second.snapshot.source);
    expect(JSON.stringify(provider.converseTextPolish.mock.calls[2]?.[0].messages)).not.toContain(
      "更加严谨",
    );
    service.releaseOwner("owner");
  });
  test("closing the patent releases every background conversation but no other patent", async () => {
    const { service, provider, startRequest } = conversationFixture();
    const signals: AbortSignal[] = [];
    provider.converseTextPolish.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const first = await service.startConversation("owner", startRequest);
    await service.resetConversation("owner", {
      identity: first.snapshot,
      expectedConversationRevision: first.snapshot.conversationRevision,
    });
    await service.startConversation("owner", { ...startRequest, clientRequestId: randomUUID() });
    const other = await service.startConversation("owner", {
      ...startRequest,
      patentId: randomUUID(),
      sessionId: randomUUID(),
      clientRequestId: randomUUID(),
    });
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    service.releaseSession(startRequest.sessionId, startRequest.patentId);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    expect((await service.snapshotConversation("owner", other.snapshot)).activeTurn).not.toBeNull();
    await expect(service.snapshotConversation("owner", first.snapshot)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    service.releaseOwner("owner");
  });
  test.each([1000, 12_500])(
    "compresses an oversized turn within a %i-character upload budget and persists it",
    async (limit) => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
      const directory = mkdtempSync(join(tmpdir(), "polish-compaction-"));
      const history = new TextPolishHistoryStore(directory);
      const { service, provider, startRequest, settings } = conversationFixture(history);
      settings.maxUploadCharacters = limit;
      const oldAnswer = "内容".repeat(9000);
      provider.converseTextPolish.mockResolvedValueOnce({ kind: "answer", message: oldAnswer });
      const started = await service.startConversation("owner", startRequest);
      const identity = {
        ...startRequest,
        conversationId: started.conversationId,
        bookKind: "description" as const,
      };
      const read = () => service.snapshotConversation("owner", identity);
      await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
      const before = await read();
      const first = before.messages[0];
      if (first?.role !== "user") throw new Error("fixture");
      const received: string[] = [];
      provider.summarizeTextPolishConversation.mockImplementation(async (input) => {
        expect((await read()).activeTurn).toMatchObject({
          status: "summarizing",
          summaryBatch: received.length + 1,
        });
        const batchText = input.messages
          .map((m) => (m.role === "assistant" ? m.reply.message : m.text))
          .join("");
        const summarySize =
          input.previousSummary?.items.reduce(
            (n, i) => n + i.text.length + i.evidenceQuotes.join("").length,
            0,
          ) ?? 0;
        expect(batchText.length + summarySize).toBeLessThanOrEqual(limit);
        received.push(batchText);
        return {
          coveredThroughMessageId: input.coveredThroughMessageId,
          items: [
            {
              kind: "requirement",
              text: first.text,
              sourceMessageIds: [first.messageId],
              evidenceQuotes: [first.text],
            },
          ],
        };
      });
      await service.sendConversation("owner", {
        identity,
        clientRequestId: randomUUID(),
        expectedConversationRevision: before.conversationRevision,
        kind: "new",
        instruction: "继续",
      });
      await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
      const after = await read();
      expect(after.lastTurnOutcome?.status).toBe("completed");
      expect(received.join("")).toBe(first.text + oldAnswer);
      expect(after.messages).toEqual(expect.arrayContaining(before.messages));
      const persisted = new TextPolishHistoryStore(directory).snapshot(
        identity.patentId,
        identity.conversationId,
      );
      expect(persisted?.summary).toEqual(after.summary);
      expect(persisted?.summary).not.toBeNull();
      expect(persisted?.messages).toEqual(after.messages);
      expect(persisted?.latestValidDraft).toEqual(after.latestValidDraft);
    },
  );

  test.each([6, 20_000])(
    "compacts actual history after overflow with a %i-character source",
    async (sourceLength) => {
      const { service, provider, startRequest, patent, events } = conversationFixture();
      const block = patent.books
        .find((b) => b.kind === "description")
        ?.document.content.find((b) => b.type === "paragraph");
      if (block?.type !== "paragraph" || startRequest.scope.kind !== "selection")
        throw new Error("fixture");
      const originalText = "原".repeat(sourceLength);
      block.content = [{ type: "text", text: originalText, marks: [] }];
      startRequest.scope.blocks = [
        { blockId: block.id, blockType: "paragraph", startOffset: 0, endOffset: sourceLength },
      ];
      startRequest.scope.selectedTextHash = createHash("sha256").update(originalText).digest("hex");
      provider.converseTextPolish.mockResolvedValueOnce({
        kind: "answer",
        message: "旧回复".repeat(1000),
      });
      const started = await service.startConversation("owner", startRequest);
      const identity = {
        ...startRequest,
        conversationId: started.conversationId,
        bookKind: "description" as const,
      };
      const read = () => service.snapshotConversation("owner", identity);
      await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
      const before = await read();
      const first = before.messages[0];
      if (first?.role !== "user") throw new Error("fixture");
      provider.summarizeTextPolishConversation.mockImplementation(async (input) => ({
        coveredThroughMessageId: input.coveredThroughMessageId,
        items: [
          {
            kind: "requirement",
            text: first.text,
            sourceMessageIds: [first.messageId],
            evidenceQuotes: [first.text],
          },
        ],
      }));
      provider.converseTextPolish.mockRejectedValueOnce(new ContextWindowExceededError());
      await service.sendConversation("owner", {
        identity,
        clientRequestId: randomUUID(),
        expectedConversationRevision: before.conversationRevision,
        kind: "new",
        instruction: "继续",
      });
      await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
      expect((await read()).lastTurnOutcome?.status).toBe("completed");
      expect(provider.summarizeTextPolishConversation).toHaveBeenCalled();
      const requests = provider.converseTextPolish.mock.calls.map(([request]) => request);
      expect(JSON.stringify(requests[2]?.messages).length).toBeLessThan(
        JSON.stringify(requests[1]?.messages).length,
      );
      expect(requests[2]?.source).toEqual(requests[1]?.source);
      expect((await read()).messages).toEqual(expect.arrayContaining(before.messages));
      expect(events.some((event) => event.type === "summary")).toBe(true);
    },
  );

  test("does not resend an identical request after overflow when no history is compressible", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish.mockRejectedValue(new ContextWindowExceededError());
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      ...startRequest,
      conversationId: started.conversationId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    expect(provider.converseTextPolish).toHaveBeenCalledTimes(1);
    expect((await service.snapshotConversation("owner", identity)).lastTurnOutcome).toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  test("does not commit or retry an overflow summary that makes the context larger", async () => {
    const { service, provider, startRequest, events } = conversationFixture();
    provider.converseTextPolish.mockResolvedValueOnce({ kind: "answer", message: "短回答" });
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      ...startRequest,
      conversationId: started.conversationId,
      bookKind: "description" as const,
    };
    const read = () => service.snapshotConversation("owner", identity);
    await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
    const before = await read();
    const first = before.messages[0];
    if (first?.role !== "user") throw new Error("fixture");
    provider.converseTextPolish.mockRejectedValueOnce(new ContextWindowExceededError());
    provider.summarizeTextPolishConversation.mockImplementation(async (input) => ({
      coveredThroughMessageId: input.coveredThroughMessageId,
      items: [
        {
          kind: "requirement",
          text: "内容".repeat(250),
          sourceMessageIds: [first.messageId],
          evidenceQuotes: [first.text],
        },
      ],
    }));
    await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: before.conversationRevision,
      kind: "new",
      instruction: "继续",
    });
    await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
    expect(provider.converseTextPolish).toHaveBeenCalledTimes(2);
    expect((await read()).summary).toBeNull();
    expect(events.some((event) => event.type === "summary")).toBe(false);
    expect((await read()).lastTurnOutcome).toMatchObject({
      status: "failed",
      message: expect.stringContaining("无法缩小上下文"),
    });
  });

  test("pins credentials with the original endpoint throughout an automatic retry", async () => {
    const { service, provider, startRequest, settings, vault } = conversationFixture();
    let key = "synthetic-original-key";
    vault.withApiKey = async (_id, use) => use(key);
    provider.converseTextPolish.mockResolvedValueOnce({
      kind: "answer",
      message: "旧回答".repeat(1000),
    });
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    const snapshot = await service.snapshotConversation("owner", identity);
    const first = snapshot.messages[0];
    if (first?.role !== "user") throw new Error("fixture");
    provider.summarizeTextPolishConversation.mockImplementation(async (input) => ({
      coveredThroughMessageId: input.coveredThroughMessageId,
      items: [
        {
          kind: "requirement",
          text: first.text,
          sourceMessageIds: [first.messageId],
          evidenceQuotes: [first.text],
        },
      ],
    }));
    provider.converseTextPolish.mockImplementationOnce(async () => {
      settings.profiles = settings.profiles.map((profile) => ({
        ...profile,
        baseUrl: "https://new-provider.example/v1",
        model: "new-model",
      }));
      key = "synthetic-new-provider-key";
      throw new ContextWindowExceededError();
    });
    await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: snapshot.conversationRevision,
      kind: "new",
      instruction: "继续",
    });
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    expect(provider.converseTextPolish).toHaveBeenCalledTimes(3);
    expect(provider.summarizeTextPolishConversation).toHaveBeenCalled();
    for (const [request] of [
      ...provider.converseTextPolish.mock.calls,
      ...provider.summarizeTextPolishConversation.mock.calls,
    ]) {
      expect(request).toMatchObject({
        baseUrl: "https://api.deepseek.com",
        model: "model-a",
        apiKey: "synthetic-original-key",
      });
    }
  });

  test("rejects a profile changed while acquiring its credentials before any request", async () => {
    const { service, provider, startRequest, settings, vault } = conversationFixture();
    vault.withApiKey = async (_id, use) => {
      settings.profiles = settings.profiles.map((profile) => ({
        ...profile,
        baseUrl: "https://new-provider.example/v1",
      }));
      return use("synthetic-new-provider-key");
    };
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    expect(provider.converseTextPolish).not.toHaveBeenCalled();
    expect((await service.snapshotConversation("owner", identity)).lastTurnOutcome).toMatchObject({
      status: "failed",
      retryable: false,
      message: expect.stringContaining("模型配置已变化"),
    });
  });

  test("charges the evolving summary against each fragment upload budget", async () => {
    const { service, provider, startRequest, settings } = conversationFixture();
    settings.maxUploadCharacters = 12_500;
    provider.converseTextPolish.mockResolvedValueOnce({
      kind: "answer",
      message: "文".repeat(12_000),
    });
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    let snap = await service.snapshotConversation("owner", identity);
    await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: snap.conversationRevision,
      kind: "new",
      instruction: "精简",
    });
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    snap = await service.snapshotConversation("owner", identity);
    const first = snap.messages[0];
    if (first?.role !== "user") throw new Error("fixture");
    const sizes: number[] = [];
    provider.summarizeTextPolishConversation.mockImplementation(async (input) => {
      sizes.push(
        input.messages.reduce(
          (total, m) =>
            total +
            (m.role === "assistant"
              ? m.reply.message.length +
                (m.reply.kind === "revision" ? m.reply.revisedText.length + 1 : 0)
              : m.text.length),
          0,
        ) +
          (input.previousSummary?.items.reduce(
            (n, i) => n + i.text.length + i.evidenceQuotes.join("").length,
            0,
          ) ?? 0),
      );
      return {
        coveredThroughMessageId: input.coveredThroughMessageId,
        items: [
          {
            kind: "requirement",
            text: "要".repeat(500),
            sourceMessageIds: [first.messageId],
            evidenceQuotes: [first.text],
          },
        ],
      };
    });
    provider.converseTextPolish.mockRejectedValueOnce(new ContextWindowExceededError());
    await service.sendConversation("owner", {
      identity,
      clientRequestId: randomUUID(),
      expectedConversationRevision: snap.conversationRevision,
      kind: "new",
      instruction: "继续",
    });
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(12_500);
    expect((await service.snapshotConversation("owner", identity)).lastTurnOutcome?.status).toBe(
      "completed",
    );
  });
  test.each(["success", "failure", "cancel"])(
    "summarizes a large complete turn atomically after provider overflow: %s",
    async (outcome) => {
      const { service, provider, startRequest } = conversationFixture();
      provider.converseTextPolish.mockResolvedValueOnce({
        kind: "revision",
        message: "解释".repeat(7500),
        revisedText: "旧稿".repeat(7500),
      });
      const started = await service.startConversation("owner", startRequest);
      const identity = {
        conversationId: started.conversationId,
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description" as const,
      };
      await vi.waitFor(async () =>
        expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
      );
      let snapshot = await service.snapshotConversation("owner", identity);
      await service.sendConversation("owner", {
        identity,
        clientRequestId: randomUUID(),
        expectedConversationRevision: snapshot.conversationRevision,
        kind: "new",
        instruction: "再修订",
      });
      await vi.waitFor(async () =>
        expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
      );
      snapshot = await service.snapshotConversation("owner", identity);
      const batches: string[] = [];
      provider.summarizeTextPolishConversation.mockImplementation(async (input) => {
        const text = input.messages
          .map((m) =>
            m.role === "assistant"
              ? [m.reply.message, m.reply.kind === "revision" ? m.reply.revisedText : ""].join("\n")
              : m.text,
          )
          .join("");
        batches.push(text);
        if (batches.length === 2 && outcome === "failure") throw new Error("summary interrupted");
        if (batches.length === 2 && outcome === "cancel") {
          const active = await service.snapshotConversation("owner", identity);
          if (active.activeTurn)
            service.cancelConversation("owner", { identity, turnId: active.activeTurn.turnId });
        }
        expect(text.length).toBeLessThanOrEqual(12_100);
        const first = snapshot.messages.find((m) => m.role === "user");
        if (first?.role !== "user") throw new Error("fixture");
        return {
          coveredThroughMessageId: input.coveredThroughMessageId,
          items: [
            {
              kind: "requirement",
              text: first.text,
              sourceMessageIds: [first.messageId],
              evidenceQuotes: [first.text],
            },
          ],
        };
      });
      provider.converseTextPolish.mockRejectedValueOnce(new ContextWindowExceededError());
      await service.sendConversation("owner", {
        identity,
        clientRequestId: randomUUID(),
        expectedConversationRevision: snapshot.conversationRevision,
        kind: "new",
        instruction: "继续",
      });
      await vi.waitFor(async () =>
        expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
      );
      const done = await service.snapshotConversation("owner", identity);
      expect(done.lastTurnOutcome?.status).toBe(
        outcome === "success" ? "completed" : outcome === "cancel" ? "cancelled" : "failed",
      );
      if (outcome !== "success") expect(done.summary).toBe(snapshot.summary);
      expect(batches.length).toBeGreaterThan(1);
      if (outcome === "success") expect(batches.join("")).toContain("旧稿");
    },
  );
  test("adopts a confirmed current model without losing dialogue or sending a request", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-model-change-")));
    const { service, provider, startRequest, settings } = conversationFixture(store);
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
    );
    const before = await service.snapshotConversation("owner", identity);
    const target = {
      profileId: randomUUID(),
      providerId: "deepseek" as const,
      displayName: "新模型",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    };
    settings.profiles.push(target);
    settings.activeProfileId = target.profileId;
    const request = {
      ...identity,
      action: "change-model" as const,
      targetModel: target,
      expectedConversationRevision: before.conversationRevision,
    };
    await expect(
      service.workspace("owner", { ...request, targetModel: { ...target, model: "outdated" } }),
    ).rejects.toThrow(/配置/);
    const save = vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    await expect(service.workspace("owner", request)).rejects.toThrow("write failed");
    expect((await service.snapshotConversation("owner", identity)).model).toEqual(before.model);
    save.mockRestore();
    const draftRead = vi.spyOn(store, "draft").mockImplementationOnce(() => {
      throw new Error("draft read failed");
    });
    await expect(service.workspace("owner", request)).rejects.toThrow("draft read failed");
    expect((await service.snapshotConversation("owner", identity)).model).toEqual(before.model);
    expect(store.snapshot(identity.patentId, identity.conversationId)?.model).toEqual(before.model);
    draftRead.mockRestore();
    const changed = await service.workspace("owner", request);
    expect(changed.snapshot?.model).toEqual(target);
    expect(changed.snapshot?.messages).toEqual(before.messages);
    expect(changed.snapshot?.latestValidDraft).toEqual(before.latestValidDraft);
    expect(provider.converseTextPolish).toHaveBeenCalledTimes(1);
    expect(store.snapshot(identity.patentId, identity.conversationId)?.model).toEqual(target);
    await expect(service.workspace("owner", request)).rejects.toThrow(/状态|更新/);
  });
  test("data transfer refuses an active turn and permits a completed saved turn", async () => {
    const { service, provider, startRequest } = conversationFixture();
    let finish!: (value: TextPolishAssistantReply) => void;
    provider.converseTextPolish.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(() => service.assertReadyForDataTransfer()).not.toThrow();
    await service.startConversation("owner", startRequest);
    expect(() => service.assertReadyForDataTransfer()).toThrow(/思考/);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish({ kind: "answer", message: "完成" });
    await vi.waitFor(() => expect(() => service.assertReadyForDataTransfer()).not.toThrow());
  });
  test("retry starts fresh reasoning instead of concatenating a failed attempt", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish
      .mockImplementationOnce(async (input) => {
        input.onReasoningDelta?.("旧思考");
        throw new AiRequestError("失败");
      })
      .mockImplementationOnce(async (input) => {
        input.onReasoningDelta?.("新思考");
        return { kind: "answer", message: "成功" };
      });
    const started = await service.startConversation("owner-a", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect(
        (await service.snapshotConversation("owner-a", identity)).lastTurnOutcome?.status,
      ).toBe("failed"),
    );
    const failed = await service.snapshotConversation("owner-a", identity);
    await service.sendConversation("owner-a", {
      identity,
      kind: "retry",
      turnId: started.turnId,
      clientRequestId: randomUUID(),
      expectedConversationRevision: failed.conversationRevision,
    });
    await vi.waitFor(async () =>
      expect(
        (await service.snapshotConversation("owner-a", identity)).lastTurnOutcome?.status,
      ).toBe("completed"),
    );
    expect(
      (await service.snapshotConversation("owner-a", identity)).reasoningByTurn?.[started.turnId]
        ?.text,
    ).toBe("新思考");
  });

  test("a damaged active conversation does not prevent loading a new workspace", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const root = mkdtempSync(join(tmpdir(), "polish-damaged-"));
    const store = new TextPolishHistoryStore(root);
    const { service, startRequest } = conversationFixture(store);
    const id = randomUUID();
    store.activate(startRequest.patentId, id);
    const path = join(root, startRequest.patentId, `conversation-${id}.json`);
    writeFileSync(path, "broken", "utf8");
    const result = await service.workspace("owner-a", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      action: "load",
      conversationId: null,
    });
    expect(result.snapshot).toBeNull();
    expect(result.history[0]?.error).toBeTruthy();
    expect(readFileSync(path, "utf8")).toBe("broken");
    const started = await service.startConversation("owner-a", startRequest);
    await vi.waitFor(async () =>
      expect(
        (
          await service.snapshotConversation("owner-a", {
            patentId: startRequest.patentId,
            sessionId: startRequest.sessionId,
            bookKind: "description",
          })
        ).lastTurnOutcome?.status,
      ).toBe("completed"),
    );
    const refreshed = await service.workspace("owner-a", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      action: "load",
      conversationId: null,
    });
    expect(refreshed.history).toHaveLength(2);
    expect(refreshed.snapshot?.conversationId).toBe(started.conversationId);
    expect(readFileSync(path, "utf8")).toBe("broken");
  });
  test("a missing active record warns but permits a new dialogue; explicit open still fails", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-missing-")));
    const { service, startRequest } = conversationFixture(store);
    const missingId = randomUUID();
    store.activate(startRequest.patentId, missingId);
    const request = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      action: "load" as const,
      conversationId: null,
    };
    const loaded = await service.workspace("owner", request);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.history).toContainEqual(
      expect.objectContaining({
        conversationId: missingId,
        error: expect.stringContaining("缺失"),
      }),
    );
    expect(store.active(startRequest.patentId)).toBeNull();
    await expect(
      service.workspace("owner", { ...request, action: "open", conversationId: missingId }),
    ).rejects.toThrow("未找到历史对话");
    await expect(service.startConversation("owner", startRequest)).resolves.toHaveProperty(
      "conversationId",
    );
  });
  test("does not leave a phantom running history when activating a new chat fails", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(
      mkdtempSync(join(tmpdir(), "polish-activate-failure-")),
    );
    const { service, provider, startRequest } = conversationFixture(store);
    vi.spyOn(store, "activate").mockImplementationOnce(() => {
      throw new Error("活动记录写入失败");
    });
    await expect(service.startConversation("owner", startRequest)).rejects.toThrow(
      "活动记录写入失败",
    );
    expect(provider.converseTextPolish).not.toHaveBeenCalled();
    expect(store.history(startRequest.patentId)).toEqual([]);
    expect(store.active(startRequest.patentId)).toBeNull();
  });

  test("a failed initial history write does not block a later start", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-save-failure-")));
    const { service, startRequest } = conversationFixture(store);
    vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new Error("磁盘已满");
    });
    await expect(service.startConversation("owner", startRequest)).rejects.toThrow("磁盘已满");
    expect(store.active(startRequest.patentId)).toBeNull();
    await expect(
      service.startConversation("owner", { ...startRequest, clientRequestId: randomUUID() }),
    ).resolves.toHaveProperty("conversationId");
  });

  test("persists a retry before requesting AI and rolls back on failed persistence", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-retry-save-")));
    const { service, provider, startRequest } = conversationFixture(store);
    provider.converseTextPolish.mockRejectedValueOnce(new Error("连接中断"));
    const started = await service.startConversation("owner", startRequest);
    await vi.waitFor(() =>
      expect(
        store.snapshot(startRequest.patentId, started.conversationId)?.lastTurnOutcome?.status,
      ).toBe("failed"),
    );
    const before = await service.snapshotConversation("owner", started.snapshot);
    const request = {
      identity: started.snapshot,
      expectedConversationRevision: before.conversationRevision,
      clientRequestId: randomUUID(),
      kind: "retry" as const,
      turnId: started.turnId,
    };
    vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new Error("磁盘已满");
    });
    await expect(service.sendConversation("owner", request)).rejects.toThrow("磁盘已满");
    expect(provider.converseTextPolish).toHaveBeenCalledTimes(1);
    expect(await service.snapshotConversation("owner", started.snapshot)).toEqual(before);
    provider.converseTextPolish.mockImplementationOnce(async () => {
      expect(
        store.snapshot(startRequest.patentId, started.conversationId)?.activeTurn?.clientRequestId,
      ).toBe(request.clientRequestId);
      return { kind: "answer", message: "重新回复" };
    });
    await service.sendConversation("owner", request);
    await vi.waitFor(() =>
      expect(
        store.snapshot(startRequest.patentId, started.conversationId)?.lastTurnOutcome?.status,
      ).toBe("completed"),
    );
    service.releaseOwner("owner");
  });

  test("a damaged target draft never retires the current conversation on failed open", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const root = mkdtempSync(join(tmpdir(), "polish-open-recovery-"));
    const store = new TextPolishHistoryStore(root);
    const { service, startRequest } = conversationFixture(store);
    const started = await service.startConversation("owner", startRequest);
    const request = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", request)).activeTurn).toBeNull(),
    );
    const saved = await service.snapshotConversation("owner", request);
    const targetId = randomUUID();
    store.save({ ...saved, conversationId: targetId });
    writeFileSync(join(root, request.patentId, `draft-${targetId}.json`), "broken");
    await expect(
      service.workspace("owner", { ...request, action: "open", conversationId: targetId }),
    ).rejects.toThrow();
    expect((await service.snapshotConversation("owner", request)).conversationId).toBe(
      started.conversationId,
    );
    expect(store.active(request.patentId)).toBe(started.conversationId);
  });

  test.each(["activate", "list"] as const)(
    "a failed %s during history switching preserves the active conversation",
    async (operation) => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
      const store = new TextPolishHistoryStore(
        mkdtempSync(join(tmpdir(), "polish-switch-failure-")),
      );
      const { service, startRequest } = conversationFixture(store);
      const started = await service.startConversation("owner", startRequest);
      const identity = {
        ...startRequest,
        conversationId: started.conversationId,
        bookKind: "description" as const,
      };
      await vi.waitFor(async () =>
        expect((await service.snapshotConversation("owner", identity)).activeTurn).toBeNull(),
      );
      const before = await service.snapshotConversation("owner", identity);
      const targetId = randomUUID();
      store.save({ ...before, conversationId: targetId });
      store.saveDraft(identity.patentId, targetId, { text: "历史草稿", presets: [] });
      const failure = vi.spyOn(store, operation).mockImplementationOnce(() => {
        throw new Error("磁盘操作失败");
      });
      await expect(
        service.workspace("owner", { ...identity, action: "open", conversationId: targetId }),
      ).rejects.toThrow("磁盘操作失败");
      expect(await service.snapshotConversation("owner", identity)).toEqual(before);
      expect(store.active(identity.patentId)).toBe(started.conversationId);
      expect(store.draft(identity.patentId, targetId).text).toBe("历史草稿");
      failure.mockRestore();
      const opened = await service.workspace("owner", {
        ...identity,
        action: "open",
        conversationId: targetId,
      });
      expect(opened.snapshot?.conversationId).toBe(targetId);
      expect(opened.draft.text).toBe("历史草稿");
      expect(store.active(identity.patentId)).toBe(targetId);
    },
  );

  test.each(["active.json", "draft-new.json"])(
    "explicitly recovers damaged %s without losing the file",
    async (name) => {
      const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
      const root = mkdtempSync(join(tmpdir(), "polish-state-recovery-"));
      const store = new TextPolishHistoryStore(root);
      const { service, startRequest } = conversationFixture(store);
      const id = startRequest.patentId;
      store.saveDraft(id, null, { text: "草稿", presets: [] });
      writeFileSync(join(root, id, name), "broken");
      const request = {
        patentId: id,
        sessionId: startRequest.sessionId,
        action: "load" as const,
        conversationId: null,
      };
      await expect(service.workspace("owner", request)).rejects.toThrow(/读取/);
      expect(readFileSync(join(root, id, name), "utf8")).toBe("broken");
      const recovered = await service.workspace("owner", { ...request, action: "recover" });
      expect(recovered.snapshot).toBeNull();
      expect(recovered.draft.text).toBe(name === "active.json" ? "草稿" : "");
      const retained = readdirSync(join(root, id)).find((file) =>
        file.startsWith(`${name}.unreadable-`),
      );
      expect(retained).toBeTruthy();
      if (!retained) throw new Error("Expected preserved damaged file");
      expect(readFileSync(join(root, id, retained), "utf8")).toBe("broken");
    },
  );
  test("keeps a generated reply copyable when its history cannot be saved", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-reply-failure-")));
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation((snapshot) => {
      if (snapshot.messages.some((message) => message.role === "assistant"))
        throw new Error("磁盘已满");
      save(snapshot);
    });
    const { service, startRequest, events } = conversationFixture(store);
    await service.startConversation("owner", startRequest);
    const request = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", request)).activeTurn).toBeNull(),
    );
    const snapshot = await service.snapshotConversation("owner", request);
    expect(snapshot.latestValidDraft).toBe("一种改进装置。");
    expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "assistant" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn-failed",
        retryable: false,
        message: expect.stringContaining("保存失败"),
      }),
    );
  });
  test("restores history and drafts after closing a session and supports another book", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const store = new TextPolishHistoryStore(mkdtempSync(join(tmpdir(), "polish-session-")));
    const { service, startRequest } = conversationFixture(store);
    const started = await service.startConversation("owner", startRequest);
    const request = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "claims" as const,
    };
    await vi.waitFor(async () =>
      expect((await service.snapshotConversation("owner", request)).activeTurn).toBeNull(),
    );
    await service.workspace("owner", {
      ...request,
      action: "draft",
      conversationId: started.conversationId,
      draft: { text: "继续完善这一点", presets: [] },
    });
    service.releaseSession(request.sessionId);
    const reopened = await service.workspace("new-owner", {
      ...request,
      sessionId: randomUUID(),
      action: "load",
      conversationId: null,
    });
    expect(reopened.snapshot?.conversationId).toBe(started.conversationId);
    expect(reopened.snapshot?.messages).toHaveLength(2);
    expect(reopened.snapshot?.bookKind).toBe("description");
    expect(reopened.draft.text).toBe("继续完善这一点");
    expect(reopened.history).toHaveLength(1);
    service.releaseOwner("new-owner");
    const fresh = conversationFixture(store);
    if (!reopened.snapshot) throw new Error("Missing restored snapshot");
    fresh.settings.profiles = [{ ...reopened.snapshot.model, providerId: "deepseek" }];
    const restored = await fresh.service.workspace("restart-owner", {
      ...request,
      sessionId: randomUUID(),
      action: "load",
      conversationId: null,
    });
    expect(fresh.provider.converseTextPolish).not.toHaveBeenCalled();
    expect(restored.snapshot?.messages).toHaveLength(2);
    const snapshot = restored.snapshot;
    if (!snapshot) throw new Error("Missing restored snapshot");
    await fresh.service.sendConversation("restart-owner", {
      identity: {
        conversationId: snapshot.conversationId,
        patentId: snapshot.patentId,
        sessionId: snapshot.sessionId,
        bookKind: snapshot.bookKind,
      },
      expectedConversationRevision: snapshot.conversationRevision,
      clientRequestId: randomUUID(),
      kind: "new",
      instruction: "继续润色",
    });
    await vi.waitFor(() => expect(fresh.provider.converseTextPolish).toHaveBeenCalledOnce());
  });
  test("an interrupted turn keeps session reasoning but loses it after an application restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TextPolishHistoryStore } = await import("./text-polish-history-store.js");
    const root = mkdtempSync(join(tmpdir(), "polish-interrupted-"));
    const store = new TextPolishHistoryStore(root);
    const { service, provider, startRequest } = conversationFixture(store);
    provider.converseTextPolish.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { signal: AbortSignal; onReasoningDelta(delta: string): void };
      input.onReasoningDelta("已收到原始参考文字，正在分析。");
      return await new Promise((_resolve, reject) =>
        input.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
    });
    const started = await service.startConversation("owner", startRequest);
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledOnce());
    service.releaseSession(startRequest.sessionId);
    const fresh = conversationFixture(store);
    const request = {
      patentId: startRequest.patentId,
      sessionId: randomUUID(),
      action: "load" as const,
      conversationId: null,
    };
    const restored = await fresh.service.workspace("new-owner", request);
    expect(restored.snapshot?.activeTurn).toBeNull();
    expect(restored.snapshot?.lastTurnOutcome).toEqual({
      status: "cancelled",
      turnId: started.turnId,
    });
    expect(restored.snapshot?.reasoningByTurn?.[started.turnId]?.text).toContain("原始参考文字");
    const restarted = conversationFixture(new TextPolishHistoryStore(root));
    const afterRestart = await restarted.service.workspace("restarted-owner", request);
    expect(afterRestart.snapshot?.reasoningByTurn).toBeUndefined();
    expect(afterRestart.snapshot?.messages).toEqual(restored.snapshot?.messages);
    expect(afterRestart.snapshot?.lastTurnOutcome).toEqual(restored.snapshot?.lastTurnOutcome);
    expect(restarted.provider.converseTextPolish).not.toHaveBeenCalled();
    expect(fresh.provider.converseTextPolish).not.toHaveBeenCalled();
    await expect(fresh.service.workspace("other-owner", request)).rejects.toThrow(/不属于/);
    const different = await fresh.service.workspace("new-owner", {
      ...request,
      patentId: randomUUID(),
    });
    expect(different.snapshot).toBeNull();
    expect(different.history).toEqual([]);
  });
  test("keeps an empty-response failure retryable and preserves its conversation", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish.mockRejectedValueOnce(
      new AiRequestError("AI 本轮未返回内容，请重试本轮。"),
    );
    const started = await service.startConversation("owner", startRequest);
    const request = {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: startRequest.scope.bookKind,
    };
    await vi.waitFor(async () => {
      const snapshot = await service.snapshotConversation("owner", request);
      expect(snapshot.lastTurnOutcome).toMatchObject({ status: "failed", retryable: true });
      expect(snapshot.messages).toHaveLength(1);
    });
    const snapshot = await service.snapshotConversation("owner", request);
    await service.sendConversation("owner", {
      identity: { ...request, conversationId: started.conversationId },
      expectedConversationRevision: snapshot.conversationRevision,
      clientRequestId: randomUUID(),
      kind: "retry",
      turnId: started.turnId,
    });
    await vi.waitFor(async () => {
      const recovered = await service.snapshotConversation("owner", request);
      expect(recovered.lastTurnOutcome).toMatchObject({ status: "completed" });
      expect(recovered.messages).toHaveLength(2);
    });
  });
  test("pins existing conversations to their original profile when the global selection changes", async () => {
    const { service, provider, startRequest, settings, profileId } = conversationFixture();
    const started = await service.startConversation("owner", startRequest);
    const identity = {
      conversationId: started.conversationId,
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description" as const,
    };
    const read = () => service.snapshotConversation("owner", identity);
    await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
    const originalProfile = settings.profiles[0];
    if (!originalProfile) throw new Error("fixture");
    const other = { ...originalProfile, profileId: randomUUID(), model: "model-b" };
    settings.profiles.push(other);
    settings.activeProfileId = other.profileId;
    await service.sendConversation("owner", {
      identity,
      expectedConversationRevision: (await read()).conversationRevision,
      clientRequestId: randomUUID(),
      kind: "new",
      instruction: "继续",
    });
    await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
    expect((await read()).lastTurnOutcome?.status).toBe("completed");
    expect(provider.converseTextPolish).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "model-a" }),
    );
    settings.profiles = settings.profiles.filter((profile) => profile.profileId !== profileId);
    await service.sendConversation("owner", {
      identity,
      expectedConversationRevision: (await read()).conversationRevision,
      clientRequestId: randomUUID(),
      kind: "new",
      instruction: "再次继续",
    });
    await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
    expect((await read()).lastTurnOutcome).toMatchObject({ status: "failed", retryable: false });
    expect((await read()).messages.filter((message) => message.role === "assistant")).toHaveLength(
      2,
    );
  });
  test.each(["invalid-evidence", "empty", "invalid-format"])(
    "continues after compression and keeps the previous summary after %s",
    async (failure) => {
      const { service, provider, startRequest } = conversationFixture();
      provider.converseTextPolish.mockResolvedValue({
        kind: "revision",
        message: "已完成",
        revisedText: "改".repeat(15_000),
      });
      const summarize = vi
        .spyOn(provider, "summarizeTextPolishConversation")
        .mockImplementation(async (...args: unknown[]) => {
          const input = args[0] as {
            coveredThroughMessageId: string;
            messages: Array<{ messageId: string }>;
            previousSummary?: {
              items: Array<{
                kind: "requirement";
                text: string;
                sourceMessageIds: string[];
                evidenceQuotes: string[];
              }>;
            };
          };
          const first = input.messages[0];
          if (!first) throw new Error("fixture");
          return {
            coveredThroughMessageId: input.coveredThroughMessageId,
            items: input.previousSummary?.items ?? [
              {
                kind: "requirement" as const,
                text: "更加严谨",
                sourceMessageIds: [first.messageId],
                evidenceQuotes: ["更加严谨"],
              },
            ],
          };
        });
      const started = await service.startConversation("owner-a", startRequest);
      const identity = {
        ...startRequest,
        conversationId: started.conversationId,
        bookKind: "description" as const,
      };
      const read = () => service.snapshotConversation("owner-a", identity);
      const wait = async () => {
        await vi.waitFor(async () => expect((await read()).activeTurn).toBeNull());
        return await read();
      };
      let snapshot = await wait();
      for (let i = 0; i < 5; i++) {
        await service.sendConversation("owner-a", {
          identity,
          expectedConversationRevision: snapshot.conversationRevision,
          clientRequestId: randomUUID(),
          kind: "new",
          instruction: `第${i}轮`,
        });
        snapshot = await wait();
        expect(snapshot.lastTurnOutcome?.status).toBe("completed");
        provider.converseTextPolish.mockResolvedValue({
          kind: "revision",
          message: "已完成",
          revisedText: `${i}${"改".repeat(15_000)}`,
        });
      }
      expect(summarize).toHaveBeenCalled();
      expect(snapshot.summary).not.toBeNull();
      const previous = snapshot.summary;
      summarize.mockImplementation(async (...args: unknown[]) => {
        if (failure === "invalid-format") {
          throw new AiRequestError("AI 本轮摘要格式或长度不符合要求，原有对话已保留，请重试本轮。");
        }
        const input = args[0] as { coveredThroughMessageId: string };
        return {
          coveredThroughMessageId: input.coveredThroughMessageId,
          items:
            failure === "empty"
              ? []
              : [
                  {
                    kind: "term" as const,
                    text: "无效摘要",
                    sourceMessageIds: [randomUUID()],
                    evidenceQuotes: ["不存在的引文"],
                  },
                ],
        } as never;
      });
      for (let i = 0; i < 8 && snapshot.lastTurnOutcome?.status !== "failed"; i++) {
        await service.sendConversation("owner-a", {
          identity,
          expectedConversationRevision: snapshot.conversationRevision,
          clientRequestId: randomUUID(),
          kind: "new",
          instruction: `继续${i}`,
        });
        snapshot = await wait();
      }
      expect(snapshot.lastTurnOutcome).toMatchObject({ status: "failed", retryable: true });
      expect(snapshot.summary).toEqual(previous);
    },
  );

  test("keeps the production provider instance bound while invoking class methods", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish.mockImplementation(function (this: unknown) {
      expect(this).toBe(provider);
      return Promise.resolve({
        kind: "revision" as const,
        message: "已完成",
        revisedText: "绑定实例后的结果",
      });
    });

    await service.startConversation("owner-a", startRequest);
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledOnce());
  });

  test("creates one identity-bound conversation and sends only the verified source", async () => {
    const { service, provider, events, patent, startRequest } = conversationFixture();
    const started = await service.startConversation("owner-a", startRequest);

    expect(started.conversationId).toBeTruthy();
    expect(started.snapshot.messages[0]?.role).toBe("user");
    expect(started.snapshot.source.kind).toBe("selection");
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledTimes(1));
    expect(provider.converseTextPolish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ kind: "selection" }),
        instruction: "更加严谨",
      }),
    );
    expect(JSON.stringify(provider.converseTextPolish.mock.calls)).not.toContain("不得上传");
    expect(events.some((event) => event.type === "message")).toBe(true);

    await expect(
      service.startConversation("owner-a", { ...startRequest, clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONVERSATION_EXISTS" });
    expect(started.snapshot.patentId).toBe(patent.patentId);
  });

  test("revision updates latestValidDraft while clarification and answer do not", async () => {
    const { service, provider, startRequest } = conversationFixture();
    const first = await service.startConversation("owner-a", startRequest);
    await vi.waitFor(() => expect(first.snapshot.activeTurn).toBeTruthy());
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledTimes(1));
    let snapshot = await service.snapshotConversation("owner-a", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description",
    });
    expect(snapshot.latestValidDraft).toBe("一种改进装置。");

    provider.converseTextPolish.mockResolvedValueOnce({
      kind: "clarification",
      message: "请确认是否保留参数。",
    });
    const send: TextPolishConversationSendRequest = {
      kind: "new",
      identity: {
        conversationId: first.conversationId,
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      },
      expectedConversationRevision: snapshot.conversationRevision,
      clientRequestId: randomUUID(),
      instruction: "继续",
    };
    await service.sendConversation("owner-a", send);
    await vi.waitFor(() => expect(provider.converseTextPolish).toHaveBeenCalledTimes(2));
    snapshot = await service.snapshotConversation("owner-a", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description",
    });
    expect(snapshot.latestValidDraft).toBe("一种改进装置。");
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      reply: { kind: "clarification" },
    });
  });

  test("is idempotent for duplicate client requests, rejects concurrent turns, and cancels safely", async () => {
    const { service, provider, startRequest } = conversationFixture();
    let resolveReply: ((value: TextPolishAssistantReply) => void) | undefined;
    provider.converseTextPolish.mockImplementation(
      () => new Promise((resolve) => (resolveReply = resolve)),
    );
    const first = await service.startConversation("owner-a", startRequest);
    const duplicate = await service.startConversation("owner-a", startRequest);
    expect(duplicate).toMatchObject({
      conversationId: first.conversationId,
      turnId: first.turnId,
    });
    expect(duplicate.snapshot.conversationRevision).toBeGreaterThanOrEqual(
      first.snapshot.conversationRevision,
    );
    await expect(
      service.sendConversation("owner-a", {
        kind: "new",
        identity: {
          conversationId: first.conversationId,
          patentId: startRequest.patentId,
          sessionId: startRequest.sessionId,
          bookKind: "description",
        },
        expectedConversationRevision: first.snapshot.conversationRevision,
        clientRequestId: randomUUID(),
        instruction: "并发要求",
      }),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(
      service.cancelConversation("owner-a", {
        identity: {
          conversationId: first.conversationId,
          patentId: startRequest.patentId,
          sessionId: startRequest.sessionId,
          bookKind: "description",
        },
        turnId: first.turnId,
      }),
    ).toBe(true);
    if (!resolveReply) throw new Error("测试回复未准备好");
    resolveReply({ kind: "answer", message: "迟到结果" });
    await vi.waitFor(async () => {
      const snapshot = await service.snapshotConversation("owner-a", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      });
      expect(snapshot.activeTurn).toBeNull();
      expect(snapshot.lastTurnOutcome).toEqual({ status: "cancelled", turnId: first.turnId });
    });
    expect(
      (
        await service.snapshotConversation("owner-a", {
          patentId: startRequest.patentId,
          sessionId: startRequest.sessionId,
          bookKind: "description",
        })
      ).messages.at(-1),
    ).not.toMatchObject({ reply: { message: "迟到结果" } });
  });

  test("new conversation disposal removes the fixed source, model and history", async () => {
    const { service, startRequest } = conversationFixture();
    const first = await service.startConversation("owner-a", startRequest);
    await vi.waitFor(async () => {
      const snapshot = await service.snapshotConversation("owner-a", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      });
      expect(snapshot.lastTurnOutcome?.status).toBe("completed");
    });
    const snapshot = await service.snapshotConversation("owner-a", {
      patentId: startRequest.patentId,
      sessionId: startRequest.sessionId,
      bookKind: "description",
    });

    await service.resetConversation("owner-a", {
      identity: {
        conversationId: first.conversationId,
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      },
      expectedConversationRevision: snapshot.conversationRevision,
    });
    await expect(
      service.snapshotConversation("owner-a", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const restarted = await service.startConversation("owner-a", {
      ...startRequest,
      clientRequestId: randomUUID(),
      instruction: "一场全新的对话",
    });
    expect(restarted.conversationId).not.toBe(first.conversationId);
    expect(restarted.snapshot.messages).toHaveLength(1);
  });

  test("persists permanent failures in snapshots without offering a dead retry", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish.mockRejectedValueOnce(new IncompatibleModelError("连续对话"));
    const started = await service.startConversation("owner-a", startRequest);

    await vi.waitFor(async () => {
      const snapshot = await service.snapshotConversation("owner-a", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      });
      expect(snapshot.lastTurnOutcome).toEqual({
        status: "failed",
        turnId: started.turnId,
        message: "当前模型不兼容结构化连续对话结果。",
        retryable: false,
      });
    });
  });

  test("preserves safe AI transport errors so users can diagnose a failed turn", async () => {
    const { service, provider, startRequest } = conversationFixture();
    provider.converseTextPolish.mockRejectedValueOnce(
      new AiRequestError("AI 服务未返回流式数据。"),
    );
    const started = await service.startConversation("owner-a", startRequest);

    await vi.waitFor(async () => {
      const snapshot = await service.snapshotConversation("owner-a", {
        patentId: startRequest.patentId,
        sessionId: startRequest.sessionId,
        bookKind: "description",
      });
      expect(snapshot.lastTurnOutcome).toEqual({
        status: "failed",
        turnId: started.turnId,
        message: "AI 服务未返回流式数据。",
        retryable: true,
      });
    });
  });

  test("keeps history but refuses a changed model profile, while release disposes the owner", async () => {
    const fixtureState = conversationFixture();
    const first = await fixtureState.service.startConversation(
      "owner-a",
      fixtureState.startRequest,
    );
    await vi.waitFor(() =>
      expect(fixtureState.provider.converseTextPolish).toHaveBeenCalledTimes(1),
    );
    await expect(
      fixtureState.service.sendConversation("owner-b", {
        kind: "new",
        identity: {
          conversationId: first.conversationId,
          patentId: fixtureState.startRequest.patentId,
          sessionId: fixtureState.startRequest.sessionId,
          bookKind: "description",
        },
        expectedConversationRevision: first.snapshot.conversationRevision,
        clientRequestId: randomUUID(),
        instruction: "继续",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixtureState.service.releaseOwner("owner-a");
    await expect(
      fixtureState.service.snapshotConversation("owner-a", {
        patentId: fixtureState.startRequest.patentId,
        sessionId: fixtureState.startRequest.sessionId,
        bookKind: "description",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
