import { z } from "zod";
export const AutomationTrashSchema = z
  .object({ patentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
  .strict();
export const AutomationTrashItemSchema = z
  .object({ patentId: z.string().uuid(), expectedDeletedAt: z.string().datetime() })
  .strict();
