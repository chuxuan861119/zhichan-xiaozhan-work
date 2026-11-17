import { describe, expect, test } from "vitest";
import {
  AUTOMATIC_EDIT_RED,
  formatDescriptionLegendText,
  formatReferenceMarkText,
  PatentReferenceMarkSettingsSchema,
  parseReferenceLegendText,
  referenceNumberColor,
} from "./reference-marks.js";

function colorMetrics(hex: string): { saturation: number; contrastWithBlack: number } {
  const channels = [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ] as const;
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const lightness = (maximum + minimum) / 2;
  const saturation =
    maximum === minimum ? 0 : (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
  const linearize = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const [red, green, blue] = channels.map(linearize) as [number, number, number];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return { saturation, contrastWithBlack: (luminance + 0.05) / 0.05 };
}

describe("reference mark legend", () => {
  test("parses and formats the patent drawing legend grammar", () => {
    const parsed = parseReferenceLegendText("其中：1、箱体；2、箱盖。");
    expect(parsed).toEqual({
      ok: true,
      entries: [
        { number: 1, keyword: "箱体" },
        { number: 2, keyword: "箱盖" },
      ],
    });
    expect(parseReferenceLegendText("其中，1、箱体；2、箱盖。").ok).toBe(true);
    expect(parseReferenceLegendText("其中：1、箱体；1、箱盖。").ok).toBe(false);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(formatReferenceMarkText(parsed.entries)).toBe("1、箱体；2、箱盖");
    expect(formatDescriptionLegendText(parsed.entries)).toBe("其中：1、箱体；2、箱盖。");
  });

  test("assigns stable visible colors outside automatic-edit red", () => {
    expect(referenceNumberColor(1)).toMatch(/^#[0-9A-F]{6}$/u);
    expect(referenceNumberColor(1)).toBe(referenceNumberColor(1));
    expect(referenceNumberColor(1)).not.toBe(referenceNumberColor(2));
    expect(referenceNumberColor(1)).not.toBe(AUTOMATIC_EDIT_RED);
  });

  test("keeps numbered keyword highlights vivid and readable behind black text", () => {
    for (let number = 1; number <= 64; number += 1) {
      const metrics = colorMetrics(referenceNumberColor(number));
      expect(metrics.saturation).toBeGreaterThanOrEqual(0.75);
      expect(metrics.contrastWithBlack).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("accepts old settings and validates a persisted pending review", () => {
    expect(PatentReferenceMarkSettingsSchema.parse({ synchronizedEditingEnabled: false })).toEqual({
      synchronizedEditingEnabled: false,
    });
    expect(
      PatentReferenceMarkSettingsSchema.parse({
        synchronizedEditingEnabled: true,
        pendingReview: {
          referenceMarkId: "00000000-0000-4000-8000-000000009977",
          ownerBookKind: "abstract",
          previousNumber: 1,
          previousKeyword: "箱体",
          number: 2,
          keyword: "新箱体",
          counts: { claims: 2, description: 1, abstract: 1 },
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }).pendingReview,
    ).toMatchObject({ keyword: "新箱体", ownerBookKind: "abstract" });
  });
});
