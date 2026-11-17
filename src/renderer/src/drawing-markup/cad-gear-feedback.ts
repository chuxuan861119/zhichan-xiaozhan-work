import type { CadScene } from "./cadcraft-client";

type Entity = CadScene["entities"][number];
/** Read old retained scenes as well as current multi-edge native scenes. */
export function cadGearMates(entity: Entity): readonly string[] {
  return entity.gearMates ?? (entity.gearMate ? [entity.gearMate] : []);
}
const components = new WeakMap<CadScene, Map<string, ReadonlySet<string>>>();
/** Retained scenes are immutable. Cache components without retaining old history scenes. */
export function cadGearSelection(scene: CadScene, handles: readonly string[]): Set<string> {
  let index = components.get(scene);
  if (!index) {
    index = new Map();
    const graph = new Map(scene.entities.filter(e=>e.gear).map(e=>[e.handle,cadGearMates(e)]));
    for (const root of graph.keys()) {
      if (index.has(root)) continue;
      const members = new Set([root]), queue = [root];
      for (let i=0;i<queue.length;i++) for (const mate of graph.get(queue[i]!) ?? [])
        if (!members.has(mate)) { members.add(mate); queue.push(mate); }
      for (const member of members) index.set(member,members);
    }
    components.set(scene,index);
  }
  const result = new Set(handles);
  const visited = new Set<ReadonlySet<string>>();
  for (const handle of handles) {
    const members = index.get(handle);
    if (!members || visited.has(members)) continue;
    visited.add(members);
    for (const member of members) result.add(member);
  }
  return result;
}
/** Pair identity is stable across selection order and reload; these colors never enter CAD data. */
export function cadGearColor(entity: Entity, companion?: string) {
  const mate = entity.gearMate ?? companion;
  return mate && entity.handle.padStart(16, "0") > mate.padStart(16, "0") ? "#8056d9" : "#007aff";
}
export function cadGearName(entity: Entity, companion?: string) {
  const gear = entity.gear!;
  const identity =
    entity.gearMate || companion
      ? cadGearColor(entity, companion) === "#007aff"
        ? " A"
        : " B"
      : "";
  return `${gear.kind === "rack" ? "齿条" : gear.kind === "internal" ? "内齿圈" : "外齿轮"}${identity} · ${gear.teeth} 齿`;
}
