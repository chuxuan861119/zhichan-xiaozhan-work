const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  eventHandlers: new Map<string, (_event: unknown, value: unknown) => void>(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: [] })),
}));

import { createHash } from "node:crypto";
import { createBlankPatent } from "../shared/patent/defaults.js";

test("forwards automation close requests and acknowledgements across the real bridge", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    automation: {
      onEvent(listener: (event: unknown) => void): () => void;
      control(input: unknown): Promise<unknown>;
    };
  };
  const event = {
    type: "close",
    patentId: "00000000-0000-4000-8000-000000000991",
    sessionId: "00000000-0000-4000-8000-000000000992",
    token: "00000000-0000-4000-8000-000000000993",
  };
  const listener = vi.fn();
  const dispose = api.automation.onEvent(listener);
  electron.eventHandlers.get("automation:event")?.({}, event);
  expect(listener).toHaveBeenCalledWith(event);
  const ack = { action: "closeAck", sessionId: event.sessionId, token: event.token, ok: true };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: null });
  await api.automation.control(ack);
  expect(electron.invoke).toHaveBeenLastCalledWith("automation:control", ack);
  dispose();
});

test("library relocation uses the declared no-path IPC bridge", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    application: { relocateLibrary(): Promise<unknown> };
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: false });
  expect(await api.application.relocateLibrary()).toEqual({ ok: true, value: false });
  expect(electron.invoke).toHaveBeenLastCalledWith("application:relocate-library");
});

test("passes backup migration choices and reports through the preload bridge", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    backup: { configure(input: unknown): Promise<unknown> };
  };
  const request = {
    enabled: true,
    folder: "C:/new",
    intervalMinutes: 5,
    migrateExisting: true,
    expectedSourceFolder: "C:/old",
  };
  const result = { ok: true, value: { migratedCount: 3, skippedCount: 1, retainedSourceCount: 0 } };
  electron.invoke.mockResolvedValueOnce(result);
  expect(await api.backup.configure(request)).toEqual(result);
  expect(electron.invoke).toHaveBeenLastCalledWith("backup:configure", request);
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, handler: (_event: unknown, value: unknown) => void) =>
      electron.eventHandlers.set(channel, handler),
    removeListener: vi.fn(),
  },
}));

test("validates local polish drafts and rejects undeclared fields before IPC", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: { polishWorkspace(input: unknown): Promise<unknown> };
  };
  const request = {
    patentId: "00000000-0000-4000-8000-000000000991",
    sessionId: "00000000-0000-4000-8000-000000000992",
    action: "draft",
    conversationId: null,
    draft: { text: "未发送的文字", presets: ["专业严谨"] },
  };
  const value = { snapshot: null, draft: request.draft, history: [] };
  electron.invoke.mockResolvedValueOnce({ ok: true, value });
  expect(await api.aiCorrection.polishWorkspace(request)).toEqual({ ok: true, value });
  expect(electron.invoke).toHaveBeenLastCalledWith("text-polish:workspace", request);
  const count = electron.invoke.mock.calls.length;
  await expect(
    api.aiCorrection.polishWorkspace({ ...request, path: "C:/unrelated.json" }),
  ).rejects.toThrow();
  await expect(
    api.aiCorrection.polishWorkspace({
      ...request,
      draft: { text: "字".repeat(2001), presets: [] },
    }),
  ).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(count);
});

test("validates red draft clipboard requests while retaining normal text copying", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    clipboard: { writeText(request: unknown): Promise<unknown> };
  };
  electron.invoke.mockResolvedValue({ ok: true, value: undefined });
  const draft = { text: "箱体1", style: "red-draft" };
  expect(await api.clipboard.writeText(draft)).toEqual({ ok: true, value: undefined });
  expect(electron.invoke).toHaveBeenLastCalledWith("clipboard:write-text", draft);
  expect(await api.clipboard.writeText("普通文字")).toEqual({ ok: true, value: undefined });
  const calls = electron.invoke.mock.calls.length;
  await expect(api.clipboard.writeText({ text: "文字", style: "unknown" })).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(calls);
  electron.invoke.mockResolvedValue({ ok: true, value: [] });
});

