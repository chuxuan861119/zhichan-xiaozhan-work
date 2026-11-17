import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  AI_CORRECTION_ISSUE_LIMIT,
  type AiCorrectionEvent,
  type AiCorrectionIssue,
} from "../../shared/ai-correction/contract.js";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../../shared/ai-correction/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import type { ProviderIssue } from "./openai-compatible-provider.js";
import { PatentCorrectionService } from "./patent-correction-service.js";

function fixture() {
  const patent = createBlankPatent({ patentType: "invention", name: "不得上传" });
  patent.revision = 4;
  const book = patent.books.find((candidate) => candidate.kind === "description");
  if (!book) throw new Error("fixture");
  const blockId = randomUUID();
  book.document.content = [
    {
      id: blockId,
      type: "paragraph",
      attrs: {
        alignment: "left",
        paragraphIndentMm: 0,
        lineSpacing: 1.5,
        defaultFontFamily: "SimSun",
        defaultFontSizePt: 12,
      },
      content: [{ type: "text", text: "错别字", marks: [] }],
    },
  ];
  return { patent, blockId };
}

async function runCorrectionWithProviderIssue(
  text: string,
  providerIssue: Record<string, unknown> | Record<string, unknown>[],
): Promise<{ blockId: string; issues: AiCorrectionIssue[]; discardedIssueCount: number }> {
  const { patent, blockId } = fixture();
  const book = patent.books.find((candidate) => candidate.kind === "description");
  const block = book?.document.content[0];
  if (block?.type !== "paragraph") throw new Error("fixture");
  block.content = [{ type: "text", text, marks: [] }];
  const profileId = randomUUID();
  let completedIssues: AiCorrectionIssue[] = [];
  let discardedIssueCount = 0;
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const service = new PatentCorrectionService({
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      enabled: true,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "测试模型",
          baseUrl: "https://api.deepseek.com",
          model: "m",
        },
      ],
    }),
    vault: {
      hasApiKey: async () => true,
      withApiKey: async (_profileId, use) => await use("secret"),
    },
    patents: { requireActiveReadSession: () => patent },
    provider: {
      correct: async () =>
        (Array.isArray(providerIssue) ? providerIssue : [providerIssue]) as never,
    },
    emit: (event) => {
      if (event.type !== "completed") return;
      completedIssues = event.issues;
      discardedIssueCount = event.discardedIssueCount ?? 0;
      complete();
    },
    randomUUID,
  });
  await service.start({
    jobId: randomUUID(),
    patentId: patent.patentId,
    sessionId: randomUUID(),
    expectedRevision: patent.revision,
    scope: { kind: "current-book", bookKind: "description" },
    thinkingEnabled: false,
    uploadConfirmed: true,
  });
  await completed;
  return { blockId, issues: completedIssues, discardedIssueCount };
}

function concurrentServiceFixture() {
  const { patent } = fixture();
  const profileId = randomUUID();
  const sessionId = randomUUID();
  const events: Array<{ type: string; jobId: string }> = [];
  const service = new PatentCorrectionService({
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      enabled: true,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "测试模型",
          baseUrl: "https://api.deepseek.com",
          model: "m",
        },
      ],
    }),
    vault: {
      hasApiKey: async () => true,
      withApiKey: async (_profileId, use) => await use("secret"),
    },
    patents: { requireActiveReadSession: () => patent },
    provider: {
      correct: async ({ signal }) =>
        await new Promise<never[]>((resolve) => {
          if (signal.aborted) resolve([]);
          else signal.addEventListener("abort", () => resolve([]), { once: true });
        }),
    },
    emit: (event) => events.push({ type: event.type, jobId: event.jobId }),
    randomUUID,
  });
  return { events, patent, service, sessionId };
}

