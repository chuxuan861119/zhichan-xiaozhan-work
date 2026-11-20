import { z } from "zod";
export const AutoTrimOptionsSchema = z
  .object({
    mode: z.enum(["transparent", "solid"]),
    tolerance: z.number().int().min(0).max(50),
  })
  .strict();
export type AutoTrimOptions = z.infer<typeof AutoTrimOptionsSchema>;
export const DEFAULT_AUTO_TRIM: AutoTrimOptions = {
  mode: "transparent",
  tolerance: 0,
};
