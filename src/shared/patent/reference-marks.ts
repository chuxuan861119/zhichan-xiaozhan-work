import { z } from "zod";

export const AUTOMATIC_EDIT_RED = "#D92D20" as const;

export const PatentReferenceMarkSchema = z
  .object({
    referenceMarkId: z.string().uuid(),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    keyword: z
      .string()
      .trim()
      .min(1)
      .refine((value) => [...value].length <= 500)
      .refine((value) => !/[\r\n；;、]/u.test(value)),
  })
  .strict();
export type PatentReferenceMark = z.infer<typeof PatentReferenceMarkSchema>;

export const PatentReferenceMarkPendingReviewSchema = z
  .object({
    referenceMarkId: z.string().uuid(),
    ownerBookKind: z.enum(["claims", "description", "abstract"]),
    previousNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    previousKeyword: PatentReferenceMarkSchema.shape.keyword,
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    keyword: PatentReferenceMarkSchema.shape.keyword,
    counts: z
      .object({
        claims: z.number().int().nonnegative(),
        description: z.number().int().nonnegative(),
        abstract: z.number().int().nonnegative(),
      })
      .strict(),
    descriptionNumberedCount: z.number().int().nonnegative().optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PatentReferenceMarkPendingReview = z.infer<
  typeof PatentReferenceMarkPendingReviewSchema
>;

export const PatentReferenceMarkSettingsSchema = z
  .object({
    synchronizedEditingEnabled: z.boolean(),
    pendingReview: PatentReferenceMarkPendingReviewSchema.optional(),
  })
  .strict();
export type PatentReferenceMarkSettings = z.infer<typeof PatentReferenceMarkSettingsSchema>;

export type ParsedReferenceMark = { number: number; keyword: string };
export type LegendParseResult =
  | { ok: true; entries: ParsedReferenceMark[] }
  | { ok: false; message: string };

export function parseReferenceLegendText(text: string): LegendParseResult {
  const normalized = text.trim();
  const prefix = normalized.match(/^其中[：,:，]/u);
  if (!prefix) return { ok: false, message: "附图标记应以“其中：”开头。" };
  const body = normalized
    .slice(prefix[0].length)
    .trim()
    .replace(/[。.]+$/u, "")
    .trim();
  if (body.length === 0) return { ok: true, entries: [] };
  const entries: ParsedReferenceMark[] = [];
  for (const part of body.split(/[；;]/u)) {
    const matched = part.trim().match(/^(\d+)[、,，]\s*(.+)$/u);
    if (!matched) return { ok: false, message: "附图标记格式无效。" };
    const number = Number(matched[1]);
    const keyword = matched[2]?.trim() ?? "";
    if (!Number.isSafeInteger(number) || number <= 0 || keyword.length === 0) {
      return { ok: false, message: "附图标记格式无效。" };
    }
    entries.push({ number, keyword });
  }
  const numbers = new Set(entries.map((entry) => entry.number));
  const keywords = new Set(entries.map((entry) => entry.keyword));
  return numbers.size === entries.length && keywords.size === entries.length
    ? { ok: true, entries }
    : { ok: false, message: "附图标记的序号和关键词不能重复。" };
}

/**
 * 按传入顺序输出附图标记文本（不内部排序）：顺序由调用方决定，
 * 例如按关键词在权利要求书中的出现先后（sortReferenceMarksByAppearance）或按编号。
 */
export function formatReferenceMarkText(entries: readonly ParsedReferenceMark[]): string {
  return entries.map((entry) => `${entry.number}、${entry.keyword}`).join("；");
}

export function formatDescriptionLegendText(entries: readonly ParsedReferenceMark[]): string {
  const content = formatReferenceMarkText(entries);
  return content ? `其中：${content}。` : "其中：";
}

export function deterministicReferenceMarkId(
  seed: string,
  number: number,
  keyword: string,
): string {
  const hash = (salt: string): string => {
    let value = 0x811c9dc5;
    for (const character of `${salt}:${seed}:${number}:${keyword}`) {
      value ^= character.codePointAt(0) ?? 0;
      value = Math.imul(value, 0x01000193);
    }
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  const value = `${hash("a")}${hash("b")}${hash("c")}${hash("d")}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function referenceNumberColor(number: number): `#${string}` {
  let hue = (number * 137.508) % 360;
  if (hue >= 345 || hue <= 15) hue = (hue + 32) % 360;
  const saturation = 0.88;
  const lightness = 0.78;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = lightness - chroma / 2;
  const [red, green, blue] =
    hue < 60
      ? [chroma, intermediate, 0]
      : hue < 120
        ? [intermediate, chroma, 0]
        : hue < 180
          ? [0, chroma, intermediate]
          : hue < 240
            ? [0, intermediate, chroma]
            : hue < 300
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  const toHex = (value: number) =>
    Math.round((value + base) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}
