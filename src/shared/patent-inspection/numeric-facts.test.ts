import { describe, expect, test } from "vitest";
import { extractNumericFacts } from "./numeric-facts.js";

const location = {
  kind: "book" as const,
  bookKind: "description" as const,
  targetId: "paragraph-1",
};

describe("extractNumericFacts", () => {
  test("extracts explicit range endpoints and percentages without guessing", () => {
    const facts = extractNumericFacts("下限为80℃，上限为20℃，A占60%，B占50%.", location);

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "range",
          lower: 80,
          upper: 20,
          unit: "℃",
          lowerUnit: "℃",
          upperUnit: "℃",
        }),
        expect.objectContaining({ kind: "percentage", value: 60 }),
      ]),
    );
  });

  test("retains each range endpoint unit for consistency checks", () => {
    const facts = extractNumericFacts("下限为80mm，上限为20cm。", location);

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "range",
          lowerUnit: "mm",
          upperUnit: "cm",
        }),
      ]),
    );
  });

  test("assigns range endpoints by their labels rather than their text order", () => {
    const facts = extractNumericFacts("上限为80℃，下限为20℃。", location);

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "range", lower: 20, upper: 80, unit: "℃" }),
      ]),
    );
  });

  test.each(["温度范围为10℃至20℃。", "温度取10℃～20℃。", "压力在10kPa至20kPa之间。"])(
    "extracts a clearly stated range: %s",
    (text) => {
      const facts = extractNumericFacts(text, location);

      expect(facts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "range", lower: 10, upper: 20 })]),
      );
    },
  );

  test("does not interpret a process change as a reversed range", () => {
    const facts = extractNumericFacts("温度由80℃降至20℃。", location);

    expect(facts.some((fact) => fact.kind === "range")).toBe(false);
  });

  test("keeps multi-letter units intact", () => {
    const facts = extractNumericFacts("长度达到80mm。", location);

    expect(facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ raw: "80mm", value: 80, unit: "mm" })]),
    );
  });

  test("prefers longer electrical units over their single-letter suffixes", () => {
    const facts = extractNumericFacts("电压为5mV。", location);

    expect(facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ raw: "电压为5mV", unit: "mV" })]),
    );
  });
});
