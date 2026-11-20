import { z } from "zod";
export const ColorRangeOptionsSchema = z
  .object({
    preset: z.enum([
      "sampled",
      "highlights",
      "midtones",
      "shadows",
      "reds",
      "yellows",
      "greens",
      "cyans",
      "blues",
      "magentas",
    ]),
    fuzziness: z.number().int().min(0).max(200),
    localized: z.boolean(),
    range: z.number().int().min(1).max(100),
    invert: z.boolean(),
    sampleAllLayers: z.boolean(),
    mode: z.enum(["replace", "add", "subtract", "intersect"]),
    preview: z.enum(["image", "grayscale", "black", "white", "overlay"]),
  })
  .strict();
export type ColorRangeOptions = z.infer<typeof ColorRangeOptionsSchema>;
export const DEFAULT_COLOR_RANGE: ColorRangeOptions = {
  preset: "sampled",
  fuzziness: 40,
  localized: false,
  range: 100,
  invert: false,
  sampleAllLayers: true,
  mode: "replace",
  preview: "grayscale",
};
