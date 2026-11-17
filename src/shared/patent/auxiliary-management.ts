export function adjacentAuxiliaryAfterDelete(
  ids: readonly string[],
  activeId: string | null,
  deletedId: string,
): string | null {
  if (activeId !== deletedId) return activeId;
  const index = ids.indexOf(deletedId);
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

export function uniqueAuxiliaryTitle(title: string, existing: readonly string[]): string {
  const used = new Set(existing);
  const base = title.trim().slice(0, 200);
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `（${index}）`;
    const candidate = base.slice(0, 200 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

export function moveAuxiliaryDocument<T extends { auxiliaryDocumentId: string }>(
  documents: readonly T[],
  id: string,
  direction: "up" | "down",
): T[] {
  const result = [...documents];
  const index = result.findIndex((document) => document.auxiliaryDocumentId === id);
  if (index < 0) throw new Error("未找到其他文档。");
  const target = index + (direction === "up" ? -1 : 1);
  if (target < 0 || target >= result.length) return result;
  const item = result.splice(index, 1)[0];
  if (item) result.splice(target, 0, item);
  return result;
}
