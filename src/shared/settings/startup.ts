import { z } from "zod";
export const StartupStateSchema = z
  .object({
    supported: z.boolean(),
    enabled: z.boolean(),
    management: z.literal("system").optional(),
    unavailableReason: z.string().max(200).optional(),
  })
  .strict();
export type StartupState = z.infer<typeof StartupStateSchema>;
export const BackgroundSaveResultSchema = z
  .object({ token: z.string().uuid(), ok: z.boolean() })
  .strict();
