export const DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH = 76;
export const DOCUMENT_STRUCTURE_RULER_COMPACT_WIDTH = 20;
export const DOCUMENT_STRUCTURE_RULER_GAP = 8;
const DOCUMENT_STRUCTURE_RULER_MEASUREMENT_TOLERANCE = 0.5;
export const DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT = 24;
export const DOCUMENT_STRUCTURE_RULER_NAVIGATION_GAP = 2;
export const DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP =
  DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT + DOCUMENT_STRUCTURE_RULER_NAVIGATION_GAP;
export const DOCUMENT_STRUCTURE_RULER_RESUME_WINDOW_MS = 1000;
export const DOCUMENT_STRUCTURE_RULER_TARGET_FLASH_MS = 1000;

export type DocumentStructureRulerMode = "wide" | "compact";

export function nearestDocumentStructureRulerMarkerIndex(
  markerCenters: readonly number[],
  viewportCenter: number,
): number | null {
  if (markerCenters.length === 0) return null;

  let nearestIndex = 0;
  let nearestDistance = Math.abs(markerCenters[0]! - viewportCenter);
  for (let index = 1; index < markerCenters.length; index += 1) {
    const distance = Math.abs(markerCenters[index]! - viewportCenter);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  return nearestIndex;
}

export function documentStructureRulerNavigationTop(
  markerIndex: number,
  anchorIndex: number,
  viewportCenter: number,
  scrollOffset: number,
): number {
  return (
    viewportCenter -
    DOCUMENT_STRUCTURE_RULER_NAVIGATION_ROW_HEIGHT / 2 +
    (markerIndex - anchorIndex) * DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP -
    scrollOffset
  );
}

export function clampDocumentStructureRulerOffset(
  requestedOffset: number,
  anchorIndex: number,
  markerCount: number,
): number {
  if (markerCount === 0) return 0;

  const minimumOffset = -anchorIndex * DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP;
  const maximumOffset = (markerCount - 1 - anchorIndex) * DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP;
  return Math.min(Math.max(requestedOffset, minimumOffset), maximumOffset);
}

export function documentStructureRulerCenterIndex(
  anchorIndex: number,
  scrollOffset: number,
  markerCount: number,
): number | null {
  if (markerCount === 0) return null;

  const roundedIndex = Math.ceil(
    anchorIndex + scrollOffset / DOCUMENT_STRUCTURE_RULER_NAVIGATION_STEP - 0.5,
  );
  return Math.min(Math.max(roundedIndex, 0), markerCount - 1);
}

export function nextDocumentStructureRulerMode(
  visibleLeftSpace: number,
): DocumentStructureRulerMode {
  return visibleLeftSpace + DOCUMENT_STRUCTURE_RULER_MEASUREMENT_TOLERANCE >=
    DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH
    ? "wide"
    : "compact";
}
