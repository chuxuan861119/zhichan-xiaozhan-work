import { z } from "zod";
import { SessionIdSchema } from "../ipc/primitives.js";
import { LibraryPatentIdSchema, LibraryRevisionSchema } from "../library/model.js";
import { AiCorrectionSettingsSchema, AiServiceBaseUrlSchema } from "./model.js";

export const AiCorrectionSettingsStateSchema = z
  .object({
    settings: AiCorrectionSettingsSchema,
    credentialProfileIds: z.array(z.uuid()).max(20),
    credentialStatusUnknown: z.boolean().optional(),
  })
  .strict();
export type AiCorrectionSettingsState = z.infer<typeof AiCorrectionSettingsStateSchema>;

export const AiCorrectionProfileRequestSchema = z.object({ profileId: z.uuid() }).strict();
export type AiCorrectionProfileRequest = z.infer<typeof AiCorrectionProfileRequestSchema>;

export const AiProviderDocsRequestSchema = z
  .object({
    providerId: z.literal("deepseek"),
    document: z.enum(["api", "privacy", "terms"]).optional(),
  })
  .strict();
export type AiProviderDocsRequest = z.infer<typeof AiProviderDocsRequestSchema>;

export const AiApiKeyRequestSchema = z
  .object({
    profileId: z.uuid(),
    apiKey: z.string().trim().min(1).max(4_000),
    resetUnavailable: z.boolean().optional(),
  })
  .strict();
export type AiApiKeyRequest = z.infer<typeof AiApiKeyRequestSchema>;

export const AiModelDiscoveryRequestSchema = z
  .object({
    providerId: z.literal("deepseek"),
    baseUrl: AiServiceBaseUrlSchema.refine(
      (value) => value === "https://api.deepseek.com",
      "仅支持 DeepSeek 官方接口。",
    ),
    apiKey: z.string().trim().max(4_000),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.apiKey.length === 0) {
      context.addIssue({ code: "custom", message: "请输入 API Key。", path: ["apiKey"] });
    }
  });
export type AiModelDiscoveryRequest = z.infer<typeof AiModelDiscoveryRequestSchema>;

export const AiModelDiscoveryResultSchema = z
  .object({ models: z.array(z.string().trim().min(1).max(200)).max(200) })
  .strict();
export type AiModelDiscoveryResult = z.infer<typeof AiModelDiscoveryResultSchema>;

export const AiCorrectionStartResultSchema = z.object({ jobId: z.uuid() }).strict();
export type AiCorrectionStartResult = z.infer<typeof AiCorrectionStartResultSchema>;

export const AiCorrectionBookKindSchema = z.enum(["claims", "description", "abstract"]);
export type AiCorrectionBookKind = z.infer<typeof AiCorrectionBookKindSchema>;

