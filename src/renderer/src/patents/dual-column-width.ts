import { canFitComfortableColumns } from "./dual-column-comfort";
import { dualPaneRulerIsCompact } from "./dual-pane-layout-budget";
import {
  FUNCTION_RAIL_RECOVERY_MARGIN,
  type FunctionRailSpace,
  nextFunctionRailSpace,
} from "./function-rail/function-rail-state";

/** Fit both pages; compact controls reserve reading space on laptop windows. */
export function dualColumnWidth(
  availableWidth: number,
  pageWidth: number,
  zoomPercent: number,
  railExpanded: boolean,
  previous?: Readonly<{ baseZoom: number; railSpace?: FunctionRailSpace; rulerCompact?: boolean }>,
) {
  // Keep one pixel for fractional layout rounding; only pages take the remaining width.
  const controlsWidth = canFitComfortableColumns(availableWidth)
    ? 34 + 292 + 168 + FUNCTION_RAIL_RECOVERY_MARGIN
    : 34 + 48 + 56;
  const baseZoom =
    previous?.baseZoom ?? Math.max(0.1, (availableWidth - controlsWidth - 1) / (2 * pageWidth));
  // Two compact rulers (20 + 8 each), the scrollbar/gaps and the collapsed rail.
  const maxZoomPercent = Math.max(
    1,
    Math.min(150, Math.floor(((availableWidth - 56 - 34 - 48) / (2 * pageWidth * baseZoom)) * 100)),
  );
  const zoom = (baseZoom * Math.min(zoomPercent, maxZoomPercent)) / 100;
  const pagesWidth = pageWidth * zoom * 2;
  const railFits = previous?.railSpace
    ? nextFunctionRailSpace(previous.railSpace, availableWidth, pagesWidth, 168 + 34) === "fits"
    : pagesWidth + 168 + 34 + 292 <= availableWidth;
  const railWidth = railFits && railExpanded ? 292 : 48;
  const rulerWidth = dualPaneRulerIsCompact(
    Boolean(previous?.rulerCompact),
    availableWidth - 34 - railWidth,
    pagesWidth + 84,
    0,
  )
    ? 20
    : 76;
  const columnWidth = pageWidth * zoom + rulerWidth + 8;
  return {
    maxZoomPercent,
    baseZoom,
    zoom,
    railFits,
    railWidth,
    rulerWidth,
    columnWidth,
    groupWidth: columnWidth * 2 + 34 + railWidth,
  };
}
