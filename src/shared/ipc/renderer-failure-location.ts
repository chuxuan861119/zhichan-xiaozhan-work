import { z } from "zod";

export const RendererFailureLocationSchema = z
  .object({
    bundle: z.string().regex(/^index-[A-Za-z0-9_-]{8}\.js$/u),
    line: z.number().int().min(1).max(10_000_000),
    column: z.number().int().min(1).max(10_000_000),
  })
  .strict();
export type RendererFailureLocation = z.infer<typeof RendererFailureLocationSchema>;
