import {
  DESIGN_DIMENSION_GROUPS,
  type DesignDimensionAxis,
} from "../../../shared/patent/design-dimension-matrix";
import {
  MAX_DESIGN_IMAGE_SOURCE_EDGE_PX,
  MAX_DESIGN_IMAGE_SOURCE_PIXELS,
} from "../../../shared/patent/design-patent";
import { SIX_VIEW_KINDS, type SixViewImage, type SixViewKind } from "./six-view-model";

export type SixViewResizeAxes = Record<DesignDimensionAxis, number>;
type Size = { width: number; height: number };
export type SixViewResizeItem = {
  viewId: string;
  kind: SixViewKind;
  before: Size;
  after: Size;
  change: "same" | "scale" | "stretch";
};
export type SixViewResizeRequest = { axes: SixViewResizeAxes; items: SixViewResizeItem[] };

const axisPreferences = {
  width: ["front", "rear", "top", "bottom"],
  height: ["front", "rear", "left", "right"],
  depth: ["top", "bottom", "left", "right"],
} as const;
const validEdge = (value: number | null | undefined): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= MAX_DESIGN_IMAGE_SOURCE_EDGE_PX;

export function sixViewResizeDefaults(images: readonly SixViewImage[]) {
  const find = (axis: DesignDimensionAxis) => {
    const group = DESIGN_DIMENSION_GROUPS.find((item) => item.axis === axis);
    for (const kind of axisPreferences[axis]) {
      const image = images.find((item) => item.kind === kind && !item.omitted);
      const dimension = group?.entries.find((entry) => entry.kind === kind)?.dimension;
      const value = dimension ? image?.[dimension] : null;
      if (validEdge(value)) return { value, kind };
    }
    return null;
  };
  return { width: find("width"), height: find("height"), depth: find("depth") };
}

export function sixViewTargetSize(kind: SixViewKind, axes: SixViewResizeAxes): Size {
  const dimension = (side: keyof Size) => {
    const group = DESIGN_DIMENSION_GROUPS.find((candidate) =>
      candidate.entries.some((entry) => entry.kind === kind && entry.dimension === side),
    );
    if (!group) throw new Error("该视图没有对应的尺寸轴。");
    return axes[group.axis];
  };
  return { width: dimension("width"), height: dimension("height") };
}

export function planSixViewResize(
  images: readonly SixViewImage[],
  axes: SixViewResizeAxes,
): SixViewResizeItem[] {
  if (
    ![axes.width, axes.height, axes.depth].every(validEdge) ||
    SIX_VIEW_KINDS.some((kind) => {
      const size = sixViewTargetSize(kind, axes);
      return size.width * size.height > MAX_DESIGN_IMAGE_SOURCE_PIXELS;
    })
  )
    throw new Error("请输入有效的正整数像素值：每边最多 10,000 px，每张图片最多 4,000 万像素。");
  return images
    .filter((image) => !image.omitted)
    .map(({ viewId, kind, width, height }) => {
      if (!validEdge(width) || !validEdge(height))
        throw new Error("部分图片的当前尺寸尚不可用，请加载完成后重试。");
      const before = { width, height },
        after = sixViewTargetSize(kind, axes);
      const change =
        width === after.width && height === after.height
          ? "same"
          : width * after.height === height * after.width
            ? "scale"
            : "stretch";
      return { viewId, kind, before, after, change };
    });
}
