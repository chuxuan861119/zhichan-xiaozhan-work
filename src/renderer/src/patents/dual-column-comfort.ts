import { FUNCTION_RAIL_RECOVERY_MARGIN } from "./function-rail/function-rail-state";

export const MIN_COLUMN_PAGE_WIDTH = 600;

export function canFitComfortableColumns(availableWidth: number) {
  return (
    availableWidth >= 2 * MIN_COLUMN_PAGE_WIDTH + 168 + 34 + 292 + FUNCTION_RAIL_RECOVERY_MARGIN + 1
  );
}

export function resizedColumnPosition(
  position: number,
  oldHeight: number,
  oldZoom: number,
  height: number,
  zoom: number,
  side: number,
) {
  if (position === 0) return 0;
  return ((position + (side + 1 / 3) * oldHeight) / oldZoom) * zoom - (side + 1 / 3) * height;
}
