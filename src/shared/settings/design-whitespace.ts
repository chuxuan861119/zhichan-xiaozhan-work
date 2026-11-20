import { z } from "zod";

const margin = z.number().int().min(0).max(2000);
export const WhitespaceOptionsSchema = z
  .object({
    trim: z.boolean(),
    pad: z.boolean(),
    tolerance: z.number().int().min(0).max(50),
    linked: z.boolean(),
    top: margin,
    right: margin,
    bottom: margin,
    left: margin,
    color: z.enum(["white", "transparent"]),
  })
  .strict()
  .refine((o) => o.trim || o.pad, "请选择裁白边或增加留白。");
export type WhitespaceOptions = z.infer<typeof WhitespaceOptionsSchema>;
export const DEFAULT_WHITESPACE: WhitespaceOptions = {
  trim: true,
  pad: false,
  tolerance: 0,
  linked: true,
  top: 20,
  right: 20,
  bottom: 20,
  left: 20,
  color: "white",
};
const box = z
  .object({
    left: z.number().int().min(-2000).max(10000),
    top: z.number().int().min(-2000).max(10000),
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
  })
  .strict();
export const WhitespacePlanSchema = z
  .object({
    original: z
      .object({
        width: z.number().int().positive().max(10000),
        height: z.number().int().positive().max(10000),
      })
      .strict(),
    crop: box,
    rect: box,
    padding: z.object({ top: margin, right: margin, bottom: margin, left: margin }).strict(),
    changed: z.boolean(),
  })
  .strict()
  .refine(
    (p) =>
      p.original.width * p.original.height <= 40000000 &&
      p.rect.width * p.rect.height <= 40000000 &&
      p.crop.left >= 0 &&
      p.crop.top >= 0 &&
      p.crop.left + p.crop.width <= p.original.width &&
      p.crop.top + p.crop.height <= p.original.height &&
      p.rect.left === p.crop.left - p.padding.left &&
      p.rect.top === p.crop.top - p.padding.top &&
      p.rect.width === p.crop.width + p.padding.left + p.padding.right &&
      p.rect.height === p.crop.height + p.padding.top + p.padding.bottom,
  );
export type WhitespacePlan = z.infer<typeof WhitespacePlanSchema>;
