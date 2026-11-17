import { z } from "zod";

const target = { patentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
export const AutomationSnapshotCreateSchema = z.object(target).strict();
export const AutomationSnapshotDeleteSchema = z
  .object({ ...target, revision: z.number().int().nonnegative() })
  .strict();
