import { DEFAULT_PATTERN_VALUES, type PatternValues } from "./cad-pattern-command";

export const CAD_HATCH_PREFERENCES_KEY = "patent-workbench:cad-hatch-preferences:v1";
type HatchPreferences = Pick<
  PatternValues,
  "pattern" | "scale" | "hatchAngle" | "islandStyle" | "gapTolerance"
>;

function appearance(value: unknown): Partial<HatchPreferences> {
  if (!value || typeof value !== "object") return {};
  const stored = value as Record<string, unknown>;
  const result: Partial<HatchPreferences> = {};
  if (typeof stored.pattern === "string" && stored.pattern.trim()) result.pattern = stored.pattern;
  const numeric = (key: "scale" | "hatchAngle" | "gapTolerance", valid: (n: number) => boolean) => {
    const text = stored[key];
    if (
      typeof text === "string" &&
      text.trim() &&
      Number.isFinite(Number(text)) &&
      valid(Number(text))
    )
      result[key] = text;
  };
  numeric("scale", (n) => n > 0);
  numeric("hatchAngle", () => true);
  numeric("gapTolerance", (n) => n >= 0 && n <= 5000);
  if (stored.gapTolerance === "") result.gapTolerance = "";
  if (
    typeof stored.islandStyle === "string" &&
    ["normal", "outer", "ignore"].includes(stored.islandStyle)
  )
    result.islandStyle = stored.islandStyle as HatchPreferences["islandStyle"];
  return result;
}

export function readHatchPreferences(): PatternValues {
  try {
    return {
      ...DEFAULT_PATTERN_VALUES,
      ...appearance(JSON.parse(localStorage.getItem(CAD_HATCH_PREFERENCES_KEY) ?? "null")),
    };
  } catch {
    // Missing, corrupt or restricted optional preferences never block drawing.
    return { ...DEFAULT_PATTERN_VALUES };
  }
}

/** Called only after the accepted hatch has a committed checkpoint, never on preview/enqueue. */
export function rememberHatchPreferences(name: string, params: object) {
  const command = params as {
    pattern: string;
    scale: number;
    angle: number;
    style: string;
    gapTolerance?: number;
  };
  const previous = readHatchPreferences();
  const next = appearance({
    pattern: command.pattern,
    scale: String(command.scale),
    hatchAngle: String(command.angle),
    islandStyle: command.style,
    gapTolerance:
      command.gapTolerance === undefined
        ? name === "hatch"
          ? ""
          : previous.gapTolerance
        : String(command.gapTolerance),
  });
  try {
    localStorage.setItem(CAD_HATCH_PREFERENCES_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("填充已保存，但未能记住填充参数。", error);
  }
}
