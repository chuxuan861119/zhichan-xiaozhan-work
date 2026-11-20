import type { DesignPatent } from "./design-patent.js";

export type DesignImageMode = "six-view" | "multi-image";
export function swapDesignImages(design: DesignPatent, id: string, targetId: string): DesignPatent {
  const from = design.views.findIndex((view) => view.viewId === id),
    to = design.views.findIndex((view) => view.viewId === targetId);
  if (from < 0 || to < 0 || from === to) return design;
  const views = [...design.views];
  [views[from], views[to]] = [views[to]!, views[from]!];
  return { ...design, views };
}
export const DESIGN_IMAGE_NAME_PRESETS = [
  "产品视图",
  "主视图",
  "变化状态图",
  "参考图",
  "放大图",
  "使用状态图",
] as const;
export function resetDesignImageMode(design: DesignPatent, mode: DesignImageMode): DesignPatent {
  return {
    ...design,
    imageMode: mode,
    primaryExpression: null,
    views: [],
    representativeViewId: null,
    dimensionReferenceViewId: null,
    brief: {
      ...design.brief,
      omissions: [],
      continuousSurface: null,
      elongatedObjectLengthOmitted: false,
    },
  };
}
export function renameDesignImage(design: DesignPatent, id: string, name: string): DesignPatent {
  const label = name.trim();
  if (!label || label.length > 100) throw new Error("图片名称应为 1～100 个字符。");
  return {
    ...design,
    views: design.views.map((view) => (view.viewId === id ? { ...view, label } : view)),
  };
}
/** Move before a card; null appends at the end. Stable ids retain layered projects. */
export function reorderDesignImages(
  design: DesignPatent,
  id: string,
  beforeId: string | null,
): DesignPatent {
  const source = design.views.find((view) => view.viewId === id);
  if (
    !source ||
    id === beforeId ||
    (beforeId && !design.views.some((view) => view.viewId === beforeId))
  )
    return design;
  const views = design.views.filter((view) => view.viewId !== id);
  views.splice(
    beforeId ? views.findIndex((view) => view.viewId === beforeId) : views.length,
    0,
    source,
  );
  return { ...design, views };
}