test("exposes only schema-validated default-template editor operations", async () => {
  if (!electron.exposed.has("patentApi")) await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    patentTemplates: {
      readSummary(): Promise<unknown>;
      readAuxiliary(): Promise<unknown>;
      openEditor(request: unknown): Promise<unknown>;
      closeEditor(request: unknown): Promise<unknown>;
    };
  };
  electron.invoke.mockClear();
  electron.invoke
    .mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL", message: "测试错误" } })
    .mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL", message: "测试错误" } })
    .mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL", message: "测试错误" } });

  await api.patentTemplates.readSummary();
  expect(electron.invoke).toHaveBeenLastCalledWith("patent-templates:read-summary");
  await api.patentTemplates.readAuxiliary();
  expect(electron.invoke).toHaveBeenLastCalledWith("patent-templates:read-auxiliary");
  await api.patentTemplates.openEditor({ patentType: "invention" });
  expect(electron.invoke).toHaveBeenLastCalledWith("patent-templates:open-editor", {
    patentType: "invention",
  });

  electron.invoke.mockClear();
  await expect(api.patentTemplates.closeEditor({ sessionId: "not-a-uuid" })).rejects.toThrow();
  expect(electron.invoke).not.toHaveBeenCalled();
});

test("does not expose the retired chart API", () => {
  expect(electron.exposed.get("patentApi")).not.toHaveProperty("scientificCharts");
});

test("loads a staged DOCX image only through the declared preview channel", async () => {
  const api = electron.exposed.get("patentApi") as {
    patents: { getDocxImportPreviewAsset(sessionId: string, assetId: string): Promise<unknown> };
  };
  const sessionId = "00000000-0000-4000-8000-000000000811";
  const assetId = "00000000-0000-4000-8000-000000000814";
  electron.invoke.mockResolvedValueOnce({ ok: true, value: Uint8Array.from([137, 80, 78, 71]) });

  await api.patents.getDocxImportPreviewAsset(sessionId, assetId);

  expect(electron.invoke).toHaveBeenLastCalledWith("patents:get-docx-import-preview-asset", {
    sessionId,
    assetId,
  });
});

test("requests renderer recovery only through the declared application channel", async () => {
  const api = electron.exposed.get("patentApi") as {
    application: { reloadRenderer(): Promise<unknown> };
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: undefined });

  await api.application.reloadRenderer();

  expect(electron.invoke).toHaveBeenLastCalledWith("application:reload-renderer");
});

test("exposes a narrow AI correction API without a plaintext key reader", async () => {
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: {
      getSettings(): Promise<unknown>;
      start(request: unknown): Promise<unknown>;
      getApiKey?: unknown;
    };
  };
  expect(api.aiCorrection.getApiKey).toBeUndefined();
  electron.invoke.mockResolvedValueOnce({
    ok: true,
    value: {
      settings: {
        enabled: false,
        activeProfileId: null,
        profiles: [],
        timeoutMs: 60_000,
        maxUploadCharacters: 50_000,
      },
      credentialProfileIds: [],
    },
  });
  await api.aiCorrection.getSettings();
  expect(electron.invoke).toHaveBeenLastCalledWith("ai-correction:get-settings");
});

test("hashes selected text through the narrow main-process boundary without Web Crypto", async () => {
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: { hashText(text: string): Promise<unknown> };
  };
  electron.invoke.mockClear();
  const text = "跨段选中\n文字";
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  electron.invoke.mockResolvedValueOnce({ ok: true, value: hash });

  await expect(api.aiCorrection.hashText(text)).resolves.toEqual({ ok: true, value: hash });
  expect(electron.invoke).toHaveBeenCalledWith("ai-correction:hash-text", text);
  electron.invoke.mockClear();
  const longText = "字".repeat(100_001);
  const longHash = createHash("sha256").update(longText, "utf8").digest("hex");
  electron.invoke.mockResolvedValueOnce({ ok: true, value: longHash });
  await expect(api.aiCorrection.hashText(longText)).resolves.toEqual({ ok: true, value: longHash });
  expect(electron.invoke).toHaveBeenCalledWith("ai-correction:hash-text", longText);
});

