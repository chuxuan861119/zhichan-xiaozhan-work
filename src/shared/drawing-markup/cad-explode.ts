import { cadObjectGroup, cadObjectHandles } from "./cad-objects.js";
import type { DrawingProject } from "./model.js";

export type CadExplodeDetail = { id: string; handles: string[]; groups: string[] };
export function planCadExplode(project: DrawingProject, requested: string[], inside?: string) {
  const selected = new Set(requested);
  const owners = new Map<string, { id: string; role: string }>();
  for (const object of project.cad?.objects ?? [])
    for (const role of ["label", "body", "frame", "source"] as const)
      for (const handle of object[role] ?? []) owners.set(handle, { id: object.id, role });
  const details: CadExplodeDetail[] = (project.cad?.objects ?? []).flatMap((object) => {
    const whole = [...(object.body ?? []), ...(object.frame ?? [])];
    if (
      object.kind !== "detail" ||
      object.id === inside ||
      !whole.length ||
      !whole.every((h) => selected.has(h)) ||
      project.cad?.overlayAssetId ||
      !project.detailViews?.some((d) => d.id === object.id)
    )
      return [];
    return [
      {
        id: object.id,
        handles: [...new Set(cadObjectHandles(object))],
        groups: (["label", "body", "frame", "source"] as const).map((role) =>
          cadObjectGroup({ id: object.id, kind: "detail", role }),
        ),
      },
    ];
  });
  const detached = new Set(details.flatMap((d) => d.handles));
  const handles = [...selected].filter((h) => {
    if (detached.has(h)) return false;
    const owner = owners.get(h);
    return !owner || (inside === owner.id && owner.role === "body");
  });
  const allowed = new Set(handles);
  return {
    handles,
    details,
    retained: [...selected].filter((h) => !allowed.has(h) && !detached.has(h)).length,
  };
}