describe("patent correction service", () => {
  test.each([false, true])(
    "checks split-boundary errors once and protects conflicting batches (%s)",
    async (conflicting) => {
      const { patent, blockId } = fixture();
      const book = patent.books.find((book) => book.kind === "description");
      const paragraph = book?.document.content[0];
      if (paragraph?.type !== "paragraph") throw new Error("fixture");
      const text = `${"字".repeat(49_900)}错字${"字".repeat(97)}。。${"文".repeat(1000)}`;
      const outside = "不应发送的内容";
      paragraph.content = [{ type: "text", text: outside + text + outside, marks: [] }];
      const profileId = randomUUID();
      const events: AiCorrectionEvent[] = [];
      const correct = vi.fn(
        async ({ segments }: { segments: readonly { segmentId: string; text: string }[] }) =>
          segments.flatMap((segment) =>
            [
              "错字",
              "。。",
              ...(conflicting && segment.text.endsWith("。") ? ["字。"] : []),
            ].flatMap((quote) => {
              const startOffset = segment.text.indexOf(quote);
              return startOffset < 0
                ? []
                : [
                    {
                      segmentId: segment.segmentId,
                      startOffset,
                      endOffset: startOffset + quote.length,
                      originalText: quote,
                      category: "punctuation" as const,
                      risk: "low" as const,
                      applicability: "replace" as const,
                      replacement: quote === "。。" ? "。" : quote === "字。" ? "字；" : "文字",
                      explanation: "测试建议",
                    },
                  ];
            }),
          ),
      );
      const service = new PatentCorrectionService({
        readSettings: async () => ({
          ...DEFAULT_AI_CORRECTION_SETTINGS,
          maxUploadCharacters: 1000,
          activeProfileId: profileId,
          profiles: [
            {
              profileId,
              providerId: "deepseek",
              displayName: "测试",
              baseUrl: "https://api.deepseek.com",
              model: "deepseek-flash",
            },
          ],
        }),
        vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("synthetic") },
        patents: { requireActiveReadSession: () => patent },
        provider: { correct },
        emit: (event) => events.push(event),
        randomUUID,
      });
      await service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: 4,
        thinkingEnabled: true,
        uploadConfirmed: true,
        scope: {
          kind: "selection",
          bookKind: "description",
          selectedTextHash: createHash("sha256").update(text).digest("hex"),
          blocks: [
            {
              blockId,
              blockType: "paragraph",
              startOffset: outside.length,
              endOffset: outside.length + text.length,
            },
          ],
        },
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === "completed")).toBe(true));
      const completed = events.find((event) => event.type === "completed");
      if (completed?.type !== "completed") throw new Error("expected completion");
      expect(completed.issues.map((issue) => issue.anchor.originalText)).toEqual(
        conflicting ? ["错字", "字。", "。。"] : ["错字", "。。"],
      );
      const boundaryIssue = completed.issues.find((issue) => issue.anchor.originalText === "。。");
      expect(boundaryIssue?.anchor).toMatchObject({
        blockId,
        originalText: "。。",
        startOffset: outside.length + 49_999,
        endOffset: outside.length + 50_001,
      });
      expect(boundaryIssue?.replacement).toBe(conflicting ? null : "。");
      if (conflicting) {
        expect(
          completed.issues.slice(1).every((issue) => issue.applicability === "analysis-only"),
        ).toBe(true);
      }
      expect(completed.discardedIssueCount).toBe(0);
      expect(correct).toHaveBeenCalledTimes(2);
      for (const [request] of correct.mock.calls) {
        expect(request.segments.every((segment) => !segment.text.includes(outside))).toBe(true);
        expect(
          request.segments.reduce((n, segment) => n + segment.text.length, 0),
        ).toBeLessThanOrEqual(50_000);
      }
      expect(events.filter((event) => event.type === "progress")).toEqual([
        expect.objectContaining({ completedChunks: 0, totalChunks: 2 }),
        expect.objectContaining({ completedChunks: 1, totalChunks: 2 }),
        expect.objectContaining({ completedChunks: 2, totalChunks: 2 }),
      ]);
    },
  );

  test("checks unlimited selected text in bounded chunks without applying the current-document cap", async () => {
    const { patent } = fixture();
    const book = patent.books.find((book) => book.kind === "description");
    const paragraph = book?.document.content[0];
    if (!book || paragraph?.type !== "paragraph") throw new Error("fixture");
    const text = "文字".repeat(60);
    book.document.content = Array.from({ length: 1100 }, () => ({
      ...paragraph,
      id: randomUUID(),
      content: [{ type: "text" as const, text, marks: [] }],
    }));
    const profileId = randomUUID();
    const correct = vi.fn(async () => []);
    const events: AiCorrectionEvent[] = [];
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        maxUploadCharacters: 1000,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-flash",
          },
        ],
      }),
      vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("synthetic") },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: (event) => events.push(event),
      randomUUID,
    });
    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: 4,
      thinkingEnabled: true,
      uploadConfirmed: true,
      scope: {
        kind: "selection",
        bookKind: "description",
        selectedTextHash: createHash("sha256")
          .update(Array(1100).fill(text).join("\n"))
          .digest("hex"),
        blocks: book.document.content.map((p) => ({
          blockId: p.id,
          blockType: "paragraph",
          startOffset: 0,
          endOffset: text.length,
        })),
      },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "completed")).toBe(true));
    expect(correct).toHaveBeenCalledTimes(3);
    const requests = correct.mock.calls as unknown as Array<
      [{ segments: Array<{ text: string }> }]
    >;
    expect(
      requests
        .flatMap(([request]) => request.segments)
        .map((s) => s.text)
        .join(""),
    ).toBe(text.repeat(1100));
    expect(
      requests.every(
        ([request]) => request.segments.reduce((n, s) => n + s.text.length, 0) <= 50000,
      ),
    ).toBe(true);
  });
  test("cancels while the privacy gate is pending without reading settings", async () => {
    const { patent } = fixture();
    const readSettings = vi.fn(async () => DEFAULT_AI_CORRECTION_SETTINGS);
    const events: AiCorrectionEvent[] = [];
    const service = new PatentCorrectionService({
      readSettings,
      vault: { hasApiKey: vi.fn(), withApiKey: vi.fn() },
      provider: { correct: vi.fn() },
      patents: { requireActiveReadSession: () => patent },
      emit: (event) => events.push(event),
      randomUUID,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobId = randomUUID();
    const pending = service.start(
      {
        jobId,
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: 4,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: true,
        uploadConfirmed: true,
      },
      () => gate,
    );
    expect(service.cancel(jobId)).toBe(true);
    release();
    await pending;
    expect(events).toContainEqual({ type: "cancelled", jobId });
    expect(readSettings).not.toHaveBeenCalled();
  });
  test("conflicting overlapping replacements are analysis only", async () => {
    const base = {
      segmentId: "segment-1",
      startOffset: 0,
      endOffset: 1,
      originalText: "错",
      category: "spelling",
      risk: "low",
      applicability: "replace",
      explanation: "测试",
    };
    const result = await runCorrectionWithProviderIssue("错别字", [
      { ...base, replacement: "正" },
      { ...base, replacement: "措" },
    ]);
    expect(result.issues).toHaveLength(2);
    expect(
      result.issues.every(
        (issue) => issue.applicability === "analysis-only" && issue.replacement === null,
      ),
    ).toBe(true);
  });
  test.each(["10mm", "甲\n乙"])(
    "unsafe %s replacement is downgraded before reaching the panel",
    async (text) => {
      const result = await runCorrectionWithProviderIssue(text, {
        segmentId: "segment-1",
        startOffset: 0,
        endOffset: text.length,
        originalText: text,
        replacement: "改写",
        category: "grammar",
        risk: "low",
        applicability: "replace",
        explanation: "测试",
      });
      expect(result.issues[0]).toMatchObject({
        risk: "high",
        applicability: "analysis-only",
        replacement: null,
      });
    },
  );
  test("cancels while settings are loading without accessing credentials or sending text", async () => {
    const { patent } = fixture();
    let release!: (settings: typeof DEFAULT_AI_CORRECTION_SETTINGS) => void;
    const settings = new Promise<typeof DEFAULT_AI_CORRECTION_SETTINGS>((resolve) => {
      release = resolve;
    });
    const provider = { correct: vi.fn(async () => []) };
    const vault = { hasApiKey: vi.fn(async () => true), withApiKey: vi.fn() };
    const events: AiCorrectionEvent[] = [];
    const service = new PatentCorrectionService({
      readSettings: () => settings,
      vault,
      provider,
      patents: { requireActiveReadSession: () => patent },
      emit: (event) => events.push(event),
      randomUUID,
    });
    const jobId = randomUUID();
    const pending = service.start({
      jobId,
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });
    expect(service.cancel(jobId)).toBe(true);
    release(DEFAULT_AI_CORRECTION_SETTINGS);
    await pending;
    expect(events).toContainEqual({ type: "cancelled", jobId });
    expect(vault.hasApiKey).not.toHaveBeenCalled();
    expect(provider.correct).not.toHaveBeenCalled();
    expect(service.cancel(jobId)).toBe(false);
  });

  test("discards replacements which do not change any text", async () => {
    const result = await runCorrectionWithProviderIssue("错别字", {
      segmentId: "segment-1",
      startOffset: 0,
      endOffset: 3,
      originalText: "错别字",
      replacement: "错别字",
      category: "spelling",
      risk: "low",
      applicability: "replace",
      explanation: "测试",
    });
    expect(result.issues).toEqual([]);
    expect(result.discardedIssueCount).toBe(1);
  });
  test("allows different books in one patent to run concurrently and cancel independently", async () => {
    const { events, patent, service, sessionId } = concurrentServiceFixture();
    const claimsJobId = randomUUID();
    const descriptionJobId = randomUUID();

    await service.start({
      jobId: claimsJobId,
      patentId: patent.patentId,
      sessionId,
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "claims" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });
    await service.start({
      jobId: descriptionJobId,
      patentId: patent.patentId,
      sessionId,
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });

    expect(service.cancel(claimsJobId)).toBe(true);
    expect(service.cancel(descriptionJobId)).toBe(true);
    await vi.waitFor(() => {
      expect(events.filter(({ type }) => type === "cancelled")).toHaveLength(2);
    });
  });

  test("rejects a second running task for the same book", async () => {
    const { patent, service, sessionId } = concurrentServiceFixture();
    const jobId = randomUUID();
    await service.start({
      jobId,
      patentId: patent.patentId,
      sessionId,
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "claims" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });

    await expect(
      service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId,
        expectedRevision: patent.revision,
        scope: { kind: "current-book", bookKind: "claims" },
        thinkingEnabled: true,
        uploadConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(service.cancel(jobId)).toBe(true);
  });

  test("repairs a one-character model offset only when original text identifies one nearby range", async () => {
    const text =
      "4.根据权利要求1所述的一种电动汽车电池冷却机构，其特征在于：所述连接轴与所述电池主体同轴心设置，所述电池主体的底部配置有支撑底座，防护壳与支撑底座之间留有通风缝隙。。";
    const { blockId, issues } = await runCorrectionWithProviderIssue(text, {
      segmentId: "segment-1",
      startOffset: text.length - 3,
      endOffset: text.length - 1,
      originalText: "。。",
      category: "punctuation",
      risk: "low",
      applicability: "replace",
      replacement: "。",
      explanation: "存在重复句号。",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        replacement: "。",
        anchor: expect.objectContaining({
          blockId,
          startOffset: text.length - 2,
          endOffset: text.length,
          originalText: "。。",
        }),
      }),
    ]);
  });

  test("repairs an oversized model end offset instead of emitting an out-of-bounds anchor", async () => {
    const text = "尾部。。";
    const { issues } = await runCorrectionWithProviderIssue(text, {
      segmentId: "segment-1",
      startOffset: 2,
      endOffset: 99,
      originalText: "。。",
      category: "punctuation",
      risk: "low",
      applicability: "replace",
      replacement: "。",
      explanation: "存在重复句号。",
    });

    expect(issues[0]?.anchor).toMatchObject({ startOffset: 2, endOffset: 4, originalText: "。。" });
  });

  test("rejects an offset mismatch when original text has multiple nearby matches", async () => {
    const { issues, discardedIssueCount } = await runCorrectionWithProviderIssue("错字错字", {
      segmentId: "segment-1",
      startOffset: 1,
      endOffset: 3,
      originalText: "错字",
      category: "spelling",
      risk: "low",
      applicability: "replace",
      replacement: "正确",
      explanation: "存在错字。",
    });

    expect(issues).toEqual([]);
    expect(discardedIssueCount).toBe(1);
  });

  test("emits validated anchored results without mutating the patent", async () => {
    const { patent, blockId } = fixture();
    const profileId = randomUUID();
    const events: unknown[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: false,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "m",
          },
        ],
      }),
      vault: {
        hasApiKey: async (requestedProfileId) => requestedProfileId === profileId,
        withApiKey: async (requestedProfileId, use) => {
          expect(requestedProfileId).toBe(profileId);
          return await use("secret");
        },
      },
      patents: { requireActiveReadSession: () => structuredClone(patent) },
      provider: {
        correct: async (input) => {
          expect(input).toMatchObject({ thinkingEnabled: true, timeoutMs: 600_000 });
          expect(input.segments).toEqual([
            {
              segmentId: "segment-1",
              bookKind: "description",
              text: "错别字",
              boundary: { startsAtParagraphStart: true, endsAtParagraphEnd: true },
              structure: "paragraph",
              claim: undefined,
              requestContext: { chunkIndex: 1, chunkCount: 1, completeDocument: true },
            },
          ]);
          return [
            {
              segmentId: "segment-1",
              startOffset: 0,
              endOffset: 1,
              originalText: "错",
              category: "spelling",
              risk: "low",
              applicability: "replace",
              replacement: "正",
              explanation: "错字。",
            },
          ];
        },
      },
      emit: (event) => {
        events.push(event);
        if (["completed", "failed", "cancelled"].includes(event.type)) complete();
      },
      randomUUID,
    });

    const { jobId } = await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: 4,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: false,
      uploadConfirmed: true,
    });
    await completed;

    expect(events).toContainEqual(expect.objectContaining({ type: "started", jobId }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "completed",
        issues: [
          expect.objectContaining({
            anchor: expect.objectContaining({ blockId, originalText: "错" }),
          }),
        ],
      }),
    );
    expect(
      patent.books.find((candidate) => candidate.kind === "description")?.document.content[0],
    ).toMatchObject({ id: blockId });
  });

  test("streams DeepSeek Thinking phases with a ten-minute per-chunk deadline", async () => {
    const { patent } = fixture();
    const profileId = randomUUID();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const correct = vi.fn(async (input) => {
      const thinkingInput = input as typeof input & {
        thinkingEnabled: boolean;
        onPhase?(phase: "thinking" | "structuring"): void;
        onReasoningDelta?(delta: string): void;
      };
      thinkingInput.onPhase?.("thinking");
      thinkingInput.onReasoningDelta?.("正在核对术语");
      thinkingInput.onPhase?.("structuring");
      return [];
    });
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "DeepSeek · V4 Pro",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-v4-pro",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: (event) => {
        events.push(event);
        if (event.type === "completed") complete();
      },
      randomUUID,
    });

    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });
    await completed;

    expect(correct).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingEnabled: true, timeoutMs: 600_000 }),
    );
    expect(events.map(({ type }) => type)).toEqual([
      "started",
      "phase",
      "progress",
      "phase",
      "phase",
      "reasoning",
      "phase",
      "progress",
      "completed",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "reasoning", delta: "正在核对术语" }),
    );
  });

  test("rejects a stale persisted revision before contacting the provider", async () => {
    const { patent } = fixture();
    const profileId = randomUUID();
    const correct = vi.fn();
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "m",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: () => undefined,
      randomUUID,
    });
    await expect(
      service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: 3,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: false,
        uploadConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(correct).not.toHaveBeenCalled();
  });

  test("rejects a configuration without an active model", async () => {
    const { patent } = fixture();
    const correct = vi.fn();
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: false,
      }),
      vault: {
        hasApiKey: async () => false,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: () => undefined,
      randomUUID,
    });

    await expect(
      service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: patent.revision,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: false,
        uploadConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "AI_DISABLED" });
    expect(correct).not.toHaveBeenCalled();
  });

  test("rejects removed local providers before reading credentials or contacting AI", async () => {
    const { patent } = fixture();
    const profileId = randomUUID();
    const correct = vi.fn(
      async (_input: { segments: readonly { segmentId: string; text: string }[] }) => [],
    );
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "ollama",
            displayName: "Ollama · Qwen3 8B",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "qwen3:8b",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => false,
        withApiKey: async () => {
          throw new Error("Ollama 不应读取密钥");
        },
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: vi.fn(),
      randomUUID,
    });
    await expect(
      service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: patent.revision,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: false,
        uploadConfirmed: true,
      }),
    ).rejects.toThrow("请先选择用于 AI 纠错的模型。");
    expect(correct).not.toHaveBeenCalled();
  });

  test("keeps ordinary segments whole while chunking at 50000 characters", async () => {
    const { patent } = fixture();
    const book = patent.books.find((candidate) => candidate.kind === "description");
    if (!book) throw new Error("fixture");
    const paragraph = book.document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    book.document.content = [
      {
        ...paragraph,
        id: randomUUID(),
        content: [{ type: "text", text: "甲".repeat(30_000), marks: [] }],
      },
      {
        ...paragraph,
        id: randomUUID(),
        content: [{ type: "text", text: "乙".repeat(30_000), marks: [] }],
      },
    ];
    const profileId = randomUUID();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const correct = vi.fn(
      async (_input: {
        segments: readonly { segmentId: string; text: string }[];
        scopeKind: "selection" | "current-book";
        timeoutMs: number;
      }) => [],
    );
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        maxUploadCharacters: 100_000,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "m",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: (event) => {
        events.push(event);
        if (event.type === "completed") complete();
      },
      randomUUID,
    });

    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: false,
      uploadConfirmed: true,
    });
    await completed;

    expect(correct).toHaveBeenCalledTimes(2);
    expect(
      correct.mock.calls.map(([input]) => input.segments.map((segment) => segment.text.length)),
    ).toEqual([[30_000], [30_000]]);
    expect(correct).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "current-book", timeoutMs: 600_000 }),
    );
    expect(events.filter(({ type }) => type === "progress")).toEqual([
      expect.objectContaining({ completedChunks: 0, totalChunks: 2 }),
      expect.objectContaining({ completedChunks: 1, totalChunks: 2 }),
      expect.objectContaining({ completedChunks: 2, totalChunks: 2 }),
    ]);
  });

  test.each([50_001, 100_000])(
    "splits a %s-character segment with bounded intact overlap",
    async (length) => {
      const { patent } = fixture();
      const book = patent.books.find((candidate) => candidate.kind === "description");
      if (!book) throw new Error("fixture");
      const paragraph = book.document.content[0];
      if (paragraph?.type !== "paragraph") throw new Error("fixture");
      book.document.content = [
        {
          ...paragraph,
          id: randomUUID(),
          content: [
            {
              type: "text",
              text: `${"甲".repeat(49_999)}😀${"甲".repeat(length - 50_001)}`,
              marks: [],
            },
          ],
        },
      ];
      const profileId = randomUUID();
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const correct = vi.fn(
        async (_input: {
          segments: readonly { segmentId: string; text: string; checkFromOffset?: number }[];
          scopeKind: "selection" | "current-book";
          timeoutMs: number;
        }) => [],
      );
      const service = new PatentCorrectionService({
        readSettings: async () => ({
          ...DEFAULT_AI_CORRECTION_SETTINGS,
          enabled: true,
          maxUploadCharacters: 100_000,
          activeProfileId: profileId,
          profiles: [
            {
              profileId,
              providerId: "deepseek",
              displayName: "测试模型",
              baseUrl: "https://api.deepseek.com",
              model: "m",
            },
          ],
        }),
        vault: {
          hasApiKey: async () => true,
          withApiKey: async (_profileId, use) => await use("secret"),
        },
        patents: { requireActiveReadSession: () => patent },
        provider: { correct },
        emit: (event) => {
          if (event.type === "completed") complete();
        },
        randomUUID,
      });
      await service.start({
        jobId: randomUUID(),
        patentId: patent.patentId,
        sessionId: randomUUID(),
        expectedRevision: patent.revision,
        scope: { kind: "current-book", bookKind: "description" },
        thinkingEnabled: true,
        uploadConfirmed: true,
      });
      await completed;

      expect(correct).toHaveBeenCalledTimes(length === 50_001 ? 2 : 3);
      const sent = correct.mock.calls.flatMap(([input]) => input.segments);
      expect(sent.map((segment) => segment.text.slice(segment.checkFromOffset ?? 0)).join("")).toBe(
        `${"甲".repeat(49_999)}😀${"甲".repeat(length - 50_001)}`,
      );
      for (const segment of sent) {
        expect(segment.text.length).toBeLessThanOrEqual(50_000);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(segment.text)).toBe(false);
      }
    },
  );

  test("marks the completed result when a chunk reaches the 200 issue limit", async () => {
    const { patent } = fixture();
    const book = patent.books.find((candidate) => candidate.kind === "description");
    if (!book) throw new Error("fixture");
    const paragraph = book.document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    book.document.content = [
      {
        ...paragraph,
        id: randomUUID(),
        content: [{ type: "text", text: "错".repeat(AI_CORRECTION_ISSUE_LIMIT), marks: [] }],
      },
    ];
    const profileId = randomUUID();
    const events: AiCorrectionEvent[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const correct = vi.fn(
      async (input: { segments: readonly { segmentId: string; text: string }[] }) => {
        const segment = input.segments[0];
        if (!segment) throw new Error("missing test segment");
        return Array.from(
          { length: AI_CORRECTION_ISSUE_LIMIT },
          (_, index): ProviderIssue => ({
            segmentId: segment.segmentId,
            startOffset: index,
            endOffset: index + 1,
            originalText: "错",
            category: "spelling",
            risk: "low",
            applicability: "replace",
            replacement: "正",
            explanation: "错字。",
          }),
        );
      },
    );
    const service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        maxUploadCharacters: 100_000,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "m",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: (event) => {
        events.push(event);
        if (event.type === "completed") complete();
      },
      randomUUID,
    });
    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: true,
      uploadConfirmed: true,
    });
    await completed;

    expect(events).toContainEqual(
      expect.objectContaining({ type: "completed", resultLimitReached: true }),
    );
  });

  test("stops before the next chunk when cancelled after progress", async () => {
    const { patent } = fixture();
    const book = patent.books.find((candidate) => candidate.kind === "description");
    if (!book) throw new Error("fixture");
    const paragraph = book.document.content[0];
    if (paragraph?.type !== "paragraph") throw new Error("fixture");
    book.document.content = [
      {
        ...paragraph,
        id: randomUUID(),
        content: [{ type: "text", text: "甲".repeat(5_000), marks: [] }],
      },
      {
        ...paragraph,
        id: randomUUID(),
        content: [{ type: "text", text: "乙".repeat(4_000), marks: [] }],
      },
    ];
    const profileId = randomUUID();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const correct = vi.fn(async () => []);
    let service!: PatentCorrectionService;
    service = new PatentCorrectionService({
      readSettings: async () => ({
        ...DEFAULT_AI_CORRECTION_SETTINGS,
        enabled: true,
        activeProfileId: profileId,
        profiles: [
          {
            profileId,
            providerId: "deepseek",
            displayName: "测试模型",
            baseUrl: "https://api.deepseek.com",
            model: "m",
          },
        ],
      }),
      vault: {
        hasApiKey: async () => true,
        withApiKey: async (_profileId, use) => await use("secret"),
      },
      patents: { requireActiveReadSession: () => patent },
      provider: { correct },
      emit: (event) => {
        events.push(event);
        if (event.type === "progress" && event.completedChunks === 1) service.cancel(event.jobId);
        if (event.type === "cancelled") cancelled();
      },
      randomUUID,
    });

    await service.start({
      jobId: randomUUID(),
      patentId: patent.patentId,
      sessionId: randomUUID(),
      expectedRevision: patent.revision,
      scope: { kind: "current-book", bookKind: "description" },
      thinkingEnabled: false,
      uploadConfirmed: true,
    });
    await cancellation;

    expect(correct).toHaveBeenCalledTimes(1);
    expect(events.filter(({ type }) => type === "cancelled")).toHaveLength(1);
    expect(events.some(({ type }) => type === "completed")).toBe(false);
  });
});

