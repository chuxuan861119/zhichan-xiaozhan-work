import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createBlankPatent } from "../../shared/patent/defaults.js";
import { OpenAiCompatibleProvider, type PostJson } from "./openai-compatible-provider.js";
import { buildPatentCorrectionContext } from "./patent-context-builder.js";

describe("AI correction privacy boundary", () => {
  test("sends only authorized book text and keeps metadata, paths, and credentials out of the body", async () => {
    const patent = createBlankPatent({ patentType: "invention", name: "客户秘密专利" });
    patent.customer = "客户秘密";
    patent.assets = [
      {
        assetId: randomUUID(),
        kind: "image",
        originalName: "C:\\secret\\case.png",
        mediaType: "image/png",
        extension: "png",
        byteLength: 100,
        sha256: "A".repeat(64),
        widthPx: 100,
        heightPx: 100,
        previewByteLength: 50,
        previewSha256: "B".repeat(64),
      },
    ];
    const expectedTexts = [
      ["claims", "权利要求唯一正文"],
      ["description", "说明书唯一正文"],
      ["abstract", "摘要唯一正文"],
    ] as const;
    for (const [kind, text] of expectedTexts) {
      const book = patent.books.find((candidate) => candidate.kind === kind);
      if (!book) throw new Error("fixture");
      book.document.content = [
        {
          id: randomUUID(),
          type: "paragraph",
          attrs: {
            alignment: "left",
            paragraphIndentMm: 0,
            lineSpacing: 1.5,
            defaultFontFamily: "SimSun",
            defaultFontSizePt: 12,
          },
          content: [{ type: "text", text, marks: [] }],
        },
      ];
    }
    const context = buildPatentCorrectionContext(
      patent,
      { kind: "current-book", bookKind: "description" },
      1_000,
    );
    const postJson = vi.fn<PostJson>(async () => ({
      choices: [{ message: { content: '{"issues":[]}' } }],
    }));
    const provider = new OpenAiCompatibleProvider(postJson);

    await provider.correct({
      providerId: "custom",
      baseUrl: "https://provider.example/v1",
      model: "model-a",
      apiKey: "test-api-key",
      timeoutMs: 60_000,
      thinkingEnabled: false,
      signal: new AbortController().signal,
      scopeKind: "current-book",
      segments: context.segments.map(({ segmentId, bookKind, text }) => ({
        segmentId,
        bookKind,
        text,
      })),
    });

    const serializedBody = JSON.stringify(postJson.mock.calls[0]?.[1].body);
    expect(serializedBody).toContain("说明书唯一正文");
    expect(serializedBody).not.toContain("权利要求唯一正文");
    expect(serializedBody).not.toContain("摘要唯一正文");
    expect(serializedBody).not.toContain("客户秘密");
    expect(serializedBody).not.toContain("C:\\secret\\case");
    expect(serializedBody).not.toContain("test-api-key");
  });
});
