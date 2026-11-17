export const FUNCTION_RAIL_EXPANDED_WIDTH = 280;
export const FUNCTION_RAIL_COLLAPSED_WIDTH = 36;
export const FUNCTION_RAIL_GAP = 12;
export const FUNCTION_RAIL_RECOVERY_MARGIN = 12;

export type FunctionRailSpace = "fits" | "constrained";
export type FunctionRailUserIntent = "auto" | "collapsed" | "pinned";

export type FunctionRailPresentationInput = Readonly<{
  space: FunctionRailSpace;
  userIntent: FunctionRailUserIntent;
  hovered: boolean;
  interactionActive: boolean;
  toolRequestCount: number;
  edgeAnchored?: boolean;
}>;

export type FunctionRailPresentation = Readonly<{
  expanded: boolean;
  layout: "docked" | "overlay";
  slotWidth: 36 | 280;
  reason: "tool" | "interaction" | "pinned" | "hover" | "manual-collapse" | "auto";
}>;

export function resolveFunctionRailPresentation(
  input: FunctionRailPresentationInput,
): FunctionRailPresentation {
  const reason =
    input.toolRequestCount > 0
      ? "tool"
      : input.interactionActive
        ? "interaction"
        : input.userIntent === "pinned"
          ? "pinned"
          : input.hovered
            ? "hover"
            : input.userIntent === "collapsed"
              ? "manual-collapse"
              : "auto";
  const layout = (input.edgeAnchored ?? input.space === "constrained") ? "overlay" : "docked";
  const expanded =
    reason === "tool" ||
    reason === "interaction" ||
    reason === "pinned" ||
    reason === "hover" ||
    (reason === "auto" && input.space === "fits");

  return {
    expanded,
    layout,
    slotWidth: expanded && layout === "docked" ? 280 : 36,
    reason,
  };
}

export function nextFunctionRailSpace(
  currentSpace: FunctionRailSpace,
  availableWidth: number,
  renderedPageWidth: number,
  structuralReservation = 0,
): FunctionRailSpace {
  const requiredWidth =
    renderedPageWidth + structuralReservation + FUNCTION_RAIL_GAP + FUNCTION_RAIL_EXPANDED_WIDTH;

  if (currentSpace === "fits") {
    return availableWidth < requiredWidth ? "constrained" : "fits";
  }

  // Separate collapse and recovery thresholds so small resize/layout fluctuations
  // cannot repeatedly move the page between docked and overlay layouts.
  return availableWidth >= requiredWidth + FUNCTION_RAIL_RECOVERY_MARGIN ? "fits" : "constrained";
}
