import { z } from "zod";
import { ColorRangeOptionsSchema, DEFAULT_COLOR_RANGE } from "./design-color-range.js";
import {
  BucketOptionsSchema,
  DEFAULT_BUCKET,
  DEFAULT_FILL,
  FillOptionsSchema,
} from "./design-fill.js";
import { DEFAULT_TONE, ToneOptionsSchema } from "./design-tone.js";
import { DEFAULT_WHITESPACE, WhitespaceOptionsSchema } from "./design-whitespace.js";

const color = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();
const brush = z
  .object({
    size: z.number().min(1).max(5000),
    opacity: z.number().min(0).max(1),
    flow: z.number().min(0).max(1),
    hardness: z.number().min(0).max(1),
  })
  .strict();
const selection = z
  .object({
    mode: z.enum(["replace", "add", "subtract", "intersect"]),
    style: z.enum(["normal", "ratio", "fixed"]),
    width: z.number().min(1).max(10000),
    height: z.number().min(1).max(10000),
    feather: z.number().min(0).max(1000),
    antiAlias: z.boolean(),
  })
  .strict();
export const DesignMagicWandOptionsSchema = z
  .object({
    tolerance: z.number().int().min(0).max(255),
    contiguous: z.boolean(),
    antiAlias: z.boolean(),
    sampleSize: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(11)]),
    sampleAllLayers: z.boolean(),
    mode: z.enum(["replace", "add", "subtract", "intersect"]),
  })
  .strict();
export const DEFAULT_MAGIC_WAND_OPTIONS = {
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleSize: 1 as const,
  sampleAllLayers: false,
  mode: "replace" as const,
};
export const DesignEditorPreferencesSchema = z
  .object({
    version: z.literal(1),
    brush,
    eraser: brush,
    clone: brush.default({ size: 24, opacity: 1, flow: 1, hardness: 1 }),
    blur: brush.default({ size: 24, opacity: 1, flow: 1, hardness: 0.5 }),
    retouch: z
      .object({ aligned: z.boolean(), merged: z.boolean(), strength: z.number().min(0).max(1) })
      .strict()
      .default({ aligned: true, merged: false, strength: 0.5 }),
    magicWand: DesignMagicWandOptionsSchema.default(DEFAULT_MAGIC_WAND_OPTIONS),
    colorRange: ColorRangeOptionsSchema.default(DEFAULT_COLOR_RANGE),
    fill: FillOptionsSchema.default(DEFAULT_FILL),
    bucket: BucketOptionsSchema.default(DEFAULT_BUCKET),
    whitespace: WhitespaceOptionsSchema.default(DEFAULT_WHITESPACE),
    tone: ToneOptionsSchema.default(DEFAULT_TONE),
    selections: z
      .object({ rectangle: selection, ellipse: selection, lasso: selection, polygon: selection })
      .strict(),
    foreground: color,
    background: color,
    autoSelect: z.boolean(),
    sampleSource: z.enum(["current", "merged"]),
    transformLinked: z.boolean(),
    deletePixels: z.boolean(),
    cursor: z
      .object({ tip: z.enum(["normal", "full", "precise"]), crosshair: z.boolean() })
      .strict(),
    navigation: z
      .object({
        mode: z.enum(["marquee", "scrubby"]),
        center: z.boolean(),
        wheel: z.boolean(),
        pixelGrid: z.boolean(),
        selectionEdges: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type DesignEditorPreferences = z.infer<typeof DesignEditorPreferencesSchema>;
const selectionDefault = {
  mode: "replace" as const,
  style: "normal" as const,
  width: 1,
  height: 1,
  feather: 0,
  antiAlias: true,
};
export const DEFAULT_DESIGN_EDITOR_PREFERENCES: DesignEditorPreferences = {
  version: 1,
  brush: { size: 8, opacity: 1, flow: 1, hardness: 1 },
  eraser: { size: 8, opacity: 1, flow: 1, hardness: 1 },
  clone: { size: 24, opacity: 1, flow: 1, hardness: 1 },
  blur: { size: 24, opacity: 1, flow: 1, hardness: 0.5 },
  retouch: { aligned: true, merged: false, strength: 0.5 },
  magicWand: { ...DEFAULT_MAGIC_WAND_OPTIONS },
  colorRange: { ...DEFAULT_COLOR_RANGE },
  fill: { ...DEFAULT_FILL, color: { ...DEFAULT_FILL.color } },
  bucket: { ...DEFAULT_BUCKET },
  whitespace: { ...DEFAULT_WHITESPACE },
  tone: { ...DEFAULT_TONE },
  selections: {
    rectangle: { ...selectionDefault },
    ellipse: { ...selectionDefault },
    lasso: { ...selectionDefault },
    polygon: { ...selectionDefault },
  },
  foreground: { r: 0, g: 0, b: 0 },
  background: { r: 255, g: 255, b: 255 },
  autoSelect: true,
  sampleSource: "merged",
  transformLinked: true,
  deletePixels: false,
  cursor: { tip: "normal", crosshair: false },
  navigation: {
    mode: "marquee",
    center: false,
    wheel: true,
    pixelGrid: true,
    selectionEdges: true,
  },
};
