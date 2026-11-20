import { z } from "zod";
import {
  WhitespaceOptionsSchema,
  WhitespacePlanSchema,
} from "../../../../shared/settings/design-whitespace";

const preview = z
  .string()
  .max(300000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
export const WhitespaceStateSchema = z
  .object({
    options: WhitespaceOptionsSchema,
    busy: z.boolean(),
    applying: z.boolean(),
    canApply: z.boolean(),
    error: z.string().max(500),
    plan: WhitespacePlanSchema.nullable(),
    before: preview,
    after: preview.nullable(),
  })
  .strict();
export type WhitespaceState = z.infer<typeof WhitespaceStateSchema>;
