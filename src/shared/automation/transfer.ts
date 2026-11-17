import { z } from "zod";

export const AutomationTransferReadSchema = z.object({}).strict();
export const AutomationTransferExportSchema = z
  .object({
    output: z.string().min(1),
    password: z.string().min(12).max(1024),
    passwordHint: z.string().max(500).nullable().default(null),
    passwordRecorded: z.literal(true),
    persisted: z.literal(true),
  })
  .strict();

export const AutomationTransferPrepareSchema = z
  .object({
    path: z.string().min(1),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const AutomationTransferImportSchema = z.object({ importId: z.string().uuid() }).strict();
export const AutomationTransferCommitSchema = AutomationTransferImportSchema.extend({
  restart: z.literal(true),
});

export const AutomationRelocateSchema = z
  .object({ parent: z.string().min(1), restart: z.literal(true) })
  .strict();
