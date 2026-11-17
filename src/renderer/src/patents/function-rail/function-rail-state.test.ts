import {
  FUNCTION_RAIL_COLLAPSED_WIDTH,
  FUNCTION_RAIL_EXPANDED_WIDTH,
  type FunctionRailUserIntent,
  nextFunctionRailSpace,
  resolveFunctionRailPresentation,
} from "./function-rail-state";

describe("function rail state", () => {
  test("uses the fixed expanded and collapsed widths", () => {
    expect(FUNCTION_RAIL_EXPANDED_WIDTH).toBe(280);
    expect(FUNCTION_RAIL_COLLAPSED_WIDTH).toBe(36);
  });

  test.each([
    ["collapsed", false, false, 0, false, "manual-collapse"],
    ["collapsed", true, false, 0, true, "hover"],
    ["collapsed", false, true, 0, true, "interaction"],
    ["collapsed", false, false, 1, true, "tool"],
    ["pinned", false, false, 0, true, "pinned"],
  ] as const)(
    "resolves %s intent with hover=%s, interaction=%s, and tool requests=%s",
    (userIntent, hovered, interactionActive, toolRequestCount, expanded, reason) => {
      expect(
        resolveFunctionRailPresentation({
          space: "constrained",
          userIntent,
          hovered,
          interactionActive,
          toolRequestCount,
        }),
      ).toEqual({
        expanded,
        layout: "overlay",
        slotWidth: 36,
        reason,
      });
    },
  );

  test.each([
    ["tool", "pinned", true, true, 1],
    ["interaction", "pinned", true, true, 0],
    ["pinned", "pinned", true, false, 0],
    ["hover", "collapsed", true, false, 0],
  ] as const)(
    "prioritizes %s when multiple expansion reasons apply",
    (reason, userIntent, hovered, interactionActive, toolRequestCount) => {
      expect(
        resolveFunctionRailPresentation({
          space: "constrained",
          userIntent,
          hovered,
          interactionActive,
          toolRequestCount,
        }).reason,
      ).toBe(reason);
    },
  );

  test.each([
    ["auto", "fits", true, 280],
    ["auto", "constrained", false, 36],
    ["collapsed", "fits", false, 36],
    ["pinned", "fits", true, 280],
  ] as const)(
    "resolves %s intent in %s space",
    (userIntent: FunctionRailUserIntent, space, expanded, slotWidth) => {
      expect(
        resolveFunctionRailPresentation({
          space,
          userIntent,
          hovered: false,
          interactionActive: false,
          toolRequestCount: 0,
        }),
      ).toMatchObject({
        expanded,
        layout: space === "fits" ? "docked" : "overlay",
        slotWidth,
      });
    },
  );

  test("requires a small recovery margin before expanding a constrained rail", () => {
    expect(nextFunctionRailSpace("fits", 1099, 820)).toBe("constrained");
    expect(nextFunctionRailSpace("fits", 1111, 820)).toBe("constrained");
    expect(nextFunctionRailSpace("fits", 1112, 820)).toBe("fits");
    expect(nextFunctionRailSpace("constrained", 1111, 820)).toBe("constrained");
    expect(nextFunctionRailSpace("constrained", 1112, 820)).toBe("constrained");
    expect(nextFunctionRailSpace("constrained", 1123, 820)).toBe("constrained");
    expect(nextFunctionRailSpace("constrained", 1124, 820)).toBe("fits");
  });

  test("does not alternate layouts when resize measurements jitter at the boundary", () => {
    let space: "fits" | "constrained" = "fits";
    const states = [1111.8, 1112.2, 1111.9, 1112.4, 1112, 1111.7].map((width) => {
      space = nextFunctionRailSpace(space, width, 820);
      return space;
    });
    expect(states).toEqual(Array(6).fill("constrained"));
    expect(nextFunctionRailSpace(space, 1130, 820)).toBe("fits");
  });

  test("keeps an edge-opened rail overlaid when fitted space is available", () => {
    expect(
      resolveFunctionRailPresentation({
        space: "fits",
        userIntent: "pinned",
        hovered: false,
        interactionActive: false,
        toolRequestCount: 0,
        edgeAnchored: true,
      }),
    ).toMatchObject({ expanded: true, layout: "overlay", slotWidth: 36 });
  });
});
