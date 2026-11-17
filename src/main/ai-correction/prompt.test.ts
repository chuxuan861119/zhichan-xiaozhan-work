import { describe, expect, test } from "vitest";
import { buildCorrectionMessages } from "./prompt.js";

function systemPrompt(
  bookKind: "claims" | "description" | "abstract",
  scopeKind: "selection" | "current-book" = "current-book",
) {
  return (
    buildCorrectionMessages(scopeKind, [
      { segmentId: "segment-1", bookKind, text: "待检查文字" },
    ])[0]?.content ?? ""
  );
}

describe("AI correction document-specific prompts", () => {
  test("explains overlap ownership without treating the prefix as a second check", () => {
    const segment = {
      segmentId: "part-2",
      bookKind: "description" as const,
      text: "。。正文",
      checkFromOffset: 1,
    };
    const messages = buildCorrectionMessages("selection", [segment]);
    expect(messages[0]?.content).toContain("不单独报告完全位于前缀中的问题");
    expect(messages[0]?.content).toContain("originalText 必须包含完整错误文字");
    expect(JSON.parse(messages[1]?.content ?? "{}").untrustedPatentText).toEqual([segment]);
  });
  test.each(["claims", "description", "abstract"] as const)(
    "uses quote-only output and bounded review instructions for %s",
    (kind) => {
      const prompt = systemPrompt(kind);
      expect(prompt).not.toContain("startOffset");
      expect(prompt).not.toContain("endOffset");
      expect(prompt).not.toContain("UTF-16");
      expect(prompt).toContain("contextBefore");
      expect(prompt).toContain("consistency");
      expect(prompt).toContain("没有新证据");
      expect(prompt).toContain("不手工计算");
    },
  );
  test.each([true, false])(
    "keeps full and partial description coverage free of other book rules (%s)",
    (completeDocument) => {
      const prompt =
        buildCorrectionMessages("current-book", [
          {
            segmentId: "segment-1",
            bookKind: "description",
            text: "正文",
            requestContext: { completeDocument, chunkIndex: 1, chunkCount: 1 },
          },
        ])[0]?.content ?? "";
      expect(prompt).not.toContain("权利要求末段");
      expect(prompt).not.toContain("摘要要素");
      expect(prompt).not.toContain("claim.complete");
    },
  );
  test.each(["claims", "description", "abstract"] as const)(
    "defines bounded exact quotes and partial-context rules for %s",
    (kind) => {
      const prompt = systemPrompt(kind, "selection");
      expect(prompt).toContain("逐字复制");
      expect(prompt).toContain("4000");
      expect(prompt).toContain("1000");
      expect(prompt).toContain("不得根据选区或分块边界判断句子不完整");
      expect(prompt).not.toContain('"replacement":"正确"');
    },
  );
  test("routes claims rules without description or abstract rules", () => {
    const prompt = systemPrompt("claims");
    expect(prompt).toContain("权利要求编号、引用关系和从属关系");
    expect(prompt).toContain("不得改变权利要求保护范围");
    expect(prompt).toContain("多项从属权利要求");
    expect(prompt).toContain(
      "仅当同一项权利要求分成多个段落时，非最后段可以使用冒号或分号结尾，最后一段必须使用句号结尾",
    );
    expect(prompt).not.toContain("技术领域、背景技术、发明内容");
    expect(prompt).not.toContain("宣传性、评价性和不确定性措辞");
  });

  test("routes description rules without claims or abstract rules", () => {
    const prompt = systemPrompt("description");
    expect(prompt).toContain("技术领域、背景技术、发明内容、附图说明和具体实施方式");
    expect(prompt).toContain("不因为句子较长就直接判定为语病");
    expect(prompt).toContain("不得使用‘如权利要求……所述的……’一类引用语");
    expect(prompt).toContain("不得使用商业性宣传用语");
    expect(prompt).not.toContain("只有该项权利要求最后一段以句号结束");
    expect(prompt).not.toContain("宣传性、评价性和不确定性措辞");
  });

  test("routes abstract rules and excludes the local 300-character check", () => {
    const prompt = systemPrompt("abstract");
    expect(prompt).toContain("简洁、客观、连贯");
    expect(prompt).toContain("不对摘要附图进行处理");
    expect(prompt).toContain("摘要文字中出现的附图标记应当使用括号");
    expect(prompt).toContain("不得检查、计算或报告摘要是否超过300字");
    expect(prompt).not.toContain("技术领域、背景技术、发明内容、附图说明和具体实施方式");
  });

  test("limits selection conclusions to uploaded selection", () => {
    const prompt = systemPrompt("description", "selection");
    expect(prompt).toContain("只能报告可由当前选区独立证明的问题");
    expect(prompt).toContain("不得假设或引用选区外内容");
    expect(prompt).toContain("所有专用规则中的一致性、引用关系和章节要求都只适用于当前选区");
  });

  test("enables complete-document rules only when the request explicitly carries full coverage", () => {
    const partialPrompt =
      buildCorrectionMessages("selection", [
        {
          segmentId: "segment-1",
          bookKind: "claims",
          text: "包含一个支架；",
          requestContext: {
            chunkIndex: 1,
            chunkCount: 1,
            completeDocument: false,
          },
        },
      ])[0]?.content ?? "";
    const completePrompt =
      buildCorrectionMessages("selection", [
        {
          segmentId: "segment-1",
          bookKind: "claims",
          text: "1.一种装置。",
          requestContext: {
            chunkIndex: 1,
            chunkCount: 1,
            completeDocument: true,
          },
        },
      ])[0]?.content ?? "";

    expect(partialPrompt).not.toContain("完整输入中可以检查权利要求末段句号");
    expect(completePrompt).toContain("完整输入中可以检查权利要求末段句号");
  });

  test("does not ask a partial abstract selection to judge missing abstract elements", () => {
    const prompt =
      buildCorrectionMessages("selection", [
        {
          segmentId: "segment-1",
          bookKind: "abstract",
          text: "一种装置。",
          requestContext: { chunkIndex: 1, chunkCount: 1, completeDocument: false },
        },
      ])[0]?.content ?? "";
    expect(prompt).not.toContain("完整摘要输入可以检查其是否清楚表达");
  });

  test("rejects mixed book kinds instead of applying the wrong rules", () => {
    expect(() =>
      buildCorrectionMessages("current-book", [
        { segmentId: "claims-1", bookKind: "claims", text: "权利要求" },
        { segmentId: "description-1", bookKind: "description", text: "说明书" },
      ]),
    ).toThrow("同一次 AI 纠错请求只能包含一种文档类型");
  });
});
