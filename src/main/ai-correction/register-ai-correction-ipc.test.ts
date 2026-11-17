import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_AI_CORRECTION_SETTINGS,
} from "../../shared/ai-correction/model.js";
import { IPC_CHANNELS } from "../../shared/ipc/contract.js";
import { registerAiCorrectionIpc } from "./register-ai-correction-ipc.js";

describe("AI correction IPC registration", () => {
  test("keeps local history available offline and validates draft writes", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const workspace = vi.fn(async () => ({
      snapshot: null,
      draft: { text: "", presets: [] },
      history: [],
    }));
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      connectionsEnabled: async () => false,
      readSettings: async () => structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
      updateSettings: vi.fn(),
      vault: { listProfileIds: async () => [], setApiKey: vi.fn(), clearApiKey: vi.fn() },
      correction: { start: vi.fn(), cancel: vi.fn() },
      polish: { start: vi.fn(), cancel: vi.fn(), workspace },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
    });
    const input = {
      patentId: randomUUID(),
      sessionId: randomUUID(),
      action: "load",
      conversationId: null,
    };
    expect(await handlers.get(IPC_CHANNELS.textPolishWorkspace)?.({}, input)).toMatchObject({
      ok: true,
    });
    expect(
      await handlers.get(IPC_CHANNELS.textPolishWorkspace)?.({}, { ...input, sessionId: "" }),
    ).toMatchObject({ ok: false });
    expect(workspace).toHaveBeenCalledOnce();
  });
  test("does not acknowledge a rejected cancellation as success", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const cancel = vi.fn(() => false);
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
      updateSettings: vi.fn(),
      vault: { listProfileIds: async () => [], setApiKey: vi.fn(), clearApiKey: vi.fn() },
      correction: { start: vi.fn(), cancel },
      polish: { start: vi.fn(), cancel: vi.fn() },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
    });
    expect(
      await handlers.get(IPC_CHANNELS.aiCorrectionCancel)?.({}, { jobId: randomUUID() }),
    ).toMatchObject({ ok: false, error: { message: "未确认任务已停止，请重试。" } });
    cancel.mockReturnValue(true);
    expect(
      await handlers.get(IPC_CHANNELS.aiCorrectionCancel)?.({}, { jobId: randomUUID() }),
    ).toEqual({ ok: true, value: undefined });
  });
  test("blocks every AI request entry when connections are disabled, without deleting configuration", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const network = vi.fn();
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      connectionsEnabled: async () => false,
      readSettings: async () => structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
      updateSettings: vi.fn(),
      vault: { listProfileIds: async () => [], setApiKey: vi.fn(), clearApiKey: vi.fn() },
      correction: {
        start: async (_request, _event, ensureConnection) => {
          await ensureConnection?.();
          return network();
        },
        cancel: vi.fn(),
      },
      polish: {
        start: network,
        cancel: vi.fn(),
        startConversation: network,
        sendConversation: network,
      },
      testConnection: network,
      discoverModels: network,
      openExternal: network,
    });
    for (const channel of [
      IPC_CHANNELS.aiCorrectionStart,
      IPC_CHANNELS.textPolishStart,
      IPC_CHANNELS.textPolishConversationStart,
      IPC_CHANNELS.textPolishConversationSend,
      IPC_CHANNELS.aiCorrectionTestConnection,
      IPC_CHANNELS.aiCorrectionDiscoverModels,
    ]) {
      const input =
        channel === IPC_CHANNELS.aiCorrectionStart
          ? {
              jobId: randomUUID(),
              patentId: randomUUID(),
              sessionId: randomUUID(),
              expectedRevision: 1,
              scope: { kind: "current-book", bookKind: "description" },
              thinkingEnabled: true,
              uploadConfirmed: true,
            }
          : {};
      expect(await handlers.get(channel)?.({}, input)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("AI 连接已关闭") },
      });
    }
    expect(network).not.toHaveBeenCalled();
    expect(await handlers.get(IPC_CHANNELS.aiCorrectionGetSettings)?.({})).toMatchObject({
      ok: true,
    });
  });
  test("returns settings with key presence but never plaintext", async () => {
    const profileId = randomUUID();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const vault = {
      listProfileIds: vi.fn(async () => [profileId]),
      setApiKey: vi.fn(),
      clearApiKey: vi.fn(),
    };
    const openExternal = vi.fn(async () => undefined);
    const discoverModels = vi.fn(async () => ["remote-model", "remote-model-fast"]);
    const settings = {
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek" as const,
          displayName: "测试模型",
          baseUrl: "https://api.deepseek.com",
          model: "test-model",
        },
      ],
    };
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => settings,
      updateSettings: vi.fn(),
      vault,
      correction: { start: vi.fn(), cancel: vi.fn() },
      polish: { start: vi.fn(), cancel: vi.fn() },
      testConnection: vi.fn(),
      discoverModels,
      openExternal,
    });

    const selectedText = "跨段选中\n文字";
    expect(handlers.get(IPC_CHANNELS.aiCorrectionHashText)?.({}, selectedText)).toEqual({
      ok: true,
      value: createHash("sha256").update(selectedText, "utf8").digest("hex"),
    });
    expect(handlers.get(IPC_CHANNELS.aiCorrectionHashText)?.({}, "字".repeat(100_001))).toEqual({
      ok: true,
      value: createHash("sha256").update("字".repeat(100_001), "utf8").digest("hex"),
    });

    const result = await handlers.get(IPC_CHANNELS.aiCorrectionGetSettings)?.({});
    expect(result).toEqual({
      ok: true,
      value: { settings, credentialProfileIds: [profileId], credentialStatusUnknown: false },
    });
    expect(JSON.stringify(result)).not.toContain("apiKey");

    await handlers.get(IPC_CHANNELS.aiCorrectionSetApiKey)?.({}, { profileId, apiKey: "secret" });
    expect(vault.setApiKey).toHaveBeenCalledWith(profileId, "secret");
    await handlers.get(IPC_CHANNELS.aiCorrectionClearApiKey)?.({}, { profileId });
    expect(vault.clearApiKey).toHaveBeenCalledWith(profileId);

    await handlers.get(IPC_CHANNELS.aiCorrectionOpenProviderDocs)?.({}, { providerId: "deepseek" });
    expect(openExternal).toHaveBeenCalledWith(AI_PROVIDER_PRESETS[0].docsUrl);

    const discovered = await handlers.get("ai-correction:discover-models")?.(
      {},
      {
        providerId: "deepseek",
        baseUrl: AI_PROVIDER_PRESETS[0].baseUrl,
        apiKey: "temporary-secret",
      },
    );
    expect(discovered).toEqual({
      ok: true,
      value: { models: ["remote-model", "remote-model-fast"] },
    });
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: AI_PROVIDER_PRESETS[0].baseUrl,
      apiKey: "temporary-secret",
      timeoutMs: DEFAULT_AI_CORRECTION_SETTINGS.timeoutMs,
    });

    const mismatchedPreset = await handlers.get("ai-correction:discover-models")?.(
      {},
      {
        providerId: "deepseek",
        baseUrl: "https://provider.example/v1",
        apiKey: "temporary-secret",
      },
    );
    expect(mismatchedPreset).toMatchObject({ ok: false });

    vault.setApiKey.mockClear();
    const rejected = await handlers.get(IPC_CHANNELS.aiCorrectionSetApiKey)?.(
      {},
      { profileId: randomUUID(), apiKey: "secret" },
    );
    expect(rejected).toMatchObject({ ok: false });
    expect(vault.setApiKey).not.toHaveBeenCalled();
  });

  test("forwards the invoking renderer identity for task ownership", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const start = vi.fn(async (request: { jobId: string }) => ({ jobId: request.jobId }));
    const cancel = vi.fn(() => true);
    const event = { sender: { id: 17 } };
    const jobId = randomUUID();
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => DEFAULT_AI_CORRECTION_SETTINGS,
      updateSettings: vi.fn(),
      vault: {
        listProfileIds: vi.fn(async () => []),
        setApiKey: vi.fn(),
        clearApiKey: vi.fn(),
      },
      correction: { start, cancel },
      polish: { start: vi.fn(), cancel: vi.fn() },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
    });

    await handlers.get(IPC_CHANNELS.aiCorrectionStart)?.(event, {
      jobId,
      patentId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: 1,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });
    await handlers.get(IPC_CHANNELS.aiCorrectionCancel)?.(event, { jobId });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ jobId }),
      event,
      expect.any(Function),
    );
    expect(cancel).toHaveBeenCalledWith(jobId, event);
  });

  test("forwards text polish start and cancel to the invoking renderer owner", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const start = vi.fn(async (request: { jobId: string }) => ({ jobId: request.jobId }));
    const cancel = vi.fn(() => true);
    const event = { sender: { id: 29 } };
    const jobId = randomUUID();
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => DEFAULT_AI_CORRECTION_SETTINGS,
      updateSettings: vi.fn(),
      vault: {
        listProfileIds: vi.fn(async () => []),
        setApiKey: vi.fn(),
        clearApiKey: vi.fn(),
      },
      correction: { start: vi.fn(), cancel: vi.fn() },
      polish: { start, cancel },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
    });

    await handlers.get("text-polish:start")?.(event, {
      jobId,
      patentId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: 1,
      scope: {
        kind: "selection",
        bookKind: "description",
        blocks: [
          {
            blockId: randomUUID(),
            blockType: "paragraph",
            startOffset: 0,
            endOffset: 2,
          },
        ],
        selectedTextHash: "a".repeat(64),
      },
      requirement: "更专业严谨",
      uploadConfirmed: true,
    });
    await handlers.get("text-polish:cancel")?.(event, { jobId });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ jobId }), event);
    expect(cancel).toHaveBeenCalledWith(jobId, event);
  });

  test("registers strict conversation channels and rejects malformed requests", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const conversation = {
      startConversation: vi.fn(),
      sendConversation: vi.fn(),
      cancelConversation: vi.fn(),
      resetConversation: vi.fn(),
      snapshotConversation: vi.fn(),
    };
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => DEFAULT_AI_CORRECTION_SETTINGS,
      updateSettings: vi.fn(),
      vault: {
        listProfileIds: vi.fn(async () => []),
        setApiKey: vi.fn(),
        clearApiKey: vi.fn(),
      },
      correction: { start: vi.fn(), cancel: vi.fn() },
      polish: { start: vi.fn(), cancel: vi.fn(), ...conversation },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
    });

    for (const channel of [
      IPC_CHANNELS.textPolishConversationStart,
      IPC_CHANNELS.textPolishConversationSend,
      IPC_CHANNELS.textPolishConversationCancel,
      IPC_CHANNELS.textPolishConversationReset,
      IPC_CHANNELS.textPolishConversationSnapshot,
    ]) {
      expect(handlers.has(channel)).toBe(true);
      await expect(handlers.get(channel)?.({}, {})).resolves.toMatchObject({ ok: false });
    }
    expect(conversation.startConversation).not.toHaveBeenCalled();
    expect(conversation.sendConversation).not.toHaveBeenCalled();
  });
  test("recovery cannot bypass a main-process confirmation", async () => {
    const profileId = randomUUID();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const settings = {
      ...structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek" as const,
          displayName: "test",
          baseUrl: "https://api.deepseek.com",
          model: "test",
        },
      ],
    };
    const setApiKey = vi.fn();
    const confirmCredentialReset = vi.fn(async () => false);
    registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
      readSettings: async () => settings,
      updateSettings: vi.fn(),
      vault: { listProfileIds: async () => [], setApiKey, clearApiKey: vi.fn() },
      correction: { start: vi.fn(), cancel: vi.fn() },
      polish: { start: vi.fn(), cancel: vi.fn() },
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
      openExternal: vi.fn(),
      confirmCredentialReset,
    });
    const request = { profileId, apiKey: "replacement", resetUnavailable: true };
    const invoke = () => handlers.get(IPC_CHANNELS.aiCorrectionSetApiKey)?.({}, request);
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(setApiKey).not.toHaveBeenCalled();
    confirmCredentialReset.mockResolvedValue(true);
    expect(await invoke()).toMatchObject({ ok: true });
    expect(setApiKey).toHaveBeenCalledWith(profileId, "replacement", { resetUnavailable: true });
  });
});

