import { DEFAULT_PAGE_SETTINGS } from "../../../shared/document/defaults";
import {
  DOCUMENT_STRUCTURE_RULER_COMPACT_WIDTH,
  DOCUMENT_STRUCTURE_RULER_GAP,
  DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH,
} from "./document-structure-ruler-state";
import {
  FUNCTION_RAIL_COLLAPSED_WIDTH,
  FUNCTION_RAIL_EXPANDED_WIDTH,
  FUNCTION_RAIL_GAP,
  FUNCTION_RAIL_RECOVERY_MARGIN,
} from "./function-rail/function-rail-state";
export const DUAL_PANE_MINIMUM_SCALE = 0.52;
export const DUAL_PANE_DIVIDER_WIDTH = 15;
export const DUAL_PANE_PADDING = 12;
export const DUAL_PANE_SCROLLBAR = 15;
export const DUAL_PANE_RULER = DOCUMENT_STRUCTURE_RULER_WIDE_WIDTH + DOCUMENT_STRUCTURE_RULER_GAP;
export const DUAL_PANE_COMPACT_RULER =
  DOCUMENT_STRUCTURE_RULER_COMPACT_WIDTH + DOCUMENT_STRUCTURE_RULER_GAP;
export const DUAL_PANE_COLLAPSED_RAIL = FUNCTION_RAIL_COLLAPSED_WIDTH + FUNCTION_RAIL_GAP;
export const DUAL_PANE_DEFAULT_PAGE_WIDTH = (DEFAULT_PAGE_SETTINGS.widthMm * 96) / 25.4;
export function minimumDualPaneWidth(
  pageWidth = DUAL_PANE_DEFAULT_PAGE_WIDTH,
  chrome = DUAL_PANE_PADDING * 2 + DUAL_PANE_SCROLLBAR,
) {
  return Math.ceil(
    pageWidth * DUAL_PANE_MINIMUM_SCALE +
      DUAL_PANE_COMPACT_RULER +
      DUAL_PANE_COLLAPSED_RAIL +
      chrome,
  );
}

export function dualPaneRulerIsCompact(
  wasCompact: boolean,
  availableWidth: number,
  renderedPageWidth: number,
  railWidth: number,
) {
  const required = renderedPageWidth + DUAL_PANE_RULER + railWidth;
  return availableWidth < required + (wasCompact ? FUNCTION_RAIL_RECOVERY_MARGIN : 0);
}

export function fitDualPanePage(
  paneWidth: number,
  pageWidth = DUAL_PANE_DEFAULT_PAGE_WIDTH,
  chrome = DUAL_PANE_PADDING * 2 + DUAL_PANE_SCROLLBAR,
  actual?: Readonly<{ ruler: number; rail: number }>,
  displayWidthMm?: number | null,
) {
  if (actual) {
    const pageAvailableWidth = Math.max(0, paneWidth - chrome - actual.ruler - actual.rail);
    const fitScale = Math.min(2, pageAvailableWidth / pageWidth);
    return {
      initialRailSpace:
        actual.rail > DUAL_PANE_COLLAPSED_RAIL ? ("fits" as const) : ("constrained" as const),
      pageAvailableWidth,
      fitScale,
      fitZoomPercent: Math.floor(fitScale * 100),
    };
  }
  const dockedWidth = Math.max(
    0,
    paneWidth -
      chrome -
      DUAL_PANE_RULER -
      FUNCTION_RAIL_EXPANDED_WIDTH -
      FUNCTION_RAIL_GAP -
      FUNCTION_RAIL_RECOVERY_MARGIN -
      1,
  );
  // An automatic fit must also be reachable from the collapsed state. Filling
  // the entire docked budget otherwise leaves no room for the recovery hysteresis.
  // The extra pixel covers clientWidth rounding versus fractional grid measurements.
  const supportsDockedFit =
    displayWidthMm !== null && (displayWidthMm === undefined || displayWidthMm >= 500);
  const initialRailSpace =
    dockedWidth >= pageWidth && supportsDockedFit ? ("fits" as const) : ("constrained" as const);
  const pageAvailableWidth =
    initialRailSpace === "fits"
      ? dockedWidth
      : Math.max(0, paneWidth - chrome - DUAL_PANE_COMPACT_RULER - DUAL_PANE_COLLAPSED_RAIL);
  // Keep a natural-size page while controls consume/release space. Filling the
  // compact budget above 100% makes crossing the docked threshold jump backwards.
  const maximumScale = supportsDockedFit && initialRailSpace === "constrained" ? 1 : 2;
  const fitScale = Math.min(maximumScale, pageAvailableWidth / pageWidth);
  return {
    initialRailSpace,
    pageAvailableWidth,
    fitScale,
    fitZoomPercent: Math.floor(fitScale * 100),
  };
}
