import {
  createEditorColorGamut,
  gamutColor,
  hexToHsv,
  locateGamutColor,
} from "./editor-color-gamut.js";
import {
  DEFAULT_EDITOR_COLORS,
  EDITOR_COLOR_PRESETS,
  EditorColorsSchema,
} from "./editor-colors.js";

test("all page hues remain continuous across the full rendered width", () => {
  for (let hue = 0; hue < 360; hue++) {
    const gamut = createEditorColorGamut(DEFAULT_EDITOR_COLORS, "page", hue);
    for (const y of [0, 0.25, 0.5, 0.75, 1]) {
      for (let x = 0; x < 127; x++) {
        const a = gamutColor(gamut, x / 127, y);
        const b = gamutColor(gamut, (x + 1) / 127, y);
        const jump = Math.max(
          ...[1, 3, 5].map((i) =>
            Math.abs(
              Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16),
            ),
          ),
        );
        expect(jump, `hue=${hue} x=${x} y=${y} ${a} -> ${b}`).toBeLessThanOrEqual(6);
      }
    }
  }
});

test("green page gamut has no abrupt jumps between neighboring samples", () => {
  const gamut = createEditorColorGamut(DEFAULT_EDITOR_COLORS, "page", 120);
  const distance = (a: string, b: string) =>
    Math.max(
      ...[1, 3, 5].map((i) =>
        Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)),
      ),
    );
  let largest = 0;
  for (let x = 0; x < 255; x++)
    for (let y = 0; y < 255; y++) {
      const color = gamutColor(gamut, x / 255, y / 255);
      largest = Math.max(
        largest,
        distance(color, gamutColor(gamut, (x + 1) / 255, y / 255)),
        distance(color, gamutColor(gamut, x / 255, (y + 1) / 255)),
      );
    }
  expect(largest).toBeLessThanOrEqual(4);
});

test("gamut samples interpolate between columns and brightness levels", () => {
  expect(
    gamutColor(
      [
        ["#ffffff", "#dddddd"],
        ["#00ff00", "#00dd00"],
      ],
      0.5,
      0.5,
    ),
  ).toBe("#77ee77");
});

test("yellow-green slices interpolate brightness instead of visible quantization bands", () => {
  for (let hue = 50; hue <= 140; hue += 5) {
    const gamut = createEditorColorGamut(
      { ...DEFAULT_EDITOR_COLORS, canvas: "#667085" },
      "page",
      hue,
    );
    const samples = Array.from({ length: 1001 }, (_, i) => gamutColor(gamut, 0.28, i / 1000));
    const longestRun = samples.reduce(
      (state, color) => {
        const run = color === state.previous ? state.run + 1 : 1;
        return { previous: color, run, longest: Math.max(run, state.longest) };
      },
      { previous: "", run: 0, longest: 0 },
    );
    expect(longestRun.longest, `hue ${hue}`).toBeLessThan(40);
  }
});

test("custom light and dark backgrounds retain a nonempty valid page gamut", () => {
  for (const canvas of ["#ffffff", "#fafafa", "#e6ffe6", "#000000"]) {
    for (let hue = 0; hue < 360; hue += 30) {
      const colors = { ...DEFAULT_EDITOR_COLORS, canvas };
      const gamut = createEditorColorGamut(colors, "page", hue);
      expect(gamut.length).toBeGreaterThan(0);
      for (const x of [0, 0.5, 1])
        for (const y of [0, 0.5, 1]) {
          expect(
            EditorColorsSchema.safeParse({ ...colors, page: gamutColor(gamut, x, y) }).success,
          ).toBe(true);
        }
    }
  }
});

test("every position in each field's gamut satisfies the persisted color rules", () => {
  for (const { colors } of EDITOR_COLOR_PRESETS) {
    for (const field of ["page", "canvas", "panel"] as const) {
      for (const hue of [0, 60, 120, 180, 240, 300, 360]) {
        const gamut = createEditorColorGamut(colors, field, hue);
        for (const x of [0, 0.2, 0.5, 0.8, 1]) {
          for (const y of [0, 0.2, 0.5, 0.8, 1]) {
            expect(
              EditorColorsSchema.safeParse({ ...colors, [field]: gamutColor(gamut, x, y) }).success,
            ).toBe(true);
          }
        }
      }
    }
  }
});

test("gamut preserves other fields, clamps coordinates and offers many more than preset colors", () => {
  const colors = { ...DEFAULT_EDITOR_COLORS };
  const gamut = createEditorColorGamut(colors, "page", 210);
  const choices = new Set<string>();
  for (const hue of [0, 60, 120, 180, 240, 300]) {
    const slice = createEditorColorGamut(colors, "page", hue);
    for (let x = 0; x <= 100; x++)
      for (let y = 0; y <= 100; y++) choices.add(gamutColor(slice, x / 100, y / 100));
  }
  expect(choices.size).toBeGreaterThan(1000);
  expect(gamutColor(gamut, -1, 2)).toBe(gamutColor(gamut, 0, 1));
  expect(colors).toEqual(DEFAULT_EDITOR_COLORS);
  expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
  const chosen = gamutColor(gamut, 0.6, 0.4);
  const location = locateGamutColor(gamut, chosen);
  expect(gamutColor(gamut, location.x, location.y)).toBe(chosen);
});
