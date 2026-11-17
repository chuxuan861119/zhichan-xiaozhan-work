import { describe, expect, test } from "vitest";
import {
  CustomDualViewPresetsSchema,
  compactCustomDualViewSlots,
  customDualViewFullLabel,
  customDualViewShortcutId,
  customDualViewShortLabel,
  isCustomDualViewPresetAvailable,
} from "./custom-dual-view.js";
import { DEFAULT_SHORTCUT_SETTINGS } from "./shortcuts.js";

describe("custom dual-view presets", () => {
  test("restores tool presets alongside legacy books without changing persisted fields", () => {
    const presets = [
      { leftBookKind: "description", rightBookKind: "claims" },
      { leftBookKind: "flowchart", rightBookKind: "description" },
      { leftBookKind: "claims", rightBookKind: "drawing-markup" },
      { leftBookKind: "drawing-markup", rightBookKind: "flowchart" },
    ];
    expect(CustomDualViewPresetsSchema.parse(JSON.parse(JSON.stringify(presets)))).toEqual(presets);
    const tools = CustomDualViewPresetsSchema.parse(presets).at(-1);
    if (!tools) throw new Error("Missing tool preset fixture");
    expect(customDualViewShortLabel(tools)).toEqual(["CAD", "流"]);
    expect(customDualViewFullLabel(tools)).toBe("CAD标号｜流程图 / 电路图");
  });

  test("allows tools without drawing books but rejects unavailable drawing presets", () => {
    const tools = CustomDualViewPresetsSchema.parse([
      { leftBookKind: "flowchart", rightBookKind: "drawing-markup" },
    ])[0];
    if (!tools) throw new Error("Missing tool preset fixture");
    expect(isCustomDualViewPresetAvailable(tools, ["description", "claims", "abstract"])).toBe(
      true,
    );
    expect(
      isCustomDualViewPresetAvailable(
        { leftBookKind: "description-drawings", rightBookKind: "claims" },
        ["claims"],
      ),
    ).toBe(false);
  });

  test.each(["flowchart", "drawing-markup"])("rejects duplicate %s hosts", (tool) => {
    expect(
      CustomDualViewPresetsSchema.safeParse([{ leftBookKind: tool, rightBookKind: tool }]).success,
    ).toBe(false);
  });
  test("accepts more than three supported pairs", () => {
    expect(
      CustomDualViewPresetsSchema.parse([
        { leftBookKind: "description", rightBookKind: "claims" },
        { leftBookKind: "abstract", rightBookKind: "description" },
        { leftBookKind: "claims", rightBookKind: "description-drawings" },
        { leftBookKind: "description-drawings", rightBookKind: "abstract" },
      ]),
    ).toHaveLength(4);
  });

  test("rejects duplicate sides and abstract drawings", () => {
    expect(() =>
      CustomDualViewPresetsSchema.parse([
        { leftBookKind: "description", rightBookKind: "description" },
      ]),
    ).toThrow();
    expect(() =>
      CustomDualViewPresetsSchema.parse([
        { leftBookKind: "abstract-drawing", rightBookKind: "claims" },
      ]),
    ).toThrow();
  });

  test("builds labels and compacts shortcut slots after deletion", () => {
    const presets = [
      { leftBookKind: "description" as const, rightBookKind: "claims" as const },
      { leftBookKind: "abstract" as const, rightBookKind: "description" as const },
    ];
    const [firstPreset, secondPreset] = presets;
    if (!firstPreset || !secondPreset) throw new Error("preset fixture missing");
    const shortcuts = {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "open-custom-dual-view-1": "F8",
      "open-custom-dual-view-2": "Ctrl+Alt+K",
    };

    expect(customDualViewShortLabel(firstPreset)).toEqual(["说", "权"]);
    expect(customDualViewFullLabel(firstPreset)).toBe("说明书｜权利要求书");
    expect(compactCustomDualViewSlots(presets, shortcuts, 0)).toMatchObject({
      presets: [secondPreset],
      shortcuts: {
        "open-custom-dual-view-1": "Ctrl+Alt+K",
        "open-custom-dual-view-2": null,
        "open-custom-dual-view-3": null,
      },
    });
  });

  test("builds and compacts shortcut ids beyond the legacy first three slots", () => {
    const presets = Array.from({ length: 5 }, (_, index) => ({
      leftBookKind: index % 2 === 0 ? ("description" as const) : ("claims" as const),
      rightBookKind: index % 2 === 0 ? ("claims" as const) : ("description" as const),
    }));
    const shortcuts = {
      ...DEFAULT_SHORTCUT_SETTINGS,
      "open-custom-dual-view-4": "F9",
      "open-custom-dual-view-5": "F10",
    };

    expect(customDualViewShortcutId(3)).toBe("open-custom-dual-view-4");
    expect(compactCustomDualViewSlots(presets, shortcuts, 1)).toMatchObject({
      presets: [presets[0], presets[2], presets[3], presets[4]],
      shortcuts: {
        "open-custom-dual-view-3": "F9",
        "open-custom-dual-view-4": "F10",
        "open-custom-dual-view-5": null,
      },
    });
  });
});