test("validates and forwards a temporary model-discovery credential", async () => {
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: { discoverModels(request: unknown): Promise<unknown> };
  };
  const request = {
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "temporary-secret",
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: { models: ["deepseek-v4-pro"] } });

  await expect(api.aiCorrection.discoverModels(request)).resolves.toEqual({
    ok: true,
    value: { models: ["deepseek-v4-pro"] },
  });
  expect(electron.invoke).toHaveBeenLastCalledWith("ai-correction:discover-models", request);
});

test("validates and forwards a text polish request through the AI namespace", async () => {
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: { polish(request: unknown): Promise<unknown> };
  };
  const request = {
    jobId: "00000000-0000-4000-8000-000000000901",
    patentId: "00000000-0000-4000-8000-000000000902",
    sessionId: "00000000-0000-4000-8000-000000000903",
    expectedRevision: 1,
    scope: {
      kind: "selection",
      bookKind: "claims",
      blocks: [
        {
          blockId: "00000000-0000-4000-8000-000000000904",
          blockType: "paragraph",
          startOffset: 0,
          endOffset: 2,
        },
      ],
      selectedTextHash: "a".repeat(64),
    },
    requirement: "更加简洁",
    uploadConfirmed: true,
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: { jobId: request.jobId } });

  await api.aiCorrection.polish(request);

  expect(electron.invoke).toHaveBeenLastCalledWith("text-polish:start", request);
});

test("keeps the conversation bridge strict and drops malformed events", async () => {
  const api = electron.exposed.get("patentApi") as {
    aiCorrection: {
      startConversation(request: unknown): Promise<unknown>;
      onConversationEvent(listener: (event: unknown) => void): () => void;
    };
  };
  electron.invoke.mockClear();
  await expect(api.aiCorrection.startConversation({})).rejects.toThrow();
  expect(electron.invoke).not.toHaveBeenCalled();

  const listener = vi.fn();
  const dispose = api.aiCorrection.onConversationEvent(listener);
  electron.eventHandlers.get("text-polish:conversation-event")?.({}, { type: "message" });
  expect(listener).not.toHaveBeenCalled();
  electron.eventHandlers.get("text-polish:conversation-event")?.(
    {},
    {
      type: "phase",
      conversationId: "00000000-0000-4000-8000-000000000951",
      conversationRevision: 2,
      turnId: "00000000-0000-4000-8000-000000000952",
      phase: "thinking",
    },
  );
  expect(listener).toHaveBeenCalledOnce();
  dispose();
});

test("validates and invokes manual snapshot creation through the declared channel", async () => {
  if (!electron.exposed.has("patentApi")) await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    snapshot: { create(request: unknown): Promise<unknown> };
  };
  const request = {
    documentType: "patent",
    documentId: "00000000-0000-4000-8000-000000000971",
    source: "manual-create",
  };
  const created = {
    ok: true as const,
    value: {
      outcome: "created" as const,
      revision: 8,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "manual-create" as const,
    },
  };
  const alreadyExists = {
    ok: true as const,
    value: {
      outcome: "already-exists" as const,
      revision: 8,
      createdAt: "2026-08-16T01:02:03.000Z",
      source: "manual-create" as const,
    },
  };
  electron.invoke.mockResolvedValueOnce(created).mockResolvedValueOnce(alreadyExists);

  await expect(api.snapshot.create(request)).resolves.toEqual(created);
  await expect(api.snapshot.create(request)).resolves.toEqual(alreadyExists);
  expect(electron.invoke).toHaveBeenLastCalledWith("snapshot:create", request);
});

