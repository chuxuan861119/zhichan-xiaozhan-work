import { expect, test } from "vitest";
import { createBlankPatent } from "../../../shared/patent/defaults";
import { createRulerModelCalculator } from "./ruler-model-cache";

test("description text/format edits reuse marker models but structural edits invalidate them", () => {
  const book = createBlankPatent({ patentType: "invention", name: "测试" }).books.find(
    (b) => b.kind === "description",
  );
  if (!book) throw new Error("Missing description");
  const calculate = createRulerModelCalculator();
  const document = structuredClone(book.document);
  const first = calculate(document, "description");
  const body = document.content.find(
    (b) => b.type === "paragraph" && b.attrs.alignment !== "center" && b.content.length === 0,
  );
  if (body?.type !== "paragraph") throw new Error("missing empty body paragraph");
  body.content = [{ type: "text", text: "正文一", marks: [] }];
  const filled = calculate(document, "description");
  expect(filled).not.toBe(first);
  body.content = [{ type: "text", text: "正文修改", marks: [{ type: "bold" }] }];
  expect(calculate(document, "description")).toBe(filled);
  body.content = [{ type: "text", text: "背景技术", marks: [] }];
  body.attrs.paragraphIndentMm = 0;
  body.attrs.alignment = "left";
  expect(calculate(document, "description")).not.toBe(filled);
  const titled = calculate(document, "description");
  document.content.reverse();
  expect(calculate(document, "description")).not.toBe(titled);
});

test("claims are recalculated after reference and number text changes", () => {
  const document = createBlankPatent({ patentType: "invention", name: null }).books[0]?.document;
  if (!document) throw new Error("Missing claims");
  const calculate = createRulerModelCalculator();
  const first = calculate(document, "claims");
  expect(calculate(document, "claims")).not.toBe(first);
});
