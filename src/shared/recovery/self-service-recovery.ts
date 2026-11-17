import { z } from "zod";

export const RecoverySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }).strict(),
  z.object({ kind: z.literal("backup"), fileName: z.string().min(1).max(255) }).strict(),
  z
    .object({
      kind: z.literal("snapshot"),
      patentId: z.string().uuid(),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type RecoverySource = z.infer<typeof RecoverySourceSchema>;
export const PreparedRecoverySchema = z
  .object({
    token: z.string().uuid(),
    libraryPath: z.string().min(1),
    sourceLibraryPath: z.string().min(1).optional(),
    documentId: z.string().uuid(),
    displayName: z.string(),
  })
  .strict();
export type PreparedRecovery = z.infer<typeof PreparedRecoverySchema>;
