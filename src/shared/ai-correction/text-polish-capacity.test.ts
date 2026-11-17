import { expect, test } from "vitest";
import { textPolishCapacity, textPolishHistoryCapacity } from "./text-polish-capacity.js";

test("accounts for assistant history and reserves a complete reply before sending", () => {
  const messages = Array.from({ length: 33 }, (_, index) => ({
    role: "assistant" as const,
    messageId: String(index),
    turnId: String(index),
    reply: { kind: "revision" as const, message: "已完成", revisedText: "文".repeat(20000) },
  }));
  const budget = textPolishHistoryCapacity(messages, "文".repeat(20000));
  expect(budget.canSend).toBe(false);
  expect(budget.bytes).toBeGreaterThan(2_000_000);
  expect(textPolishCapacity(null, messages, "文".repeat(20000), "继续", 50000).warning).toBe(true);
  expect(textPolishHistoryCapacity([], "").canSend).toBe(true);
});

test("warns about irreducible context before a long conversation hits the ceiling", () => {
  const source = { kind: "generation" as const, requirement: "任务" };
  expect(textPolishCapacity(source, [], "", "简化", 50000).warning).toBe(false);
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    messageId: String(i),
    turnId: String(i),
    text: "字".repeat(1000),
  }));
  const capacity = textPolishCapacity(source, messages, "稿".repeat(20000), "继续", 50000);
  expect(capacity.warning).toBe(true);
  expect(capacity.estimatedCharacters).toBeGreaterThan(50000);
});
