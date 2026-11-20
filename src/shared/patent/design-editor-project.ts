import { z } from "zod";
import { type DesignSelectionCoverage, isSelectionCoverage } from "./design-selection-coverage.js";

const identifier = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const point = z.tuple([coordinate, coordinate]);
const ring = z
  .array(point)
  .min(4)
  .max(50_000)
  .refine((points) => {
    const first = points[0],
      last = points.at(-1);
    return first?.[0] === last?.[0] && first?.[1] === last?.[1];
  }, "选区轮廓必须闭合。");
const size = z
  .object({
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
  })
  .strict()
  .refine((value) => value.width * value.height <= 40_000_000, "图片像素总量超限。");
const layer = z
  .object({
    id: identifier,
    properties: z
      .object({
        index: z.number().int().min(0).max(15),
        name: z.string().max(200),
        opacity: z.number().min(0).max(1),
        isVisible: z.boolean(),
        hasClipping: z.boolean(),
        mixModeStr: z.enum([
          "source-over",
          "darken",
          "multiply",
          "color-burn",
          "lighten",
          "screen",
          "color-dodge",
          "overlay",
          "soft-light",
          "hard-light",
          "difference",
          "exclusion",
          "hue",
          "saturation",
          "color",
          "luminosity",
        ]),
        hostLocks: z
          .object({
            all: z.boolean(),
            pixels: z.boolean(),
            position: z.boolean(),
            alpha: z.boolean(),
          })
          .strict()
          .optional(),
        hostBackground: z.boolean().optional(),
      })
      .strict(),
    backing: z
      .object({
        x: coordinate.int(),
        y: coordinate.int(),
        width: z.number().int().min(1).max(10_000),
        height: z.number().int().min(1).max(10_000),
      })
      .strict()
      .refine((value) => value.width * value.height <= 40_000_000, "外围像素总量超限。")
      .optional(),
    mask: z
      .object({
        x: coordinate.int(),
        y: coordinate.int(),
        width: z.number().int().min(1).max(10000),
        height: z.number().int().min(1).max(10000),
        outside: z.union([z.literal(0), z.literal(255)]),
        enabled: z.boolean(),
        linked: z.boolean(),
      })
      .strict()
      .refine((v) => v.width * v.height <= 40000000)
      .optional(),
  })
  .strict();

/** Binary digests/envelope budgets are validated separately before decoding any asset. */
export const DesignEditorMetadataSchema = z
  .object({
    projectId: z.object({ value: identifier }).strict(),
    hostViewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().finite().positive(),
        pixelRatio: z.number().finite().positive(),
      })
      .strict()
      .optional(),
    size,
    selection: z
      .object({
        coverage: z.custom<DesignSelectionCoverage>(isSelectionCoverage).optional(),
        value: z.array(z.array(ring).min(1).max(1000)).max(1000).optional(),
        feather: z.number().min(0).max(1000).optional(),
        antiAlias: z.boolean().optional(),
        previous: z
          .object({
            coverage: z.custom<DesignSelectionCoverage>(isSelectionCoverage).optional(),
            value: z.array(z.array(ring).min(1).max(1000)).max(1000),
            feather: z.number().min(0).max(1000).optional(),
            antiAlias: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    activeLayerId: identifier,
    maskFocus: z.object({ id: identifier, view: z.boolean() }).strict().optional(),
    selectedLayerIds: z.array(identifier).max(16).optional(),
    layers: z.array(layer).min(1).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.maskFocus &&
      (value.maskFocus.id !== value.activeLayerId ||
        !value.layers.find((layer) => layer.id === value.maskFocus!.id)?.mask)
    )
      context.addIssue({ code: "custom", message: "当前蒙版编辑目标无效。" });
    const backgrounds = value.layers.filter((layer) => layer.properties.hostBackground);
    if (
      backgrounds.length > 1 ||
      backgrounds.some(
        (layer) =>
          layer.properties.index !== 0 ||
          layer.properties.opacity !== 1 ||
          layer.properties.hasClipping ||
          layer.properties.mixModeStr !== "source-over",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "背景层必须唯一、位于底部且保持不透明正常混合。",
      });
    }
    if (
      new Set(value.layers.map((item) => item.id)).size !== value.layers.length ||
      !value.layers.some((item) => item.id === value.activeLayerId) ||
      (value.selectedLayerIds !== undefined &&
        (new Set(value.selectedLayerIds).size !== value.selectedLayerIds.length ||
          (value.selectedLayerIds.length > 0 &&
            !value.selectedLayerIds.includes(value.activeLayerId)) ||
          value.selectedLayerIds.some((id) => !value.layers.some((layer) => layer.id === id)))) ||
      value.layers.some((item, index) => item.properties.index !== index)
    ) {
      context.addIssue({ code: "custom", message: "图层标识、顺序或当前图层无效。" });
    }
    const points =
      value.selection.value?.reduce(
        (total, polygon) => total + polygon.reduce((sum, outline) => sum + outline.length, 0),
        0,
      ) ?? 0;
    const previousPoints =
      value.selection.previous?.value.reduce(
        (total, polygon) => total + polygon.reduce((sum, outline) => sum + outline.length, 0),
        0,
      ) ?? 0;
    if (points + previousPoints > 50_000)
      context.addIssue({ code: "custom", message: "选区节点总量超限。" });
  });
export type DesignEditorMetadata = z.infer<typeof DesignEditorMetadataSchema>;
