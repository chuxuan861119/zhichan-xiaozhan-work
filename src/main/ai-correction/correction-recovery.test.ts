import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  type AiCorrectionEvent,
  AiCorrectionEventSchema,
} from "../../shared/ai-correction/contract.js";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../../shared/ai-correction/model.js";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { OpenAiCompatibleProvider, type ProviderIssue } from "./openai-compatible-provider.js";
import { PatentCorrectionService } from "./patent-correction-service.js";

const issue: ProviderIssue = {
  segmentId: "segment-1",
  startOffset: 0,
  endOffset: 2,
  originalText: "错误",
  replacement: "正确",
  category: "spelling",
  risk: "low",
  applicability: "replace",
  explanation: "错字",
};

test.each([199, 200, 201])("warns at the actual result ceiling: %i", async (count) => {
  const { startOffset: _start, endOffset: _end, ...quote } = issue;
  const provider = new OpenAiCompatibleProvider(async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({ issues: Array.from({ length: count }, () => quote) }),
        },
      },
    ],
  }));
  const result = await provider.correct({
    providerId: "custom",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
    model: "fixture",
    timeoutMs: 1000,
    thinkingEnabled: true,
    signal: new AbortController().signal,
    scopeKind: "current-book",
    segments: [{ segmentId: "segment-1", bookKind: "description", text: "错误" }],
  });
  expect(result.resultLimitReached).toBe(count >= 200);
});

test("publishes completed chunk results before a later chunk fails", async () => {
  const patent = createBlankPatent({ patentType: "invention", name: null });
  const book = patent.books.find((b) => b.kind === "description")!;
  const base = book.document.content.find((b) => b.type === "paragraph")!;
  if (base.type !== "paragraph") throw new Error("fixture");
  book.document.content = [
    {
      ...base,
      id: randomUUID(),
      content: [{ type: "text", text: "错误" + "文".repeat(39998), marks: [] }],
    },
    { ...base, id: randomUUID(), content: [{ type: "text", text: "文".repeat(20000), marks: [] }] },
  ];
  const profileId = randomUUID();
  const events: AiCorrectionEvent[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const service = new PatentCorrectionService({
    readSettings: async () => ({
      ...DEFAULT_AI_CORRECTION_SETTINGS,
      maxUploadCharacters: 100000,
      activeProfileId: profileId,
      profiles: [
        {
          profileId,
          providerId: "deepseek",
          displayName: "fixture",
          baseUrl: "https://api.deepseek.com",
          model: "fixture",
        },
      ],
    }),
    vault: { hasApiKey: async () => true, withApiKey: async (_, use) => use("fixture") },
    patents: { requireActiveReadSession: () => patent },
    randomUUID,
    provider: {
      correct: async () => {
        if (++calls === 1) return [issue];
        throw new Error("后续分块超时");
      },
    },
    emit: (event) => {
      expect(AiCorrectionEventSchema.safeParse(event).success).toBe(true);
      events.push(event);
      if (event.type === "failed" || event.type === "completed") finish();
    },
  });
  await service.start({
    patentId: patent.patentId,
    sessionId: randomUUID(),
    expectedRevision: patent.revision,
    jobId: randomUUID(),
    scope: { kind: "current-book", bookKind: "description" },
    thinkingEnabled: true,
    uploadConfirmed: true,
  });
  await completed;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "partial",
      completedChunks: 1,
      totalChunks: 2,
      issues: [expect.objectContaining({ replacement: "正确" })],
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "failed", message: "后续分块超时" });
});
