import {
  availableEditorColors,
  colorLuminance,
  colorsAreDistinct,
  EDITOR_COLOR_PRESETS,
  EditorColorsSchema,
  editorColorTokens,
} from "./editor-colors.js";
import { AppSettingsPatchSchema, AppSettingsSchema, DEFAULT_APP_SETTINGS } from "./model.js";

const colors = {
  page: "#ffffff",
  canvas: "#dfe2e7",
  panel: "#ffffff",
  panelFollowsPage: false,
};

test("coordinated presets include five light schemes and night blue", () => {
  expect(
    EDITOR_COLOR_PRESETS.map(({ name, colors }) => [
      name,
      colors.page,
      colors.canvas,
      colors.panel,
      colors.panelFollowsPage,
    ]),
  ).toEqual([
    ["经典白", "#ffffff", "#dfe2e7", "#ffffff", false],
    ["柔和灰", "#f5f5f3", "#d5d8da", "#fafaf8", false],
    ["暖纸", "#faf4e6", "#ded5c3", "#fdf9f0", false],
    ["浅竹绿", "#eef5eb", "#cfdacb", "#f6f9f3", false],
    ["雾蓝", "#f0f4fa", "#ced7e3", "#f7f9fc", false],
    ["暗夜蓝", "#f0f4fa", "#142b49", "#1c3b60", false],
  ]);
});

test("every offered color remains applicable without changing other fields", () => {
  for (const { colors: palette } of EDITOR_COLOR_PRESETS) {
    for (const key of ["page", "canvas", "panel"] as const) {
      const options = availableEditorColors(palette, key);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        const next = { ...palette, [key]: option.color };
        expect(EditorColorsSchema.safeParse(next).success).toBe(true);
        for (const other of ["page", "canvas", "panel"] as const) {
          if (other !== key) expect(next[other]).toBe(palette[other]);
        }
      }
    }
  }
});

test("preserves valid custom colors and filters conflicting page and canvas colors", () => {
  const custom = { ...colors, page: "#fffef0" };
  expect(availableEditorColors(custom, "page").some((item) => item.color === custom.page)).toBe(
    true,
  );
  expect(availableEditorColors(colors, "page").some((item) => item.color === "#000000")).toBe(
    false,
  );
  expect(availableEditorColors(colors, "canvas").some((item) => item.color === colors.page)).toBe(
    false,
  );
  expect(
    availableEditorColors({ ...colors, canvas: "#faf4e6" }, "page").some(
      (item) => item.color === "#faf4e6",
    ),
  ).toBe(false);
});

test.each(["#3b82f6", "#808080", "#777777", "#000000", "#ffffff", "#ff00ff"])(
  "inactive mask and ruler adapt to %s",
  (canvas) => {
    const tokens = editorColorTokens({ ...colors, canvas });
    expect(tokens["--editor-display-active-canvas"]).toBe(canvas);
    const inactive = tokens["--editor-display-inactive-canvas"] ?? "";
    expect(colorsAreDistinct(canvas, inactive)).toBe(true);
    for (const [background, ink] of [
      [canvas, tokens["--editor-display-canvas-ink"]],
      [inactive, tokens["--editor-display-inactive-canvas-ink"]],
    ]) {
      const a = colorLuminance(background ?? "");
      const b = colorLuminance(ink ?? "");
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  },
);

test("old settings receive a neutral display-only palette", () => {
  const { editorColors: _colors, ...old } = DEFAULT_APP_SETTINGS;
  expect(AppSettingsSchema.parse(old).editorColors).toEqual(colors);
});

test.each(["#000000", "#777777", "#0000ff", "#ff0000"])(
  "rejects unreadable or dark paper %s",
  (page) => {
    expect(AppSettingsPatchSchema.safeParse({ editorColors: { ...colors, page } }).success).toBe(
      false,
    );
  },
);

test.each(["#ffffff", "#fefefe", "#f8f8f8"])("rejects canvas too close to paper %s", (canvas) => {
  expect(AppSettingsPatchSchema.safeParse({ editorColors: { ...colors, canvas } }).success).toBe(
    false,
  );
});

test.each(["#000000", "#0000ff", "#ff00ff", "#ff0000"])(
  "allows arbitrary distinct canvas and panel %s",
  (canvas) => {
    expect(
      AppSettingsPatchSchema.safeParse({ editorColors: { ...colors, canvas, panel: canvas } })
        .success,
    ).toBe(true);
  },
);

test("unrelated patches never inject palette defaults", () => {
  expect(AppSettingsPatchSchema.parse({ zoomPercent: 125 })).toEqual({ zoomPercent: 125 });
});

test("rejects malformed color values at the settings boundary", () => {
  expect(
    AppSettingsPatchSchema.safeParse({ editorColors: { ...colors, panel: "url(remote)" } }).success,
  ).toBe(false);
});

test("all presets keep paper light and active canvas distinct", () => {
  for (const preset of EDITOR_COLOR_PRESETS) {
    expect(EditorColorsSchema.safeParse(preset.colors).success).toBe(true);
    const tokens = editorColorTokens(preset.colors);
    expect(colorsAreDistinct(preset.colors.page, tokens["--editor-display-active-canvas"]!)).toBe(
      true,
    );
  }
});

test("following paper does not lose the independently chosen panel color", () => {
  expect(
    editorColorTokens({ ...colors, panel: "#000000", panelFollowsPage: true })[
      "--editor-display-panel"
    ],
  ).toBe("#ffffff");
  expect(editorColorTokens({ ...colors, panel: "#000000" })["--editor-display-panel-ink"]).toBe(
    "#ffffff",
  );
});

test.each(["#777777", "#888888", "#ffff00", "#0000ff", "#ff0000", "#123456"])(
  "panel text remains readable on custom %s",
  (panel) => {
    const tokens = editorColorTokens({ ...colors, panel });
    for (const key of ["ink", "muted", "accent", "danger", "success", "warning"]) {
      const a = colorLuminance(panel);
      const b = colorLuminance(tokens[`--editor-display-panel-${key}`]!);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  },
);
