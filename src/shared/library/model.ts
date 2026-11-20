import { z } from "zod";
import { PatentTypeSchema } from "../patent/model.js";

export const LibraryDocumentIdSchema = z.string().uuid();
export type LibraryDocumentId = z.infer<typeof LibraryDocumentIdSchema>;

export const LibraryPatentIdSchema = z.string().uuid();
export type LibraryPatentId = z.infer<typeof LibraryPatentIdSchema>;

export const LibraryRevisionSchema = z.number().int().nonnegative();
export type LibraryRevision = z.infer<typeof LibraryRevisionSchema>;

export const LibrarySaveStateSchema = z.enum(["saving", "saved", "failed"]);
export type LibrarySaveState = z.infer<typeof LibrarySaveStateSchema>;

export const LibraryDocumentSummarySchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    title: z.string().trim().min(1).max(255),
    snippet: z.string().max(500),
    revision: LibraryRevisionSchema,
    saveState: LibrarySaveStateSchema,
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
    quarantinedAt: z.string().datetime().nullable(),
    recoveryState: z.enum(["healthy", "quarantined"]),
    recoveryErrorCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.recoveryState === "healthy" &&
      (summary.quarantinedAt !== null || summary.recoveryErrorCode !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "健康文档不能包含隔离时间或恢复错误码。",
        path: ["recoveryState"],
      });
    }
    if (
      summary.recoveryState === "quarantined" &&
      (summary.quarantinedAt === null || summary.recoveryErrorCode === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "隔离文档必须包含隔离时间和恢复错误码。",
        path: ["recoveryState"],
      });
    }
  });
export type LibraryDocumentSummary = z.infer<typeof LibraryDocumentSummarySchema>;

export const PatentBookStatusSchema = z.enum(["empty", "draft", "complete", "unavailable"]);
export type PatentBookStatus = z.infer<typeof PatentBookStatusSchema>;

export const LibraryPatentSummarySchema = z
  .object({
    patentId: LibraryPatentIdSchema,
    name: z.string().trim().min(1).max(500).nullable(),
    customer: z.string().trim().max(200).nullable(),
    patentType: PatentTypeSchema,
    revision: LibraryRevisionSchema,
    bookStatuses: z
      .object({
        claims: PatentBookStatusSchema,
        description: PatentBookStatusSchema,
        "description-drawings": PatentBookStatusSchema,
        abstract: PatentBookStatusSchema,
        "abstract-drawing": PatentBookStatusSchema,
      })
      .strict(),
    issueCount: z.number().int().nonnegative(),
    saveState: LibrarySaveStateSchema,
    createdAt: z.string().datetime(),
    modifiedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
    recoveryState: z.enum(["healthy", "quarantined"]),
    recoveryErrorCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
      .nullable(),
    abstractText: z.string().max(1_000_000).optional(),
    drawingPreviewAssetId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.recoveryState === "healthy" && summary.recoveryErrorCode !== null) {
      context.addIssue({
        code: "custom",
        message: "健康专利不能包含恢复错误码。",
        path: ["recoveryState"],
      });
    }
    if (summary.recoveryState === "quarantined" && summary.recoveryErrorCode === null) {
      context.addIssue({
        code: "custom",
        message: "隔离专利必须包含恢复错误码。",
        path: ["recoveryState"],
      });
    }
  });
export type LibraryPatentSummary = z.infer<typeof LibraryPatentSummarySchema>;

export const LibraryEditAckSchema = z
  .object({
    libraryDocumentId: LibraryDocumentIdSchema,
    operationId: z.string().uuid(),
    revision: LibraryRevisionSchema,
    savedAt: z.string().datetime(),
  })
  .strict();
export type LibraryEditAck = z.infer<typeof LibraryEditAckSchema>;
