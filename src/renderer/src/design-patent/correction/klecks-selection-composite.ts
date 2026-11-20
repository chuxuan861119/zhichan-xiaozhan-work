/** Selection coverage is shared geometry, not two independent layer opacities. */
export function selectionRemainderCoverage(
  removed: number,
  destination: number,
  sourceOpacity: number,
): number {
  return Math.max(0, 1 - removed - Math.max(0, destination - removed) * sourceOpacity);
}
