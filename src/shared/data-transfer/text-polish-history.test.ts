import { expect, test } from "vitest";
import { stripTextPolishReasoning, validateTextPolishHistoryEntry } from "./text-polish-history.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("strips only the transient snapshot field from parseable recovery data", () => {
  const record = {
    snapshot: {
      messages: ["reasoningByTurn 是用户正文"],
      reasoningByTurn: { text: "思考" },
      unknown: "保留",
    },
    updatedAt: "原日期",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  expect(JSON.parse(new TextDecoder().decode(stripTextPolishReasoning(bytes)))).toEqual({
    snapshot: { messages: record.snapshot.messages, unknown: "保留" },
    updatedAt: "原日期",
  });
  const corrupt = new TextEncoder().encode("{broken");
  expect(stripTextPolishReasoning(corrupt)).toBe(corrupt);
});
test("rejects oversized polish JSON before decoding but keeps quarantined attachments opaque", () => {
  const bytes = new Uint8Array(16 * 1024 * 1024 + 1);
  expect(() =>
    validateTextPolishHistoryEntry(`text-polish-history/${id}/active.json`, bytes),
  ).toThrow("Polish history JSON exceeds size limit");
  expect(() =>
    validateTextPolishHistoryEntry(`text-polish-history/${id}/active.json.unreadable-${id}`, bytes),
  ).not.toThrow();
});