test("exposes only the declared final-backup operations", async () => {
  const api = electron.exposed.get("patentApi") as {
    backup: {
      ensureCurrent(request: unknown): Promise<unknown>;
      finalize(): Promise<unknown>;
      operationStatus(): Promise<unknown>;
      cancelFinalization(): Promise<unknown>;
    };
  };
  const target = {
    documentType: "patent",
    documentId: "00000000-0000-4000-8000-000000000974",
  };
  electron.invoke.mockReset();
  const completed = {
    ok: true as const,
    value: {
      trigger: "application-close",
      attemptedCount: 0,
      successCount: 0,
      skippedCount: 0,
      failures: [],
      cancelled: false,
      completedAt: "2026-08-23T01:02:03.000Z",
    },
  };
  const idleStatus = {
    ok: true as const,
    value: {
      running: false,
      trigger: null,
      totalCount: 0,
      completedCount: 0,
      currentDisplayName: null,
      cancelRequested: false,
    },
  };
  const cancelled = { ok: true as const, value: undefined };
  electron.invoke
    .mockResolvedValueOnce(completed)
    .mockResolvedValueOnce(completed)
    .mockResolvedValueOnce(idleStatus)
    .mockResolvedValueOnce(cancelled);

  await expect(api.backup.ensureCurrent(target)).resolves.toEqual(completed);
  await expect(api.backup.finalize()).resolves.toEqual(completed);
  expect(electron.invoke).toHaveBeenNthCalledWith(1, "backup:ensure-current", target);
  expect(electron.invoke).toHaveBeenNthCalledWith(2, "backup:finalize", {});
  await expect(api.backup.ensureCurrent({ ...target, path: "D:\\unsafe" })).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(2);
  await expect(api.backup.operationStatus()).resolves.toEqual(idleStatus);
  await expect(api.backup.cancelFinalization()).resolves.toEqual(cancelled);
  expect(electron.invoke).toHaveBeenNthCalledWith(3, "backup:operation-status");
  expect(electron.invoke).toHaveBeenNthCalledWith(4, "backup:cancel-finalization", {});
  electron.invoke.mockReset();
});

test("validates and invokes snapshot content and asset previews through declared channels", async () => {
  const api = electron.exposed.get("patentApi") as {
    snapshot: {
      preview(request: unknown): Promise<unknown>;
      previewAsset(request: unknown): Promise<unknown>;
    };
  };
  const documentId = "00000000-0000-4000-8000-000000000971";
  const assetId = "00000000-0000-4000-8000-000000000972";
  const patent = createBlankPatent(
    { patentType: "invention", name: "快照预览" },
    {
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      createId: () => "00000000-0000-4000-8000-000000000973",
    },
  );
  const preview = {
    current: {
      revision: 2,
      createdAt: "2026-08-16T02:00:00.000Z",
      books: patent.books.map(({ kind, document }) => ({ kind, document })),
    },
    baseline: null,
    comparison: "initial",
    skippedRevisions: [],
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: preview });

  await expect(
    api.snapshot.preview({ documentType: "patent", documentId, revision: 2 }),
  ).resolves.toEqual({ ok: true, value: preview });
  expect(electron.invoke).toHaveBeenLastCalledWith("snapshot:preview", {
    documentType: "patent",
    documentId,
    revision: 2,
  });

  const bytes = new Uint8Array([1, 2, 3]);
  electron.invoke.mockResolvedValueOnce({ ok: true, value: bytes });
  await expect(
    api.snapshot.previewAsset({ documentType: "patent", documentId, revision: 2, assetId }),
  ).resolves.toEqual({ ok: true, value: bytes });
  expect(electron.invoke).toHaveBeenLastCalledWith("snapshot:preview-asset", {
    documentType: "patent",
    documentId,
    revision: 2,
    assetId,
  });
});

test("rejects malformed snapshot preview requests before invoking Electron", async () => {
  const api = electron.exposed.get("patentApi") as {
    snapshot: {
      preview(request: unknown): Promise<unknown>;
      previewAsset(request: unknown): Promise<unknown>;
    };
  };
  electron.invoke.mockClear();

  await expect(
    api.snapshot.preview({ documentType: "patent", documentId: "invalid", revision: 1 }),
  ).rejects.toThrow();
  await expect(
    api.snapshot.preview({
      documentType: "patent",
      documentId: "00000000-0000-4000-8000-000000000971",
      revision: -1,
    }),
  ).rejects.toThrow();
  await expect(
    api.snapshot.previewAsset({
      documentType: "patent",
      documentId: "00000000-0000-4000-8000-000000000971",
      revision: 1,
      assetId: "invalid",
    }),
  ).rejects.toThrow();
  expect(electron.invoke).not.toHaveBeenCalled();
});

