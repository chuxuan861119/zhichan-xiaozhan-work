import { expect, test } from "vitest";
import { polishTextEdits } from "./text-polish-diff";

test.each([
  ["完全相同", "完全相同"],
  ["风冷效率比较低且耗能比较高", "风冷效率较低且耗能较高"],
  ["😀温度30°C。。", "😃温度30°C。"],
  ["abc", ""],
  ["", "abc"],
  ["甲乙甲丙甲", "甲丁乙甲戊丙甲"],
])("aligned edits reconstruct %s without changing equal ranges", (original, revised) => {
  const edits = polishTextEdits(original, revised);
  expect(edits).not.toBeNull();
  if (!edits) throw new Error("alignment unavailable");
  let result = original;
  for (const edit of [...edits].reverse())
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  expect(result).toBe(revised);
});

test("large unmatched formatted text requests confirmation instead of unbounded alignment", () => {
  expect(polishTextEdits("甲".repeat(20_000), "乙".repeat(20_000))).toBeNull();
});
