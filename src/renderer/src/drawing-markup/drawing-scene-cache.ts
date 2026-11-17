import { leaderPoints } from "../../../shared/drawing-markup/label-layout";
import type {
  DrawingAnnotation,
  DrawingProject,
  DrawingRegion,
} from "../../../shared/drawing-markup/model";
import {
  annotationOutputStyle,
  type DrawingAnnotationScale,
} from "../../../shared/drawing-markup/output-settings";
import { allFigureDrawingRegions } from "../../../shared/drawing-markup/regions";

export function createAnnotationLayoutCache() {
  const cache = new WeakMap<DrawingAnnotation, DrawingAnnotation>();
  return (a: DrawingAnnotation, scale: DrawingAnnotationScale | null) => {
    const style = annotationOutputStyle(a, scale),
      old = cache.get(a);
    if (old && old.fontSize === style.fontSize && old.lineWidth === style.lineWidth) return old;
    const styled = { ...a, ...style },
      result = { ...styled, points: leaderPoints(styled) };
    cache.set(a, result);
    return result;
  };
}

export function createDrawingSidebarCache() {
  const markTexts = new WeakMap<DrawingAnnotation, string>();
  const texts = new WeakMap<DrawingProject["annotations"], Set<string>>();
  const linkedRegions = new WeakMap<DrawingProject["regions"], DrawingRegion[]>();
  const previous = new Map<string, { project: DrawingProject; numbers: Set<string> }>();
  let numberSets: Set<string>[] = [],
    numbers = new Set<string>();
  let regionInputs: { projectId: string; regions: DrawingRegion[] }[] = [],
    figureKey = "";
  let regions: ReturnType<typeof allFigureDrawingRegions> = [];
  return (projects: DrawingProject[], figures: { figureId: string }[]) => {
    const ids = new Set(projects.map((p) => p.projectId));
    for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);
    const sets = projects.map((project) => {
      const old = previous.get(project.projectId);
      if (old?.project === project) return old.numbers;
      let found = texts.get(project.annotations);
      if (!found) {
        found = new Set(
          project.annotations.map((a) => {
            let text = markTexts.get(a);
            if (text === undefined) {
              text = a.text.trim();
              markTexts.set(a, text);
            }
            return text;
          }),
        );
        if (
          old &&
          found.size === old.numbers.size &&
          [...found].every((text) => old.numbers.has(text))
        )
          found = old.numbers;
        texts.set(project.annotations, found);
      }
      previous.set(project.projectId, { project, numbers: found });
      return found;
    });
    if (sets.length !== numberSets.length || sets.some((set, i) => set !== numberSets[i])) {
      numbers = new Set(sets.flatMap((set) => [...set]));
      numberSets = sets;
    }
    const linked = projects.map((p, i) => {
      let found = linkedRegions.get(p.regions);
      if (!found) {
        found = p.regions.filter((r) => r.figureId);
        const old = regionInputs[i];
        if (
          old?.projectId === p.projectId &&
          old.regions.length === found.length &&
          found.every((r, i) => r === old.regions[i])
        )
          found = old.regions;
        linkedRegions.set(p.regions, found);
      }
      return { ...p, regions: found };
    });
    const key = figures.map((f) => f.figureId).join(",");
    if (
      key !== figureKey ||
      linked.length !== regionInputs.length ||
      linked.some(
        (p, i) =>
          p.projectId !== regionInputs[i]?.projectId || p.regions !== regionInputs[i]?.regions,
      )
    ) {
      regions = allFigureDrawingRegions(
        linked,
        figures.map((f) => f.figureId),
      );
      regionInputs = linked.map((p) => ({ projectId: p.projectId, regions: p.regions }));
      figureKey = key;
    }
    return { numbers, regions };
  };
}