test("exposes the narrow data-transfer API and validates progress before delivery", async () => {
  const api = electron.exposed.get("patentApi") as {
    dataTransfer: { onProgress(listener: (value: unknown) => void): () => void };
  };
  const listener = vi.fn();
  const unsubscribe = api.dataTransfer.onProgress(listener);
  const emit = electron.eventHandlers.get("data-transfer:progress");
  const valid = {
    operationId: "00000000-0000-4000-8000-000000000901",
    kind: "full-data-export",
    phase: "encrypting",
    completedBytes: 1,
    totalBytes: 2,
    currentCategory: "database",
    elapsedMs: 10,
    remainingMs: 10,
    cancellable: true,
  };
  emit?.({}, { ...valid, currentCategory: "D:\\secret" });
  expect(listener).not.toHaveBeenCalled();
  emit?.({}, valid);
  expect(listener).toHaveBeenCalledWith(valid);
  unsubscribe();
  emit?.({}, valid);
  expect(listener).toHaveBeenCalledOnce();
});

test("validates transfer requests before invoking their declared channels", async () => {
  const api = electron.exposed.get("patentApi") as {
    dataTransfer: { exportPackage(request: unknown): Promise<unknown> };
  };
  electron.invoke.mockClear();
  await expect(api.dataTransfer.exportPackage({ password: "incomplete" })).rejects.toThrow();
  expect(electron.invoke).not.toHaveBeenCalled();
});

test("drawing progress uses a validated event-only bridge and unsubscribes cleanly", () => {
  const api = electron.exposed.get("patentApi") as {
    assets: { onDrawingImportProgress(listener: (value: unknown) => void): () => void };
  };
  const listener = vi.fn();
  const unsubscribe = api.assets.onDrawingImportProgress(listener);
  const emit = electron.eventHandlers.get("drawings:import-progress");
  const valid = {
    sessionId: "00000000-0000-4000-8000-000000000901",
    operationId: "00000000-0000-4000-8000-000000000902",
    stage: { phase: "draw", completed: 1, total: 2 },
    elapsedMs: 100,
    overallPercent: 50,
    estimatedRemainingMs: [1000, 2000],
    takingLonger: false,
  };
  emit?.({}, { ...valid, overallPercent: 100 });
  emit?.({}, { ...valid, path: "private" });
  expect(listener).not.toHaveBeenCalled();
  emit?.({}, valid);
  expect(listener).toHaveBeenCalledWith(valid);
  unsubscribe();
  emit?.({}, valid);
  expect(listener).toHaveBeenCalledOnce();
});

test("requests normal quit through the declared application channel", async () => {
  const api = electron.exposed.get("patentApi") as {
    application: { requestQuit(): Promise<unknown> };
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: undefined });
  await api.application.requestQuit();
  expect(electron.invoke).toHaveBeenLastCalledWith("application:request-quit");
});

test("forwards committed CLI library changes across preload", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    automation: { onEvent(listener: (event: unknown) => void): () => void };
  };
  const listener = vi.fn();
  const dispose = api.automation.onEvent(listener);
  const event = {
    type: "libraryChanged",
    command: "patent.create",
    patentIds: ["p"],
    createdPatentIds: ["p"],
  };
  electron.eventHandlers.get("automation:event")?.({}, event);
  expect(listener).toHaveBeenCalledWith(event);
  dispose();
});

