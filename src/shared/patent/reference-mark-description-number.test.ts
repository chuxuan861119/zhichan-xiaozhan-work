import { describe, expect, test } from "vitest";
import {
  descriptionReferenceNumberRanges,
  descriptionReferenceNumberSuffix,
} from "./reference-mark-description-number.js";

describe("description reference number suffix", () => {
  test("does not mistake the end of a quantity range for a detached mark", () => {
    expect(descriptionReferenceNumberRanges("数量为1至5，参见权利要求1至5。")).toEqual([]);
  });
  test.each([
    "5mm",
    "5 mm",
    "5个",
    "5毫米",
    "5.5毫米",
    "５．５毫米",
    "5～8个",
    "5至8个",
    "5%",
    "5℃",
    "5μm",
    "5×8",
    "5组",
    "5kg",
    "5小时",
  ])("does not recognize a quantity: %s", (text) =>
    expect(descriptionReferenceNumberSuffix(text)).toBeNull(),
  );
  test.each(["5", "５", "5连接", "5组成", "5次级", "(5)", "（５）", " 5的"])(
    "recognizes a reference number: %s",
    (text) => expect(descriptionReferenceNumberSuffix(text)?.number).toBe(5),
  );
});