test("forwards formula context to the provider and never accepts formula replacement", async () => {
  const { patent } = fixture();
  const book = patent.books.find((b) => b.kind === "description")!;
  const block = book.document.content[0]!;
  if (block.type !== "paragraph") throw new Error("fixture");
  block.content = [
    { type: "text", text: "计算", marks: [] },
    { type: "inline-formula", source: "Q=P/R", formulaKind: "math" },
  ];
  const profileId = randomUUID();
  const events: AiCorrectionEvent[] = [];
  const correct = vi.fn(
    async () =>
      [
        {
          segmentId: "segment-1",
          category: "spelling",
          risk: "low",
          applicability: "replace",
          originalText: "\uFFFC",
          replacement: "Q=P*R",
          explanation: "修改公式",
          startOffset: 2,
          endOffset: 3,
        },
      ] as ProviderIssue[],
  );
  const service = new PatentCorrectionService({
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      enabled: true,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "测试",
          baseUrl: "https://api.deepseek.com",
          model: "m",
        },
      ],
    }),
    vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("test") },
    patents: { requireActiveReadSession: () => patent },
    provider: { correct },
    emit: (event) => {
      events.push(event);
    },
    randomUUID,
  });
  await service.start({
    jobId: randomUUID(),
    patentId: patent.patentId,
    sessionId: randomUUID(),
    expectedRevision: patent.revision,
    scope: { kind: "current-book", bookKind: "description" },
    thinkingEnabled: false,
    uploadConfirmed: true,
  });
  await vi.waitFor(() => expect(events.some((e) => e.type === "completed")).toBe(true));
  expect(correct).toHaveBeenCalledWith(
    expect.objectContaining({
      segments: [
        expect.objectContaining({ objects: [{ offset: 2, description: '公式 "Q=P/R"' }] }),
      ],
    }),
  );
  const completed = events.find((e) => e.type === "completed");
  if (completed?.type !== "completed") throw new Error("completion");
  expect(completed.issues[0]).toMatchObject({ applicability: "analysis-only", replacement: null });
});
