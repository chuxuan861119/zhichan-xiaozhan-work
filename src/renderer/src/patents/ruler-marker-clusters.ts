import type { DocumentStructureRulerMarker } from "../../../shared/patent/document-structure-ruler";

export function rulerClusterLabel(
  markers: readonly (Pick<DocumentStructureRulerMarker, "kind" | "label"> &
    Partial<Pick<DocumentStructureRulerMarker, "error" | "warning">>)[],
) {
  const errors = markers.filter((marker) => marker.error || marker.warning).length;
  if (errors) return `${errors} 处问题`;
  const chapter = markers.find((marker) => marker.kind === "description-chapter");
  if (chapter) {
    const numbers = markers
      .filter((marker) => marker.kind === "description-paragraph")
      .map((marker) => marker.label.replace(/[[\]]/g, ""))
      .filter((number) => /^\d+$/.test(number));
    if (!numbers.length) return chapter.label;
    const label = chapter.label.replace("具体实施方式", "实施方式");
    const range = numbers.length === 1 ? String(numbers[0]) : `${numbers[0]}–${numbers.at(-1)}`;
    return `${label}\n[${range}]`;
  }
  if (markers.every((marker) => marker.kind === "description-paragraph"))
    return `${markers[0]!.label.replace(/[[\]]/g, "")}–${markers.at(-1)!.label.replace(/[[\]]/g, "")}`;
  return `${markers.length} 项`;
}

/** Keep label-sized groups on the ruler; the navigation retains every target. */
export function rulerMarkerClusters(
  geometry: ReadonlyMap<string, { top: number }>,
  currentIds?: ReadonlySet<string>,
) {
  const clusters = new Map<string, string[]>();
  let top = -Infinity;
  let members: string[] = [];
  // Geometry is measured asynchronously; removed/replaced markers must never
  // become a cluster member or hide a surviving member behind an obsolete head.
  const currentGeometry = currentIds
    ? [...geometry].filter(([id]) => currentIds.has(id))
    : [...geometry];
  for (const [id, position] of currentGeometry.sort((a, b) => a[1].top - b[1].top)) {
    if (position.top - top >= 24) {
      top = position.top;
      members = [];
      clusters.set(id, members);
    }
    members.push(id);
  }
  return clusters;
}
