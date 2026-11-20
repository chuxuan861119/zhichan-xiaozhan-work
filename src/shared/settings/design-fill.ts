import { z } from "zod";
export const FillOptionsSchema = z
  .object({
    source: z.enum(["foreground", "background", "color", "black", "white", "gray"]),
    color: z
      .object({
        r: z.number().int().min(0).max(255),
        g: z.number().int().min(0).max(255),
        b: z.number().int().min(0).max(255),
      })
      .strict(),
    opacity: z.number().min(0).max(100),
    blend: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"]),
    preserveTransparency: z.boolean(),
  })
  .strict();
export type FillOptions = z.infer<typeof FillOptionsSchema>;
export type FillColor = FillOptions["color"];
export const DEFAULT_FILL: FillOptions = {
  source: "foreground",
  color: { r: 255, g: 255, b: 255 },
  opacity: 100,
  blend: "normal",
  preserveTransparency: false,
};
export const BucketOptionsSchema = FillOptionsSchema.pick({
  opacity: true,
  blend: true,
  preserveTransparency: true,
})
  .extend({
    tolerance: z.number().int().min(0).max(255),
    contiguous: z.boolean(),
    antiAlias: z.boolean(),
    sampleAllLayers: z.boolean(),
  })
  .strict();
export type BucketOptions = z.infer<typeof BucketOptionsSchema>;
export const DEFAULT_BUCKET: BucketOptions = {
  opacity: 100,
  blend: "normal",
  preserveTransparency: false,
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleAllLayers: false,
};
