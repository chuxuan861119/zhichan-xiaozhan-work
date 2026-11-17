import { createHash, randomUUID } from "node:crypto";
import { Editor } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/main/ai-correction/openai-compatible-provider.js";
import { PatentCorrectionService } from "../src/main/ai-correction/patent-correction-service.js";
import { createPatentExtensions } from "../src/renderer/src/editor/extensions.js";
import {
  applyCorrectionIssues,
  locateCorrectionAnchor,
  startCorrectionAnchorTracking,
} from "../src/renderer/src/patents/ai-correction/correction-anchor.js";
import {
  AiCorrectionEventSchema,
  type AiCorrectionIssue,
} from "../src/shared/ai-correction/contract.js";
import { DEFAULT_AI_CORRECTION_SETTINGS } from "../src/shared/ai-correction/model.js";
import { createBlankPatent } from "../src/shared/patent/defaults.js";
import { AUTOMATIC_EDIT_RED } from "../src/shared/patent/reference-marks.js";

const original = "前言。甲。。乙错字。";
async function checkSelection() {
  const patent = createBlankPatent({ patentType: "invention", name: "合成测试" });
  const book = patent.books.find((item) => item.kind === "description");
  if (!book) throw new Error("fixture");
  const blockId = randomUUID(),
    profileId = randomUUID();
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
      content: [{ type: "text", text: original, marks: [] }],
    },
  ];
  const editor = new Editor({
    extensions: createPatentExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { nodeId: blockId },
          content: [{ type: "text", text: original }],
        },
      ],
    },
  });
  const stop = startCorrectionAnchorTracking(editor);
  const wireIssues = [
    {
      segmentId: "segment-1",
      originalText: "。。",
      replacement: "。",
      category: "punctuation",
      risk: "low",
      applicability: "replace",
      explanation: "重复标点。",
    },
    {
      segmentId: "segment-1",
      originalText: "错字",
      replacement: "正字",
      category: "spelling",
      risk: "low",
      applicability: "replace",
      explanation: "合成文字修正。",
    },
  ];
  let resolve!: (issues: AiCorrectionIssue[]) => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<AiCorrectionIssue[]>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
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
          displayName: "合成测试",
          model: "deepseek-v4-flash",
          baseUrl: "https://api.deepseek.com",
        },
      ],
    }),
    patents: { requireActiveReadSession: () => patent },
    vault: { hasApiKey: async () => true, withApiKey: async (_id, use) => use("synthetic") },
    provider: new OpenAiCompatibleProvider(vi.fn(), async (_url, request, onData) => {
      expect(JSON.stringify(request.body.messages)).not.toContain("前言");
      onData({
        choices: [
          { delta: { content: JSON.stringify({ issues: wireIssues }) }, finish_reason: "stop" },
        ],
      });
    }),
    emit: (event) => {
      AiCorrectionEventSchema.parse(event);
      if (event.type === "failed") reject(new Error(event.message));
      if (event.type === "completed") resolve(event.issues);
    },
    randomUUID,
  });
  await service.start({
    jobId: randomUUID(),
    patentId: patent.patentId,
    sessionId: randomUUID(),
    expectedRevision: patent.revision,
    scope: {
      kind: "selection",
      bookKind: "description",
      blocks: [{ blockId, blockType: "paragraph", startOffset: 3, endOffset: original.length }],
      selectedTextHash: createHash("sha256").update(original.slice(3)).digest("hex"),
    },
    thinkingEnabled: true,
    uploadConfirmed: true,
  });
  return { editor, stop, issues: await completed };
}

test("quote-to-IPC-to-editor preserves selection offsets, red edits and undo", async () => {
  const { editor, stop, issues } = await checkSelection();
  try {
    const first = issues[0];
    if (!first) throw new Error("Expected a correction result");
    expect(issues).toHaveLength(2);
    expect(issues[0]?.anchor).toMatchObject({ startOffset: 4, endOffset: 6, originalText: "。。" });
    expect(locateCorrectionAnchor(editor, first)).toMatchObject({
      status: "ready",
      from: 5,
      to: 7,
    });
    expect(applyCorrectionIssues(editor, issues).skippedIssueIds).toEqual([]);
    expect(editor.getText()).toBe("前言。甲。乙正字。");
    expect(JSON.stringify(editor.getJSON())).toContain(AUTOMATIC_EDIT_RED);
    editor.commands.undo();
    expect(editor.getText()).toBe(original);
  } finally {
    stop();
    editor.destroy();
  }
});

test("quote-derived pending anchors track unrelated changes but refuse altered target text", async () => {
  const { editor, stop, issues } = await checkSelection();
  try {
    const first = issues[0];
    if (!first) throw new Error("Expected a correction result");
    editor.commands.insertContentAt(1, "新增");
    expect(locateCorrectionAnchor(editor, first)).toMatchObject({
      status: "ready",
      from: 7,
      to: 9,
    });
    editor.commands.insertContentAt({ from: 7, to: 9 }, "！");
    expect(applyCorrectionIssues(editor, [first]).skippedIssueIds).toEqual([first.issueId]);
    expect(editor.getText()).toContain("甲！");
  } finally {
    stop();
    editor.destroy();
  }
});
