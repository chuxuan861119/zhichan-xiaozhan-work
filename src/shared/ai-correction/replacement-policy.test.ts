import { expect, test } from "vitest";
import { replacementSafetyReason } from "./replacement-policy.js";

test.each([
  ["。。", "。", null],
  ["的的", "的", null],
  ["甲", "甲", "建议与原文相同。"],
  ["甲\n乙", "甲乙", "涉及换行或行内对象，请人工修改。"],
  ["10mm", "20mm", "涉及数值、单位、范围或否定含义变化，请人工核对。"],
  ["连接", "不连接", "涉及数值、单位、范围或否定含义变化，请人工核对。"],
  ["5毫米", "5厘米", "涉及数值、单位、范围或否定含义变化，请人工核对。"],
])("checks replacement %s → %s", (original, replacement, expected) => {
  expect(replacementSafetyReason(original, replacement)).toBe(expected);
});
