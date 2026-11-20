import {
  type ColorRangeOptions,
  ColorRangeOptionsSchema,
} from "../../../../shared/settings/design-color-range";
export type ColorRangeState = {
  options: ColorRangeOptions;
  sampling: "replace" | "add" | "subtract";
  positive: number;
  negative: number;
  busy: boolean;
  canApply: boolean;
  error: string;
  percent: number;
};
export function isColorRangeState(v: unknown): v is ColorRangeState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as ColorRangeState;
  return (
    Object.keys(s).length === 8 &&
    ColorRangeOptionsSchema.safeParse(s.options).success &&
    ["replace", "add", "subtract"].includes(s.sampling) &&
    [s.positive, s.negative].every((n) => Number.isInteger(n) && n >= 0 && n <= 32) &&
    s.positive + s.negative <= 32 &&
    typeof s.busy === "boolean" &&
    typeof s.canApply === "boolean" &&
    typeof s.error === "string" &&
    s.error.length <= 500 &&
    Number.isFinite(s.percent) &&
    s.percent >= 0 &&
    s.percent <= 100
  );
}
