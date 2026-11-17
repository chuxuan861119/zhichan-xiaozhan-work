// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../../shared/ai-correction/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { PatentPolishService } from "../ai-correction/patent-polish-service.js";
import { TextPolishHistoryStore } from "../ai-correction/text-polish-history-store.js";
import { AutomationConversations } from "./conversations.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cli-conversations-"));
  roots.push(root);
  const history = new TextPolishHistoryStore(root);
  const patent = createBlankPatent({ patentType: "invention", name: "多轮测试" });
  const profileId = randomUUID();
  const converse = vi.fn(async (_input: { signal: AbortSignal }) => ({
    kind: "revision" as const,
    message: "已修改",
    revisedText: "修改后的技术方案。",
  }));
  let adapter: AutomationConversations;
  const service = new PatentPolishService({
    history,
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "测试",
          baseUrl: "https://api.deepseek.com",
          model: "test",
        },
      ],
    }),
    vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("test-only") },
    patents: {
      requireActiveReadSession: (session, id) =>
        adapter.capture(session, id) ?? structuredClone(patent),
    },
    provider: {
      polish: async () => "",
      converseTextPolish: converse,
      summarizeTextPolishConversation: async () => ({ coveredThroughMessageId: null, items: [] }),
    },
    emit: (event, owner) => adapter?.observe(event, owner),
  });
  const enabled = vi.fn(async () => true);
  adapter = new AutomationConversations(service, history, enabled);
  const begin = vi.fn();
  const context = () => ({
    operationId: randomUUID(),
    signal: new AbortController().signal,
    assertAuthorized: vi.fn(),
    progress: vi.fn(),
    begin,
  });
  const start = {
    patentId: patent.patentId,
    expectedRevision: patent.revision,
    action: "start",
    scope: { kind: "generation", bookKind: "description" },
    instruction: "生成方案",
  };
  return { root, history, patent, service, adapter, converse, enabled, context, start, begin };
}
test("continues persisted conversations without exposing credentials or changing the patent", async () => {
  const f = await fixture();
  const first = await f.adapter.run(f.patent, f.start, f.context());
  expect(first.snapshot!.messages).toHaveLength(2);
  const second = await f.adapter.run(
    f.patent,
    {
      patentId: f.patent.patentId,
      expectedRevision: 0,
      action: "send",
      conversationId: first.snapshot!.conversationId,
      expectedConversationRevision: first.snapshot!.conversationRevision,
      instruction: "再精简",
    },
    f.context(),
  );
  expect(second.snapshot!.messages).toHaveLength(4);
  expect(f.converse).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(second)).not.toContain("test-only");
  expect(f.patent.revision).toBe(0);
  expect(f.begin).toHaveBeenCalledTimes(2);
});
test("read-only history does not rewrite imported legacy reasoning", async () => {
  const f = await fixture();
  const result = await f.adapter.run(f.patent, f.start, f.context());
  const file = join(
    f.root,
    f.patent.patentId,
    `conversation-${result.snapshot!.conversationId}.json`,
  );
  const data = JSON.parse(await readFile(file, "utf8"));
  data.snapshot.reasoningByTurn = {};
  const original = JSON.stringify(data);
  await writeFile(file, original);
  const read = f.adapter.read({
    patentId: f.patent.patentId,
    conversationId: result.snapshot!.conversationId,
  });
  expect(JSON.stringify(read)).not.toContain("reasoningByTurn");
  expect(await readFile(file, "utf8")).toBe(original);
  f.adapter.read({ patentId: f.patent.patentId });
  expect(await readFile(file, "utf8")).toBe(original);
});
test("disabled networking and stale versions cause no conversation side effects", async () => {
  const f = await fixture();
  f.enabled.mockResolvedValue(false);
  await expect(f.adapter.run(f.patent, f.start, f.context())).rejects.toMatchObject({
    code: "AI_DISABLED",
  });
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.converse).not.toHaveBeenCalled();
  f.enabled.mockResolvedValue(true);
  const first = await f.adapter.run(f.patent, f.start, f.context());
  f.begin.mockClear();
  await expect(
    f.adapter.run(
      f.patent,
      {
        patentId: f.patent.patentId,
        expectedRevision: 0,
        instruction: "继续",
        action: "send",
        conversationId: first.snapshot!.conversationId,
        expectedConversationRevision: 999,
      },
      f.context(),
    ),
  ).rejects.toThrow();
  expect(f.begin).not.toHaveBeenCalled();
});
test("cancellation stops the provider and preserves a recoverable conversation", async () => {
  const f = await fixture();
  let providerSignal: AbortSignal | undefined;
  f.converse.mockImplementation((input) => {
    providerSignal = input.signal;
    return new Promise((_resolve, reject) =>
      input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
  });
  const controller = new AbortController();
  const run = f.adapter.run(f.patent, f.start, { ...f.context(), signal: controller.signal });
  const checked = expect(run).rejects.toMatchObject({ code: "CANCELLED" });
  await vi.waitFor(() => expect(providerSignal).toBeDefined());
  controller.abort();
  await checked;
  expect(providerSignal?.aborted).toBe(true);
  const id = f.history.history(f.patent.patentId)[0]!.conversationId;
  expect(f.history.snapshot(f.patent.patentId, id)?.activeTurn).toBeNull();
  expect(f.history.snapshot(f.patent.patentId, id)?.lastTurnOutcome?.status).toBe("cancelled");
  const cancelled = f.history.snapshot(f.patent.patentId, id)!;
  f.converse.mockResolvedValue({ kind: "revision", message: "完成", revisedText: "重试结果" });
  const retried = await f.adapter.run(
    f.patent,
    {
      patentId: f.patent.patentId,
      expectedRevision: 0,
      action: "retry",
      conversationId: id,
      expectedConversationRevision: cancelled.conversationRevision,
      turnId: cancelled.lastTurnOutcome!.turnId,
    },
    f.context(),
  );
  expect(retried.snapshot?.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
});
test("does not take over a conversation held by the GUI", async () => {
  const f = await fixture();
  const sessionId = randomUUID();
  const gui = await f.service.startConversation("gui-owner", {
    clientRequestId: randomUUID(),
    sessionId,
    patentId: f.patent.patentId,
    expectedPatentRevision: 0,
    scope: { kind: "generation", bookKind: "description" },
    instruction: "GUI内容",
    uploadConfirmed: true,
  });
  await vi.waitFor(() =>
    expect(f.history.snapshot(f.patent.patentId, gui.conversationId)?.activeTurn).toBeNull(),
  );
  const saved = f.history.snapshot(f.patent.patentId, gui.conversationId)!;
  await expect(
    f.adapter.run(
      f.patent,
      {
        patentId: f.patent.patentId,
        expectedRevision: 0,
        action: "send",
        conversationId: gui.conversationId,
        expectedConversationRevision: saved.conversationRevision,
        instruction: "CLI内容",
      },
      f.context(),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(f.history.snapshot(f.patent.patentId, gui.conversationId)?.messages).toEqual(
    saved.messages,
  );
  f.service.releaseSession(sessionId);
});
test.each(["draft", "recover"] as const)(
  "%s cannot alter files of a conversation held by the GUI",
  async (action) => {
    const f = await fixture();
    const sessionId = randomUUID();
    const gui = await f.service.startConversation("gui-owner", {
      clientRequestId: randomUUID(),
      sessionId,
      patentId: f.patent.patentId,
      expectedPatentRevision: 0,
      scope: { kind: "generation", bookKind: "description" },
      instruction: "GUI内容",
      uploadConfirmed: true,
    });
    try {
      await vi.waitFor(() =>
        expect(f.history.snapshot(f.patent.patentId, gui.conversationId)?.activeTurn).toBeNull(),
      );
      const file = join(f.root, f.patent.patentId, `draft-${gui.conversationId}.json`);
      f.history.saveDraft(f.patent.patentId, gui.conversationId, {
        text: "尚未发送的GUI草稿",
        presets: [],
      });
      const read = f.adapter.read({
        patentId: f.patent.patentId,
        conversationId: gui.conversationId,
      }) as { draftHash: string };
      if (action === "recover") await writeFile(file, "damaged GUI draft");
      const before = await readFile(file, "utf8");
      await expect(
        f.adapter.run(
          f.patent,
          {
            patentId: f.patent.patentId,
            expectedRevision: 0,
            action,
            conversationId: gui.conversationId,
            ...(action === "draft"
              ? {
                  expectedDraftHash: read.draftHash,
                  draft: { text: "CLI草稿", presets: [] },
                }
              : {}),
          },
          f.context(),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      f.service.releaseSession(sessionId);
    }
  },
);
test("draft CAS, model selection and new-chat pointer reuse existing history semantics", async () => {
  const f = await fixture();
  const read = f.adapter.read({ patentId: f.patent.patentId }) as { draftHash: string };
  const draft = {
    patentId: f.patent.patentId,
    expectedRevision: 0,
    action: "draft",
    conversationId: null,
    expectedDraftHash: read.draftHash,
    draft: { text: "输入草稿", presets: [] },
  };
  await f.adapter.run(f.patent, draft, f.context());
  await expect(f.adapter.run(f.patent, draft, f.context())).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
  });
  const started = (await f.adapter.run(f.patent, f.start, f.context())).snapshot!;
  const changed = (
    await f.adapter.run(
      f.patent,
      {
        patentId: f.patent.patentId,
        expectedRevision: 0,
        action: "change-model",
        conversationId: started.conversationId,
        expectedConversationRevision: started.conversationRevision,
        targetModel: started.model,
      },
      f.context(),
    )
  ).snapshot!;
  await f.adapter.run(
    f.patent,
    {
      patentId: f.patent.patentId,
      expectedRevision: 0,
      action: "reset",
      conversationId: changed.conversationId,
      expectedConversationRevision: changed.conversationRevision,
    },
    f.context(),
  );
  expect(f.history.active(f.patent.patentId)).toBeNull();
  expect(f.history.snapshot(f.patent.patentId, started.conversationId)?.messages).toHaveLength(2);
});
test("recovers a persisted interrupted turn before continuing", async () => {
  const f = await fixture();
  const sessionId = randomUUID();
  f.converse.mockImplementation(
    (input) =>
      new Promise((_resolve, reject) =>
        input.signal.addEventListener("abort", () => reject(new Error("stop")), { once: true }),
      ),
  );
  const pending = await f.service.startConversation("prior-session", {
    clientRequestId: randomUUID(),
    sessionId,
    patentId: f.patent.patentId,
    expectedPatentRevision: 0,
    scope: { kind: "generation", bookKind: "description" },
    instruction: "生成",
    uploadConfirmed: true,
  });
  f.service.releaseSession(sessionId);
  f.history.save(pending.snapshot);
  const recovered = await f.adapter.run(
    f.patent,
    {
      patentId: f.patent.patentId,
      expectedRevision: 0,
      action: "recover",
      conversationId: pending.conversationId,
    },
    f.context(),
  );
  expect(recovered.snapshot?.activeTurn).toBeNull();
  expect(f.history.snapshot(f.patent.patentId, pending.conversationId)?.activeTurn).toBeNull();
});
