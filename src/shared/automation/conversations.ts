import { z } from "zod";
import {
  TextPolishConversationModelSchema,
  TextPolishInputDraftSchema,
  TextPolishScopeSchema,
} from "../ai-correction/text-polish-contract.js";

const target = {
  patentId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  persisted: z.boolean().default(false),
};
const conversation = {
  ...target,
  conversationId: z.string().uuid(),
  expectedConversationRevision: z.number().int().nonnegative(),
};
export const AutomationConversationReadSchema = z
  .object({
    patentId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const AutomationConversationRunSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...target,
      action: z.literal("start"),
      scope: TextPolishScopeSchema,
      instruction: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      ...conversation,
      action: z.literal("send"),
      instruction: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z.object({ ...conversation, action: z.literal("retry"), turnId: z.string().uuid() }).strict(),
  z
    .object({
      ...conversation,
      action: z.literal("change-model"),
      targetModel: TextPolishConversationModelSchema,
    })
    .strict(),
  z.object({ ...conversation, action: z.literal("reset") }).strict(),
  z
    .object({
      ...target,
      action: z.literal("draft"),
      conversationId: z.string().uuid().nullable(),
      expectedDraftHash: z.string().regex(/^[a-f0-9]{64}$/u),
      draft: TextPolishInputDraftSchema,
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal("recover"),
      conversationId: z.string().uuid().nullable(),
    })
    .strict(),
]);