export const AI_CORRECTION_ISSUE_LIMIT = 200;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "需要 SHA-256 文本摘要。");
export const AiTextHashRequestSchema = z.string();
export type AiTextHashRequest = z.infer<typeof AiTextHashRequestSchema>;
export const CorrectionAnchorSchema = z
  .object({
    bookKind: AiCorrectionBookKindSchema,
    blockId: z.uuid(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    originalText: z.string().min(1).max(4_000),
    originalTextHash: Sha256Schema,
    contextBefore: z.string().max(64).optional(),
    contextAfter: z.string().max(64).optional(),
  })
  .strict()
  .refine((anchor) => anchor.endOffset > anchor.startOffset, {
    message: "文本范围必须包含至少一个字符。",
    path: ["endOffset"],
  });
export type CorrectionAnchor = z.infer<typeof CorrectionAnchorSchema>;

const AiCorrectionSelectionBlockSchema = z
  .object({
    blockId: z.uuid(),
    blockType: z.enum(["paragraph", "heading", "object"]),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .strict()
  .refine((span) => span.endOffset >= span.startOffset, {
    message: "文本范围结束位置不能早于开始位置。",
    path: ["endOffset"],
  });

const AiCorrectionSelectionScopeSchema = z
  .object({
    kind: z.literal("selection"),
    formatVersion: z.literal(2).optional(),
    bookKind: AiCorrectionBookKindSchema,
    blocks: z.array(AiCorrectionSelectionBlockSchema).min(1),
    selectedTextHash: Sha256Schema,
  })
  .strict()
  .refine((scope) => scope.blocks.some((span) => span.endOffset > span.startOffset), {
    message: "选中范围必须包含至少一个字符。",
    path: ["blocks"],
  });

const AiCorrectionCurrentBookScopeSchema = z
  .object({ kind: z.literal("current-book"), bookKind: AiCorrectionBookKindSchema })
  .strict();

export const AiCorrectionScopeSchema = z.discriminatedUnion("kind", [
  AiCorrectionSelectionScopeSchema,
  AiCorrectionCurrentBookScopeSchema,
]);
export type AiCorrectionScope = z.infer<typeof AiCorrectionScopeSchema>;

export const AiCorrectionStartRequestSchema = z
  .object({
    jobId: z.uuid(),
    patentId: LibraryPatentIdSchema,
    sessionId: SessionIdSchema,
    expectedRevision: LibraryRevisionSchema,
    scope: AiCorrectionScopeSchema,
    thinkingEnabled: z.boolean(),
    uploadConfirmed: z.literal(true),
  })
  .strict();
export type AiCorrectionStartRequest = z.infer<typeof AiCorrectionStartRequestSchema>;

export const AiCorrectionIssueSchema = z
  .object({
    issueId: z.uuid(),
    category: z.enum([
      "spelling",
      "grammar",
      "punctuation",
      "terminology",
      "compliance",
      "consistency",
    ]),
    risk: z.enum(["low", "medium", "high"]),
    applicability: z.enum(["replace", "analysis-only"]),
    anchor: CorrectionAnchorSchema,
    replacement: z.string().min(1).max(4_000).nullable(),
    explanation: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((issue, context) => {
    if (
      issue.category === "consistency" &&
      (issue.risk !== "high" || issue.applicability !== "analysis-only")
    ) {
      context.addIssue({
        code: "custom",
        message: "内容一致性问题只能作为高风险分析项。",
        path: ["applicability"],
      });
    }
    if (issue.applicability === "analysis-only" && issue.replacement !== null) {
      context.addIssue({
        code: "custom",
        message: "分析项不能包含可直接替换的文本。",
        path: ["replacement"],
      });
    }
    if (issue.applicability === "replace" && issue.replacement === null) {
      context.addIssue({
        code: "custom",
        message: "可替换项必须提供替换文本。",
        path: ["replacement"],
      });
    }
    if (issue.risk === "high" && issue.applicability !== "analysis-only") {
      context.addIssue({
        code: "custom",
        message: "高风险项只能作为分析项展示。",
        path: ["applicability"],
      });
    }
    if (issue.category === "compliance" && issue.applicability !== "analysis-only") {
      context.addIssue({
        code: "custom",
        message: "规范项只能作为分析项展示。",
        path: ["applicability"],
      });
    }
  });
export type AiCorrectionIssue = z.infer<typeof AiCorrectionIssueSchema>;

export const AiCorrectionJobIdSchema = z.uuid();
export const AiCorrectionPhaseSchema = z.enum([
  "preparing",
  "connecting",
  "retrying",
  "thinking",
  "structuring",
  "summarizing",
]);
export type AiCorrectionPhase = z.infer<typeof AiCorrectionPhaseSchema>;
export const AiCorrectionCancelRequestSchema = z
  .object({ jobId: AiCorrectionJobIdSchema })
  .strict();
export type AiCorrectionCancelRequest = z.infer<typeof AiCorrectionCancelRequestSchema>;

export const AiCorrectionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), jobId: AiCorrectionJobIdSchema }).strict(),
  z
    .object({
      type: z.literal("partial"),
      jobId: AiCorrectionJobIdSchema,
      issues: z.array(AiCorrectionIssueSchema),
      resultLimitReached: z.boolean(),
      discardedIssueCount: z.number().int().nonnegative(),
      completedChunks: z.number().int().positive(),
      totalChunks: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      jobId: AiCorrectionJobIdSchema,
      completedChunks: z.number().int().nonnegative(),
      totalChunks: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("phase"),
      jobId: AiCorrectionJobIdSchema,
      phase: AiCorrectionPhaseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      jobId: AiCorrectionJobIdSchema,
      delta: z.string().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      jobId: AiCorrectionJobIdSchema,
      issues: z.array(AiCorrectionIssueSchema),
      resultLimitReached: z.boolean(),
      discardedIssueCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      jobId: AiCorrectionJobIdSchema,
      message: z.string().max(500),
    })
    .strict(),
  z.object({ type: z.literal("cancelled"), jobId: AiCorrectionJobIdSchema }).strict(),
]);
export type AiCorrectionEvent = z.infer<typeof AiCorrectionEventSchema>;
