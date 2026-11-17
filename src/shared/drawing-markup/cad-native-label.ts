import { cadSemanticKeyMatches } from "./cad-semantic-key.js";
import type { DrawingProject } from "./model.js";

/** A semantic label is native only after its current revision has a complete CAD binding. */
export function nativeCadLabelHandles(project: DrawingProject, id: string): string[] {
  if (!project.cad?.unified || !cadSemanticKeyMatches(project)) return [];
  if (!project.annotations.some((annotation) => annotation.id === id)) return [];
  return (
    project.cad.objects?.find((object) => object.kind === "label" && object.id === id)?.label ?? []
  );
}

export function nativeCadLabelIds(project: DrawingProject): Set<string> {
  if (!project.cad?.unified || !cadSemanticKeyMatches(project))
    return new Set();
  const ids = new Set(project.annotations.map((annotation) => annotation.id));
  return new Set(
    project.cad.objects
      ?.filter((object) => object.kind === "label" && ids.has(object.id) && object.label?.length)
      .map((object) => object.id) ?? [],
  );
}

export function nativeCadLabelHandleSet(project: DrawingProject): Set<string> {
  const ids = nativeCadLabelIds(project);
  if (!project.cad) return new Set();
  return new Set(
    project.cad.objects
      ?.filter((object) => object.kind === "label" && ids.has(object.id))
      .flatMap((object) => object.label ?? []) ?? [],
  );
}

export function selectedNativeCadLabelIds(
  project: DrawingProject,
  selectedHandles: readonly string[],
): Set<string> {
  const selected = new Set(selectedHandles);
  const ids = nativeCadLabelIds(project);
  return new Set(
    project.cad?.objects
      ?.filter(
        (object) => ids.has(object.id) && object.label?.every((handle) => selected.has(handle)),
      )
      .map((object) => object.id) ?? [],
  );
}
