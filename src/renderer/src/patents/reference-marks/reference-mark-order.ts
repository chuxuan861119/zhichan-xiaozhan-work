export function reconcileReferenceOrder(
  ids: readonly string[],
  saved: readonly string[],
): string[] {
  const remaining = new Set(ids);
  const ordered: string[] = [];
  for (const id of saved) if (remaining.delete(id)) ordered.push(id);
  return [...ordered, ...remaining];
}

export function moveReferenceOrder(ids: readonly string[], from: string, to: string): string[] {
  const result = [...ids];
  const start = result.indexOf(from);
  const end = result.indexOf(to);
  if (start < 0 || end < 0 || start === end) return result;
  result.splice(start, 1);
  result.splice(end, 0, from);
  return result;
}
