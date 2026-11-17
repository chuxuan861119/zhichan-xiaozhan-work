import type { CadScene } from "./cadcraft-client";
export function supportsCadAppearance(entity: CadScene["entities"][number], key: string) {
  if (entity.type === "Wipeout" || entity.locked) return false;
  if (key === "color") return true;
  if (
    ["Text", "MText", "AttDef", "Attribute Definition", "Solid", "Trace", "Image"].includes(
      entity.type,
    )
  )
    return false;
  if (key === "linetype" && ["Hatch", "Point"].includes(entity.type)) return false;
  if (entity.type === "Hatch" && (entity.geometry as { solid?: boolean } | undefined)?.solid)
    return false;
  return true;
}
