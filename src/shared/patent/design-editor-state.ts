import { z } from "zod";

export const DesignEditorCheckpointSchema = z
  .object({
    revisionId: z.string().uuid(),
    projectAssetId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Explicit save and crash-recovery references are independent; neither implies applied output. */
export const DesignEditorStateSchema = z
  .object({
    version: z.literal(1),
    sourceAssetId: z.string().uuid(),
    saved: DesignEditorCheckpointSchema.nullable(),
    recovery: DesignEditorCheckpointSchema.nullable(),
    applied: DesignEditorCheckpointSchema.extend({
      imageAssetId: z.string().uuid(),
      widthPx: z.number().int().min(1).max(10000),
      heightPx: z.number().int().min(1).max(10000),
    })
      .strict()
      .refine((value) => value.widthPx * value.heightPx <= 40000000)
      .nullable()
      .optional(),
  })
  .strict();
export type DesignEditorState = z.infer<typeof DesignEditorStateSchema>;
