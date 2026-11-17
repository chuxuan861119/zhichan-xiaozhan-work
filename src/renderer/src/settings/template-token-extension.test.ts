import type { JSONContent } from "@tiptap/core";
import { PATENT_TEMPLATE_TOKENS } from "../../../shared/patent/templates";
import {
  TemplateTokenChips,
  templateTokenNodesToText,
  templateTokensToNodes,
} from "./template-token-extension";

test("converts persisted token strings to atomic nodes and back without losing marks", () => {
  const input: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `名称：${PATENT_TEMPLATE_TOKENS.patentName}。`,
            marks: [{ type: "bold" }, { type: "textStyle", attrs: { color: "#ef4444" } }],
          },
        ],
      },
    ],
  };

  const converted = templateTokensToNodes(input);
  const paragraph = converted.content?.[0];
  expect(paragraph?.content?.map((node) => node.type)).toEqual(["text", "templateToken", "text"]);
  expect(paragraph?.content?.[1]).toMatchObject({
    type: "templateToken",
    attrs: { token: PATENT_TEMPLATE_TOKENS.patentName },
    marks: input.content?.[0]?.content?.[0]?.marks,
  });
  expect(templateTokenNodesToText(converted)).toEqual(input);
});

test("declares template tokens as selectable inline atoms", () => {
  expect(TemplateTokenChips.config.inline).toBe(true);
  expect(TemplateTokenChips.config.atom).toBe(true);
  expect(TemplateTokenChips.config.selectable).toBe(true);
});

test.each(["发明", "实用新型"])("converts saved %s content headings to bold type chips", (name) => {
  const marks = [{ type: "bold" }];
  const source: JSONContent = {
    type: "heading",
    attrs: { level: 1 },
    content: [
      { type: "text", text: name, marks },
      { type: "text", text: "内容", marks },
    ],
  };
  const converted = templateTokensToNodes(source);
  expect(converted.attrs).toEqual(source.attrs);
  expect(converted.content).toEqual([
    { type: "templateToken", attrs: { token: PATENT_TEMPLATE_TOKENS.typeName }, marks },
    { type: "text", text: "内容", marks },
  ]);
  const saved = templateTokenNodesToText(converted);
  expect(saved.content?.[0]?.text).toBe(`${PATENT_TEMPLATE_TOKENS.typeName}内容`);
  expect(templateTokensToNodes(saved)).toEqual(converted);
  expect(source.content?.[0]?.text).toBe(name);
});

test("does not turn body mentions of invention content into heading chips", () => {
  const source: JSONContent = {
    type: "paragraph",
    content: [{ type: "text", text: "以下发明内容供参考。" }],
  };
  expect(templateTokensToNodes(source)).toEqual(source);
});

test("splits legacy self references into editable text and a type-only token without losing marks", () => {
  const marks = [{ type: "bold" }];
  const converted = templateTokensToNodes({
    type: "paragraph",
    content: [{ type: "text", text: PATENT_TEMPLATE_TOKENS.typeSelfReference, marks }],
  });
  expect(converted.content).toEqual([
    { type: "text", text: "本", marks },
    { type: "templateToken", attrs: { token: PATENT_TEMPLATE_TOKENS.typeName }, marks },
  ]);
  const saved = templateTokenNodesToText(converted);
  expect(saved.content?.[0]?.text).toBe(`本${PATENT_TEMPLATE_TOKENS.typeName}`);
  expect(templateTokenNodesToText(templateTokensToNodes(saved))).toEqual(saved);
  const withoutPrefix = { ...converted, content: converted.content?.slice(1) ?? [] };
  expect(templateTokenNodesToText(withoutPrefix).content?.[0]?.text).toBe(
    PATENT_TEMPLATE_TOKENS.typeName,
  );
});