test("update bridge validates input and filters event payloads and unsubscribes", async () => {
  await import("./index.js");
  const api = (electron.exposed.get("patentApi") as import("../shared/ipc/contract.js").PatentApi)
    .updates;
  if (!api) throw Error("Update bridge missing");
  const state = {
    currentVersion: "1.1.1",
    status: "latest",
    release: null,
    lastCheckedAt: null,
    notification: false,
    sourceHost: null,
    message: "已是最新",
  };
  const listener = vi.fn();
  const off = api.onChanged(listener);
  electron.eventHandlers.get("updates:changed")?.({}, { bogus: true });
  expect(listener).not.toHaveBeenCalled();
  electron.eventHandlers.get("updates:changed")?.({}, state);
  expect(listener).toHaveBeenCalledOnce();
  off();
  electron.eventHandlers.get("updates:changed")?.({}, state);
  expect(listener).toHaveBeenCalledOnce();
  electron.invoke.mockResolvedValueOnce({ ok: true, value: undefined });
  await api.openDownload("1.2.0");
  expect(electron.invoke).toHaveBeenLastCalledWith("updates:open-download", "1.2.0");
  await expect(api.openDownload("https://evil.example.com")).rejects.toThrow();
});

test("usage statistics bridge validates choice and ignores malformed events", async () => {
  const { USAGE_NOTICE_VERSION } = await import("../shared/usage-statistics/model.js");
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as import("../shared/ipc/contract.js").PatentApi;
  const state = {
    enabled: false,
    accepted: false,
    available: false,
    status: "disabled",
    message: "已关闭",
    noticeVersion: USAGE_NOTICE_VERSION,
    lastAttempt: null,
    disclosure: {
      operator: "",
      contact: "",
      recipient: "",
      region: "",
      retentionMonths: 18,
      securityLogNotice: "",
    },
  };
  electron.invoke.mockResolvedValueOnce({ ok: true, value: state });
  expect(await api.usageStatistics?.choose({ enabled: false })).toEqual({ ok: true, value: state });
  expect(electron.invoke).toHaveBeenLastCalledWith("usage-statistics:choose", { enabled: false });
  const listener = vi.fn();
  const stop = api.usageStatistics?.onChanged(listener);
  electron.eventHandlers.get("usage-statistics:changed")?.({}, { ...state, deviceId: "forbidden" });
  expect(listener).not.toHaveBeenCalled();
  electron.eventHandlers.get("usage-statistics:changed")?.({}, state);
  expect(listener).toHaveBeenCalledWith(state);
  stop?.();
});

test("agreement bridge rejects missing versions and undeclared input before IPC", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as {
    agreements: { read(): Promise<unknown>; accept(value: unknown): Promise<unknown> };
  };
  electron.invoke.mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "测试" } });
  await api.agreements.read();
  expect(electron.invoke).toHaveBeenLastCalledWith("agreements:read");
  const request = {
    appVersion: "1.1.1",
    termsVersion: "terms-1",
    privacyVersion: "privacy-1",
    participate: false,
  };
  await api.agreements.accept(request);
  expect(electron.invoke).toHaveBeenLastCalledWith("agreements:accept", request);
  const count = electron.invoke.mock.calls.length;
  await expect(api.agreements.accept({ ...request, termsVersion: "" })).rejects.toThrow();
  await expect(api.agreements.accept({ ...request, deviceId: "forbidden" })).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledTimes(count);
});

test("resource inspection validates identifiers and does not accept renderer file paths", async () => {
  await import("./index.js");
  const api = electron.exposed.get("patentApi") as import("../shared/ipc/contract.js").PatentApi;
  const request = {
    patentId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    operationId: "00000000-0000-4000-8000-000000000003",
    expectedRevision: 0,
  };
  electron.invoke.mockResolvedValueOnce({
    ok: true,
    value: { patentId: request.patentId, patentRevision: 0, assets: [] },
  });
  await api.patents.inspectResources!(request);
  expect(electron.invoke).toHaveBeenLastCalledWith("patents:inspect-resources", request);
  const count = electron.invoke.mock.calls.length;
  await expect(
    api.patents.inspectResources!({ ...request, path: "/private/unrelated" } as typeof request),
  ).rejects.toThrow();
  expect(electron.invoke.mock.calls.length).toBe(count);
  electron.invoke.mockResolvedValueOnce({ ok: true, value: undefined });
  await api.patents.cancelResourceInspection!({
    sessionId: request.sessionId,
    operationId: request.operationId,
  });
  expect(electron.invoke).toHaveBeenLastCalledWith("patents:cancel-resource-inspection", {
    sessionId: request.sessionId,
    operationId: request.operationId,
  });
});