test("rejects removed providers without making discovery requests and opens official legal pages", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const network = vi.fn();
  const openExternal = vi.fn(async (_url: string) => undefined);
  registerAiCorrectionIpc((channel, handler) => handlers.set(channel, handler), {
    readSettings: async () => structuredClone(DEFAULT_AI_CORRECTION_SETTINGS),
    updateSettings: vi.fn(),
    vault: { listProfileIds: async () => [], setApiKey: vi.fn(), clearApiKey: vi.fn() },
    correction: { start: vi.fn(), cancel: vi.fn() },
    polish: { start: vi.fn(), cancel: vi.fn() },
    testConnection: network,
    discoverModels: network,
    openExternal,
  });
  expect(
    await handlers.get(IPC_CHANNELS.aiCorrectionDiscoverModels)?.(
      {},
      { providerId: "custom", baseUrl: "https://proxy.example/v1", apiKey: "test-secret" },
    ),
  ).toMatchObject({ ok: false });
  expect(network).not.toHaveBeenCalled();
  for (const document of ["privacy", "terms"] as const)
    expect(
      await handlers.get(IPC_CHANNELS.aiCorrectionOpenProviderDocs)?.(
        {},
        { providerId: "deepseek", document },
      ),
    ).toMatchObject({ ok: true });
  expect(openExternal.mock.calls.map((call) => call[0])).toEqual([
    "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html",
    "https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html",
  ]);
  expect(
    await handlers.get(IPC_CHANNELS.aiCorrectionOpenProviderDocs)?.({}, { providerId: "openai" }),
  ).toMatchObject({ ok: false });
  expect(openExternal).toHaveBeenCalledTimes(2);
});
