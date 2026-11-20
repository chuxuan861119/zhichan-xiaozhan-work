import { z } from "zod";

const byte = z.number().int().min(0).max(255);
export const ToneOptionsSchema = z
  .object({
    mode: z.enum(["levels", "threshold"]),
    channel: z.enum(["rgb", "r", "g", "b"]),
    black: byte,
    white: byte,
    gamma: z.number().min(0.1).max(9.99),
    outBlack: byte,
    outWhite: byte,
    threshold: byte,
  })
  .strict()
  .refine(
    (o) => o.black < o.white && o.outBlack <= o.outWhite,
    "输入黑点须小于白点，输出黑点不得大于白点。",
  );
export type ToneOptions = z.infer<typeof ToneOptionsSchema>;
export const DEFAULT_TONE: ToneOptions = {
  mode: "levels",
  channel: "rgb",
  black: 0,
  white: 255,
  gamma: 1,
  outBlack: 0,
  outWhite: 255,
  threshold: 128,
};
export function tonePixel(pixel: readonly number[], o: ToneOptions): number[] {
  const result = [...pixel];
  if (!pixel[3]) return result;
  if (o.mode === "threshold") {
    const n =
      Math.round(pixel[0]! * 0.299 + pixel[1]! * 0.587 + pixel[2]! * 0.114) >= o.threshold
        ? 255
        : 0;
    return [n, n, n, pixel[3]!];
  }
  for (let k = 0; k < 3; k++)
    if (o.channel === "rgb" || o.channel === ["r", "g", "b"][k])
      result[k] = Math.round(
        o.outBlack +
          (o.outWhite - o.outBlack) *
            Math.max(0, Math.min(1, (pixel[k]! - o.black) / (o.white - o.black))) ** (1 / o.gamma),
      );
  return result;
}
const png = z
  .string()
  .max(300000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
export const ToneStateSchema = z
  .object({
    options: ToneOptionsSchema,
    busy: z.boolean(),
    applying: z.boolean(),
    canApply: z.boolean(),
    error: z.string().max(500),
    before: png,
    after: png.nullable(),
    histogram: z.array(z.number().nonnegative().finite()).length(256),
  })
  .strict();
export type ToneState = z.infer<typeof ToneStateSchema>;
